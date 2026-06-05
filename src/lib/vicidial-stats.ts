/**
 * Vicidial admin dashboard scraper.
 *
 * Hub server-side fetches https://expeditusbpo.vicitel.cc/vicidial/admin.php
 * using the Render outbound IPs we whitelisted for the recording proxy,
 * parses the visible numbers, and returns a stable JSON shape for the
 * /team/live-report page.
 *
 * Auth: Vicidial form login via welcome.php. Credentials live in vault
 * under two entries:
 *   "Vicidial Admin Username"  — typically "AdminRoot"
 *   "Vicidial Admin Password"
 *
 * Caching: in-memory, 55s TTL (just under the frontend's 60s poll so
 * each poll hits one fresh fetch instead of waiting for cache to expire
 * mid-window). N parallel pollers within a single 55s window hit the
 * cached value.
 *
 * Failure mode: never throws to the caller — returns { ok: false, error }
 * instead. The UI shows a "Live data unavailable" banner without crashing
 * the rest of the page.
 *
 * Brittleness: the parser uses regex against the visible labels. If
 * Vicidial updates the admin page HTML, individual fields fall back to
 * null (UI renders "—"). The shape stays stable.
 */

import { getSecretByName } from './vault-service'

const VICIDIAL_BASE = 'https://expeditusbpo.vicitel.cc/vicidial'
const CACHE_TTL_MS = 55_000

/** Set a real-browser UA so we don't get filtered as a bot. Vicidial's
 *  HTML doesn't care much, but some upstream proxies do. */
const USER_AGENT =
  'Mozilla/5.0 (Hub-Scraper) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export type VicidialStatsResult =
  | { ok: true; stats: VicidialStats; fetchedAt: string }
  | { ok: false; error: string; fetchedAt: string }

export type VicidialStats = {
  /** Top stat cards on the dashboard. Any field may be null if the
   *  page layout changed and the parser couldn't find it. */
  agentsLoggedIn: number | null
  agentsInCalls: number | null
  activeCalls: number | null
  callsRinging: number | null

  /** System Summary table. Each row gives Active / Inactive / Total. */
  systemSummary: {
    users: SummaryRow
    campaigns: SummaryRow
    lists: SummaryRow
    inGroups: SummaryRow
    dids: SummaryRow
  }

  /** Total Stats for Today */
  today: TotalStatsRow
  /** Total Stats for Yesterday */
  yesterday: TotalStatsRow
}

type SummaryRow = {
  active: number | null
  inactive: number | null
  total: number | null
}

type TotalStatsRow = {
  /** "Total Calls" — may be "X / Y" on the yesterday row (counted /
   *  billable). We return the FIRST number (counted). */
  totalCalls: number | null
  inboundCalls: number | null
  outboundCalls: number | null
  maxAgents: number | null
}

let cached: { value: VicidialStatsResult; at: number } | null = null
let inFlight: Promise<VicidialStatsResult> | null = null

/** Side-channel raw HTML, captured on every successful fetch. The
 *  admin debug endpoint (/api/admin/vicidial/debug) reads this so we
 *  can iterate on regex without re-deploying. Cleared after 5 min so
 *  stale HTML can't leak through if the scraper stops working. */
let lastRawHtml: string | null = null
let lastRawAt = 0

/** Admin-only debug accessor — returns the raw HTML from the last
 *  successful fetch, or null when none has happened in the last
 *  5 minutes. Never call from non-admin code paths. */
export function getLastRawVicidialHtml(): {
  html: string
  fetchedAt: string
} | null {
  if (!lastRawHtml) return null
  if (Date.now() - lastRawAt > 5 * 60_000) return null
  return {
    html: lastRawHtml,
    fetchedAt: new Date(lastRawAt).toISOString(),
  }
}

