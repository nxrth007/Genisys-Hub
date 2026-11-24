import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { sendSmsToPhone } from '@/lib/ghl'
import { setClientCustomValue } from '@/lib/ghl-automation-values'
import { bestIntake } from '@/lib/automation-copy'
import { readProfile, setHlGoogleProfile, setHlReviewLink } from '@/lib/hl/accounts'
import { emailList, phoneList } from '@/lib/hl/phone'
import { hubAlert, hubLink } from '@/lib/hub-alerts'
import { PLACES_KEY_ENTRY, placesApiKey } from '@/lib/places-key'
import { markTeamEdits, readMeta } from '@/lib/seo/client-facts'
import type { BusinessFacts } from '@/lib/seo/types'
import { randomBytes } from 'node:crypto'
import { getWriterAccountEmail } from '@/lib/drive'
import { sendEmail } from '@/lib/gmail'
import { TEAM_ALERT_PHONES, textTeam } from '@/lib/team-sms'
import {
  instructionsEmail,
  instructionsText,
  GBP_INPUT_KEYS,
  GBP_STATUSES,
  gbpPrefill,
  intakeSaysProfile,
  ownerFields,
  reminderMessage,
  verificationMessage,
  type GbpInputs,
  type GbpSource,
  type GbpStatus,
  type OwnerField,
} from '@/lib/gbp-kit'
import {
  daytime,
  digits10,
  EMAIL_RE,
  goesOutAt,
  listingMatches,
  listingQuery,
  listingVerdict,
  LOOKUP_VERSION,
  lookupDue,
  nextLookup,
  ownerZone,
  pageState,
  relatedNames,
  readOpenSend,
  sendCheck,
  SENDING_LOST_MS,
  showsTheirSite,
  STALE_LOOKUP_MS,
  strongListing,
  theirListing,
  wantedListing,
  type ListingKind,
  type MapsCandidate,
  type MapsLookup,
  type OpenSend,
  type OwnerZone,
  type PageState,
} from '@/lib/gbp-plan'

/**
 * Google Business Profile setup per client (src/lib/gbp-kit.ts for the kit).
 *
 *   1. A "No" on the onboarding form (or a person on the board) starts it:
 *      the Hub looks on Google Maps for a listing the business already has,
 *      often one Google made on its own that nobody claimed.
 *   2. Scout asks in the Office "Send X their Google profile page?" A yes (or a
 *      pick on Google Profiles) texts and emails the owner their own setup page,
 *      in daytime where they are: claim the listing, or make one from our
 *      answers. Or someone at Genisys creates it from the kit.
 *   3. The Hub reminds them every few days until they finish or someone
 *      marks it verified.
 *   4. Verified: the profile link goes into the SEO engine's facts (the
 *      site's sameAs) and the review link into the GHL sub-account's
 *      "Review Google URL" custom value and the Genisys OS sub-account's
 *      Google review link, which the review workflows use.
 *
 * State lives in AppSetting `gbp.client.<id>`, changed only through change()
 * (compare-and-swap: a text takes seconds, and the owner or a person on the
 * board may be changing it too). A page asked about, queued or going out also
 * has `gbp.send.<id>`, claimed the same way before anything is sent, so it
 * goes out once. No schema change.
 */

const KEY = (id: string) => `gbp.client.${id}`
const SMS_VAULT_ENTRY = 'GHL Genisys Token'
const REMIND_EVERY_MS = 3 * 86_400_000
const MAX_REMINDERS = 5

export type { MapsCandidate, MapsLookup } from '@/lib/gbp-plan'

export type GbpState = {
  status: GbpStatus | null
  values: Partial<GbpInputs>
  lookup: MapsLookup | null
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
  /** When their setup page last went out (text or email), and when someone said Not now. */
  sentAt?: string | null
  skippedAt?: string | null
  /** When a reminder was last claimed, just before it's texted. */
  remindedAt?: string | null
}

const empty = (): GbpState => ({ status: null, values: {}, lookup: null, profileUrl: null, reviewUrl: null, texts: [], remind: false, history: [] })

function parse(raw: string | null | undefined): GbpState {
  try {
    const p = raw ? (JSON.parse(raw) as Partial<GbpState>) : {}
    return {
      ...empty(),
      ...p,
      status: p.status && (GBP_STATUSES as readonly string[]).includes(p.status) ? p.status : null,
      values: cleanValues(p.values),
      texts: Array.isArray(p.texts) ? p.texts : [],
      history: Array.isArray(p.history) ? p.history : [],
    }
  } catch {
    return empty()
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

/** Make a row; false when that key is taken. */
async function createOnce(key: string, value: string): Promise<boolean> {
  try {
    await prisma.appSetting.create({ data: { key, value } })
    return true
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return false
    throw err
  }
}

/**
 * Change a client's state from exactly what's stored, again if someone else changed it meanwhile. The
 * edit returns false to leave it as it is (then this returns null).
 */
async function change(id: string, edit: (s: GbpState) => void | false): Promise<GbpState | null> {
  const key = KEY(id)
  for (let tries = 0; tries < 10; tries++) {
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } })
    const state = parse(row?.value)
    if (edit(state) === false) return null
    state.history = state.history.slice(-40)
    state.texts = state.texts.slice(-20)
    const value = JSON.stringify(state)
    if (row ? (await prisma.appSetting.updateMany({ where: { key, value: row.value }, data: { value } })).count === 1 : await createOnce(key, value)) return state
  }
  throw new Error('Couldn’t save their Google profile board: it keeps changing. Try again.')
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const now = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// The board's data
// ---------------------------------------------------------------------------

