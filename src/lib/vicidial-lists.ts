/**
 * Vicidial Lists + Leads — HTML scrape of the admin Lists section.
 *
 * Backs the Hub's "Leads" section (/leads): mirror of Vicidial's
 * Lists → Show Lists (admin.php?ADD=100), the per-list called-count
 * stats, and the per-list lead listing (admin_search_lead.php).
 * The BPO's non_agent_api whitelist doesn't include any list/lead
 * read functions, so scraping admin pages is the only road — same
 * approach as vicidial-stats + vicidial-users.
 *
 * Hard-won lessons from the vicidial-users build, baked in here:
 *   - Wire HTML differs from DevTools: hrefs ship `&amp;`, and
 *     Vicidial emits UNCLOSED <font> tags. Never anchor a capture
 *     on a closing </font>; strip tags from full <td> captures
 *     instead.
 *   - Self-discover URLs from the page where possible (e.g. the
 *     "show list leads counts" link) instead of guessing params.
 *   - When a parse returns nothing, the error string carries page
 *     title / body length / marker counts / a row snippet so the
 *     next iteration needs zero extra round-trips.
 *
 * Auth: HTTP Basic + VD_login/VD_pass cookies from vault creds,
 * identical to vicidial-users. Render's IP is whitelisted at
 * vicitel; local dev machines are not.
 */

import { getSecretByName } from './vault-service'

const VICIDIAL_BASE = 'https://expeditusbpo.vicitel.cc/vicidial'

const USER_AGENT =
  'Mozilla/5.0 (Hub-Scraper) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const LISTS_CACHE_TTL_MS = 5 * 60_000
const STATS_CACHE_TTL_MS = 5 * 60_000
const LEADS_CACHE_TTL_MS = 10 * 60_000

/* -------------------------------------------------------------------------- */
/*  Shared fetch core                                                          */
/* -------------------------------------------------------------------------- */

async function vicidialCredentials(): Promise<{
  basicAuth: string
  cookieHeader: string
} | null> {
  const username = (await getSecretByName('Vicidial Admin Username')).trim()
  const password = (await getSecretByName('Vicidial Admin Password')).trim()
  if (!username || !password) return null
  return {
    basicAuth: Buffer.from(`${username}:${password}`).toString('base64'),
    cookieHeader: `VD_login=${encodeURIComponent(username)}; VD_pass=${encodeURIComponent(password)}`,
  }
}

/**
 * Fetch a path relative to the /vicidial/ base with admin auth.
 * `path` examples: "admin.php?ADD=100", "admin_search_lead.php".
 * Exported for the probe endpoint so iteration on new pages doesn't
 * need a second auth implementation.
 */
export async function vicidialAdminFetch(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: string },
): Promise<
  | { ok: true; html: string; status: number; finalUrl: string }
  | { ok: false; error: string }