export async function fetchVicidialStats(): Promise<VicidialStatsResult> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }
  // De-dupe parallel callers — a frontend page poll + an admin page
  // poll arriving in the same millisecond both share one fetch.
  if (inFlight) return inFlight
  inFlight = doFetch()
    .then((value) => {
      cached = { value, at: Date.now() }
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function doFetch(): Promise<VicidialStatsResult> {
  const fetchedAt = new Date().toISOString()
  try {
    const username = (await getSecretByName('Vicidial Admin Username')).trim()
    const password = (await getSecretByName('Vicidial Admin Password')).trim()
    if (!username || !password) {
      return {
        ok: false,
        error: 'Vicidial admin credentials missing from vault',
        fetchedAt,
      }
    }

    // Vicidial deployments commonly stack two auth layers:
    //   1. HTTP Basic auth at the web-server level (nginx/Apache
    //      wrapping the entire /vicidial/* path). Returns 401 if
    //      the Authorization header is missing — that's the symptom
    //      we hit on the first run.
    //   2. Vicidial's own form login that sets VD_login + VD_pass
    //      cookies (plaintext password in the cookie, yes, that's
    //      their design).
    //
    // We send BOTH credentials on the same request so the helper
    // works regardless of which (or both) layers are configured.
    // Same username/password are reused across the two — common
    // BPO setup.
    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64')
    const cookieHeader = `VD_login=${encodeURIComponent(username)}; VD_pass=${encodeURIComponent(password)}`

    const res = await fetch(`${VICIDIAL_BASE}/admin.php`, {
      headers: {
        'User-Agent': USER_AGENT,
        Authorization: `Basic ${basicAuth}`,
        Cookie: cookieHeader,
        // Vicidial returns the login form (not the dashboard) when
        // it doesn't see the right cookies — but we still want the
        // body to inspect for parser errors.
        Accept: 'text/html',
      },
      redirect: 'follow',
    })

    if (!res.ok) {
      return {
        ok: false,
        error: `Vicidial returned HTTP ${res.status}`,
        fetchedAt,
      }
    }

    const html = await res.text()
    // Cache the raw HTML on a side channel so the admin debug
    // endpoint can dump it without re-fetching. Pure read; never
    // exposed to non-admin callers.
    lastRawHtml = html
    lastRawAt = Date.now()

    // Detect the "login form" response — Vicidial returns 200 with a
    // login HTML body when auth fails. The form has VD_login as an
    // input name; the dashboard never does.
    if (
      html.includes('name="VD_login"') &&
      html.includes('name="VD_pass"') &&
      !html.includes('System Summary')
    ) {
      return {
        ok: false,
        error:
          'Vicidial returned the login form — credentials may be incorrect or Render IP not whitelisted',
        fetchedAt,
      }
    }

    const stats = parseAdminHtml(html)
    return { ok: true, stats, fetchedAt }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown fetch error',
      fetchedAt,
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  HTML parsing                                                              */
/* -------------------------------------------------------------------------- */

/** Pull a single integer that follows a given label. Tolerates any
 *  HTML tags between the label and the number — Vicidial wraps cards
 *  in nested divs/spans/font tags depending on the version.
 *
 *  Multi-strategy because Vicidial 2.14 stat cards lay the LABEL on
 *  top and the NUMBER below (sometimes with the number in a separate
 *  table cell, sometimes via a <br>+<font size="6">):
 *    1. Number AFTER label, within 800 chars
 *    2. Number BEFORE label, within 400 chars (rare card variant)
 *  Window widened from the initial 400 → 800 because the top
 *  cards have icon images + nested fonts before the digit.
 */
function extractNumberAfter(html: string, label: string): number | null {
  const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Strategy 1: forward search.
  const fwd = new RegExp(`${labelEsc}[\\s\\S]{0,800}?>\\s*(\\d+)\\s*<`, 'i')
  const m1 = html.match(fwd)
  if (m1) {
    const n = Number(m1[1])
    if (Number.isFinite(n)) return n
  }
  // Strategy 2: backward search — for card layouts where the
  // number comes first. Smaller window so we don't pull a number
  // from an unrelated section above.
  const back = new RegExp(`>\\s*(\\d+)\\s*<[\\s\\S]{0,400}?${labelEsc}`, 'i')
  const m2 = html.match(back)
  if (m2) {
    const n = Number(m2[1])
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Find a table row by label (e.g. "Users:") and pull the three
 *  consecutive `<td>` cells after it (Active / Inactive / Total).
 *
 *  Targets `<td>...</td>` cells explicitly rather than a generic
 *  `>...<` match. The earlier generic-tag approach captured the
 *  EMPTY whitespace between `</td><td>` boundaries (non-greedy
 *  matched zero chars first), which made every row look like 0.
 *  Now we anchor on actual cell boundaries and let cellToNumber
 *  handle digits / &nbsp; / nested font tags. */
function extractSummaryRow(html: string, label: string): SummaryRow {
  const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `${labelEsc}[\\s\\S]*?<td[^>]*>([\\s\\S]{0,200}?)</td>[\\s\\S]*?<td[^>]*>([\\s\\S]{0,200}?)</td>[\\s\\S]*?<td[^>]*>([\\s\\S]{0,200}?)</td>`,
    'i',
  )
  const m = html.match(re)
  if (!m) return { active: null, inactive: null, total: null }
  return {
    active: cellToNumber(m[1]),
    inactive: cellToNumber(m[2]),
    total: cellToNumber(m[3]),
  }
}

/** Convert a captured cell's raw inner HTML/text into a number.
 *  - "<digit run>" → that digit
 *  - "&nbsp;" / whitespace-only → 0 (Vicidial visually renders 0
 *    as blank in some columns, especially Inactive)
 *  - Mixed content with a digit run after tag-strip → that digit
 *  - Anything else (unexpected markup) → null so the UI shows "—"
 *    instead of misreporting. */
function cellToNumber(raw: string): number | null {
  // Strip nested tags first, then normalize whitespace + &nbsp;.
  const stripped = raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, '')
    .trim()
  if (stripped === '') return 0
  if (/^\d+$/.test(stripped)) return Number(stripped)
  return null
}

/** Pull "Total Stats for X" — the 4-column row beneath the header.
 *  Reverted to generic `>...<` matching (worked before the <td>
 *  switch). The total-stats row in Vicidial 2.14 is NOT wrapped in
 *  <td> cells — likely styled <font> blocks instead. The summary
 *  table IS <td>-based, so the two parsers diverge intentionally.
 *
 *  Yesterday's first cell sometimes renders as "X / Y" (counted /
 *  billable). We strip non-digit chars and take the first integer
 *  from that cell. */
function extractTotalStats(
  html: string,
  headerLabel: string,
): TotalStatsRow {
  const headerEsc = headerLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `${headerEsc}[\\s\\S]{0,1500}?>\\s*([\\d/\\s]+)\\s*<[\\s\\S]{0,200}?>\\s*(\\d+)\\s*<[\\s\\S]{0,200}?>\\s*(\\d+)\\s*<[\\s\\S]{0,200}?>\\s*(\\d+)\\s*<`,
    'i',
  )
  const m = html.match(re)
  if (!m) {
    return {
      totalCalls: null,
      inboundCalls: null,
      outboundCalls: null,
      maxAgents: null,
    }
  }
  // First cell may be "53191 / 52918" — take the first integer.
  const firstNum = m[1].trim().split(/[^\d]/).filter(Boolean)[0]
  return {
    totalCalls: firstNum ? Number(firstNum) : null,
    inboundCalls: Number(m[2]) || null,
    outboundCalls: Number(m[3]) || null,
    maxAgents: Number(m[4]) || null,
  }
}

function parseAdminHtml(rawHtml: string): VicidialStats {
  // Normalize the HTML before any regex work:
  //   - Replace &nbsp; with a regular space. Vicidial uses &nbsp;
  //     between words in card titles to prevent line breaks
  //     ("Agents&nbsp;Logged&nbsp;In"), which made our literal-
  //     space label matches fail on the first two top cards.
  //   - Collapse runs of whitespace so labels match regardless of
  //     extra HTML formatting.
  const html = rawHtml
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')

  return {
    agentsLoggedIn: extractNumberAfter(html, 'Agents Logged In'),
    agentsInCalls: extractNumberAfter(html, 'Agents In Calls'),
    activeCalls: extractNumberAfter(html, 'Active Calls'),
    callsRinging: extractNumberAfter(html, 'Calls Ringing'),
    systemSummary: {
      users: extractSummaryRow(html, 'Users:'),
      campaigns: extractSummaryRow(html, 'Campaigns:'),
      lists: extractSummaryRow(html, 'Lists:'),
      inGroups: extractSummaryRow(html, 'In-Groups:'),
      dids: extractSummaryRow(html, 'DIDs:'),
    },
    today: extractTotalStats(html, 'Total Stats for Today'),
    yesterday: extractTotalStats(html, 'Total Stats for Yesterday'),
  }
}