const CLIENT_SELECT = {
  id: true,
  name: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  siteUrl: true,
  website: true,
  archivedAt: true,
  lifecycle: true,
  geoLat: true,
  geoLng: true,
  geoLabel: true,
  seoSite: { select: { id: true, facts: true } },
  hlAccount: { select: { profile: true, timezone: true } },
  intakes: {
    orderBy: { receivedAt: 'desc' },
    // A submission can be stored more than once; the copy with its answers in the right boxes counts (bestIntake).
    take: 6,
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
} satisfies Prisma.ClientSelect

type ClientSource = Prisma.ClientGetPayload<{ select: typeof CLIENT_SELECT }>

const clientSource = (id: string): Promise<ClientSource | null> => prisma.client.findUnique({ where: { id }, select: CLIENT_SELECT })

/** Clients who are texted, checked and listed. */
const GONE = ['churned', 'denied']
const ACTIVE = { archivedAt: null, lifecycle: { notIn: GONE } } satisfies Prisma.ClientWhereInput

const OUR_PHONES = new Set(TEAM_ALERT_PHONES.map((p) => digits10(p.phone)))
const TOLL_FREE = /^8(?:00|33|44|55|66|77|88)/

/** What their Genisys OS Business Profile knows about the owner: where their own alerts go, never our phone or email, or a toll-free number. */
function ownerFromProfile(account: ClientSource['hlAccount']): GbpSource['hl'] {
  if (!account) return null
  const p = readProfile(account.profile)
  return {
    ownerFirstName: p.ownerFirstName ?? p.ownerName ?? null,
    phone: phoneList(p.notifyPhone).find((n) => !OUR_PHONES.has(digits10(n)) && !TOLL_FREE.test(digits10(n))) ?? null,
    email: emailList(p.notifyEmail).find((e) => !/@(?:leadgenisys|peakfinitylabs)\.com$/.test(e)) ?? null,
    serviceArea: p.serviceArea ?? null,
  }
}

/** The SEO engine's business facts, keeping only what has the right shape: one odd record mustn't break the list. */
function readFacts(v: unknown): GbpSource['facts'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
  const strs = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined)
  return {
    businessName: str('businessName'),
    trade: str('trade'),
    primaryCity: str('primaryCity'),
    state: str('state'),
    serviceAreas: strs('serviceAreas'),
    services: Array.isArray(o.services) ? (o.services as unknown[]).filter((x): x is { name: string } => !!x && typeof (x as { name?: unknown }).name === 'string') : undefined,
    phone: str('phone'),
    email: str('email'),
    address: str('address'),
    hiddenAddress: o.hiddenAddress === true,
    owner: str('owner'),
    established: typeof o.established === 'number' ? o.established : null,
    insurance: str('insurance'),
    license: str('license'),
    hours: str('hours'),
    differentiators: strs('differentiators'),
  }
}

/** Their newest answer to "Do you have a Google Business Profile?", and the first link they gave. */
function profileAnswer(intakes: { hasGoogleProfile: string | null; googleProfileLink: string | null }[]): { answer: string | null; link: string | null } {
  return {
    answer: intakes.find((i) => i.hasGoogleProfile?.trim())?.hasGoogleProfile ?? null,
    link: intakes.find((i) => i.googleProfileLink?.trim())?.googleProfileLink ?? null,
  }
}

export type GbpBoard = {
  client: { id: string; name: string; hasIntake: boolean; siteUrl: string | null; seoSiteId: string | null }
  intake: { answer: string | null; link: string | null; says: 'yes' | 'no' | null }
  prefill: GbpInputs
  state: GbpState
  /** status, or what the onboarding answer implies when nobody has set one. */
  effectiveStatus: GbpStatus | null
  /** Where they are (the Home globe's), so a Maps search looks around there. */
  near: { lat: number; lng: number } | null
  /** Other words for where they are (their Genisys OS address, the globe's label), for which state a listing must be in. */
  places: string[]
  /** Where the owner is, for texting them in daytime. */
  zone: OwnerZone
  /** Not archived, churned or denied. */
  active: boolean
}

function boardFrom(c: ClientSource, state: GbpState): GbpBoard {
  const intake = bestIntake(c.intakes) ?? null
  const { answer, link } = profileAnswer(c.intakes)
  const facts = readFacts(c.seoSite?.facts)
  const says = intakeSaysProfile(answer)
  const prefill = gbpPrefill({ ...c, intake, facts, hl: ownerFromProfile(c.hlAccount) })
  const x = { ...prefill, ...state.values }
  const places = [c.hlAccount ? readProfile(c.hlAccount.profile).address : null, c.geoLabel, facts?.state].filter((v): v is string => typeof v === 'string' && !!v.trim())
  return {
    client: { id: c.id, name: c.name, hasIntake: !!intake, siteUrl: c.siteUrl, seoSiteId: c.seoSite?.id ?? null },
    intake: { answer, link, says },
    prefill,
    state,
    effectiveStatus: state.status ?? (says === 'no' ? 'needed' : says === 'yes' || link ? 'has_profile' : null),
    near: c.geoLat != null && c.geoLng != null ? { lat: c.geoLat, lng: c.geoLng } : null,
    places,
    zone: ownerZone(c.hlAccount?.timezone, [x.address, ...places, ...x.serviceAreas.split('\n')]),
    active: !c.archivedAt && !GONE.includes(c.lifecycle),
  }
}

export async function gbpBoard(id: string): Promise<GbpBoard | null> {
  const c = await clientSource(id)
  return c ? boardFrom(c, await load(id)) : null
}

// ---------------------------------------------------------------------------
// 1. Is there a listing already?
// ---------------------------------------------------------------------------

const PLACE_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.businessStatus,places.pureServiceAreaBusiness'