> {
  const creds = await vicidialCredentials()
  if (!creds) {
    return { ok: false, error: 'Vicidial admin credentials missing from vault' }
  }
  const url = `${VICIDIAL_BASE}/${path.replace(/^\/+/, '')}`
  try {
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Authorization: `Basic ${creds.basicAuth}`,
        Cookie: creds.cookieHeader,
        Accept: 'text/html',
        ...(init?.method === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      body: init?.method === 'POST' ? init.body : undefined,
      redirect: 'follow',
    })
    if (!res.ok) {
      return { ok: false, error: `Vicidial returned HTTP ${res.status}` }
    }
    const html = await res.text()
    if (
      html.includes('name="VD_login"') &&
      html.includes('name="VD_pass"') &&
      !html.includes('ADMINISTRATION')
    ) {
      return {
        ok: false,
        error:
          'Vicidial returned the login form — credentials may be incorrect or Render IP not whitelisted',
      }
    }
    return { ok: true, html, status: res.status, finalUrl: res.url }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown fetch error',
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Generic row/cell helpers                                                   */
/* -------------------------------------------------------------------------- */

/** Strip tags + entities + collapse whitespace from raw cell HTML.
 *  Tolerates Vicidial's unclosed <font> tags because we never rely
 *  on closing tags — everything inside the <td> capture gets
 *  flattened to text. */
function cellText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** All <td> cell texts for a row's inner HTML. Vicidial DOES close
 *  its <td>s (confirmed in the users-page wire dump) even though it
 *  leaves <font> open. */
function rowCells(rowHtml: string): string[] {
  const cells: string[] = []
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi
  let m
  while ((m = re.exec(rowHtml))) cells.push(cellText(m[1]))
  return cells
}

/** Every striped data row (records_list_x / _y) on a page. */
function dataRows(html: string): string[] {
  const rows: string[] = []
  const re =
    /<tr[^>]*class=['"][^'"]*records_list_[xy][^'"]*['"][^>]*>([\s\S]*?)<\/tr>/gi
  let m
  while ((m = re.exec(html))) rows.push(m[1])
  return rows
}

/** Standard rich diagnostic suffix for parse-zero errors. */
function diagnostics(html: string): string {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : '(no title)'
  const rowCount = (html.match(/records_list_[xy]/gi) || []).length
  const firstRow = dataRows(html)[0]
  const snippet = firstRow
    ? firstRow.slice(0, 350).replace(/\s+/g, ' ')
    : '(no data rows)'
  return `Title: "${title}". Body: ${html.length}b. records_list_:${rowCount}. First row: ${snippet}`
}

function toIntOrNull(s: string | undefined): number | null {
  if (!s) return null
  const n = Number(s.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) && s.replace(/[^0-9]/g, '').length > 0 ? n : null
}

/* -------------------------------------------------------------------------- */
/*  Show Lists (admin.php?ADD=100)                                             */
/* -------------------------------------------------------------------------- */

export type VicidialList = {
  listId: string
  name: string
  description: string
  /** Null when the listing page hides counts behind the "show list
   *  leads counts" link and the count fetch fell through. */
  leadsCount: number | null
  active: boolean
  lastCallDate: string | null
  campaign: string
}

export type VicidialListsResult =
  | { ok: true; lists: VicidialList[]; fetchedAt: string }
  | { ok: false; error: string; fetchedAt: string }

let listsCache: { value: VicidialListsResult; at: number } | null = null

export async function fetchVicidialLists(): Promise<VicidialListsResult> {
  const now = Date.now()
  if (listsCache && listsCache.value.ok && now - listsCache.at < LISTS_CACHE_TTL_MS) {
    return listsCache.value
  }
  const value = await doFetchLists()
  if (value.ok) listsCache = { value, at: Date.now() }
  return value
}

async function doFetchLists(): Promise<VicidialListsResult> {
  const fetchedAt = new Date().toISOString()
  const first = await vicidialAdminFetch('admin.php?ADD=100')
  if (!first.ok) return { ok: false, error: first.error, fetchedAt }

  // The listing hides per-list lead counts behind a "show list
  // leads counts" link (counts are expensive server-side, so
  // Vicidial makes them opt-in). Verified live 2026-06-11: the
  // link is admin.php?ADD=100&rank=999 and its anchor text is
  // wrapped in a <font> tag — the discovery regex must allow one
  // intervening tag between the href and the text. Self-discover
  // first (resilient to upgrades), fall back to the known param.
  let html = first.html
  const countsLink = first.html.match(
    /href=['"]?([^'">\s]+)['"]?[^>]*>(?:\s*<font[^>]*>)?\s*show list leads counts/i,
  )
  const countsHref = countsLink
    ? countsLink[1]
        .replace(/&amp;/gi, '&')
        .replace(/^https?:\/\/[^/]+/i, '')
        .replace(/^\/vicidial\//i, '')
    : 'admin.php?ADD=100&rank=999'
  const withCounts = await vicidialAdminFetch(countsHref)
  if (withCounts.ok) html = withCounts.html

  const lists: VicidialList[] = []
  for (const row of dataRows(html)) {
    // list_id appears in the row's modify/detail links regardless of
    // cell layout. Tolerate &amp; in wire HTML.
    const idMatch = row.match(/list_id=(\d+)/i)
    if (!idMatch) continue
    const listId = idMatch[1]

    const cells = rowCells(row)
    if (cells.length < 7) continue
    // Layout per the live screenshot: LIST ID | NAME | DESCRIPTION |
    // RTIME | LEADS COUNT | CALL TIME | ACTIVE | LAST CALL DATE |
    // CAMPAIGN | MODIFY. Counts show "X" until the counts variant
    // of the page is fetched.
    const [, name, description, , leadsCountRaw, , activeRaw, lastCallRaw, campaign] =
      cells
    lists.push({
      listId,
      name: name ?? '',
      description: description ?? '',
      leadsCount: toIntOrNull(leadsCountRaw),
      active: (activeRaw ?? '').toUpperCase().startsWith('Y'),
      lastCallDate: lastCallRaw?.trim() || null,
      campaign: campaign ?? '',
    })
  }

  if (lists.length === 0) {
    return {
      ok: false,
      error: `Parsed 0 lists from admin.php?ADD=100. ${diagnostics(html)}`,
      fetchedAt,
    }
  }
  return { ok: true, lists, fetchedAt }
}

/* -------------------------------------------------------------------------- */
/*  Per-list stats (called counts within this list)                            */
/* -------------------------------------------------------------------------- */

export type VicidialListStatusRow = {
  status: string
  statusName: string
  subtotal: number
}

export type VicidialListStatsResult =
  | {
      ok: true
      listId: string
      /** Grand total leads in the list (TOTAL row of the called-
       *  counts table — matches the blue number Alex circled). */
      total: number | null
      statuses: VicidialListStatusRow[]
      fetchedAt: string
    }
  | { ok: false; error: string; fetchedAt: string }

const statsCache = new Map<string, { value: VicidialListStatsResult; at: number }>()

export async function fetchVicidialListStats(
  listId: string,
): Promise<VicidialListStatsResult> {
  const cached = statsCache.get(listId)
  if (cached && cached.value.ok && Date.now() - cached.at < STATS_CACHE_TTL_MS) {
    return cached.value
  }
  const value = await doFetchListStats(listId)
  if (value.ok) statsCache.set(listId, { value, at: Date.now() })
  return value
}

async function doFetchListStats(
  listId: string,
): Promise<VicidialListStatsResult> {
  const fetchedAt = new Date().toISOString()
  const id = encodeURIComponent(listId)

  // The called-counts tables live on the Modify List page —
  // verified live 2026-06-11: the listing's row links go to
  // admin.php?ADD=311&list_id=N (NOT ADD=1111 as other builds
  // use), and the plain page already includes "CALLED COUNTS
  // WITHIN THIS LIST" with no stats toggle needed. Alternate
  // shapes kept as marker-checked fallbacks for upgrades.
  const candidates = [
    `admin.php?ADD=311&list_id=${id}`,
    `admin.php?ADD=1111&list_id=${id}&list_stats=1`,
    `admin.php?ADD=1111&list_id=${id}`,
  ]
  let html: string | null = null
  let lastError = 'no fetch attempted'
  for (const path of candidates) {
    const res = await vicidialAdminFetch(path)
    if (!res.ok) {
      lastError = res.error
      continue
    }
    if (/CALLED COUNTS WITHIN THIS LIST/i.test(res.html)) {
      html = res.html
      break
    }
    lastError = `page fetched but missing "CALLED COUNTS WITHIN THIS LIST" marker (${path})`
    // Keep the page anyway as a last resort so diagnostics show it.
    if (html === null) html = res.html
  }
  if (html === null) {
    return { ok: false, error: `List stats fetch failed: ${lastError}`, fetchedAt }
  }

  // Bound the parse to the called-counts section so status-looking
  // rows elsewhere on the page can't pollute the result.
  const sectionStart = html.search(/CALLED COUNTS WITHIN THIS LIST/i)
  const sectionEnd = html.search(/TODAY CALLED COUNTS/i)
  const section =
    sectionStart >= 0
      ? html.slice(sectionStart, sectionEnd > sectionStart ? sectionEnd : undefined)
      : html

  const statuses: VicidialListStatusRow[] = []
  let total: number | null = null

  // Status rows + the TOTAL row aren't striped data rows on this
  // table — walk every <tr> in the section.
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let m
  while ((m = trRe.exec(section))) {
    const cells = rowCells(m[1])
    if (cells.length < 2) continue
    const first = (cells[0] ?? '').trim()
    if (/^TOTAL$/i.test(first) || /^TOTAL$/i.test(cells[1] ?? '')) {
      // Grand total = the last numeric cell on the TOTAL row.
      for (let i = cells.length - 1; i >= 0; i--) {
        const n = toIntOrNull(cells[i])
        if (n !== null) {
          total = n
          break
        }
      }
      continue
    }
    // Status code cell: short uppercase alphanumeric (A, AA, WRNGNO,
    // CBHOLD…). Header rows ("STATUS") excluded by the name check.
    if (!/^[A-Z0-9]{1,6}$/.test(first) || first === 'STATUS') continue
    const subtotal = toIntOrNull(cells[cells.length - 1])
    if (subtotal === null) continue
    statuses.push({
      status: first,
      statusName: cells[1] ?? '',
      subtotal,
    })
  }

  if (statuses.length === 0) {
    return {
      ok: false,
      error: `Parsed 0 status rows for list ${listId}. ${diagnostics(html)}`,
      fetchedAt,
    }
  }
  return { ok: true, listId, total, statuses, fetchedAt }
}

/* -------------------------------------------------------------------------- */
/*  Per-list leads (admin_search_lead.php)                                     */
/* -------------------------------------------------------------------------- */

export type VicidialLead = {
  leadId: string
  status: string
  vendorId: string
  lastAgent: string
  listId: string
  phone: string
  name: string
  city: string
  lastCall: string
}

export type VicidialLeadsResult =
  | {
      ok: true
      listId: string
      /** Vicidial caps search results at 10,000 — when totalParsed
       *  hits that, the list likely has more leads than shown. */
      totalParsed: number
      leads: VicidialLead[]
      fetchedAt: string
    }
  | { ok: false; error: string; fetchedAt: string }

const leadsCache = new Map<string, { value: VicidialLeadsResult; at: number }>()

export async function fetchVicidialListLeads(
  listId: string,
): Promise<VicidialLeadsResult> {
  const cached = leadsCache.get(listId)
  if (cached && cached.value.ok && Date.now() - cached.at < LEADS_CACHE_TTL_MS) {
    return cached.value
  }
  const value = await doFetchListLeads(listId)
  if (value.ok) leadsCache.set(listId, { value, at: Date.now() })
  return value
}

async function doFetchListLeads(listId: string): Promise<VicidialLeadsResult> {
  const fetchedAt = new Date().toISOString()
  const id = encodeURIComponent(listId)

  // Verified live 2026-06-11: a plain GET with just list_id returns
  // the full results page (the blue TOTAL links on the stats page
  // use the same shape, adding called_count= / status= filters).
  // The page is BIG — list 104 returned 10.4MB for its 10k-row cap.
  const res = await vicidialAdminFetch(`admin_search_lead.php?list_id=${id}`)
  if (!res.ok) {
    return { ok: false, error: `Lead search fetch failed: ${res.error}`, fetchedAt }
  }
  const html = res.html

  // CRITICAL (live-verified): unlike every other Vicidial admin
  // listing, lead-search rows have NO records_list_x/y class —
  // they're bgcolor-striped <TR>s inside the table that follows the
  // "RESULTS: N" marker. The page also contains bgcolor'd <tr>s in
  // its embedded color-picker JavaScript, so we anchor the parse
  // strictly after RESULTS: and require a lead_id link per row.
  //
  // Confirmed row shape (cells in CLOSED <FONT> here, unlike the
  // unclosed ones elsewhere — rowCells strips tags either way):
  //   # | LEAD ID(link to admin_modify_lead.php?lead_id=N) | STATUS
  //   | VENDOR ID | LAST AGENT | LIST ID | PHONE | NAME | CITY
  //   | SECURITY | LAST CALL
  const resultsIdx = html.search(/RESULTS:\s*[\d,]+/i)
  if (resultsIdx === -1) {
    return {
      ok: false,
      error: `Lead search page has no "RESULTS:" marker for list ${listId}. ${diagnostics(html)}`,
      fetchedAt,
    }
  }
  const resultsSection = html.slice(resultsIdx)

  const leads: VicidialLead[] = []
  const trRe = /<tr[^>]+bgcolor[^>]*>([\s\S]*?)<\/tr>/gi
  let m
  while ((m = trRe.exec(resultsSection))) {
    const row = m[1]
    const idMatch = row.match(/lead_id=(\d+)/i)
    if (!idMatch) continue
    const cells = rowCells(row)
    if (cells.length < 9) continue
    leads.push({
      leadId: idMatch[1],
      status: cells[2] ?? '',
      vendorId: cells[3] ?? '',
      lastAgent: cells[4] ?? '',
      listId: cells[5] ?? listId,
      phone: cells[6] ?? '',
      name: cells[7] ?? '',
      city: cells[8] ?? '',
      lastCall: cells[cells.length - 1] ?? '',
    })
  }

  if (leads.length === 0) {
    return {
      ok: false,
      error: `Parsed 0 leads for list ${listId}. ${diagnostics(html)}`,
      fetchedAt,
    }
  }
  return { ok: true, listId, totalParsed: leads.length, leads, fetchedAt }
}
