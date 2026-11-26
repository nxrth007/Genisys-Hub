/**
 * "Send Site Update" (Alex, 2026-11-25): the press in a client's Sites folder once their site is
 * live on its own domain. Texts the owner from Lead Genisys's GHL sub-account (the line the team's
 * client texts go out on): the first draft is up at their link, text us the changes, and their
 * Genisys OS login (a link to choose a password, as the client report sends it). Nothing goes out
 * without the press; each send is kept in AppSetting hl.siteUpdate:<clientId>. Owners are texted
 * 9 AM to 7 PM where they are, as every client text is: outside that, the press says when to try.
 */
import { prisma } from '@/lib/prisma'
import { sendSmsToPhone } from '@/lib/ghl'
import { EMAIL_RE, digits10, goesOutAt, ownerZone } from '@/lib/gbp-plan'
import { TEAM_ALERT_PHONES } from '@/lib/team-sms'
import { siteHref } from '@/lib/site-status'
import { readProfile } from './accounts'
import { HlInputError } from './http'
import { inviteLogin, ownerStaffId } from './logins'
import { publicBase } from './twilio'
import { ownerContact, prettyPhone, readSentLog, SITE_UPDATE_LOG_KEY, siteUpdateReady, siteUpdateText, type SiteUpdateLogin, type SiteUpdateSent, type SiteUpdateView } from './site-update-plan'

/** Lead Genisys's GHL sub-account, where the team's own texts to clients go out from. */
const SMS_VAULT_ENTRY = 'GHL Genisys Token'
/** Only the live Hub texts clients. */
const live = () => process.env.NODE_ENV === 'production'
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function gather(clientId: string) {
  return prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactPhone: true,
      contactEmail: true,
      address: true,
      siteUrl: true,
      archivedAt: true,
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { fullName: true, customerPhone: true, leadEmail: true, businessAddress: true } },
      hlAccount: {
        select: {
          id: true,
          name: true,
          profile: true,
          archivedAt: true,
          timezone: true,
          numbers: { where: { status: 'active' }, select: { number: true } },
          members: { select: { user: { select: { email: true } } } },
        },
      },
    },
  })
}
type Client = NonNullable<Awaited<ReturnType<typeof gather>>>

function facts(c: Client) {
  const a = c.hlAccount && !c.hlAccount.archivedAt ? c.hlAccount : null
  const p = readProfile(a?.profile)
  const intake = c.intakes[0] ?? null
  const owner = ownerContact({
    profile: p,
    contactName: c.contactName,
    contactPhone: c.contactPhone,
    contactEmail: c.contactEmail,
    intake,
    notOwner: [...TEAM_ALERT_PHONES.map((t) => t.phone), ...(a?.numbers.map((n) => n.number) ?? [])],
  })
  const zone = ownerZone(a?.timezone, [p.address, c.address, intake?.businessAddress])
  return { a, p, owner, zone, business: p.businessName || c.name }
}

async function sentLog(clientId: string): Promise<SiteUpdateSent[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SITE_UPDATE_LOG_KEY + clientId } }).catch(() => null)
  return readSentLog(row?.value)
}

export async function siteUpdateView(clientId: string, at = new Date()): Promise<SiteUpdateView | null> {
  const c = await gather(clientId)
  if (!c) return null
  const { a, owner, zone, business } = facts(c)
  const r = siteUpdateReady(c)
  const log = await sentLog(clientId)
  return {
    ready: r.ready,
    why: r.why,
    business,
    firstName: owner.firstName,
    siteUrl: c.siteUrl?.trim() ? siteHref(c.siteUrl.trim()) : null,
    to: owner.phone,
    email: owner.email,
    canLogin: !!a,
    logins: a?.members.map((m) => m.user.email) ?? [],
    signInUrl: `${publicBase()}/login`,
    goesOutAt: goesOutAt(zone, at),
    last: log[log.length - 1] ?? null,
  }
}

/**
 * Text the owner from the line the team's client texts go out on; when GHL refuses that number
 * outright, from the sub-account's default. Anything else that goes wrong isn't tried again: GHL
 * may have taken it.
 */