/** One Places API (New) text search: up to 10 listings. */
async function searchText(key: string, query: string, near: GbpBoard['near'] = null): Promise<Omit<MapsCandidate, 'matches'>[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACE_FIELDS },
    body: JSON.stringify({
      textQuery: query,
      pageSize: 10,
      regionCode: 'US',
      // Businesses that go to their customers have no public address; Google leaves them out unless asked,
      // and that's how most contractors are listed.
      includePureServiceAreaBusinesses: true,
      ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } } } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json().catch(() => ({}))) as { places?: Array<Record<string, unknown>>; error?: { message?: string } }
  if (!res.ok) throw new Error(data.error?.message || `Places API HTTP ${res.status}`)
  return (data.places ?? []).map((p) => ({
    placeId: String(p.id ?? ''),
    name: String((p.displayName as { text?: string } | undefined)?.text ?? ''),
    address: String(p.formattedAddress ?? ''),
    phone: typeof p.nationalPhoneNumber === 'string' ? p.nationalPhoneNumber : null,
    website: typeof p.websiteUri === 'string' ? p.websiteUri : null,
    mapsUrl: typeof p.googleMapsUri === 'string' ? p.googleMapsUri : null,
    status: typeof p.businessStatus === 'string' ? p.businessStatus : null,
    serviceArea: p.pureServiceAreaBusiness === true,
  }))
}

/**
 * Search Google Maps (Places API, New) for the business by name and town, and by its phone numbers,
 * with the Vault's "Places API (New)" key (lib/places-key.ts). Read-only: changes nothing, on the
 * board or anywhere else. Candidates are only listings that share the business's phone, website or
 * name (src/lib/gbp-plan.ts). Two or three searches; Google's first 1,000 a month are free.
 */
export async function searchMapsListings(x: GbpInputs, at: { near: GbpBoard['near']; places: string[] } = { near: null, places: [] }): Promise<MapsLookup> {
  const wanted = wantedListing(x, at.places)
  const query = listingQuery(x)
  const result: MapsLookup = { at: now(), query, candidates: [], error: null, v: LOOKUP_VERSION }
  try {
    const key = await placesApiKey()
    const found = new Map<string, MapsCandidate>()
    const searches = [searchText(key, query, at.near), ...wanted.phones.slice(0, 2).map((d) => searchText(key, `+1 ${d}`))]
    for (const p of (await Promise.all(searches)).flat()) {
      const matches = listingMatches(p, wanted)
      if (p.placeId && matches.length && !found.has(p.placeId)) found.set(p.placeId, { ...p, matches, related: relatedNames(wanted.businessName, p.name) })
    }
    const rank = (c: MapsCandidate) => Number(theirListing(c)) * 2 + Number(strongListing(c))
    result.candidates = [...found.values()].sort((a, b) => rank(b) - rank(a) || b.matches.length - a.matches.length)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.error = /not found in \/vault|Vault entry/i.test(msg)
      ? `Add the "${PLACES_KEY_ENTRY}" key to the Vault to search Google Maps.`
      : /has not been used|disabled|not enabled|PERMISSION_DENIED|API_KEY_SERVICE_BLOCKED|does not have permission|not authorized to use this API/i.test(msg)
        ? `Google Maps search is off for this key: enable “Places API (New)” for the Vault’s "${PLACES_KEY_ENTRY}" key in Google Cloud. (${msg})`
        : msg
  }
  return result
}

/** The board's own lookup: the Maps search, saved on the board, and its status moved on. */
export async function lookupExistingListing(id: string): Promise<MapsLookup | null> {
  const board = await gbpBoard(id)
  if (!board) return null
  const result = await searchMapsListings({ ...board.prefill, ...board.state.values }, board)
  // A listing that's theirs means claim, not create. Looking says nothing about a client whose form says
  // they have a profile, or doesn't say.
  const found = !result.error && listingVerdict(result).kind === 'claim'
  await change(id, (s) => {
    s.lookup = nextLookup(s.lookup, result)
    if (!s.status && board.intake.says === 'no') s.status = found ? 'existing' : 'needed'
    else if (s.status === 'needed' && found) s.status = 'existing'
    s.history.push({ at: now(), by: null, what: result.error ? `Maps search failed: ${result.error}` : `Searched Google Maps for “${result.query}”: ${result.candidates.length} possible match(es)` })
  })
  return result
}

/** Clients checked per scheduler run. */
const CHECKS_PER_RUN = 4
let nextListingScan = 0

/**
 * Scheduler: every client who needs a profile gets its Maps check (one that failed is tried again, one
 * done the old way is done once more), a few a minute until none is left. Looks only; sends nothing.
 */
export async function maybeCheckListings(nowMs = Date.now()): Promise<number> {
  if (process.env.NODE_ENV !== 'production' || nowMs < nextListingScan) return 0
  nextListingScan = nowMs + 60_000
  const [rows, active] = await Promise.all([gbpOverview(), prisma.client.findMany({ where: ACTIVE, select: { id: true } })])
  const ids = new Set(active.map((c) => c.id))
  const due = rows.filter((r) => ids.has(r.id) && (r.status === 'needed' || r.status === 'existing') && lookupDue(r.lookup, nowMs)).slice(0, CHECKS_PER_RUN)
  if (!due.length) {
    nextListingScan = nowMs + 30 * 60_000
    return 0
  }
  for (const r of due) await lookupExistingListing(r.id).catch((err) => console.warn(`[google profile] Maps check for ${r.name}:`, err))
  return due.length
}

// ---------------------------------------------------------------------------
// Board actions
// ---------------------------------------------------------------------------

export async function saveGbpBoard(id: string, patch: { values?: unknown; status?: unknown; remind?: unknown }, by: string | null): Promise<GbpState> {
  const state = await change(id, (s) => {
    if (patch.values !== undefined) s.values = cleanValues(patch.values)
    if (typeof patch.status === 'string' && (GBP_STATUSES as readonly string[]).includes(patch.status) && patch.status !== s.status) {
      s.status = patch.status as GbpStatus
      s.history.push({ at: now(), by, what: `Status set to ${patch.status}` })
    }
    if (typeof patch.remind === 'boolean') s.remind = patch.remind
  })
  return state!
}

/** Only the live Hub texts and emails clients. */
const live = () => process.env.NODE_ENV === 'production'

