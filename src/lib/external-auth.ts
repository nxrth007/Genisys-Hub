import bcrypt from 'bcryptjs'
import { prisma } from './prisma'
import { createApiToken } from './external-api'
import { postChannelMessage, resolveChannelIdByName } from './slack'

/**
 * Account auth for the externally-hosted CRM frontend.
 *
 * Mirrors the Hub's own agent/client registration rather than inventing
 * a second scheme: bcrypt at cost 12, a pending role until an admin
 * approves, and the same "never confirm whether an email exists"
 * posture on the public endpoints.
 *
 * Why registration does NOT grant access: this frontend reads real
 * client and appointment data and lives on a shareable preview URL. Open
 * signup would hand that to anyone who found the link.
 */

export const CRM_PENDING = 'crm_pending'
export const CRM_USER = 'crm_user'
export const CRM_DENIED = 'crm_denied'

/** Roles allowed to sign in to the CRM frontend. */
const LOGIN_ALLOWED = new Set([CRM_USER])

/** Sessions last 30 days, then the user signs in again. */
const SESSION_DAYS = 30

const MIN_PASSWORD = 10

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`
  }
  return null
}

async function notifyAdmin(text: string) {
  try {
    const settings = await prisma.nctBillingSettings.findUnique({
      where: { id: 'singleton' },
    })
    const raw = (settings?.alertChannel ?? 'genisys-alerts').trim()
    const channelId = raw.startsWith('C')
      ? raw
      : await resolveChannelIdByName(raw)
    if (channelId) await postChannelMessage(channelId, text)
  } catch (err) {
    // Never let a notification failure break registration.
    console.error('[external-auth] notify failed:', err)
  }
}

export type RegisterResult = { ok: true } | { ok: false; error: string }

/**
 * Create a pending CRM account.
 *
 * Always reports success to the caller when the input is well-formed,
 * even if the email is already taken — otherwise this endpoint becomes
 * an account-enumeration oracle. An existing account is left untouched:
 * registering with someone else's address must never overwrite their
 * password.
 */
export async function registerCrmUser(
  nameRaw: string,
  emailRaw: string,
  password: string,
): Promise<RegisterResult> {
  const name = nameRaw.trim()
  const email = emailRaw.trim().toLowerCase()

  if (!name) return { ok: false, error: 'Name is required.' }
  if (!isValidEmail(email)) {
    return { ok: false, error: 'Enter a valid email address.' }
  }
  const pw = passwordProblem(password)
  if (pw) return { ok: false, error: pw }

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    // Deliberately silent: same response shape as a fresh signup.
    await notifyAdmin(
      `🔐 CRM signup attempt for an existing account: ${email} — ignored, no changes made.`,
    )
    return { ok: true }
  }

  await prisma.user.create({
    data: {
      name,
      email,
      role: CRM_PENDING,
      passwordHash: await bcrypt.hash(password, 12),
    },
  })

  await notifyAdmin(
    `🔐 *New CRM access request*\n${name} — ${email}\nApprove in the Hub under Settings → CRM Access.`,
  )
  return { ok: true }
}

export type LoginResult =
  | {
      ok: true
      token: string
      user: { id: string; name: string | null; email: string }
    }
  | { ok: false; error: string; pending?: boolean }

/**
 * Verify credentials and mint a session token.
 *
 * The token is an ApiToken row, so it inherits hashing at rest, expiry
 * and one-click revocation, and every request is attributable to a
 * person rather than a shared key.
 */
export async function loginCrmUser(
  emailRaw: string,
  password: string,
): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase()
  const GENERIC = 'Email or password is incorrect.'

  const user = await prisma.user.findUnique({ where: { email } })

  // Compare against a dummy hash when the user is missing so the timing
  // of "no such account" matches "wrong password".
  const hash =
    user?.passwordHash ??
    '$2a$12$0000000000000000000000000000000000000000000000000000'
  const passwordOk = await bcrypt.compare(password, hash)

  if (!user || !user.passwordHash || !passwordOk) {
    return { ok: false, error: GENERIC }
  }

  if (user.role === CRM_PENDING) {
    return {
      ok: false,
      pending: true,
      error: 'Your account is awaiting approval from an admin.',
    }
  }
  if (!LOGIN_ALLOWED.has(user.role)) {
    return { ok: false, error: 'This account does not have CRM access.' }
  }

  const { plaintext } = await createApiToken(
    `Session · ${user.email}`,
    user.id,
    new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000),
  )

  return {
    ok: true,
    token: plaintext,
    user: { id: user.id, name: user.name, email: user.email },
  }
}
