import { createSign } from 'node:crypto'
import type { GscRow, GscSummary } from './types'
import { getSecret } from './secrets'

/**
 * Google Search Console, through a service account.
 *
 * The JSON key lives in the Vault; each client property adds the account's
 * client_email as a user (Full is enough for performance data and sitemap
 * submission). Tokens are minted with a self-signed JWT over node:crypto —
 * no googleapis client in the SEO path — and kept for ~50 minutes.
 *
 * Performance data is final ~2–3 days behind and in Pacific time, so the
 * 28-day window ends three days before "today" in Los Angeles.
 */

const SCOPE = 'https://www.googleapis.com/auth/webmasters'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/webmasters/v3'
const TIMEOUT_MS = 30_000
const TOKEN_TTL_MS = 50 * 60_000
const PAGE_ROWS = 25_000
const MAX_PAIR_ROWS = 50_000

export class GscError extends Error {
  status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'GscError'
    this.status = status
  }
}

type ServiceAccount = { email: string; privateKey: string }

async function serviceAccount(): Promise<ServiceAccount | null> {
  const raw = await getSecret('gscServiceAccount')
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown }
    if (typeof j.client_email !== 'string' || typeof j.private_key !== 'string') return null
    // Keys pasted through an env var or a textarea sometimes keep "\n" as two characters.
    return { email: j.client_email.trim(), privateKey: j.private_key.replace(/\\n/g, '\n') }
  } catch {
    return null
  }
}

let cachedToken: { email: string; token: string; expiresAt: number } | null = null

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.email === sa.email && Date.now() < cachedToken.expiresAt) return cachedToken.token

  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const iat = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`
  let signature: string
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(sa.privateKey, 'base64url')
  } catch {
    throw new GscError("The Search Console service account's private key couldn't be read — re-paste the whole JSON key into the Vault.", null)
  }

  let res: Response
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new GscError(`Google sign-in failed: ${err instanceof Error ? err.message : String(err)}`, null)
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown }
  if (!res.ok || typeof body.access_token !== 'string') {
    const why = typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new GscError(`Google rejected the service account (${why}). Check the key hasn't been deleted in Cloud Console.`, res.status)
  }
  const ttl = typeof body.expires_in === 'number' ? Math.min(TOKEN_TTL_MS, (body.expires_in - 300) * 1000) : TOKEN_TTL_MS
  cachedToken = { email: sa.email, token: body.access_token, expiresAt: Date.now() + Math.max(60_000, ttl) }
  return body.access_token
}

async function gsc<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const sa = await serviceAccount()
  if (!sa) throw new GscError('Search Console is not configured — add the service account JSON key to the Vault.', null)

  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(sa)
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      throw new GscError(`Search Console request failed: ${err instanceof Error ? err.message : String(err)}`, null)
    }
    // A token revoked early (key rotated) — mint a fresh one once.
    if (res.status === 401 && attempt === 0) {
      cachedToken = null
      continue
    }
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 300)
      try {
        const j = JSON.parse(text) as { error?: { message?: unknown } }
        if (typeof j.error?.message === 'string') message = j.error.message
      } catch {
        /* keep the raw text */
      }
      if (res.status === 403) message += ` — add ${sa.email} as a user on this Search Console property.`
      throw new GscError(`Search Console HTTP ${res.status}: ${message}`, res.status)
    }
    return (text ? JSON.parse(text) : {}) as T
  }
}

/** Is a service account configured, and does Google accept it? Never throws. */
export async function gscConfigured(): Promise<{ ok: boolean; serviceAccountEmail: string | null }> {
  try {
    const sa = await serviceAccount()
    if (!sa) return { ok: false, serviceAccountEmail: null }
    try {
      await accessToken(sa)
      return { ok: true, serviceAccountEmail: sa.email }
    } catch {
      return { ok: false, serviceAccountEmail: sa.email }
    }
  } catch {
    return { ok: false, serviceAccountEmail: null }
  }
}

/** Properties the service account has been added to. */
export async function gscListSites(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const r = await gsc<{ siteEntry?: { siteUrl?: unknown; permissionLevel?: unknown }[] }>('/sites')
  return (r.siteEntry ?? [])
    .filter((e): e is { siteUrl: string; permissionLevel: unknown } => typeof e.siteUrl === 'string')
    .map((e) => ({ siteUrl: e.siteUrl, permissionLevel: typeof e.permissionLevel === 'string' ? e.permissionLevel : 'unknown' }))
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl))
}

/** Tell Google about the sitemap (needs Full or Owner on the property). */
export async function gscSubmitSitemap(property: string, sitemapUrl: string): Promise<void> {
  await gsc(`/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(sitemapUrl)}`, { method: 'PUT' })
}

// ---------------------------------------------------------------------------
// Performance data
// ---------------------------------------------------------------------------

type Range = { start: string; end: string }
type ApiRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }

function pacificDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Calendar arithmetic on YYYY-MM-DD, in UTC so DST never shifts a day. */
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Last 28 days ending 3 days ago (Pacific), and the 28 days before that. */
export function gscWindows(now: Date): { range: Range; priorRange: Range } {
  const end = addDays(pacificDate(now), -3)
  const start = addDays(end, -27)
  const priorEnd = addDays(start, -1)
  return { range: { start, end }, priorRange: { start: addDays(priorEnd, -27), end: priorEnd } }
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits

function toRow(r: ApiRow, dims: string[]): GscRow {
  const key = (d: string) => {
    const i = dims.indexOf(d)
    return i === -1 ? null : (r.keys?.[i] ?? null)
  }
  return {
    query: key('query'),
    page: key('page'),
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: round(r.ctr ?? 0, 4),
    position: round(r.position ?? 0, 1),
  }
}

async function query(property: string, range: Range, dims: string[], opts: { rowLimit?: number; startRow?: number; usOnly?: boolean } = {}): Promise<GscRow[]> {
  const r = await gsc<{ rows?: ApiRow[] }>(`/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
    method: 'POST',
    body: {
      startDate: range.start,
      endDate: range.end,
      dimensions: dims,
      type: 'web',
      dataState: 'final',
      rowLimit: opts.rowLimit ?? 1000,
      startRow: opts.startRow ?? 0,
      ...(opts.usOnly ? { dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }] }] } : {}),
    },
  })
  return (r.rows ?? []).map((row) => toRow(row, dims))
}

async function queryAllPairs(property: string, range: Range): Promise<GscRow[]> {
  const rows: GscRow[] = []
  for (let start = 0; start < MAX_PAIR_ROWS; start += PAGE_ROWS) {
    const page = await query(property, range, ['query', 'page'], { rowLimit: PAGE_ROWS, startRow: start, usOnly: true })
    rows.push(...page)
    if (page.length < PAGE_ROWS) break
  }
  return rows
}

function totalsOf(rows: GscRow[]): GscSummary['totals'] {
  const r = rows[0]
  return r ? { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position } : { clicks: 0, impressions: 0, ctr: 0, position: 0 }
}

const byClicks = (a: GscRow, b: GscRow) => b.clicks - a.clicks || b.impressions - a.impressions || a.position - b.position

// ---------------------------------------------------------------------------
// Striking distance (playbook §6.5)
// ---------------------------------------------------------------------------

/**
 * Generic CTR by position — only a fallback when the site has too little
 * data of its own in a bucket. UNVERIFIED industry-ish numbers, which is
 * why the site's own medians win whenever they exist.
 */
export const GENERIC_CTR: Record<string, number> = { '1': 0.28, '2': 0.15, '3': 0.1, '4': 0.07, '5': 0.05, '6-10': 0.03, '11-20': 0.01 }

function bucket(position: number): string | null {
  const p = Math.round(position)
  if (p >= 1 && p <= 5) return String(p)
  if (p >= 6 && p <= 10) return '6-10'
  if (p >= 11 && p <= 20) return '11-20'
  return null
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Nearest-rank percentile. */
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]
}

/**
 * Expected CTR per position bucket: the site's own median where a bucket
 * has at least 5 query×page rows with 10+ impressions, else the generic curve.
 */
export function expectedCtr(rows: GscRow[]): (position: number) => number {
  const groups = new Map<string, number[]>()
  for (const r of rows) {
    if (r.impressions < 10) continue
    const b = bucket(r.position)
    if (b) groups.set(b, [...(groups.get(b) ?? []), r.ctr])
  }
  const site = new Map<string, number>()
  for (const [b, ctrs] of groups) if (ctrs.length >= 5) site.set(b, median(ctrs))
  return (position: number) => {
    const b = bucket(position)
    if (!b) return 0
    return site.get(b) ?? GENERIC_CTR[b]
  }
}

/**
 * Query×page pairs sitting at average position 4–20 with enough
 * impressions to matter (≥ max(floor, the site's p75 query impressions)),
 * ranked by the clicks they'd gain at the target position: 3 for page one,
 * 8 for page two. Pairs already beating the expected CTR there are dropped.
 */
export function strikingDistance(rows: GscRow[], opts: { minImpressions?: number; limit?: number } = {}): (GscRow & { opportunity: number })[] {
  const floor = opts.minImpressions ?? 20
  const perQuery = new Map<string, number>()
  for (const r of rows) if (r.query) perQuery.set(r.query, (perQuery.get(r.query) ?? 0) + r.impressions)
  const threshold = Math.max(floor, percentile([...perQuery.values()], 0.75))
  const exp = expectedCtr(rows)

  const out: (GscRow & { opportunity: number })[] = []
  for (const r of rows) {
    if (!r.query || !r.page) continue
    if (r.position < 3.5 || r.position >= 20.5) continue
    if (r.impressions < threshold) continue
    const target = r.position < 10.5 ? 3 : 8
    const opportunity = r.impressions * (exp(target) - r.ctr)
    if (opportunity <= 0) continue
    out.push({ ...r, opportunity: round(opportunity, 1) })
  }
  return out.sort((a, b) => b.opportunity - a.opportunity || b.impressions - a.impressions).slice(0, opts.limit ?? 30)
}

/** Never throws — a failure comes back in `error` with empty data. */
export async function gscSummary(property: string, now: Date): Promise<GscSummary> {
  const { range, priorRange } = gscWindows(now)
  const empty: GscSummary = {
    property,
    range,
    priorRange,
    totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    prior: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    topQueries: [],
    topPages: [],
    striking: [],
    error: null,
  }
  try {
    const [current, previous, queries, pages, pairs] = await Promise.all([
      query(property, range, []),
      query(property, priorRange, []),
      query(property, range, ['query'], { rowLimit: 500 }),
      query(property, range, ['page'], { rowLimit: 500 }),
      queryAllPairs(property, range),
    ])
    const totals = totalsOf(current)

    // Small sites: 28 days of US data is too thin to find anything, so look
    // at 90 days with a higher floor (playbook §6.5 step 1–2).
    let strikingRows = pairs
    let floor = 20
    if (pairs.reduce((n, r) => n + r.impressions, 0) < 500) {
      strikingRows = await queryAllPairs(property, { start: addDays(range.end, -89), end: range.end })
      floor = 50
    }

    return {
      ...empty,
      totals,
      prior: totalsOf(previous),
      topQueries: queries.sort(byClicks).slice(0, 25),
      topPages: pages.sort(byClicks).slice(0, 25),
      striking: strikingDistance(strikingRows, { minImpressions: floor, limit: 30 }),
    }
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) }
  }
}