/** A send that failed in a way that may still have gone out (GHL answered late or oddly). */
const MAYBE = '(it may have gone out)'

/**
 * Text an owner from the line the team's own texts go out on; when GHL refuses that one outright, from
 * the account's default number. Anything else that goes wrong isn't tried again: GHL may have taken it.
 */
async function sendOwnerText(to: string, text: string, x: GbpInputs, clientName: string): Promise<void> {
  const config = await prisma.remindersConfig.findUnique({ where: { id: 'singleton' }, select: { senderPhone: true } }).catch(() => null)
  const sender = config?.senderPhone?.trim() || null
  const params = { phone: `+1${to}`, message: text, firstName: x.ownerFirstName || undefined, companyName: x.businessName || clientName }
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
  if (bad) throw new Error(bad.refused ? bad.why : `${bad.why} ${MAYBE}`)
}

async function textOwner(id: string, kind: 'checklist' | 'reminder', by: string | null): Promise<{ ok: boolean; detail: string; state: GbpState }> {
  const board = await gbpBoard(id)
  if (!board) throw new Error('client not found')
  const no = (detail: string) => ({ ok: false, detail, state: board.state })
  if (!live()) return no('Only the live Hub texts clients.')
  const { x, check } = sendView(board)
  const to = digits10(x.ownerPhone)
  if (!to) return no('No owner phone number to text. Add it on the left.')
  if (check.content) return no(check.content)
  const link = board.state.publicToken ? hubLink(`/gbp-setup/${board.state.publicToken}`) : null
  const text = kind === 'checklist' ? verificationMessage(x) : reminderMessage(x, link)
  if (/⟦/.test(text)) return no('The message still has blanks. Fill them in on the left first.')
  const later = goesOutAt(board.zone, new Date())
  if (later) return no(`Not sent: owners are texted 9 AM to 7 PM where they are. Try again at ${later}.`)
  let ok = true
  let detail: string | null = null
  try {
    await sendOwnerText(to, text, x, board.client.name)
  } catch (err) {
    ok = false
    detail = message(err)
  }
  const state = await change(id, (s) => {
    s.texts.push({ at: now(), kind, to: `+1${to}`, ok, detail })
    if (ok && kind === 'checklist') {
      s.remind = !s.clientDoneAt
      if (s.status !== 'verified') s.status = 'verifying'
    }
    s.history.push({ at: now(), by, what: `${kind === 'checklist' ? 'Verification checklist' : 'Reminder'} text to +1${to}: ${ok ? 'sent' : `failed (${detail})`}` })
  })
  return { ok, detail: ok ? `Texted +1${to}` : (detail ?? 'failed'), state: state ?? board.state }
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
  const results: string[] = []
  // First, so nothing reminds them while the rest is filled in.
  await change(id, (s) => {
    s.status = 'verified'
    s.remind = false
    if (profileUrl) s.profileUrl = profileUrl
    if (reviewUrl) s.reviewUrl = reviewUrl
  })

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
  if (profileUrl) {
    // Their sub-account's Business Profile keeps the same link.
    const hl = await setHlGoogleProfile(id, profileUrl).catch(() => false)
    if (hl) results.push('Genisys OS: Google Business Profile link set')
  }
  if (reviewUrl) {
    const r = await setClientCustomValue(id, 'Review Google URL', reviewUrl).catch((err) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
    results.push(r.ok ? `GHL: ${r.detail}` : `GHL review link not set: ${r.detail}`)
    // Genisys OS's review survey sends happy customers to the sub-account's Google review link.
    const hl = await setHlReviewLink(id, reviewUrl).catch(() => false)
    if (hl) results.push('Genisys OS: Google review link set')
  }
  const state = await change(id, (s) => {
    s.history.push({ at: now(), by, what: `Marked verified. ${results.join('. ')}` })
  })
  await hubAlert(`:white_check_mark: *Google Business Profile verified* — ${client?.name ?? 'a client'}${profileUrl ? ` · <${profileUrl}|profile>` : ''}. <${hubLink(`/clients/${id}/gbp`)}|Open in Hub>`).catch(() => {})
  return { state: state!, results }
}

/**
 * The profile link typed into the client's Genisys OS Business Profile, kept here too (the two stay in
 * step). Nothing else changes: not the status, and not the SEO facts, which wait for "verified".
 */
export async function recordProfileLink(id: string, url: string, by: string | null): Promise<boolean> {
  const changed = await change(id, (s) => {
    if (s.profileUrl === url) return false
    s.profileUrl = url
    s.history.push({ at: now(), by, what: `Profile link set from their Genisys OS Business Profile: ${url}` })
  })
  return !!changed
}

// ---------------------------------------------------------------------------
// Automatic parts: a "No" on the form, and reminders
// ---------------------------------------------------------------------------

/** A new onboarding submission said there's no profile: look for one Google already made, and have Scout ask in the Office. */
export async function startGbpForNewIntake(clientId: string): Promise<void> {
  const board = await gbpBoard(clientId)
  if (!board || !board.active || board.intake.says !== 'no' || board.state.skippedAt || sendView(board).underway) return
  await lookupExistingListing(clientId)
  await openSend(clientId, { status: 'ask', at: now(), by: null, detail: null })
}

/** Their last text was 3 days ago or more, and there are reminders left. */
function reminderDue(s: GbpState): boolean {
  if (!s.remind || s.status !== 'verifying' || s.clientDoneAt) return false
  const ok = s.texts.filter((t) => t.ok)
  if (!ok.length || ok.filter((t) => t.kind === 'reminder').length >= MAX_REMINDERS) return false
  const last = Math.max(Date.parse(ok[ok.length - 1].at), s.remindedAt ? Date.parse(s.remindedAt) : 0)
  return Date.now() - last >= REMIND_EVERY_MS
}

let lastReminderRun = 0

/**
 * Every few days, remind owners who were sent the checklist and haven't
 * verified. Runs from the scheduler; does real work at most hourly, and
 * only 10am to 7pm where each owner is, so nobody gets a text at night.
 */
export async function maybeSendGbpReminders(): Promise<number> {
  // The scheduler also runs under `next dev`; only the live Hub texts clients.
  if (!live()) return 0
  if (Date.now() - lastReminderRun < 3_600_000) return 0
  lastReminderRun = Date.now()
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: 'gbp.client.' } }, select: { key: true, value: true } })
  let sent = 0
  for (const r of rows) {
    if (!reminderDue(parse(r.value))) continue
    const id = r.key.slice('gbp.client.'.length)
    const board = await gbpBoard(id).catch(() => null)
    if (!board?.active || !digits10(sendView(board).x.ownerPhone) || !daytime(board.zone, new Date(), Math.max(10, board.zone.from))) continue
    // Claimed on what's stored now, just before the text: two processes (a deploy) can't both, and one who finished meanwhile isn't reminded.
    const claimed = await change(id, (s) => {
      if (!reminderDue(s)) return false
      s.remindedAt = now()
    }).catch(() => null)
    if (!claimed) continue
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
  /** The last Google Maps check, as stored. */
  lookup: MapsLookup | null
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
        intakes: { orderBy: { receivedAt: 'desc' }, take: 6, select: { hasGoogleProfile: true, googleProfileLink: true } },
      },
    }),
    prisma.appSetting.findMany({ where: { key: { startsWith: 'gbp.client.' } }, select: { key: true, value: true } }),
  ])
  const saved = new Map(rows.map((r) => [r.key.slice('gbp.client.'.length), parse(r.value)]))
  return clients
    .map((c) => {
      const s = saved.get(c.id) ?? empty()
      const { answer, link } = profileAnswer(c.intakes)
      const says = intakeSaysProfile(answer)
      const okTexts = s.texts.filter((t) => t.ok)
      return {
        id: c.id,
        name: c.name,
        status: s.status ?? (says === 'no' ? 'needed' : says === 'yes' || link ? 'has_profile' : null),
        answer,
        profileUrl: s.profileUrl ?? link,
        lookup: s.lookup,
        textsSent: okTexts.length,
        lastTextAt: okTexts[okTexts.length - 1]?.at ?? null,
        reminding: s.remind && s.status === 'verifying',
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }))
}