async function textClient(to: string, text: string, o: { firstName: string; business: string }): Promise<void> {
  const config = await prisma.remindersConfig.findUnique({ where: { id: 'singleton' }, select: { senderPhone: true } }).catch(() => null)
  const sender = config?.senderPhone?.trim() || null
  const params = { phone: `+1${to}`, message: text, firstName: o.firstName || undefined, companyName: o.business }
  const send = async (fromNumber: string | null) => {
    try {
      await sendSmsToPhone(SMS_VAULT_ENTRY, { ...params, fromNumber: fromNumber ?? undefined })
      return null
    } catch (err) {
      const why = message(err)
      // "GHL API error 400: …" is a no; a timeout, a 5xx or an unreadable answer isn't.
      return { why, refused: /GHL API error 4(?!08)\d\d/.test(why) }
    }
  }
  let bad = await send(sender)
  if (bad?.refused && sender) bad = await send(null)
  if (bad) throw new Error(bad.refused ? bad.why : `${bad.why} (it may have gone out)`)
}

export type SendSiteUpdateResult = { ok: true; to: string; login: string | null } | { ok: false; reason: string }

/** The press: checked again, then texted once and kept in the log. `to` is the owner's number as typed. */
export async function sendSiteUpdate(clientId: string, o: { to: string; email: string | null; includeLogin: boolean; by: string }, at = new Date()): Promise<SendSiteUpdateResult> {
  const c = await gather(clientId)
  if (!c || c.archivedAt) return { ok: false, reason: 'This client is archived or gone.' }
  if (!live()) return { ok: false, reason: 'Only the live Hub texts clients.' }
  const r = siteUpdateReady(c)
  if (!r.ready) return { ok: false, reason: r.why ?? 'Not ready yet.' }
  const { a, p, owner, zone, business } = facts(c)
  const to = digits10(o.to)
  if (to.length !== 10) return { ok: false, reason: 'That isn’t a 10-digit phone number.' }
  if (TEAM_ALERT_PHONES.some((t) => digits10(t.phone) === to) || a?.numbers.some((n) => digits10(n.number) === to)) {
    return { ok: false, reason: 'That number is Genisys’s own or the business’s line, not the owner’s.' }
  }
  const later = goesOutAt(zone, at)
  if (later) return { ok: false, reason: `Not sent: owners are texted 9 AM to 7 PM where they are. Try again at ${later}.` }
  let login: SiteUpdateLogin | null = null
  if (o.includeLogin) {
    if (!a) return { ok: false, reason: 'They have no Genisys OS sub-account yet, so there’s no login to send. Untick the login, or set the sub-account up first.' }
    const email = (o.email ?? '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return { ok: false, reason: 'Add the owner’s email: it’s what they sign in with.' }
    try {
      const staffId = await ownerStaffId(a.id, email, p.ownerName || c.contactName?.trim() || business, 'site update')
      login = { link: (await inviteLogin({ accountId: a.id, staffId, email, by: o.by, quiet: true })).link, email, signInUrl: `${publicBase()}/login` }
    } catch (err) {
      if (err instanceof HlInputError) return { ok: false, reason: err.message }
      throw err
    }
  }
  const text = siteUpdateText({ firstName: owner.firstName, siteUrl: siteHref(c.siteUrl!.trim()), login })
  let ok = true
  let detail: string | null = null
  try {
    await textClient(to, text, { firstName: owner.firstName, business })
  } catch (err) {
    ok = false
    detail = message(err)
  }
  const entry: SiteUpdateSent = { at: at.toISOString(), to: `+1${to}`, by: o.by, login: login?.email ?? null, ok, detail }
  const key = SITE_UPDATE_LOG_KEY + clientId
  const log = JSON.stringify([...(await sentLog(clientId)), entry].slice(-20))
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: log }, update: { value: log } })
  console.log(`[site-update] ${o.by} texted ${business}'s site update to +1${to}: ${ok ? 'sent' : `failed (${detail})`}${login ? ` (with a login for ${login.email})` : ''}`)
  return ok ? { ok: true, to: prettyPhone(to), login: login?.email ?? null } : { ok: false, reason: `The text didn’t go out: ${detail}` }
}
