import { STATE_CODE_TO_NAME, STATE_NAME_TO_CODE } from './address'
import { parseUsAddress } from './address-parse'
import { isBusinessName } from './intake-tidy-plan'
import { stateCodeFromAddress, timezoneForStateName } from './timezone'

/**
 * Google Business Profile setup: the decisions. Pure (tests load it); src/lib/gbp-setup.ts does the work.
 *
 * Look before creating: which Google Maps listings could be this business, so its owner claims the one
 * Google already has. Making a second can get a profile suspended.
 *
 * One tap: whether a client's setup page can go out, and when (daytime where they are).
 */

// ---------------------------------------------------------------------------
// Which Maps listings could be theirs
// ---------------------------------------------------------------------------

export type MapsCandidate = {
  placeId: string
  name: string
  address: string
  phone: string | null
  website: string | null
  mapsUrl: string | null
  status: string | null
  /** Google lists it without an address: it goes to its customers. */
  serviceArea?: boolean
  /** Its name shares a word that's theirs alone: with their phone or website on it, it's theirs. */
  related?: boolean
  /** Why it looks like this business: same phone, same website, same name. */
  matches: string[]
}

export type MapsLookup = {
  at: string
  query: string
  candidates: MapsCandidate[]
  error: string | null
  /** How it was searched (LOOKUP_VERSION); older searches are run again once. */
  v?: number
  /** Failed tries in a row. */
  tries?: number
}

/**
 * 2 (2026-11-24): businesses with no public address are included (Google leaves them out unless asked,
 * and most contractors are listed that way), it also searches by phone, and a shared name only counts
 * in the client's own state.
 */
export const LOOKUP_VERSION = 2
export const MAX_LOOKUP_TRIES = 4
export const RETRY_LOOKUP_MS = 6 * 3_600_000
/** After that many tries in a row (a key problem, say), once a day. */
export const SLOW_RETRY_MS = 24 * 3_600_000
/** A check this old is run again right before the page goes out. */
export const STALE_LOOKUP_MS = 14 * 86_400_000

/** A failed check is tried again every 6 hours, then daily; one done the old way is done again. */
export function lookupDue(lookup: MapsLookup | null | undefined, now: number): boolean {
  if (!lookup) return true
  if ((lookup.v ?? 1) < LOOKUP_VERSION) return true
  if (!lookup.error) return false
  return now - Date.parse(lookup.at) >= ((lookup.tries ?? 1) < MAX_LOOKUP_TRIES ? RETRY_LOOKUP_MS : SLOW_RETRY_MS)
}