// ---------------------------------------------------------------------------
// One tap: ask, queue, send
// ---------------------------------------------------------------------------

const OPEN_PREFIX = 'gbp.send.'
const OPEN_KEY = (id: string) => `${OPEN_PREFIX}${id}`

type OpenRow = { raw: string; open: OpenSend }

async function openRow(id: string): Promise<OpenRow | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: OPEN_KEY(id) }, select: { value: true } })
  const open = readOpenSend(row?.value)
  return row && open ? { raw: row.value, open } : null
}

/** Start an open item; false when there is one already. */
const openSend = (id: string, open: OpenSend): Promise<boolean> => createOnce(OPEN_KEY(id), JSON.stringify(open))

/** Move an open item on, only from exactly what was read: two people (or two processes) can't both. */
async function moveSend(id: string, from: OpenRow, to: OpenSend | null): Promise<boolean> {
  const where = { key: OPEN_KEY(id), value: from.raw }
  const { count } = to ? await prisma.appSetting.updateMany({ where, data: { value: JSON.stringify(to) } }) : await prisma.appSetting.deleteMany({ where })
  return count === 1
}

/** Put a client's page in the queue. False when it's already queued or going out. */
async function queueSend(id: string, by: string | null, own = false): Promise<boolean> {
  const queued: OpenSend = { status: 'queued', at: now(), by, detail: null, ...(own ? { own } : {}) }
  const row = await openRow(id)
  if (!row) return openSend(id, queued)
  return row.open.status === 'ask' || row.open.status === 'failed' ? moveSend(id, row, queued) : false
}

/** Take a client's page to send right now, whatever was open for it. Null when it's already going out. */
async function claimSend(id: string, by: string | null): Promise<OpenRow | null> {
  const sending: OpenSend = { status: 'sending', at: now(), by, detail: null, own: true }
  const mine: OpenRow = { raw: JSON.stringify(sending), open: sending }
  const row = await openRow(id)
  if (!row) return (await openSend(id, sending)) ? mine : null
  if (row.open.status === 'sending') return null
  return (await moveSend(id, row, sending)) ? mine : null
}

/** What a send would do for a client, and what stops it. */
function sendView(board: GbpBoard) {
  const x = { ...board.prefill, ...board.state.values }
  const verdict = listingVerdict(board.state.lookup)
  const status = board.effectiveStatus
  const done = status === 'verified' || status === 'has_profile' || !!board.state.clientDoneAt
  // Being made by us, waiting on the owner to verify, or their page is out: a page telling them to make one would be a second.
  const underway = done || status === 'created' || status === 'verifying' || !!board.state.sentAt
  const managed = showsTheirSite(verdict.listings, board.client.siteUrl)
  const check = sendCheck({
    businessName: x.businessName,
    ownerFirstName: x.ownerFirstName,
    ownerPhone: x.ownerPhone,
    ownerEmail: x.ownerEmail,
    category: x.primaryCategory,
    siteLive: !!board.client.siteUrl?.trim(),
    listing: verdict.kind,
    managed,
    says: board.intake.says,
    autoChecked: status === 'needed' || status === 'existing',
  })
  return { x, verdict, done, underway, managed, check }
}

/**
 * A person picked these on Google Profiles: each page goes out on its own, in daytime where the owner is
 * (the scheduler sends them, a few a minute). Nothing goes to a client whose page already went out, who
 * has a profile, or whose details would embarrass us.
 */
