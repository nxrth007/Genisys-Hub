import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { sendSmsToPhone } from '@/lib/ghl'
import { setClientCustomValue } from '@/lib/ghl-automation-values'
import { hubAlert, hubLink } from '@/lib/hub-alerts'
import { PLACES_KEY_ENTRY, placesApiKey } from '@/lib/places-key'
import { markTeamEdits, readMeta } from '@/lib/seo/client-facts'
import type { BusinessFacts } from '@/lib/seo/types'
import { randomBytes } from 'node:crypto'
import { getWriterAccountEmail } from '@/lib/drive'
import { sendEmail } from '@/lib/gmail'
import { textTeam } from '@/lib/team-sms'
import {
  gbpFields,
  instructionsEmail,
  instructionsText,
  type GbpField,
  GBP_INPUT_KEYS,
  GBP_STATUSES,
  gbpPrefill,
  intakeSaysProfile,
  reminderMessage,
  verificationMessage,
  type GbpInputs,
  type GbpStatus,
} from '@/lib/gbp-kit'

/**
 * Google Business Profile setup per client (src/lib/gbp-kit.ts for the kit).
 *
 *   1. A "No" on the onboarding form (or a person on the board) starts it:
 *      the Hub looks on Google Maps for a listing the business already has,
 *      often one Google made on its own that nobody claimed.
 *   2. Someone creates the profile from the kit, with the client as owner.
 *   3. The Hub texts the owner the verification checklist and reminds them
 *      every few days until someone marks it verified.
 *   4. Verified: the profile link goes into the SEO engine's facts (the
 *      site's sameAs) and the review link into the GHL sub-account's
 *      "Review Google URL" custom value, which the review workflows use.
 *
 * State lives in AppSetting `gbp.client.<id>`; no schema change.
 */

const KEY = (id: string) => `gbp.client.${id}`
const SMS_VAULT_ENTRY = 'GHL Genisys Token'
const REMIND_EVERY_MS = 3 * 86_400_000
const MAX_REMINDERS = 5

export type MapsCandidate = {
  placeId: string
  name: string
  address: string
  phone: string | null
  website: string | null
  mapsUrl: string | null
  status: string | null
  /** Why it looks like this business: same phone, same website, same name. */
  matches: string[]
}

export type GbpState = {
  status: GbpStatus | null
  values: Partial<GbpInputs>
  lookup: { at: string; query: string; candidates: MapsCandidate[]; error: string | null } | null
  profileUrl: string | null
  reviewUrl: string | null
  /** Texts sent to the owner: the checklist first, then reminders. */
  texts: { at: string; kind: 'checklist' | 'reminder'; to: string; ok: boolean; detail: string | null }[]
  remind: boolean
  history: { at: string; by: string | null; what: string }[]
  /** The secret in the client's public setup page link (/gbp-setup/<token>). */
  publicToken?: string | null
  /** When the client pasted their new profile link on that page. */
  clientDoneAt?: string | null
}

const EMPTY: GbpState = { status: null, values: {}, lookup: null, profileUrl: null, reviewUrl: null, texts: [], remind: false, history: [] }

function parse(raw: string | null | undefined): GbpState {
  try {
    const p = raw ? (JSON.parse(raw) as Partial<GbpState>) : {}
    return {
      ...EMPTY,
      ...p,
      status: p.status && (GBP_STATUSES as readonly string[]).includes(p.status) ? p.status : null,
      values: cleanValues(p.values),
      texts: Array.isArray(p.texts) ? p.texts : [],
      history: Array.isArray(p.history) ? p.history : [],
    }
  } catch {
    return { ...EMPTY }
  }
}

export function cleanValues(v: unknown): Partial<GbpInputs> {
  const out: Partial<GbpInputs> = {}
  if (!v || typeof v !== 'object') return out
  for (const k of GBP_INPUT_KEYS) {
    const val = (v as Record<string, unknown>)[k]
    if (typeof val !== 'string') continue
    if (k === 'locationMode') {
      if (val === 'address' || val === 'service_area') out.locationMode = val
    } else out[k] = val.slice(0, 2000)
  }
  return out
}

async function load(id: string): Promise<GbpState> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY(id) } })
  return parse(row?.value)
}

async function save(id: string, state: GbpState): Promise<void> {
  const value = JSON.stringify({ ...state, history: state.history.slice(-40), texts: state.texts.slice(-20) })
  await prisma.appSetting.upsert({ where: { key: KEY(id) }, create: { key: KEY(id), value }, update: { value } })
}