/** What's stored after a check. Google not answering never throws away a good earlier check. */
export function nextLookup(prev: MapsLookup | null | undefined, found: MapsLookup): MapsLookup {
  if (!found.error) return found
  if (prev && !prev.error && (prev.v ?? 1) >= LOOKUP_VERSION) return prev
  return { ...found, candidates: prev?.candidates ?? [], tries: prev?.error && (prev.v ?? 1) >= LOOKUP_VERSION ? (prev.tries ?? 1) + 1 : 1 }
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** The 10 digits of a US number, "" otherwise. */
export function digits10(s: string | null | undefined): string {
  const d = (s ?? '').replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? ten : ''
}

/** Pages many businesses share: the same host there says nothing. */
const SHARED_HOSTS =
  'facebook.com fb.com instagram.com yelp.com linkedin.com tiktok.com twitter.com x.com youtube.com nextdoor.com thumbtack.com angi.com homeadvisor.com houzz.com bbb.org linktr.ee google.com g.page goo.gl bit.ly calendly.com housecallpro.com getjobber.com squareup.com servicetitan.com wa.me'.split(
    ' ',
  )

/** "https://www.acme.com/x" → "acme.com"; "" for a shared page (Facebook, Yelp…) or none. */
export function ownHost(url: string | null | undefined): string {
  const s = clean(url)
  if (!s) return ''
  try {
    const h = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, '')
    return SHARED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`)) ? '' : h
  } catch {
    return ''
  }
}

/** Every state an address or a list of areas mentions, as two-letter codes. */
export function statesIn(text: string | null | undefined): string[] {
  const s = text ?? ''
  const out = new Set<string>()
  // "Tyler, tx" and "tampa fl" too: people type it every way.
  for (const one of [parseUsAddress(s).state, stateCodeFromAddress(s)]) if (one) out.add(one)
  for (const m of s.matchAll(/\b([A-Z]{2})\b/g)) if (STATE_CODE_TO_NAME[m[1]]) out.add(m[1])
  const low = ` ${s.toLowerCase().replace(/[^a-z]+/g, ' ')} `
  for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) if (low.includes(` ${name} `)) out.add(code)
  return [...out]
}

/** Words that say what a contractor does, not who they are. The first of each line stands for the rest. */
const TRADE: Map<string, string> = new Map()
for (const line of [
  'contractor contractors contracting',
  'construction constructions constructors',
  'build builds builder builders building buildings built',
  'remodel remodels remodeler remodelers remodeling remodelling',
  'renovation renovations renovating renovators',
  'restoration restorations',
  'improvement improvements',
  'paint paints painter painters painting',
  'roof roofs roofer roofers roofing',
  'siding',
  'gutter gutters',
  'concrete cement',
  'mason masons masonry',
  'brick bricks stone stonework',
  'paving paver pavers asphalt',
  'fence fences fencing',
  'deck decks decking',
  'floor floors flooring',
  'tile tiles tiling',
  'drywall plaster plastering stucco',
  'carpentry carpenter carpenters woodwork woodworking',
  'cabinet cabinets cabinetry countertop countertops',
  'kitchen kitchens',
  'bath baths bathroom bathrooms',
  'window windows',
  'door doors',
  'plumbing plumber plumbers',
  'electric electrical electrician electricians',
  'hvac heating cooling air',
  'landscape landscapes landscaping landscaper landscapers',
  'lawn lawns yard yards',
  'tree trees',
  'junk',
  'removal haul hauling',
  'moving mover movers',
  'clean cleaning cleaners cleanout cleanouts',
  'pressure power wash washing',
  'pest pests',
  'pool pools spa',
  'foundation foundations',
  'waterproofing',
  'insulation',
  'solar energy',
  'garage garages',
  'appliance appliances',
  'epoxy coating coatings',
  'handyman handymen',
  'home homes house houses',
  'service services',
  'solution solutions',
  'enterprise enterprises',
  'group',
  'general',
  'property properties',
  'maintenance',
  'repair repairs',
  'residential commercial',
  'care',
  'mobile',
  'expert experts',
  'design designs',
  'pro pros professional professionals',
  'quality',
  'team',
  'american america usa national international',
]) {
  const [first, ...rest] = line.split(' ')
  for (const w of [first, ...rest]) TRADE.set(w, first)
}

const STOP = new Set(
  'llc inc incorporated corp corporation co company ltd llp pllc lp dba the and of by a an in on at for to your my our'.split(' '),
)

/** A name's words: "K&P Remodeling, LLC" → kp, remodeling. Single letters in a row are one word. */
function nameWords(s: string): string[] {
  const parts = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/\b([a-z0-9])\s*&\s*([a-z0-9])\b/g, '$1$2')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  const out: string[] = []
  let letters = ''
  for (const w of parts) {
    if (w.length === 1) {
      letters += w
      continue
    }
    if (letters) out.push(letters)
    letters = ''
    out.push(w)
  }
  if (letters) out.push(letters)
  return out.filter((w) => !STOP.has(w))
}

const single = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

/**
 * The same business by name: the names read the same, or every word that's theirs alone is in the
 * listing's name and the trade agrees. "Rojas Junk Removal Services" is "Rojas Junk Removal";
 * "IJ Switchgear" isn't "Switchgear Solutions", and "Concrete Masonry LLC" is only itself.
 */
export function sameName(ours: string, theirs: string): boolean {
  const a = nameWords(ours)
  const b = nameWords(theirs)
  if (!a.length || !b.length) return false
  if (a.join('') === b.join('')) return true
  const own = a.filter((w) => !TRADE.has(w)).map(single)
  if (!own.length) return false
  const bOwn = new Set(b.filter((w) => !TRADE.has(w)).map(single))
  if (!own.every((w) => bOwn.has(w))) return false
  const bTrade = new Set(b.map((w) => TRADE.get(w)).filter(Boolean))
  const aTrade = a.map((w) => TRADE.get(w)).filter((t): t is string => !!t)
  return !aTrade.length || aTrade.some((t) => bTrade.has(t))
}

/** The names share a word that's theirs alone ("Acme Roofing" and "Acme Exteriors"), or read the same. */
export function relatedNames(ours: string, theirs: string): boolean {
  if (sameName(ours, theirs)) return true
  const own = new Set(nameWords(ours).filter((w) => !TRADE.has(w)).map(single))
  return nameWords(theirs).some((w) => !TRADE.has(w) && own.has(single(w)))
}

export type WantedListing = { businessName: string; phones: string[]; website: string; states: string[] }

/** What to look for, from a board's details and whatever else says where they are. */
export function wantedListing(x: { businessName: string; phone: string; ownerPhone: string; website: string; address: string; serviceAreas: string }, places: string[] = []): WantedListing {
  return {
    businessName: clean(x.businessName),
    phones: [...new Set([digits10(x.ownerPhone), digits10(x.phone)].filter(Boolean))],
    website: ownHost(x.website),
    states: [...new Set([x.address, ...x.serviceAreas.split('\n'), ...places].flatMap(statesIn))],
  }
}

/** "Acme Roofing Tyler, TX": the business and its town (the address's, else the first place they listed). */
export function listingQuery(x: { businessName: string; address: string; serviceAreas: string }): string {
  const at = parseUsAddress(x.address)
  // "50 Mile Radius Around Senoia" → "Senoia".
  const first = (x.serviceAreas.split('\n').map(clean).filter(Boolean)[0] ?? '').replace(/^\d+\s*-?\s*(?:miles?|mi|minutes?|mins?|hours?|hrs?)\b\.?\s*(?:radius|drive)?\s*(?:around|of|from|near)?\s*/i, '')
  const town = at.city ? [at.city, at.state].filter(Boolean).join(', ') : first || clean(x.address)
  return [clean(x.businessName), town].filter(Boolean).join(' ')
}

/** Why a listing looks like theirs (empty: it doesn't). */
export function listingMatches(p: Pick<MapsCandidate, 'name' | 'address' | 'phone' | 'website'>, w: WantedListing): string[] {
  const out: string[] = []
  const phone = digits10(p.phone)
  if (phone && w.phones.includes(phone)) out.push('same phone')
  if (w.website && ownHost(p.website) === w.website) out.push('same website')
  if (sameName(w.businessName, p.name)) {
    const st = stateCodeFromAddress(p.address.replace(/,?\s*USA$/, ''))
    // The same name in another state is someone else, unless the phone or website says otherwise.
    if (out.length || !st || !w.states.length || w.states.includes(st)) out.push('same name')
  }
  return out
}

/** Their phone or website is on it. */
export const strongListing = (c: Pick<MapsCandidate, 'matches'>) => c.matches.includes('same phone') || c.matches.includes('same website')

/**
 * Theirs: their phone or website is on it and the name agrees. A phone alone isn't enough: numbers get
 * reused, and an owner's second business can carry the same cell.
 */
export const theirListing = (c: Pick<MapsCandidate, 'matches' | 'related'>) => strongListing(c) && (c.related === true || c.matches.includes('same name'))

/** Their listing already shows the site we built: someone looks after it (Google doesn't find that link by itself). */
export function showsTheirSite(listings: Pick<MapsCandidate, 'matches' | 'related' | 'website'>[], siteUrl: string | null | undefined): boolean {
  const site = ownHost(siteUrl)
  return !!site && listings.some((l) => theirListing(l) && ownHost(l.website) === site)
}

/** create = nothing on Maps; claim = theirs is there; maybe = a listing with their name or number, theirs or not; unchecked = not looked at (or Google didn't answer). */
export type ListingKind = 'create' | 'claim' | 'maybe' | 'unchecked'
export type ListingVerdict = { kind: ListingKind; listings: MapsCandidate[] }

const SHOWN = 3

/** Claim what's there, or create a new one? */
export function listingVerdict(lookup: MapsLookup | null | undefined): ListingVerdict {
  if (!lookup || lookup.error || (lookup.v ?? 1) < LOOKUP_VERSION) return { kind: 'unchecked', listings: [] }
  const open = lookup.candidates.filter((c) => c.placeId && c.status !== 'CLOSED_PERMANENTLY')
  const theirs = open.filter(theirListing)
  if (theirs.length) return { kind: 'claim', listings: theirs.slice(0, SHOWN) }
  if (open.length) return { kind: 'maybe', listings: open.slice(0, SHOWN) }
  return { kind: 'create', listings: [] }
}

/** "Plano, TX" out of "123 Main St, Plano, TX 75074, USA"; "" when Google shows no address. */
export function listingTown(address: string): string {
  const parts = address.replace(/,?\s*USA$/, '').split(',').map(clean).filter(Boolean)
  return parts
    .slice(-2)
    .join(', ')
    .replace(/\s*\d{5}(-\d{4})?$/, '')
}

// ---------------------------------------------------------------------------
// Can the page go out, and when
// ---------------------------------------------------------------------------

export type SendFacts = {
  businessName: string
  ownerFirstName: string
  ownerPhone: string
  ownerEmail: string
  category: string
  siteLive: boolean
  listing: ListingKind
  /** Their listing already shows the site we built (showsTheirSite). */
  managed: boolean
  /** The onboarding form's "Do you have a Google Business Profile?". */
  says: 'yes' | 'no' | null
  /** The Hub checks Google Maps for them on its own (they need a profile); otherwise a person does on their board. */
  autoChecked: boolean
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Form answers that aren't a name ("No" is one client's record). */
const NOT_A_NAME = /^(no|none|n\/?a|yes|test|tbd|same|unknown)\.?$/i

/**
 * `content` must never go out whoever presses (no real name, nobody to send it to); `hold` also stops a
 * one-tap send; `block` adds the one that clears itself (Google Maps not checked yet); `notes` are worth
 * a glance.
 */
export function sendCheck(f: SendFacts): { content: string | null; hold: string | null; block: string | null; notes: string[] } {
  const name = clean(f.businessName)
  const cell = !!digits10(f.ownerPhone)
  const email = EMAIL_RE.test(clean(f.ownerEmail))
  const content =
    name.length < 3 || NOT_A_NAME.test(name) || !isBusinessName(name)
      ? `“${name || 'blank'}” isn’t a business name. Fix it on their board first.`
      : !cell && !email
        ? 'No owner cell or email. Add one on their board first.'
        : null
  const hold =
    content ??
    (f.says === 'yes'
      ? 'The form says they already have a profile. Check with them, or mark it on their board.'
      : f.managed
        ? 'Their Google listing already shows their website, so someone looks after it. Check with them, then mark it on their board.'
        : null)
  const block =
    hold ??
    (f.listing === 'unchecked'
      ? `Google Maps isn’t checked for them yet. ${f.autoChecked ? 'The Hub does it on its own within minutes; “Search Google Maps” on their board does it now.' : '“Search Google Maps” on their board does it.'}`
      : null)
  const notes = [
    f.says ? null : 'the form doesn’t say if they have one',
    cell ? null : 'no cell, so email only',
    email ? null : 'no email, so text only',
    f.ownerFirstName ? null : 'no first name (“Hi there”)',
    f.category ? null : 'no category',
    f.siteLive ? null : 'website not live yet',
  ].filter((n): n is string => !!n)
  return { content, hold, block, notes }
}

/** Owners are texted from 9 AM until 7 PM where they are. */
export const SEND_FROM_HOUR = 9
export const SEND_UNTIL_HOUR = 19
const DEFAULT_ZONE = 'America/New_York'

/** Where the owner is, for texting them: the zone, and the hour texts may start there. */
export type OwnerZone = { zone: string; from: number }

const realZone = (z: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return true
  } catch {
    return false
  }
}

/**
 * Their sub-account's zone; New York there only means nobody changed it, so the state in their address
 * and areas decides. With no state known, noon Eastern to 7 PM, which is daytime coast to coast.
 */
export function ownerZone(accountZone: string | null | undefined, places: (string | null | undefined)[]): OwnerZone {
  const set = clean(accountZone)
  if (set && set !== DEFAULT_ZONE && realZone(set)) return { zone: set, from: SEND_FROM_HOUR }
  for (const p of places) {
    const state = parseUsAddress(p ?? '').state || stateCodeFromAddress(p)
    const zone = timezoneForStateName(state) ?? timezoneForStateName(p)
    if (zone) return { zone, from: SEND_FROM_HOUR }
  }
  return { zone: DEFAULT_ZONE, from: 12 }
}

export function hourIn(zone: string, at: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(at))
}

export function daytime(z: OwnerZone, at: Date, from = z.from): boolean {
  const h = hourIn(z.zone, at)
  return h >= from && h < SEND_UNTIL_HOUR
}

/** The next moment a text may go out there: now, or when the next day opens. */
export function nextDaytime(z: OwnerZone, at: Date): Date {
  if (daytime(z, at)) return at
  const hour = 3_600_000
  let t = Math.ceil(at.getTime() / hour) * hour
  for (let i = 0; i < 26; i++, t += hour) if (hourIn(z.zone, new Date(t)) === z.from) return new Date(t)
  return at
}

/** "9 AM Central tomorrow": when a queued page goes out, for people. Null when that's now. */
export function goesOutAt(z: OwnerZone, at: Date): string | null {
  if (daytime(z, at)) return null
  const next = nextDaytime(z, at)
  const day = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: z.zone, dateStyle: 'short' }).format(d)
  const name = new Intl.DateTimeFormat('en-US', { timeZone: z.zone, timeZoneName: 'longGeneric' }).formatToParts(next).find((p) => p.type === 'timeZoneName')?.value ?? ''
  return `${z.from === 12 ? 'noon' : `${z.from} AM`} ${name.replace(/ Time$/, '')} ${day(next) === day(at) ? 'today' : 'tomorrow'}`
}

const TITLE = /^(?:mr|mrs|ms|miss|dr|sir|rev|pastor)\.?$/i
/** What a company has in its name and a person doesn't. */
const COMPANY =
  /\b(?:llc|inc|corp|company|construction|contract(?:ing|ors?)|roofing|services?|solutions|enterprises?|group|masonry|concrete|plumbing|painting|cleaning|landscaping|remodel+ing|builders?|restoration|homes?)\b/i

/**
 * The first name to greet them by: "JOSE" and "maria" → "Jose", "Maria"; a title is skipped. Blank (the
 * message says "Hi there") when the answer isn't a person's name: an address, an email, a company.
 */
export function firstName(full: string | null | undefined): string {
  const s = clean(full)
  if (!s || /[@\d]/.test(s) || COMPANY.test(s)) return ''
  const w = (s.split(' ').find((x) => !TITLE.test(x)) ?? '').replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
  if (w.length < 2 || !/^[\p{L}'’-]+$/u.test(w)) return ''
  return w === w.toLowerCase() || (w.length > 2 && w === w.toUpperCase()) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w
}

// ---------------------------------------------------------------------------
// The open item: asked, queued, going out, failed
// ---------------------------------------------------------------------------

/** Where a client's setup page stands before it has gone out. Kept on its own, so each step happens once. */
export type OpenSend = {
  status: 'ask' | 'queued' | 'sending' | 'failed'
  at: string
  by: string | null
  detail: string | null
  /** Pressed on the client's own board: sent even to one a one-tap send would leave out. */
  own?: boolean
}

export function readOpenSend(raw: string | null | undefined): OpenSend | null {
  try {
    const v = JSON.parse(raw ?? '') as Partial<OpenSend>
    if (!v || !['ask', 'queued', 'sending', 'failed'].includes(String(v.status)) || typeof v.at !== 'string') return null
    return { status: v.status!, at: v.at, by: typeof v.by === 'string' ? v.by : null, detail: typeof v.detail === 'string' ? v.detail : null, ...(v.own === true ? { own: true } : {}) }
  } catch {
    return null
  }
}

/** A send that never reported back (the Hub restarted mid-way) is called failed after this. */
export const SENDING_LOST_MS = 10 * 60_000

/** The Google Profiles "setup page" column. */
export type PageState = 'done' | 'sent' | 'asked' | 'queued' | 'sending' | 'failed' | 'skipped' | 'not_sent'

export function pageState(f: { open: OpenSend | null; sentAt: string | null; skippedAt: string | null; done: boolean }): PageState {
  if (f.done) return 'done'
  if (f.open) return f.open.status === 'ask' ? 'asked' : f.open.status
  if (f.sentAt) return 'sent'
  return f.skippedAt ? 'skipped' : 'not_sent'
}