export async function queueSetupSends(ids: string[], by: string | null): Promise<{ queued: string[]; left: { id: string; name: string; why: string }[] }> {
  const queued: string[] = []
  const left: { id: string; name: string; why: string }[] = []
  for (const id of [...new Set(ids)].slice(0, 200)) {
    const board = await gbpBoard(id)
    if (!board) continue
    const leave = (why: string) => left.push({ id, name: board.client.name, why })
    const v = sendView(board)
    if (!board.active) leave('Not an active client.')
    else if (v.done) leave('They have a profile.')
    else if (board.state.sentAt) leave('Their page already went out; use Send on their board to send it again.')
    else if (v.underway) leave('Already under way; see their board.')
    else if (v.check.block) leave(v.check.block)
    else if (await queueSend(id, by)) queued.push(id)
    else leave('Already on its way.')
  }
  return { queued, left }
}

/** Not now: the question goes away (or it leaves the queue) and "Pick all" leaves them out; they can still be picked. */
export async function skipSetupSends(ids: string[], by: string | null): Promise<string[]> {
  const out: string[] = []
  for (const id of [...new Set(ids)].slice(0, 200)) {
    const row = await openRow(id)
    if (row?.open.status === 'sending') continue
    if (row && !(await moveSend(id, row, null))) continue
    await change(id, (s) => {
      s.skippedAt = now()
      s.history.push({ at: now(), by, what: row?.open.status === 'queued' ? 'Setup page: taken out of the queue' : 'Setup page: not now' })
    })
    out.push(id)
  }
  return out
}

/** Scout's question in the Office. */
export async function decideGbpAsk(clientId: string, decision: 'send' | 'no', by: string): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
  const row = await openRow(clientId)
  if (!row || row.open.status !== 'ask') return { ok: false, reason: 'That question has already been answered.' }
  if (decision === 'no') {
    const skipped = await skipSetupSends([clientId], by)
    return skipped.length ? { ok: true, detail: 'Not now. It stays on Google Profiles.' } : { ok: false, reason: 'That question has already been answered.' }
  }
  const board = await gbpBoard(clientId)
  if (!board) return { ok: false, reason: 'That client no longer exists.' }
  const v = sendView(board)
  if (v.underway || !board.active) {
    await moveSend(clientId, row, null)
    return { ok: false, reason: v.done ? 'They have a profile now.' : 'That’s already under way; see their board.' }
  }
  if (v.check.block) return { ok: false, reason: v.check.block }
  if (!(await queueSend(clientId, by))) return { ok: false, reason: 'That question has already been answered.' }
  const later = goesOutAt(board.zone, new Date())
  return { ok: true, detail: later ? `It goes out ${later}.` : 'On its way: it goes out within a couple of minutes.' }
}

const SENDS_PER_RUN = 4
let sendingNow = false

/**
 * Scheduler: send the queued pages that may go out now. Only the live Hub texts clients, and only a page
 * a person queued. Each is claimed first, so it goes out once.
 */
export async function maybeSendQueuedSetups(at = new Date()): Promise<number> {
  if (!live() || sendingNow) return 0
  sendingNow = true
  let sent = 0
  try {
    const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: OPEN_PREFIX } }, select: { key: true, value: true }, orderBy: { id: 'asc' } })
    for (const r of rows) {
      const open = readOpenSend(r.value)
      if (!open || open.status === 'failed') continue
      const id = r.key.slice(OPEN_PREFIX.length)
      const row: OpenRow = { raw: r.value, open }
      if (open.status === 'sending') {
        if (at.getTime() - Date.parse(open.at) > SENDING_LOST_MS) {
          await moveSend(id, row, { ...open, status: 'failed', at: at.toISOString(), detail: 'The Hub restarted while sending. Look at their texts before sending again: it may have gone out.' })
        }
        continue
      }
      // One client's trouble (a read that failed) mustn't hold up the rest; it's looked at again next minute.
      const board = await gbpBoard(id).catch((err) => {
        console.warn('[google profile] queued page:', message(err))
        return undefined
      })
      if (board === undefined) continue
      const v = board ? sendView(board) : null
      // Gone, finished, or under way since it was asked or queued (a board's own Send overrides the last two): drop it.
      const sentSince = !!board?.state.sentAt && Date.parse(board.state.sentAt) > Date.parse(open.at)
      if (!board || !v || !board.active || sentSince || (!open.own && v.underway)) {
        await moveSend(id, row, null)
        continue
      }
      if (open.status !== 'queued' || sent >= SENDS_PER_RUN || !daytime(board.zone, at)) continue
      const sending: OpenSend = { ...open, status: 'sending', at: new Date().toISOString() }
      if (!(await moveSend(id, row, sending))) continue
      const claimed: OpenRow = { raw: JSON.stringify(sending), open: sending }
      // Details can change between the yes and the morning. An unchecked Maps listing is looked at as it goes out.
      const stop = open.own ? v.check.content : v.check.hold
      const res = stop ? { ok: false, sms: stop, email: 'not sent' } : await sendSetupInstructions(id, open.by).catch((err) => ({ ok: false, sms: message(err), email: 'not known' }))
      if (res.ok) sent++
      await moveSend(id, claimed, res.ok ? null : { ...sending, status: 'failed', at: new Date().toISOString(), detail: stop ?? `Text ${res.sms}. Email ${res.email}.` })
    }
  } finally {
    sendingNow = false
  }
  return sent
}

/** The Office: pages Scout asks about, and ones that failed to go out. */
export type GbpOfficeItem = {
  clientId: string
  clientName: string
  status: 'ask' | 'failed'
  at: Date
  detail: string | null
  listing: ListingKind
  listingName: string | null
  siteLive: boolean
  by: { text: boolean; email: boolean }
  block: string | null
  later: string | null
}

