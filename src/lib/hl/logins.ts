import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { sendEmail } from '@/lib/gmail'
import { getWriterAccountEmail } from '@/lib/drive'
import { canAccessHellLevel } from './access'
import { readProfile } from './accounts'
import { HlInputError } from './http'
import { HL_MEMBER_ROLE as HL_ROLE } from './member-access'
import { sendInternalSms } from './messages'
import { publicBase } from './twilio'

/**
 * Logins for contractors (and their staff) on their own sub-account, as
 * GoHighLevel's sub-account users. Set up from Settings → My Staff → "Invite
 * to log in": the person becomes a User with role "hl_user" and an HlMember
 * row per sub-account, and gets a link (email, and a text when there's a
 * phone) to choose their own password. They sign in at /login and see only
 * their sub-accounts' day-to-day screens; what costs money or could break
 * their setup stays with Genisys (src/lib/hl/member-access.ts).
 *
 * The link's token is stored hashed on the User (the reset fields the
 * client portal uses too), good for a week from an invite and an hour from
 * "Forgot password".
 */

const INVITE_TTL = 7 * 86_400_000
const RESET_TTL = 60 * 60_000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EXPIRED = 'This link has expired or was already used. Ask for a new one on the sign-in page (“Forgot password?”).'

/** The Google sign-in domains (src/auth.ts). */
const teamDomains = () => (process.env.AUTH_ALLOWED_DOMAINS || 'leadgenisys.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)

const roleLabel = (role: string) =>
  role.startsWith('client_') ? 'a client-portal login' : role.startsWith('agent') || role.startsWith('team_') ? 'a call-center login' : 'a Genisys team login'

/** A fresh one-time link for the person to choose a password with. Only its hash is kept. */
async function passwordLink(userId: string, ttl: number): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await prisma.user.update({ where: { id: userId }, data: { passwordResetTokenHash: await bcrypt.hash(token, 10), passwordResetExpiresAt: new Date(Date.now() + ttl) } })
  return `${publicBase()}/login/password?u=${encodeURIComponent(userId)}&t=${token}`
}

async function fromAddress() {
  return process.env.AGENT_APPROVAL_FROM_EMAIL || (await getWriterAccountEmail())
}

const staffData = (data: unknown) => (data && typeof data === 'object' ? (data as Record<string, unknown>) : {})

export type LoginRow = { userId: string; staffId: string | null; email: string; name: string | null; hasPassword: boolean; invitedAt: Date; lastLoginAt: Date | null }

/** Who can log in to this sub-account. */
export async function loginsOf(accountId: string): Promise<LoginRow[]> {
  const rows = await prisma.hlMember.findMany({
    where: { accountId },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, staffId: true, invitedAt: true, lastLoginAt: true, user: { select: { email: true, name: true, passwordHash: true } } },
  })
  return rows.map((r) => ({ userId: r.userId, staffId: r.staffId, email: r.user.email, name: r.user.name, hasPassword: !!r.user.passwordHash, invitedAt: r.invitedAt, lastLoginAt: r.lastLoginAt }))
}

/**
 * Give someone on My Staff a login to this sub-account, and send them the
 * link to choose their password. Sent again, it's a fresh link (the old one
 * stops working). `email` fills in or corrects their staff record's email
 * first. Returns the link too, to pass on by hand.
 */
export async function inviteLogin(o: { accountId: string; staffId: string; email?: string | null; by: string }): Promise<{ link: string; sent: string[] }> {
  const staff = await prisma.hlRecord.findUnique({ where: { id: o.staffId } })
  if (!staff || staff.accountId !== o.accountId || staff.kind !== 'user') throw new HlInputError('That person isn’t on this sub-account’s staff.')
  const data = staffData(staff.data)
  const email = (o.email ?? (typeof data.email === 'string' ? data.email : '')).trim().toLowerCase()
  const phone = typeof data.phone === 'string' ? data.phone : null
  if (!EMAIL.test(email)) throw new HlInputError(`Add ${staff.name}’s email: it’s what they sign in with.`)
  // Genisys's own addresses sign in with Google, never as a sub-account login.
  if (canAccessHellLevel(email) || teamDomains().includes(email.split('@')[1])) throw new HlInputError(`${email} is a Genisys address. Genisys signs in with Google; use the contractor’s own email here.`)
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } })
  if (existing && existing.role !== HL_ROLE) throw new HlInputError(`${email} already has ${roleLabel(existing.role)} to the Hub. Use another email for their sub-account login.`)
  if (email !== data.email) await prisma.hlRecord.update({ where: { id: staff.id }, data: { data: { ...data, email } as Prisma.InputJsonValue } })

  const user = existing ?? (await prisma.user.create({ data: { email, name: staff.name, role: HL_ROLE } }))
  // Their email changed: the login under the old one goes.
  const stale = await prisma.hlMember.findMany({ where: { accountId: o.accountId, staffId: staff.id, userId: { not: user.id } }, select: { userId: true } })
  for (const s of stale) await removeLogin(o.accountId, s.userId)
  await prisma.hlMember.upsert({
    where: { accountId_userId: { accountId: o.accountId, userId: user.id } },
    create: { accountId: o.accountId, userId: user.id, staffId: staff.id, invitedBy: o.by },
    update: { staffId: staff.id, invitedBy: o.by, invitedAt: new Date() },
  })

  const link = await passwordLink(user.id, INVITE_TTL)
  const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: o.accountId }, select: { name: true, profile: true } })
  const business = readProfile(account.profile).businessName || account.name
  const first = staff.name.split(/\s+/)[0] || 'there'
  const sent: string[] = []
  try {
    await sendEmail({
      accountEmail: await fromAddress(),
      fromName: 'Genisys',
      to: email,
      subject: `Your login for ${business}`,
      body: `Hi ${first},\n\nYou now have a login to ${business}'s CRM: your leads, conversations, calendar and pipeline in one place.\n\nChoose your password here (the link works for 7 days):\n${link}\n\nAfter that, sign in any time at ${publicBase()}/login with ${email}.\n\n- Genisys`,
    })
    sent.push(`emailed ${email}`)
  } catch (err) {
    console.warn('[hell-level] login invite email failed:', err instanceof Error ? err.message : err)
  }
  if (phone) {
    const r = await sendInternalSms(o.accountId, [phone], `Hi ${first}, you have a login to ${business}'s CRM. Choose your password here (works for 7 days): ${link}`)
    if (r.ok) sent.push(`texted ${phone}`)
  }
  console.log(`[hell-level] ${o.by} invited ${email} to log in to ${o.accountId} (${sent.join(', ') || 'link only'})`)
  return { link, sent }
}