const now = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// The board's data
// ---------------------------------------------------------------------------

async function clientSource(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      siteUrl: true,
      website: true,
      seoSite: { select: { id: true, facts: true } },
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: {
          fullName: true,
          businessName: true,
          businessAddress: true,
          customerPhone: true,
          leadEmail: true,
          cities: true,
          mainServices: true,
          aboutBusiness: true,
          whyChooseYou: true,
          yearStarted: true,
          hasGoogleProfile: true,
          googleProfileLink: true,
        },
      },
    },
  })
}

export type GbpBoard = {
  client: { id: string; name: string; hasIntake: boolean; siteUrl: string | null; seoSiteId: string | null }
  intake: { answer: string | null; link: string | null; says: 'yes' | 'no' | null }
  prefill: GbpInputs
  state: GbpState
  /** status, or what the onboarding answer implies when nobody has set one. */
  effectiveStatus: GbpStatus | null
}

export async function gbpBoard(id: string): Promise<GbpBoard | null> {
  const c = await clientSource(id)
  if (!c) return null
  const intake = c.intakes[0] ?? null
  const facts = (c.seoSite?.facts as unknown as BusinessFacts | null) ?? null
  const state = await load(id)
  const says = intakeSaysProfile(intake?.hasGoogleProfile)
  return {
    client: { id: c.id, name: c.name, hasIntake: !!intake, siteUrl: c.siteUrl, seoSiteId: c.seoSite?.id ?? null },
    intake: { answer: intake?.hasGoogleProfile ?? null, link: intake?.googleProfileLink ?? null, says },
    prefill: gbpPrefill({ ...c, intake, facts }),
    state,
    effectiveStatus: state.status ?? (says === 'no' ? 'needed' : says === 'yes' || intake?.googleProfileLink ? 'has_profile' : null),
  }
}

// ---------------------------------------------------------------------------
// 1. Is there a listing already?
// ---------------------------------------------------------------------------

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '').slice(-10)
const host = (u: string | null | undefined) => {
  try {
    return u ? new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase() : ''
  } catch {
    return ''
  }
}
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 2 && !['llc', 'inc', 'the', 'and', 'company', 'services'].includes(w)),
  )

/**
 * Search Google Maps (Places API, New) for the business, with the Vault's
 * "Places API (New)" key (lib/places-key.ts). Read-only.
 */
export async function lookupExistingListing(id: string): Promise<GbpState['lookup']> {
  const board = await gbpBoard(id)
  if (!board) return null
  const x = { ...board.prefill, ...board.state.values }
  const areas = x.serviceAreas.split('\n').map((s) => s.trim()).filter(Boolean)
  const city = x.locationMode === 'address' ? x.address : areas[0] ?? ''
  const query = [x.businessName, city].filter(Boolean).join(' ')
  const result: NonNullable<GbpState['lookup']> = { at: now(), query, candidates: [], error: null }
  try {
    const key = await placesApiKey()
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.businessStatus',
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 8 }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => ({}))) as {
      places?: Array<Record<string, unknown>>
      error?: { message?: string }
    }
    if (!res.ok) throw new Error(data.error?.message || `Places API HTTP ${res.status}`)
    const phones = new Set([digits(x.phone), digits(x.ownerPhone)].filter((d) => d.length === 10))
    const site = host(x.website)
    const nameWords = words(x.businessName)
    result.candidates = (data.places ?? [])
      .map((p): MapsCandidate => {
        const name = String((p.displayName as { text?: string } | undefined)?.text ?? '')
        const phone = typeof p.nationalPhoneNumber === 'string' ? p.nationalPhoneNumber : null
        const website = typeof p.websiteUri === 'string' ? p.websiteUri : null
        const matches: string[] = []
        if (phone && phones.has(digits(phone))) matches.push('same phone')
        if (site && website && host(website) === site) matches.push('same website')
        const w = words(name)
        if (nameWords.size && [...nameWords].every((n) => w.has(n))) matches.push('same name')
        return {
          placeId: String(p.id ?? ''),
          name,
          address: String(p.formattedAddress ?? ''),
          phone,
          website,
          mapsUrl: typeof p.googleMapsUri === 'string' ? p.googleMapsUri : null,
          status: typeof p.businessStatus === 'string' ? p.businessStatus : null,
          matches,
        }
      })
      .filter((c) => c.matches.length > 0)
      .sort((a, b) => b.matches.length - a.matches.length)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.error = /not found in \/vault|Vault entry/i.test(msg)
      ? `Add the "${PLACES_KEY_ENTRY}" key to the Vault to search Google Maps.`
      : /has not been used|disabled|not enabled|PERMISSION_DENIED|API_KEY_SERVICE_BLOCKED|does not have permission|not authorized to use this API/i.test(msg)
        ? `Google Maps search is off for this key: enable “Places API (New)” for the Vault’s "${PLACES_KEY_ENTRY}" key in Google Cloud. (${msg})`
        : msg
  }
  const state = await load(id)
  state.lookup = result
  // A strong match (phone or website) means claim, not create.
  if (!state.status || state.status === 'needed') {
    if (result.candidates.some((c) => c.matches.includes('same phone') || c.matches.includes('same website'))) state.status = 'existing'
    else if (!state.status) state.status = 'needed'
  }
  state.history.push({ at: now(), by: null, what: result.error ? `Maps search failed: ${result.error}` : `Searched Google Maps for “${query}”: ${result.candidates.length} possible match(es)` })
  await save(id, state)
  return result
}

