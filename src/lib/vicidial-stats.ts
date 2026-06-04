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
 *  in nested divs/spans/font tags depending on the version. */
function extractNumberAfter(html: string, label: string): number | null {
  const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Look for the label followed by tags, optional whitespace, then
  // a digit run. Non-greedy match on the in-between HTML so we don't
  // skip past the actual number into the next card.
  const re = new RegExp(`${labelEsc}[\\s\\S]{0,400}?>\\s*(\\d+)\\s*<`, 'i')
  const m = html.match(re)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** Find a table row by label (e.g. "Users:") and pull the three
 *  consecutive integers from it (Active / Inactive / Total). */
function extractSummaryRow(html: string, label: string): SummaryRow {
  const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match the row label, then up to three numbers each wrapped in
  // their own <td>. ~600 chars of tolerance is plenty for the row
  // height; longer than that means we've jumped to the next row.
  const re = new RegExp(
    `${labelEsc}[\\s\\S]{0,600}?>\\s*(\\d+)\\s*<[\\s\\S]{0,200}?>\\s*(\\d+)\\s*<[\\s\\S]{0,200}?>\\s*(\\d+)\\s*<`,
    'i',
  )
  const m = html.match(re)
  if (!m) return { active: null, inactive: null, total: null }
  return {
    active: Number(m[1]) || null,
    inactive: Number(m[2]) || null,
    total: Number(m[3]) || null,
  }
}

/** Pull "Total Stats for X" — the 4-column row beneath the header.
 *  Yesterday's row sometimes shows totalCalls as "X / Y" (counted /
 *  billable). We strip out anything after the first number for that
 *  cell. */
function extractTotalStats(
  html: string,
  headerLabel: string,
): TotalStatsRow {
  const headerEsc = headerLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // From the header, search forward up to 1500 chars (the row sits
  // right under the header; anything farther than that means we've
  // gone past it). Pull four consecutive numeric cells.
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

function parseAdminHtml(html: string): VicidialStats {
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