/** Take someone's login off this sub-account; with none left, the login itself goes (and its session ends). */
export async function removeLogin(accountId: string, userId: string): Promise<void> {
  await prisma.hlMember.deleteMany({ where: { accountId, userId } })
  const left = await prisma.hlMember.count({ where: { userId } })
  if (!left) await prisma.user.deleteMany({ where: { id: userId, role: HL_ROLE } })
}

/** Someone taken off My Staff loses their login to the sub-account too. */
export async function removeStaffLogins(accountId: string, staffId: string): Promise<void> {
  const rows = await prisma.hlMember.findMany({ where: { accountId, staffId }, select: { userId: true } })
  for (const r of rows) await removeLogin(accountId, r.userId)
}

/** The login a set-password link is for, while it's good. */
export async function checkPasswordLink(userId: string, token: string): Promise<{ id: string; email: string }> {
  if (!userId || !token) throw new HlInputError(EXPIRED)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, role: true, passwordResetTokenHash: true, passwordResetExpiresAt: true } })
  if (!user || user.role !== HL_ROLE || !user.passwordResetTokenHash || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) throw new HlInputError(EXPIRED)
  if (!(await bcrypt.compare(token, user.passwordResetTokenHash))) throw new HlInputError(EXPIRED)
  return { id: user.id, email: user.email }
}

/** Choosing a password from an invite or reset link. The link is used up. */
export async function setPasswordFromLink(userId: string, token: string, password: string): Promise<{ email: string }> {
  const user = await checkPasswordLink(userId, token)
  if (password.length < 8) throw new HlInputError('Use at least 8 characters.')
  if (password.length > 200) throw new HlInputError('That password is too long.')
  const local = user.email.split('@')[0].toLowerCase()
  if (local.length >= 4 && password.toLowerCase().includes(local)) throw new HlInputError('Don’t use your email in your password.')
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 12), passwordResetTokenHash: null, passwordResetExpiresAt: null, mustChangePassword: false } })
  return { email: user.email }
}

/** "Forgot password?" on /login: a reset link by email (and text), only ever to a sub-account login. Says nothing either way. */
export async function requestPasswordReset(rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase()
  if (!EMAIL.test(email)) return
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, name: true, hlMemberships: { where: { account: { archivedAt: null } }, take: 1, orderBy: { createdAt: 'asc' }, select: { accountId: true, staffId: true } } },
  })
  if (!user || user.role !== HL_ROLE || !user.hlMemberships.length) return
  const link = await passwordLink(user.id, RESET_TTL)
  const first = (user.name ?? '').split(/\s+/)[0] || 'there'
  try {
    await sendEmail({
      accountEmail: await fromAddress(),
      fromName: 'Genisys',
      to: email,
      subject: 'Reset your password',
      body: `Hi ${first},\n\nChoose a new password here (the link works for an hour):\n${link}\n\nIf you didn't ask for this, ignore this email: your password stays as it is.\n\n- Genisys`,
    })
  } catch (err) {
    console.warn('[hell-level] reset email failed:', err instanceof Error ? err.message : err)
  }
  // A text too, to the phone on their staff record.
  const m = user.hlMemberships[0]
  const staff = m.staffId ? await prisma.hlRecord.findUnique({ where: { id: m.staffId }, select: { data: true } }) : null
  const phone = staffData(staff?.data).phone
  if (typeof phone === 'string' && phone) await sendInternalSms(m.accountId, [phone], `Reset your CRM password here (works for an hour): ${link}`).catch(() => undefined)
}

/** The sub-accounts a login can open, first one first (where /hell-level takes them). */
export async function memberAccountIds(userId: string): Promise<string[]> {
  const rows = await prisma.hlMember.findMany({ where: { userId, account: { archivedAt: null } }, orderBy: { createdAt: 'asc' }, select: { accountId: true } })
  return rows.map((r) => r.accountId)
}