// ---------------------------------------------------------------------------
// Board actions
// ---------------------------------------------------------------------------

export async function saveGbpBoard(id: string, patch: { values?: unknown; status?: unknown; remind?: unknown }, by: string | null): Promise<GbpState> {
  const state = await load(id)
  if (patch.values !== undefined) state.values = cleanValues(patch.values)
  if (typeof patch.status === 'string' && (GBP_STATUSES as readonly string[]).includes(patch.status) && patch.status !== state.status) {
    state.status = patch.status as GbpStatus
    state.history.push({ at: now(), by, what: `Status set to ${patch.status}` })
  }
  if (typeof patch.remind === 'boolean') state.remind = patch.remind
  await save(id, state)
  return state
}

async function textOwner(id: string, kind: 'checklist' | 'reminder', by: string | null): Promise<{ ok: boolean; detail: string; state: GbpState }> {
  const board = await gbpBoard(id)
  if (!board) throw new Error('client not found')
  const x = { ...board.prefill, ...board.state.values }
  const to = digits(x.ownerPhone)
  const state = board.state
  if (to.length !== 10) {
    return { ok: false, detail: 'No owner phone number to text. Add it on the left.', state }
  }
  const link = state.publicToken ? hubLink(`/gbp-setup/${state.publicToken}`) : null
  const message = kind === 'checklist' ? verificationMessage(x) : reminderMessage(x, link)
  if (/⟦/.test(message)) return { ok: false, detail: 'The message still has blanks. Fill them in on the left first.', state }
  let ok = true
  let detail: string | null = null
  try {
    const [firstName, ...rest] = (x.ownerFirstName || '').split(' ')
    await sendSmsToPhone(SMS_VAULT_ENTRY, { phone: `+1${to}`, message, firstName: firstName || undefined, lastName: rest.join(' ') || undefined, companyName: x.businessName || board.client.name })
  } catch (err) {
    ok = false
    detail = err instanceof Error ? err.message : String(err)
  }
  state.texts.push({ at: now(), kind, to: `+1${to}`, ok, detail })
  if (ok && kind === 'checklist') {
    state.remind = true
    if (state.status !== 'verified') state.status = 'verifying'
  }
  state.history.push({ at: now(), by, what: `${kind === 'checklist' ? 'Verification checklist' : 'Reminder'} text to +1${to}: ${ok ? 'sent' : `failed (${detail})`}` })
  await save(id, state)
  return { ok, detail: ok ? `Texted +1${to}` : detail ?? 'failed', state }
}

export const sendVerificationChecklist = (id: string, by: string | null) => textOwner(id, 'checklist', by)

/**
 * Verified: record the links where they're used. The profile goes into the
 * SEO engine's facts (the site's schema sameAs and the engine's GBP checks);
 * the review link into the sub-account's "Review Google URL" custom value.
 */
