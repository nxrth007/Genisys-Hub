/**
 * Is this client's site on Google? Pure (tests load it): turns Search Console's record of the homepage
 * (the daily check, ./gsc-health.ts) into one plain verdict for the Sites folder's "On Google" card, and
 * says which sites to flag: their domain was connected a week ago and Google still hasn't indexed them.
 *
 * "Our side" (does the site name its own domain? ./domain-guard.ts) and "Google's side" (has Google
 * indexed it?) are different questions. The guard can be right and Google still not have looked.
 *
 * Google sometimes files the homepage under the www (or bare) spelling of the same domain and calls ours a
 * duplicate. The site is on Google, under its own domain, so that is "settling", never flagged: Google
 * moves it over as it looks again (Lovable's www redirect is a temporary one, which lets it wait).
 */
import type { GscInspection } from './gsc'

/** AppSetting keys of the two stored Search Console results. */
export const GSC_HEALTH_KEY = 'seo.gsc.health'
export const GSC_CONNECT_KEY = 'seo.gsc.connect'

/** Flag a site that still isn't indexed this long after its domain was connected. */
export const FLAG_AFTER_DAYS = 7
const DAY = 86_400_000

export type GoogleState =
  /** Google has the homepage indexed at its own address. */
  | 'indexed'
  /** On Google, but Google files it under the www (or bare) spelling, or still calls it a duplicate of itself. */
  | 'settling'
  /** Google hasn't indexed it (unknown, discovered, crawled but not indexed…). */
  | 'not_yet'
  /** Google says it can't index it: noindex, robots, an error, not found. */
  | 'blocked'
  /** Google says the real page is on another domain. */
  | 'elsewhere'
  /** On its own domain, but not in Search Console yet (no repo linked, verification stuck). */
  | 'not_added'
  /** In Search Console, but Google hasn't been asked about the homepage yet. */
  | 'unchecked'
  /** Not on its own domain yet: nothing for Google to index. */
  | 'no_domain'

/** Google's own words for "it can't": anything else that isn't indexed is "hasn't yet". */
const BLOCKED_RE = /noindex|robots|not found|\b404\b|\b4\d\d\b|\b5\d\d\b|server error|soft 404|redirect error|unauthorized|forbidden|access denied|blocked/i

const host = (url: string | null | undefined): string | null => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null
  } catch {
    return null
  }
}
const bare = (h: string | null): string | null => (h ? h.replace(/^www\./, '') : null)

export type HomeReading = { state: 'indexed' | 'settling' | 'not_yet' | 'blocked' | 'elsewhere' | 'unchecked'; text: string; googleHost: string | null }

/** What Google says about the homepage (the URL Inspection result), in plain words. */
export function readHome(home: GscInspection | null | undefined): HomeReading {
  if (!home) return { state: 'unchecked', text: 'Google hasn’t been asked about the homepage yet.', googleHost: null }
  const ours = host(home.url)
  const google = host(home.googleCanonical)
  const said = home.coverageState ?? home.verdict
  if (home.verdict === 'PASS') return { state: 'indexed', text: `Google has indexed ${ours ?? 'the homepage'}.`, googleHost: google }
  if (google && bare(google) === bare(ours)) {
    return google === ours
      ? { state: 'settling', text: `Google has the homepage at its own address, but still shows it as a duplicate. Its record catches up as it looks again.`, googleHost: google }
      : { state: 'settling', text: `On Google under ${google}, the ${google.startsWith('www.') ? 'www' : 'no-www'} spelling of the same domain. It normally moves to ${ours} as Google looks again.`, googleHost: google }
  }
  if (google) return { state: 'elsewhere', text: `Google says the real page is on ${google}, another domain.`, googleHost: google }
  if (said === 'VERDICT_UNSPECIFIED') return { state: 'unchecked', text: 'Google gave no verdict on the homepage.', googleHost: null }
  if (home.verdict === 'FAIL' || BLOCKED_RE.test(said)) return { state: 'blocked', text: `Google can’t index it: “${said}”.`, googleHost: null }
  return { state: 'not_yet', text: `Google hasn’t indexed it yet: “${said}”.`, googleHost: null }
}

/** When the site's current domain was connected: the day the guard first saw it there, else Forge's record, else the first site link. */
export function connectedAt(o: { originSince?: string | null; domainAt?: string | null; siteLiveAt?: string | null; siteCreatedAt?: string | null }): string | null {
  return o.originSince || o.domainAt || o.siteLiveAt || o.siteCreatedAt || null
}

/**
 * When the site's address became this one, for the guard to keep: the day its link was first saved on
 * the guard's first look (now, when that isn't known), now when it moves to another domain (that's the day
 * the domain was connected), else as it was. www and no-www are the same address. A state from before
 * 2026-11-24 has no date and keeps none: its site was connected before this was tracked.
 */
export function originSince(
  prev: { servedOrigin?: string | null; originSince?: string | null } | null | undefined,
  servedOrigin: string | null | undefined,
  nowIso: string,
  firstLinkedIso?: string | null,
): string | null {
  const was = bare(host(prev?.servedOrigin))
  const is = bare(host(servedOrigin))
  if (!is) return prev?.originSince ?? null
  // Its first look (or one a deploy cut off). The site may have been live long before it got a seat
  // (a client added by hand), so the look itself isn't day one.
  if (!was) return firstLinkedIso && firstLinkedIso < nowIso ? firstLinkedIso : nowIso
  if (was !== is) return nowIso
  return prev?.originSince ?? null
}