export async function gbpOfficeItems(at = new Date()): Promise<GbpOfficeItem[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: OPEN_PREFIX }, OR: [{ value: { contains: '"status":"ask"' } }, { value: { contains: '"status":"failed"' } }] }, select: { key: true, value: true } })
  const out: GbpOfficeItem[] = []
  for (const r of rows) {
    const open = readOpenSend(r.value)
    const id = r.key.slice(OPEN_PREFIX.length)
    if (!open || (open.status !== 'ask' && open.status !== 'failed')) continue
    const c = await prisma.client.findFirst({ where: { id, ...ACTIVE }, select: CLIENT_SELECT })
    if (!c) continue
    const board = boardFrom(c, await load(id))
    const v = sendView(board)
    if (open.status === 'ask' ? v.underway : v.done) continue
    out.push({
      clientId: id,
      clientName: board.client.name,
      status: open.status,
      at: new Date(open.at),
      detail: open.detail,
      listing: v.verdict.kind,
      listingName: v.verdict.listings[0]?.name ?? null,
      siteLive: !!board.client.siteUrl?.trim(),
      by: { text: !!digits10(v.x.ownerPhone), email: EMAIL_RE.test(v.x.ownerEmail.trim()) },
      block: v.check.block,
      later: goesOutAt(board.zone, at),
    })
  }
  return out
}

/** One client on the Google Profiles page: what's on Maps, who gets the page, where it stands. */
export type GbpRow = {
  id: string
  name: string
  status: GbpStatus | null
  answer: string | null
  profileUrl: string | null
  listing: ListingKind
  /** Their listing already shows their website: probably set up. */
  managed: boolean
  listings: { name: string; address: string; mapsUrl: string | null; why: string }[]
  checkedAt: string | null
  lookupError: string | null
  businessName: string
  category: string
  owner: { first: string; phone: string; email: string }
  siteLive: boolean
  page: PageState
  pageAt: string | null
  pageDetail: string | null
  /** When a queued page goes out, when that isn't now. */
  later: string | null
  reminders: number
  reminding: boolean
  /** What stops a one-tap send, and what's worth a glance. */
  block: string | null
  notes: string[]
}