export async function markVerified(
  id: string,
  links: { profileUrl?: unknown; reviewUrl?: unknown },
  by: string | null,
): Promise<{ state: GbpState; results: string[] }> {
  const asUrl = (v: unknown) => (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : null)
  const profileUrl = asUrl(links.profileUrl)
  const reviewUrl = asUrl(links.reviewUrl)
  const state = await load(id)
  const results: string[] = []
  state.status = 'verified'
  state.remind = false
  if (profileUrl) state.profileUrl = profileUrl
  if (reviewUrl) state.reviewUrl = reviewUrl

  const client = await prisma.client.findUnique({ where: { id }, select: { name: true, seoSite: { select: { id: true, facts: true, factsMeta: true } } } })
  const site = client?.seoSite
  if (profileUrl && site?.facts) {
    const prev = site.facts as unknown as BusinessFacts
    const others = (prev.profiles ?? []).filter((p) => !/google/i.test(p.label) && !/google\.com\/maps|g\.page|maps\.app\.goo\.gl|business\.google/i.test(p.url))
    const next: BusinessFacts = { ...prev, profiles: [{ label: 'Google Business Profile', url: profileUrl }, ...others] }
    const meta = markTeamEdits(prev, next, readMeta(site.factsMeta), by)
    await prisma.seoSite.update({
      where: { id: site.id },
      data: { facts: next as unknown as Prisma.InputJsonValue, factsMeta: meta as unknown as Prisma.InputJsonValue },
    })
    results.push('Profile link added to the SEO business facts')
  } else if (profileUrl) {
    results.push('No SEO site with business facts for this client; the profile link is kept here only')
  }
  if (reviewUrl) {
    const r = await setClientCustomValue(id, 'Review Google URL', reviewUrl).catch((err) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
    results.push(r.ok ? `GHL: ${r.detail}` : `GHL review link not set: ${r.detail}`)
  }
  state.history.push({ at: now(), by, what: `Marked verified. ${results.join('. ')}` })
  await save(id, state)
  await hubAlert(`:white_check_mark: *Google Business Profile verified* — ${client?.name ?? 'a client'}${profileUrl ? ` · <${profileUrl}|profile>` : ''}. <${hubLink(`/clients/${id}/gbp`)}|Open in Hub>`).catch(() => {})
  return { state, results }
}

// ---------------------------------------------------------------------------
// Automatic parts: a "No" on the form, and reminders
// ---------------------------------------------------------------------------

/** A new onboarding submission said there's no profile: look for one Google already made, and tell the team. */
export async function startGbpForNewIntake(clientId: string): Promise<void> {
  const board = await gbpBoard(clientId)
  if (!board || board.intake.says !== 'no' || board.state.status) return
  const lookup = await lookupExistingListing(clientId)
  const found = lookup?.candidates.length ?? 0
  await hubAlert(
    `:round_pushpin: *${board.client.name}* has no Google Business Profile (onboarding form). ${
      lookup?.error ? `Maps search failed: ${lookup.error}` : found ? `Found ${found} possible existing listing${found === 1 ? '' : 's'} on Google Maps to claim.` : 'No existing listing found on Google Maps.'
    } Setup kit: <${hubLink(`/clients/${clientId}/gbp`)}|Open in Hub>`,
  ).catch(() => {})
}

let lastReminderRun = 0

/**
 * Every few days, remind owners who were sent the checklist and haven't
 * verified. Runs from the scheduler; does real work at most hourly, and
 * only 10am to 7pm Eastern so nobody gets a text at night.
 */
export async function maybeSendGbpReminders(): Promise<number> {
  // The scheduler also runs under `next dev`; only the live Hub texts clients.
  if (process.env.NODE_ENV !== 'production') return 0
  if (Date.now() - lastReminderRun < 3_600_000) return 0
  const hourEt = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()))
  if (hourEt < 10 || hourEt >= 19) return 0
  lastReminderRun = Date.now()
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: 'gbp.client.' } }, select: { key: true, value: true } })
  let sent = 0
  for (const r of rows) {
    const id = r.key.slice('gbp.client.'.length)
    const s = parse(r.value)
    if (!s.remind || s.status !== 'verifying') continue
    const okTexts = s.texts.filter((t) => t.ok)
    const last = okTexts[okTexts.length - 1]
    if (!last || Date.now() - Date.parse(last.at) < REMIND_EVERY_MS) continue
    if (okTexts.filter((t) => t.kind === 'reminder').length >= MAX_REMINDERS) continue
    const res = await textOwner(id, 'reminder', null).catch(() => null)
    if (res?.ok) sent++
  }
  return sent
}

// ---------------------------------------------------------------------------
// The Google Profiles tab
// ---------------------------------------------------------------------------