/** "seo.gsc.health": one stored check per site. */
export type StoredSite = {
  siteId: string
  property: string
  home: GscInspection | null
  sitemaps?: { lastDownloaded: string | null; isPending?: boolean; errors?: number }[]
  /** This site's own check time (a single-site refresh is newer than the daily run). */
  checkedAt?: string
}
export type StoredHealth = { checkedAt?: string; sites?: StoredSite[] }

const parseJson = (value: string | null | undefined): unknown => {
  try {
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

/** Every site's entry in the stored check (parsed once per page), with when it was read. */
export function storedSites(value: string | null | undefined): Map<string, { site: StoredSite; checkedAt: string | null }> {
  const h = parseJson(value) as StoredHealth | null
  const out = new Map<string, { site: StoredSite; checkedAt: string | null }>()
  for (const site of Array.isArray(h?.sites) ? h.sites : []) if (site?.siteId) out.set(site.siteId, { site, checkedAt: site.checkedAt ?? h?.checkedAt ?? null })
  return out
}

/** Why Search Console isn't connected yet, by site (stored progress; a connected site has no reason). */
export function connectReasons(value: string | null | undefined): Map<string, string> {
  const m = parseJson(value) as Record<string, { status?: string; detail?: string }> | null
  const out = new Map<string, string>()
  for (const [id, s] of Object.entries(m ?? {})) if (s && s.status !== 'connected' && s.detail) out.set(id, s.detail)
  return out
}

export type GoogleVerdict = {
  state: GoogleState
  /** Short label for the pill. */
  label: string
  tone: 'good' | 'wait' | 'bad' | 'idle'
  /** One plain sentence. */
  text: string
  /** Google's word on the address it uses, when it isn't the site's own. */
  googleHost: string | null
  /** When Google last looked at the homepage, and when the Hub last asked. */
  lastLooked: string | null
  checkedAt: string | null
  /** When the site's domain was connected (best known). */
  connectedAt: string | null
  daysConnected: number | null
  /** Connected a week or more ago and still not indexed: shows on the Sites list. */
  flagged: boolean
}

/** The flag in words. Where Google hasn't been asked yet, the site isn't known to be missing from it. */
export function flagLine(v: Pick<GoogleVerdict, 'state' | 'daysConnected'>): string {
  const what = v.state === 'not_added' || v.state === 'unchecked' ? 'Not confirmed on Google' : 'Not indexed'
  return `${what} ${v.daysConnected} days after its domain was connected`
}

const LABEL: Record<GoogleState, { label: string; tone: GoogleVerdict['tone'] }> = {
  indexed: { label: 'On Google', tone: 'good' },
  settling: { label: 'On Google, settling', tone: 'wait' },
  not_yet: { label: 'Not indexed yet', tone: 'wait' },
  blocked: { label: 'Blocked', tone: 'bad' },
  elsewhere: { label: 'Wrong address', tone: 'bad' },
  not_added: { label: 'Not in Search Console', tone: 'wait' },
  unchecked: { label: 'Not checked yet', tone: 'idle' },
  no_domain: { label: 'No domain yet', tone: 'idle' },
}

export type VerdictInput = {
  /** The site's link now; a lovable.app address isn't its own domain. */
  liveUrl: string | null
  /** Search Console property on the SEO site (null until the Hub adds it). */
  property: string | null
  /** This site's entry in the stored daily check (storedSites), if any. */
  stored: { site: StoredSite; checkedAt: string | null } | null | undefined
  /** Why Search Console isn't connected (connectReasons), if it isn't. */
  connectWhy: string | null | undefined
  connectedAt: string | null
  now: Date
}

const LOVABLE_RE = /(?:^|\.)(?:lovable\.app|lovableproject\.com)$/i

export function googleVerdict(i: VerdictInput): GoogleVerdict {
  const daysConnected = i.connectedAt ? Math.floor((i.now.getTime() - Date.parse(i.connectedAt)) / DAY) : null
  const done = (state: GoogleState, text: string, extra: Partial<GoogleVerdict> = {}): GoogleVerdict => {
    const flagged = !['indexed', 'settling', 'no_domain'].includes(state) && daysConnected !== null && daysConnected >= FLAG_AFTER_DAYS
    return { state, label: LABEL[state].label, tone: flagged && LABEL[state].tone === 'wait' ? 'bad' : LABEL[state].tone, text, googleHost: null, lastLooked: null, checkedAt: null, connectedAt: i.connectedAt, daysConnected, flagged, ...extra }
  }
  const h = host(i.liveUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(i.liveUrl) ? `https://${i.liveUrl}` : i.liveUrl)
  if (!h || LOVABLE_RE.test(h)) return done('no_domain', h ? 'Not on its own domain yet, so there’s nothing for Google to index.' : 'No live site yet, so there’s nothing for Google to index.')

  const stored = i.stored
  const at = { checkedAt: stored?.checkedAt ?? null }
  if (!i.property) {
    return done('not_added', i.connectWhy ? `Not in Search Console yet: ${i.connectWhy}` : 'Not in Search Console yet. The Hub adds the site on its own once its code is linked and published.', at)
  }
  if (!stored?.site.home) return done('unchecked', 'In Search Console. Google hasn’t been asked about the homepage yet; the Hub asks every day.', at)
  // A check from before the domain changed says nothing about this address.
  if (bare(host(stored.site.home.url)) !== bare(h)) return done('unchecked', 'In Search Console. The last check was for the site’s earlier address; the Hub asks again every day.', at)
  const read = readHome(stored.site.home)
  return done(read.state, read.text, { googleHost: read.googleHost, lastLooked: stored.site.home.lastCrawlTime, checkedAt: stored.checkedAt })
}