/** Every active client, A–Z. */
export async function gbpRows(at = new Date()): Promise<GbpRow[]> {
  const [clients, rows] = await Promise.all([
    prisma.client.findMany({ where: ACTIVE, select: CLIENT_SELECT }),
    prisma.appSetting.findMany({ where: { OR: [{ key: { startsWith: 'gbp.client.' } }, { key: { startsWith: OPEN_PREFIX } }] }, select: { key: true, value: true } }),
  ])
  const saved = new Map(rows.map((r) => [r.key, r.value]))
  return clients
    .map((c): GbpRow => {
      const board = boardFrom(c, parse(saved.get(KEY(c.id))))
      const open = readOpenSend(saved.get(OPEN_KEY(c.id)))
      const v = sendView(board)
      const s = board.state
      const page = pageState({ open, sentAt: s.sentAt ?? null, skippedAt: s.skippedAt ?? null, done: v.done })
      return {
        id: c.id,
        name: c.name,
        status: board.effectiveStatus,
        answer: board.intake.answer,
        profileUrl: s.profileUrl ?? board.intake.link,
        listing: v.verdict.kind,
        managed: v.managed,
        listings: v.verdict.listings.map((l) => ({ name: l.name, address: l.serviceArea ? '' : l.address, mapsUrl: l.mapsUrl, why: l.matches.join(', ') })),
        checkedAt: s.lookup?.at ?? null,
        lookupError: s.lookup?.error ?? null,
        businessName: v.x.businessName,
        category: v.x.primaryCategory,
        owner: { first: v.x.ownerFirstName, phone: v.x.ownerPhone, email: v.x.ownerEmail },
        siteLive: !!c.siteUrl?.trim(),
        page,
        pageAt: page === 'done' ? (s.clientDoneAt ?? null) : page === 'sent' ? (s.sentAt ?? null) : page === 'skipped' ? (s.skippedAt ?? null) : (open?.at ?? null),
        pageDetail: open?.detail ?? null,
        later: page === 'queued' ? goesOutAt(board.zone, at) : null,
        reminders: s.texts.filter((t) => t.ok && t.kind === 'reminder').length,
        reminding: s.remind && s.status === 'verifying' && !!digits10(v.x.ownerPhone),
        block: v.check.block,
        notes: v.check.notes,
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
  const has = (await load(id)).publicToken
  if (has) return hubLink(`/gbp-setup/${has}`)
  const token = randomBytes(18).toString('base64url')
  await prisma.appSetting.create({ data: { key: PUBLIC_KEY(token), value: id } })
  const state = await change(id, (s) => {
    s.publicToken ||= token
  })
  return hubLink(`/gbp-setup/${state!.publicToken}`)
}

/**
 * "Send Google Business Profile Instructions": text and email the owner the
 * link to their setup page, where every answer is ready to copy. Turns on
 * the every-3-days reminder (with the same link) until they're done.
 */
export async function sendSetupInstructions(id: string, by: string | null): Promise<{ ok: boolean; link: string | null; sms: string; email: string; maybe: boolean }> {
  const not = (why: string) => ({ ok: false, link: null, sms: why, email: 'not sent', maybe: false })
  if (!live()) return not('not sent: only the live Hub texts and emails clients')
  // Claim or create is settled on a fresh look.
  const before = (await load(id)).lookup
  if (listingVerdict(before).kind === 'unchecked' || Date.now() - Date.parse(before!.at) > STALE_LOOKUP_MS) await lookupExistingListing(id).catch(() => null)
  const board = await gbpBoard(id)
  if (!board) throw new Error('client not found')
  const { x, verdict, check } = sendView(board)
  if (check.content) return not(`not sent: ${check.content}`)
  const kind = verdict.kind
  const link = await publicSetupLink(id)
  const text = instructionsText(x, link, kind)
  const mail = instructionsEmail(x, link, kind)
  if (/⟦/.test(`${text}${mail.subject}${mail.body}`)) return not('not sent: a detail in the message is blank. Fill it in on their board')
  const texts: GbpState['texts'] = []

  // Text
  let sms = 'skipped: no owner cell number on the board'
  const to = digits10(x.ownerPhone)
  if (to) {
    try {
      await sendOwnerText(to, text, x, board.client.name)
      sms = `sent to +1${to}`
      texts.push({ at: now(), kind: 'checklist', to: `+1${to}`, ok: true, detail: 'setup instructions' })
    } catch (err) {
      sms = `failed: ${message(err)}`
      texts.push({ at: now(), kind: 'checklist', to: `+1${to}`, ok: false, detail: sms })
    }
  }

  // Email
  let email = 'skipped: no owner email on the board'
  const address = (x.ownerEmail || '').trim()
  if (EMAIL_RE.test(address)) {
    try {
      const from = process.env.AGENT_APPROVAL_FROM_EMAIL || (await getWriterAccountEmail())
      await sendEmail({ accountEmail: from, to: address, subject: mail.subject, body: mail.body, fromName: 'Genisys' })
      email = `sent to ${address}`
    } catch (err) {
      email = `failed: ${message(err)}`
    }
  }

  const ok = sms.startsWith('sent') || email.startsWith('sent')
  const maybe = !ok && sms.includes(MAYBE)
  try {
    await change(id, (s) => {
      s.texts.push(...texts)
      if (ok) {
        s.remind = !s.clientDoneAt
        s.sentAt = now()
        s.skippedAt = null
        if (s.status !== 'verified' && !s.clientDoneAt) s.status = 'verifying'
      }
      s.history.push({ at: now(), by, what: `Setup page (${kind === 'claim' ? 'claim their listing' : 'new profile'}): text ${sms}; email ${email}` })
    })
  } catch (err) {
    // Sent but not recorded: say so, or the list would offer to send it again.
    if (ok || maybe) throw new Error(`text ${sms}; email ${email}. The Hub couldn’t record it (${message(err)}), so don’t send it again without checking`)
    throw err
  }
  return { ok, link, sms, email, maybe }
}

/**
 * The board's Send button: now when it's daytime where they are (the same 9 AM to 7 PM as every
 * queued page), else queued for the morning. Claimed first: a second press, a queued copy and the
 * Office's question can't also send it.
 */
export async function sendNowOrQueue(id: string, by: string | null): Promise<{ ok: boolean; link: string | null; sms: string; email: string; queuedFor: string | null }> {
  const board = await gbpBoard(id)
  if (!board) throw new Error('client not found')
  const answer = (sms: string, email: string) => ({ ok: false, link: null, sms, email, queuedFor: null })
  if (!live()) return answer('not sent: only the live Hub texts and emails clients', 'not sent')
  const { check } = sendView(board)
  if (check.content) return answer(`not sent: ${check.content}`, 'not sent')
  const later = goesOutAt(board.zone, new Date())
  if (later) {
    if (!(await queueSend(id, by, true))) return answer('already on its way', 'already on its way')
    return { ok: true, link: null, sms: 'waiting for the morning', email: 'waiting for the morning', queuedFor: later }
  }
  const claim = await claimSend(id, by)
  if (!claim) return answer('already on its way', 'already on its way')
  try {
    const { ok, link, sms, email, maybe } = await sendSetupInstructions(id, by)
    // A clear failure is on the screen; one that may have gone out stays, so nobody sends it twice unawares.
    await moveSend(id, claim, maybe ? { ...claim.open, status: 'failed', at: now(), detail: `Text ${sms}. Email ${email}.` } : null)
    return { ok, link, sms, email, queuedFor: null }
  } catch (err) {
    await moveSend(id, claim, { ...claim.open, status: 'failed', at: now(), detail: `${message(err)} ${MAYBE}` }).catch(() => false)
    throw err
  }
}

export type PublicSetup = {
  businessName: string
  ownerFirstName: string
  /** claim = Google Maps lists them; maybe = a listing with their name, theirs or not; create = nothing there. */
  mode: 'create' | 'claim' | 'maybe'
  listings: { name: string; address: string; mapsUrl: string }[]
  fields: OwnerField[]
  managerEmail: string
  done: boolean
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
  const { kind, listings } = listingVerdict(board.state.lookup)
  const shown = listings.filter((l) => l.mapsUrl).map((l) => ({ name: l.name, address: l.serviceArea ? '' : l.address.replace(/,?\s*USA$/, ''), mapsUrl: l.mapsUrl! }))
  const mode = shown.length && (kind === 'claim' || kind === 'maybe') ? kind : 'create'
  return {
    businessName: x.businessName || board.client.name,
    ownerFirstName: x.ownerFirstName,
    mode,
    listings: mode === 'create' ? [] : shown,
    fields: ownerFields(x, { claim: mode === 'claim' }),
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
  await change(id, (s) => {
    s.profileUrl = url
    s.clientDoneAt = now()
    s.remind = false
    if (s.status !== 'verified') s.status = 'created'
    s.history.push({ at: now(), by: 'client (setup page)', what: `Client finished the setup page and sent their profile link: ${url}` })
  })
  // Their sub-account's Business Profile keeps the same link.
  await setHlGoogleProfile(id, url).catch(() => false)
  const client = await prisma.client.findUnique({ where: { id }, select: { name: true } })
  const name = client?.name ?? 'A client'
  await hubAlert(`:round_pushpin: *${name}* created their Google Business Profile from the setup page. <${url}|Profile> · <${hubLink(`/clients/${id}/gbp`)}|Open in Hub> (check it's verified, then mark it verified there).`).catch(() => {})
  await textTeam(`Genisys: ${name} finished their Google Business Profile setup and sent the link. Check it in the Hub: ${hubLink(`/clients/${id}/gbp`)}`, 'Google profile done').catch(() => {})
  return { ok: true }
}