export type GbpOverviewRow = {
  id: string
  name: string
  status: GbpStatus | null
  /** The onboarding form's answer, word for word. */
  answer: string | null
  profileUrl: string | null
  /** Possible existing listings from the last Google Maps search, or null when never searched. */
  found: number | null
  lookupError: string | null
  textsSent: number
  lastTextAt: string | null
  reminding: boolean
}

/** Every active client, A–Z, with its Google Business Profile standing. One query each for clients and saved state. */
export async function gbpOverview(): Promise<GbpOverviewRow[]> {
  const [clients, rows] = await Promise.all([
    prisma.client.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { hasGoogleProfile: true, googleProfileLink: true } },
      },
    }),
    prisma.appSetting.findMany({ where: { key: { startsWith: 'gbp.client.' } }, select: { key: true, value: true } }),
  ])
  const saved = new Map(rows.map((r) => [r.key.slice('gbp.client.'.length), parse(r.value)]))
  return clients
    .map((c) => {
      const s = saved.get(c.id) ?? { ...EMPTY }
      const intake = c.intakes[0] ?? null
      const says = intakeSaysProfile(intake?.hasGoogleProfile)
      const okTexts = s.texts.filter((t) => t.ok)
      return {
        id: c.id,
        name: c.name,
        status: s.status ?? (says === 'no' ? 'needed' : says === 'yes' || intake?.googleProfileLink ? 'has_profile' : null),
        answer: intake?.hasGoogleProfile ?? null,
        profileUrl: s.profileUrl ?? intake?.googleProfileLink ?? null,
        found: s.lookup && !s.lookup.error ? s.lookup.candidates.length : null,
        lookupError: s.lookup?.error ?? null,
        textsSent: okTexts.length,
        lastTextAt: okTexts[okTexts.length - 1]?.at ?? null,
        reminding: s.remind && s.status === 'verifying',
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }))
}

// ---------------------------------------------------------------------------
// The client does it: instructions and a public setup page
// ---------------------------------------------------------------------------

/** Who the client adds as a manager on their new profile, so Genisys can help keep it current. */
export const GBP_MANAGER_EMAIL = process.env.GBP_MANAGER_EMAIL?.trim() || 'alex@leadgenisys.com'
const PUBLIC_KEY = (token: string) => `gbp.public.${token}`

/** The client's setup page link, made once and kept (the same link works in every reminder). */
export async function publicSetupLink(id: string): Promise<string> {
  const state = await load(id)
  if (!state.publicToken) {
    state.publicToken = randomBytes(18).toString('base64url')
    await prisma.appSetting.create({ data: { key: PUBLIC_KEY(state.publicToken), value: id } })
    await save(id, state)
  }
  return hubLink(`/gbp-setup/${state.publicToken}`)
}

/**
 * "Send Google Business Profile Instructions": text and email the owner the
 * link to their setup page, where every answer is ready to copy. Turns on
 * the every-3-days reminder (with the same link) until they're done.
 */
