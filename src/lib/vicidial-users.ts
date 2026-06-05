/**
 * Vicidial Users list scraper.
 *
 * Mirrors what Alex sees on /vicidial/admin.php?ADD=8 — the user
 * listing showing every account in the call-center system. Each
 * row carries user_id (the 850xxx codes), full name, user_level,
 * user_group, and active flag.
 *
 * Why this matters for the Hub: today the Team #1 admin surface
 * lets Alex assign a free-form "call center number" string to
 * each team_member. There's no link between that string and an
 * actual Vicidial user_id, so a typo or stale assignment is
 * silently invisible. Surfacing the Vicidial Users list in
 * /agents gives Alex/Ethan a way to cross-check at a glance.
 *
 * Auth: same VD_login/VD_pass cookies + HTTP Basic Auth that
 * vicidial-stats uses. Credentials read from vault.
 *
 * Cache: 5 minutes. Users don't change often (admin manually
 * adds/disables), so a longer cache than the live-report dashboard
 * is fine and keeps load off Vicidial.
 *
 * Knowledge-base reference: docs/vicidial-knowledge-base.md
 * (sections 2.2 and 3 — Users admin section, vicidial_users
 * table). The non_agent_api `users_list` action would be a
 * cleaner alternative when we're ready to swap — for now we
 * reuse the proven admin.php scraping pattern.
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

    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64')
    const cookieHeader = `VD_login=${encodeURIComponent(username)}; VD_pass=${encodeURIComponent(password)}`

    // ADD=8 is the Show Users page in admin.php — same UI Alex
    // navigates to via the sidebar.
    const res = await fetch(`${VICIDIAL_BASE}/admin.php?ADD=8`, {
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
      !html.includes('USER LISTING')
    ) {
      return {
        ok: false,
        error:
          'Vicidial returned the login form — credentials may be incorrect or Render IP not whitelisted',
        fetchedAt,
      }
    }

    const users = parseUsersHtml(html)
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
 * Parse every user row from the Users listing table.
 *
 * Vicidial's listing wraps each user in a `<tr>` whose first cell
 * is `<a href="admin.php?ADD=9&...">USER_ID</a>`. We anchor on
 * that pattern and pull the surrounding cells.
 *
 * Robustness notes:
 *  - The listing's column order is stable in 2.14 (USER ID, FULL
 *    NAME, LEVEL, GROUP, ACTIVE, MODIFY, STATS, STATUS, TIME).
 *  - Empty / hidden FULL NAME cells render as "XXXXXX" — we pass
 *    through as-is so admin can spot the redacted rows.
 *  - The header row has bold cells (`<b>USER ID</b>`) which the
 *    user-row pattern won't match, so we naturally skip it.
 */
function parseUsersHtml(rawHtml: string): VicidialUser[] {
  const html = rawHtml.replace(/&nbsp;/gi, ' ')
  // Each user row starts with an anchor pointing at the per-user
  // edit URL: <a href="admin.php?ADD=9&...">user_id</a>
  // Captured groups:
  //   1: user_id (e.g. "850001")
  //   2: full name (or "XXXXXX")
  //   3: user_level (1-9)
  //   4: user_group (e.g. "Agents", "ADMIN")
  //   5: active flag (single letter, usually "Y")
  const rowRe =
    /<a[^>]*href=['"][^'"]*ADD=9[^'"]*['"][^>]*>([A-Za-z0-9_-]+)<\/a>[\s\S]{0,300}?<td[^>]*>\s*([^<]+?)\s*<\/td>[\s\S]{0,300}?<td[^>]*>\s*(\d+)\s*<\/td>[\s\S]{0,300}?<td[^>]*>\s*([A-Za-z0-9_ -]+?)\s*<\/td>[\s\S]{0,300}?<td[^>]*>\s*([YN])\s*<\/td>/gi

  const users: VicidialUser[] = []
  let m
  while ((m = rowRe.exec(html))) {
    const [, userId, fullName, levelStr, group, activeFlag] = m
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
