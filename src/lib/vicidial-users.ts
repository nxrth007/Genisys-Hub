/**
 * Vicidial Users list — via non_agent_api.php (NOT HTML scraping).
 *
 * Switched away from admin.php?ADD=* scraping after the first
 * round revealed that ADD=2 returns the "New User Addition" form
 * (not the listing) and the actual listing is behind a "show all
 * users" link gated by paging parameters that are version-specific.
 *
 * non_agent_api.php is documented + version-stable + designed for
 * machine consumption. The `users_list` function returns a pipe-
 * delimited body. Standard format per VICIDIAL docs:
 *
 *   SUCCESS: users_list - 30 records returned
 *   user_id|full_name|user_level|user_group|active
 *   850001|MARIA|1|Agents|Y
 *   850002|ALLIYAH|1|Agents|Y
 *   ...
 *
 * Our AdminRoot account is user_level=9, which exceeds the
 * function's documented level 7+ requirement.
 *
 * Why this matters for the Hub: today the Team #1 admin surface
 * lets Alex assign a free-form "call center number" string to each
 * team_member with no link to a real Vicidial user_id. Surfacing
 * the Users list in /agents lets Alex/Ethan cross-check at a
 * glance.
 *
 * Auth: same vault credentials used by vicidial-stats. We pass
 * them as form-encoded user= / pass= parameters per the API
 * convention; HTTP Basic auth header still sent for the outer
 * web-server auth layer.
 *
 * Cache: 5 minutes. Users rarely change.
 *
 * Knowledge-base reference: docs/vicidial-knowledge-base.md
 * sections 3 (vicidial_users table) and 4 (non_agent_api.php).
 */

import { getSecretByName } from './vault-service'

const VICIDIAL_BASE = 'https://expeditusbpo.vicitel.cc/vicidial'
const CACHE_TTL_MS = 5 * 60_000

const USER_AGENT =
  'Mozilla/5.0 (Hub-Scraper) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export type VicidialUsersResult =
  | { ok: true; users: VicidialUser[]; fetchedAt: string }
  | { ok: false; error: string; fetchedAt: string }

export type VicidialUser = {
  /** Login user id — typically the 850xxx codes for Genisys's
   *  BPO partner. This is what the dialer keys agents on. */
  userId: string
  /** Display name. May be redacted to "XXXXXX" in the listing
   *  when the BPO admin has hidden it — we pass through verbatim. */
  fullName: string
  /** 1-9; see knowledge base section 2 for what each level can
   *  do. Most working agents are level 1; supervisors 7-8. */
  userLevel: number | null
  userGroup: string
  /** Y / N from Vicidial. We surface "true" / "false" — admin
   *  UI doesn't need the single-letter convention. */
  active: boolean
}

let cached: { value: VicidialUsersResult; at: number } | null = null
let inFlight: Promise<VicidialUsersResult> | null = null

/** Side-channel raw HTML accessor — admin-only debug. Same
 *  pattern as vicidial-stats. Cleared after 5 min. */
let lastRawHtml: string | null = null
let lastRawAt = 0
export function getLastRawVicidialUsersHtml(): {
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

export async function fetchVicidialUsers(): Promise<VicidialUsersResult> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }
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

async function doFetch(): Promise<VicidialUsersResult> {
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

    // Outer web-server Basic auth still required (same as the
    // dashboard scraper).
    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64')

    // Inner API auth via form-encoded params. We POST instead of
    // GET because this BPO's web-server config strips the
    // `function` query param (first attempt got back
    // "ERROR: NO FUNCTION SPECIFIED" despite the URL containing it
    // — typical when the install has been hardened to require POST
    // for write-capable endpoints). non_agent_api.php's
    // $_REQUEST['function'] reads both POST and GET so this is
    // compatible with installs that don't filter.
    //
    // The `source` parameter is required by non_agent_api.php; any
    // identifier string works. We use "hub" so calls log
    // attribution.
    const requestBody = new URLSearchParams({
      source: 'hub',
      user: username,
      pass: password,
      function: 'users_list',
    })

    const res = await fetch(`${VICIDIAL_BASE}/non_agent_api.php`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Authorization: `Basic ${basicAuth}`,
        Accept: 'text/plain',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: requestBody.toString(),
    })

    if (!res.ok) {
      return {
        ok: false,
        error: `Vicidial API returned HTTP ${res.status}`,
        fetchedAt,
      }
    }

    const body = await res.text()
    lastRawHtml = body
    lastRawAt = Date.now()

    // The API returns plain text. Success body starts with "SUCCESS"
    // and has one user per line. Error responses start with "ERROR".
    const trimmed = body.trim()
    if (trimmed.startsWith('ERROR')) {
      return {
        ok: false,
        error: `Vicidial API error: ${trimmed.slice(0, 200)}`,
        fetchedAt,
      }
    }
    if (!trimmed.includes('|')) {
      // Either an unexpected response or the login form HTML
      // bleeding through. Surface the first 200 chars so the debug
      // endpoint shows what came back.
      return {
        ok: false,
        error: `Unexpected API response: ${trimmed.slice(0, 200)}`,
        fetchedAt,
      }
    }

    const users = parseUsersResponse(body)
    return { ok: true, users, fetchedAt }
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

/**
 * Parse the non_agent_api.php `users_list` response body.
 *
 * Format per VICIDIAL docs:
 *   SUCCESS: users_list - 30 records returned
 *   user_id|full_name|user_level|user_group|active
 *   850001|MARIA|1|Agents|Y
 *   ...
 *
 * Some Vicidial builds skip the column-header line and go straight
 * from the SUCCESS banner to data. We tolerate either by detecting
 * any line whose first field looks like a user_id (alphanumeric +
 * underscores / hyphens) AND has 5 pipe-delimited fields.
 *
 * Newer Vicidial builds may include additional trailing columns
 * (status, phone_login, etc.) — we accept any line with AT LEAST
 * 5 fields and just take the first 5.
 */
function parseUsersResponse(body: string): VicidialUser[] {
  const lines = body.split(/\r?\n/)
  const users: VicidialUser[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    // Skip the SUCCESS banner + any "column header" line that
    // doesn't have an actual numeric+digit user_id.
    if (line.startsWith('SUCCESS')) continue
    if (line.startsWith('ERROR')) continue
    if (line.toLowerCase().startsWith('user_id')) continue

    const parts = line.split('|')
    if (parts.length < 5) continue
    const [userId, fullName, levelStr, group, activeFlag] = parts
    // Sanity check — a user_id is non-empty and starts with letter
    // or digit. Skip anything that's clearly not a row.
    if (!userId || !/^[A-Za-z0-9_-]+$/.test(userId)) continue

    const level = Number(levelStr)
    users.push({
      userId: userId.trim(),
      fullName: fullName.trim(),
      userLevel: Number.isFinite(level) ? level : null,
      userGroup: group.trim(),
      active: activeFlag.trim().toUpperCase() === 'Y',
    })
  }
  return users
}