export async function sendSetupInstructions(id: string, by: string | null): Promise<{ ok: boolean; link: string; sms: string; email: string; state: GbpState }> {
  const board = await gbpBoard(id)
  if (!board) throw new Error('client not found')
  const x = { ...board.prefill, ...board.state.values }
  const link = await publicSetupLink(id)
  const state = await load(id)

  // Text
  let sms = 'skipped: no owner cell number on the board'
  const to = digits(x.ownerPhone)
  if (to.length === 10) {
    const text = instructionsText(x, link)
    try {
      const [firstName, ...rest] = (x.ownerFirstName || '').split(' ')
      await sendSmsToPhone(SMS_VAULT_ENTRY, { phone: `+1${to}`, message: text, firstName: firstName || undefined, lastName: rest.join(' ') || undefined, companyName: x.businessName || board.client.name })
      sms = `sent to +1${to}`
      state.texts.push({ at: now(), kind: 'checklist', to: `+1${to}`, ok: true, detail: 'setup instructions' })
    } catch (err) {
      sms = `failed: ${err instanceof Error ? err.message : String(err)}`
      state.texts.push({ at: now(), kind: 'checklist', to: `+1${to}`, ok: false, detail: sms })
    }
  }

  // Email
  let email = 'skipped: no owner email on the board'
  const address = (x.ownerEmail || '').trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    const mail = instructionsEmail(x, link)
    try {
      const from = process.env.AGENT_APPROVAL_FROM_EMAIL || (await getWriterAccountEmail())
      await sendEmail({ accountEmail: from, to: address, subject: mail.subject, body: mail.body, fromName: 'Genisys' })
      email = `sent to ${address}`
    } catch (err) {
      email = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const ok = sms.startsWith('sent') || email.startsWith('sent')
  if (ok) {
    state.remind = true
    if (state.status !== 'verified') state.status = 'verifying'
  }
  state.history.push({ at: now(), by, what: `Setup instructions: text ${sms}; email ${email}` })
  await save(id, state)
  return { ok, link, sms, email, state }
}

export type PublicSetup = {
  businessName: string
  ownerFirstName: string
  fields: GbpField[]
  managerEmail: string
  done: boolean
}

/** The setup page's notes, in the client's terms. */
function clientNote(id: string, mode: GbpInputs['locationMode']): string | undefined {
  switch (id) {
    case 'name':
      return 'Exactly as it appears on your truck, invoices and website. Don’t add a city or services to it: Google suspends profiles that do.'
    case 'category':
      return 'Start typing it and pick the closest match from Google’s list.'
    case 'extra':
      return 'After the profile is created: Edit profile, then Business category, then Add another category.'
    case 'location':
      return mode === 'address'
        ? 'When Google asks if customers can visit, choose Yes and use this address.'
        : 'When Google asks about a location customers can visit, choose No, then add these as your service areas. Your address stays private.'
    case 'phone':
      return 'Use this number exactly. It’s the one on your website, so Google sees one consistent business.'
    case 'hours':
      return 'Under Edit profile, then Hours.'
    case 'services':
      return 'Under Edit profile, then Services.'
    case 'description':
      return 'Under Edit profile, then Description.'
    default:
      return undefined
  }
}

async function idForToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null
  const row = await prisma.appSetting.findUnique({ where: { key: PUBLIC_KEY(token) } })
  return row?.value ?? null
}

/** What the client's public page shows: business details only, never notes, history or contact details. */
export async function publicSetup(token: string): Promise<PublicSetup | null> {
  const id = await idForToken(token)
  if (!id) return null
  const board = await gbpBoard(id)
  if (!board) return null
  const x = { ...board.prefill, ...board.state.values }
  return {
    businessName: x.businessName || board.client.name,
    ownerFirstName: x.ownerFirstName,
    // The owner creates it in their own account, so our "hand over ownership" step doesn't apply,
    // and the notes are rewritten for them (the board's notes are for our team).
    fields: gbpFields(x)
      .filter((f) => f.id !== 'owner')
      .map((f) => ({ ...f, note: clientNote(f.id, x.locationMode) })),
    managerEmail: GBP_MANAGER_EMAIL,
    done: !!board.state.clientDoneAt || board.state.status === 'verified',
  }
}

/** The client pasted their new profile link on the public page. */
export async function publicSetupDone(token: string, profileUrl: unknown): Promise<{ ok: boolean; error?: string }> {
  const id = await idForToken(token)
  if (!id) return { ok: false, error: 'This link is no longer valid.' }
  const url = typeof profileUrl === 'string' ? profileUrl.trim() : ''
  if (!/^https?:\/\/(www\.)?(google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl|g\.page|share\.google|business\.google\.com|g\.co)\//i.test(url) || url.length > 500) {
    return { ok: false, error: 'That doesn’t look like a Google link. In your profile, tap Share and copy the link it gives you.' }
  }
  const state = await load(id)
  state.profileUrl = url
  state.clientDoneAt = now()
  state.remind = false
  if (state.status !== 'verified') state.status = 'created'
  state.history.push({ at: now(), by: 'client (setup page)', what: `Client finished the setup page and sent their profile link: ${url}` })
  await save(id, state)
  const client = await prisma.client.findUnique({ where: { id }, select: { name: true } })
  const name = client?.name ?? 'A client'
  await hubAlert(`:round_pushpin: *${name}* created their Google Business Profile from the setup page. <${url}|Profile> · <${hubLink(`/clients/${id}/gbp`)}|Open in Hub> (check it's verified, then mark it verified there).`).catch(() => {})
  await textTeam(`Genisys: ${name} finished their Google Business Profile setup and sent the link. Check it in the Hub: ${hubLink(`/clients/${id}/gbp`)}`, 'Google profile done').catch(() => {})
  return { ok: true }
}
