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

    // ADD=0A&status=display_all is the "show all users" full
    // listing — confirmed by inspecting the Vicidial DOM via
    // Chrome DevTools. ADD=2 only returns a truncated listing
    // under the New User form.
    const res = await fetch(
      `${VICIDIAL_BASE}/admin.php?ADD=0A&status=display_all`,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Authorization: `Basic ${basicAuth}`,
          Cookie: cookieHeader,
          Accept: 'text/html',
        },
        redirect: 'follow',
      },
    )

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
      // Surface diagnostic info directly in the error so Alex can
      // see what's wrong without another debug-endpoint round-trip.
      const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i)
      const title = titleMatch ? titleMatch[1].trim() : '(no title)'
      const recordsListCount = (html.match(/records_list_[xy]/gi) || []).length
      const add3UserCount = (html.match(/ADD=3&(?:amp;)?user=/gi) || []).length
      const fontSize1Count = (
        html.match(/<font[^>]*size=['"]?1['"]?[^>]*>/gi) || []
      ).length
      // Bonus: capture the first row's raw HTML so I can see the
      // actual markup if regex still fails.
      const firstRowMatch = html.match(
        /<tr[^>]*class=['"][^'"]*records_list_[xy][^'"]*['"][^>]*>([\s\S]*?)<\/tr>/i,
      )
      const firstRowSnippet = firstRowMatch
        ? firstRowMatch[0].slice(0, 400).replace(/\s+/g, ' ')
        : '(no row matched)'
      return {
        ok: false,
        error: `Parsed 0 users. Title: "${title}". Body: ${html.length}b. records_list_:${recordsListCount}. ADD=3&user=:${add3UserCount}. <font size=1>:${fontSize1Count}. First row: ${firstRowSnippet}`,
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
 * Per the DevTools inspection (2026-06-05), Vicidial 2.14 wraps
 * each user row as:
 *
 *   <tr class="records_list_x">
 *     <td onclick="...ADD=3&user=850005">
 *       <a href="/vicidial/admin.php?ADD=3&user=850005">850005</a>
 *     </td>
 *     <td onclick="..."><font size="1">ALLIYAH</font></td>
 *     <td onclick="..."><font size="1">1</font></td>
 *     <td onclick="..."><font size="1">Agents</font></td>
 *     <td onclick="..."><font size="1">Y</font></td>
 *     ...
 *   </tr>
 *
 * Anchor on the row class (cleanest — stable across versions),
 * pull the user_id from the ADD=3&user=N onclick handler, then
 * extract the next 4 `<font size="1">VALUE</font>` cells in
 * order: full_name, user_level, user_group, active.
 */
function parseUsersHtml(rawHtml: string): VicidialUser[] {
  const html = rawHtml.replace(/&nbsp;/gi, ' ')

  // Capture each row by class. records_list_x and records_list_y
  // are the two alternating row classes in Vicidial's striped
  // table — we match both. Allow other classes alongside (Vicidial
  // sometimes emits e.g. class="records_list_x other_modifier").
  const rowRe =
    /<tr[^>]*class=['"][^'"]*records_list_[xy][^'"]*['"][^>]*>([\s\S]*?)<\/tr>/gi

  const users: VicidialUser[] = []
  let m
  while ((m = rowRe.exec(html))) {
    const rowHtml = m[1]

    // Pull the user_id from the first ADD=3&user=N reference in
    // the row (it appears in both the onclick handler and the <a>
    // href). Tolerate the HTML-escaped `&amp;` form — DevTools
    // shows `&` but the wire response uses `&amp;`.
    const userIdMatch = rowHtml.match(
      /ADD=3&(?:amp;)?user=([A-Za-z0-9_-]+)/i,
    )
    if (!userIdMatch) continue
    const userId = userIdMatch[1].trim()

    // Extract every <font size=1>VALUE in row order.
    //
    // Critical: Vicidial 2.14 emits UNCLOSED <font> tags — the
    // value runs until the next < (either </a> for the first
    // cell or </td> for the rest). The diagnostic row dump
    // showed `<font size=1>Admin</td>` with no </font>. So we
    // capture [^<]* (stop at the next tag) instead of requiring
    // a closing </font>.
    //
    // Also: the FIRST <font size=1> wraps the user_id itself
    // (`<font size=1 color=black>6666</a>`). We already pulled
    // the user_id from the ADD=3 anchor above, so we take 5
    // font values then drop the first one.
    const fontRe = /<font[^>]*size=['"]?1['"]?[^>]*>([^<]*)/gi
    const values: string[] = []
    let fm
    while ((fm = fontRe.exec(rowHtml)) && values.length < 5) {
      values.push(cellText(fm[1]))
    }
    if (values.length < 5) continue

    const [, fullName, levelStr, group, activeFlag] = values
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
