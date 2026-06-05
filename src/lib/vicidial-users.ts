/**
 * Vicidial Users list — HTML scrape of admin.php?ADD=2.
 *
 * Background: the BPO has restricted non_agent_api.php to a tight
 * whitelist (version, agent_status, add_lead, update_lead,
 * recording_lookup). users_list is blocked. The probe ruled out
 * the API path entirely.
 *
 * BUT: admin.php?ADD=2 returns 117KB of HTML — the "New User
 * Addition" form at the top AND the full Show Users listing below
 * it. Vicidial 2.14 renders both on the same page. We just need
 * to scrape the listing table.
 *
 * Row structure (per Vicidial 2.14 source):
 *   <tr><td><a href='admin.php?ADD=21&user_id=850001'>850001</a></td>
 *       <td>MARIA</td>
 *       <td>1</td>
 *       <td>Agents</td>
 *       <td>Y</td>
 *       <td><a>MODIFY</a></td>
 *       ...
 *   </tr>
 *
 * The per-row anchor uses ADD=21 (modify user). My initial parse
 * looked for ADD=9 which never matched. Fixing that is the whole
 * unlock.
 *
 * Auth: same VD_login/VD_pass cookies + HTTP Basic Auth used by
 * vicidial-stats. Credentials from vault.
 *
 * Cache: 5 minutes — users rarely change.
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
  userId: string
  fullName: string
  userLevel: number | null
  userGroup: string
  active: boolean
}

let cached: { value: VicidialUsersResult; at: number } | null = null
let inFlight: Promise<VicidialUsersResult> | null = null

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
  // Only cache successful results so a transient failure can be
  // retried immediately on the next request.
  if (cached && cached.value.ok && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }
  if (inFlight) return inFlight
  inFlight = doFetch()
    .then((value) => {
      if (value.ok) cached = { value, at: Date.now() }
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

    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64')
    const cookieHeader = `VD_login=${encodeURIComponent(username)}; VD_pass=${encodeURIComponent(password)}`

    // ADD=2 returns BOTH the New User form AND the existing-users
    // listing on one page. 117KB body, confirmed by debug.
    const res = await fetch(`${VICIDIAL_BASE}/admin.php?ADD=2`, {
      headers: {
        'User-Agent': USER_AGENT,
        Authorization: `Basic ${basicAuth}`,
        Cookie: cookieHeader,
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
    lastRawHtml = html
    lastRawAt = Date.now()

    if (
      html.includes('name="VD_login"') &&
      html.includes('name="VD_pass"') &&
      !html.includes('ADMINISTRATION')
    ) {
      return {
        ok: false,
        error:
          'Vicidial returned the login form — credentials may be incorrect or Render IP not whitelisted',
        fetchedAt,
      }
    }

    const users = parseUsersHtml(html)
    if (users.length === 0) {
      return {
        ok: false,
        error:
          'Parsed 0 users from Vicidial response. Page format may have changed — check /api/admin/vicidial/debug for diagnostic slices.',
        fetchedAt,
      }
    }
    return { ok: true, users, fetchedAt }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown fetch error',
      fetchedAt,
    }
  }
}

/**
 * Parse every user row from the listing.
 *
 * Per Vicidial 2.14 source the per-user anchor uses ADD=21 (modify
 * user). After the anchor we expect 4 subsequent <td>...</td>
 * cells in column order: full name, user_level, user_group,
 * active flag. We tolerate any HTML between the anchor and the
 * closing </tr> via a non-greedy match.
 */
function parseUsersHtml(rawHtml: string): VicidialUser[] {
  const html = rawHtml.replace(/&nbsp;/gi, ' ')
  const rowRe =
    /<a[^>]*href=['"][^'"]*ADD=21[^'"]*['"][^>]*>\s*([A-Za-z0-9_-]+)\s*<\/a>([\s\S]{0,1500}?)<\/tr>/gi

  const users: VicidialUser[] = []
  let m
  while ((m = rowRe.exec(html))) {
    const userId = m[1].trim()
    const rowTail = m[2]

    // Pull the next 4 <td>...</td> cells from the row tail.
    const cells: string[] = []
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi
    let cm
    while ((cm = cellRe.exec(rowTail)) && cells.length < 4) {
      cells.push(cellText(cm[1]))
    }
    if (cells.length < 4) continue

    const [fullName, levelStr, group, activeFlag] = cells
    const level = Number(levelStr)
    users.push({
      userId,
      fullName,
      userLevel: Number.isFinite(level) ? level : null,
      userGroup: group,
      active: activeFlag.toUpperCase().trim().startsWith('Y'),
    })
  }
  return users
}

/** Strip nested HTML tags + collapse whitespace from cell content. */
function cellText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
