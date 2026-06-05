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

/** Parse the 4 top stat-card numbers in one pass.
 *
 *  Per the debug-endpoint HTML inspection (2026-06-05), Vicidial
 *  2.14 lays out the cards as a 2-row table:
 *    Row 1: 4 `<font size:11>LABEL</font>` cells (the titles)
 *    Row 2: 4 `<font size:18>NUMBER</font>` cells (the values)
 *  Numbers correspond to labels by POSITION (1st label → 1st
 *  number etc.) — NOT proximity. The per-label regex approach was
 *  wrong; we need to grab all four numbers in order and assign by
 *  index. The `font-size:18` selector is unique to the big stat
 *  numbers (labels use size:11), so it's a precise anchor.
 */
function extractTopCardNumbers(html: string): {
  agentsLoggedIn: number | null
  agentsInCalls: number | null
  activeCalls: number | null
  callsRinging: number | null
} {
  const pattern = /<font[^>]*font-size:\s*18[^>]*>\s*(\d+)\s*<\/font>/gi
  const nums: number[] = []
  let m
  while ((m = pattern.exec(html)) && nums.length < 4) {
    nums.push(Number(m[1]))
  }
  return {
    agentsLoggedIn: nums[0] ?? null,
    agentsInCalls: nums[1] ?? null,
    activeCalls: nums[2] ?? null,
    callsRinging: nums[3] ?? null,
  }
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

/** Pull "Total Stats for X" — the 4-column data row beneath the
 *  header.
 *
 *  Per the debug-endpoint HTML inspection (2026-06-05), Vicidial
 *  2.14's totals table structure is:
 *    <tr>HEADER LABEL "Total Stats for Today:"  + view-max link</tr>
 *    <tr bgcolor=black>4 column-header <td>s with TEXT (Total Calls
 *                       / Inbound / Outbound / Maximum Agents)</tr>
 *    <tr bgcolor='#B9CBFD'>4 data <td>s with the actual numbers</tr>
 *
 *  Strategy: after the header label, collect every <td> in the
 *  section, then filter to cells whose stripped content is digit-
 *  only (or "X / Y" for yesterday). The text-header cells get
 *  filtered out automatically — they contain words like "Total
 *  Calls". First 4 digit cells = our 4 stats by position.
 *
 *  Section boundary: next "Total Stats for" header OR </table>,
 *  whichever comes first — bounds the search so Yesterday's
 *  parsing doesn't pull from a totally unrelated section if the
 *  page layout changes. */
function extractTotalStats(
  html: string,
  headerLabel: string,
): TotalStatsRow {
  const headerIdx = html.indexOf(headerLabel)
  if (headerIdx === -1) {
    return {
      totalCalls: null,
      inboundCalls: null,
      outboundCalls: null,
      maxAgents: null,
    }
  }
  // Find the end of this section: next "Total Stats for" (the
  // Yesterday header for the Today parser, or end-of-table for
  // Yesterday). Cap at 5000 chars as a safety stop.
  const afterHeader = html.slice(
    headerIdx + headerLabel.length,
    headerIdx + 5000,
  )
  const nextHeaderIdx = afterHeader.indexOf('Total Stats for')
  const tableEndIdx = afterHeader.search(/<\/table>/i)
  const boundaries = [nextHeaderIdx, tableEndIdx].filter((i) => i !== -1)
  const sectionEnd = boundaries.length > 0 ? Math.min(...boundaries) : 5000
  const section = afterHeader.slice(0, sectionEnd)

  // Collect every <td>...</td> in the section.
  const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi
  const digitCells: string[] = []
  let m
  while ((m = cellPattern.exec(section))) {
    const stripped = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, '')
      .trim()
    // Accept digit-only ("29") OR digit/slash ("53191 / 52918").
    // Empty/text cells are skipped — that's how we filter out the
    // text column-header row.
    if (stripped && /^[\d\s/]+$/.test(stripped)) {
      digitCells.push(stripped)
    }
    if (digitCells.length >= 4) break
  }

  if (digitCells.length < 4) {
    return {
      totalCalls: digitCells[0] ? parseFirstNum(digitCells[0]) : null,
      inboundCalls: digitCells[1] ? parseFirstNum(digitCells[1]) : null,
      outboundCalls: digitCells[2] ? parseFirstNum(digitCells[2]) : null,
      maxAgents: digitCells[3] ? parseFirstNum(digitCells[3]) : null,
    }
  }

  return {
    totalCalls: parseFirstNum(digitCells[0]),
    inboundCalls: parseFirstNum(digitCells[1]),
    outboundCalls: parseFirstNum(digitCells[2]),
    maxAgents: parseFirstNum(digitCells[3]),
  }
}

/** Extract the first integer from a string. Handles plain "29",
 *  whitespace-padded " 29 ", and "X / Y" (yesterday's split
 *  count). Returns 0 for empty input so a legitimately-zero cell
 *  doesn't show up as null. */
function parseFirstNum(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return 0
  const first = trimmed.split(/[^\d]/).filter(Boolean)[0]
  if (!first) return null
  const n = Number(first)
  return Number.isFinite(n) ? n : null
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

  const topCards = extractTopCardNumbers(html)
  return {
    agentsLoggedIn: topCards.agentsLoggedIn,
    agentsInCalls: topCards.agentsInCalls,
    activeCalls: topCards.activeCalls,
    callsRinging: topCards.callsRinging,
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
