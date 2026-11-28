import { getSecret } from './secrets'

/**
 * Retrieval for the SEO engine when it runs on a provider that has no hosted
 * web tools (MWAPI). Anthropic's `web_search_20260209` / `web_fetch_20260209`
 * do search and page-reading *server-side*; this module does the same work
 * in-process so the research stage keeps its exact shape.
 *
 * Search providers are tried in order and the first configured one that
 * returns hits wins. Every key comes from the Vault by entry name, so adding
 * or rotating a search key needs no deploy:
 *
 *   Brave Search   -> "Brave Search API Key"   (free tier ~2k queries/mo)
 *   Serper.dev     -> "Serper API Key"         (free tier ~2.5k queries)
 *   Google CSE     -> "Google CSE ID" + the Google API key already in the Vault
 *   DuckDuckGo     -> removed: its HTML endpoint now bot-walls (HTTP 202)
 *   Bing           -> keyless last resort, low fidelity, always flagged degraded
 *
 * Nothing here throws on a provider failure: a dead provider is recorded in
 * `errors` and the next one is tried, so one bad key never costs a weekly run.
 */

export type SearchHit = { title: string; url: string; snippet: string }

export type SearchOutcome = {
  hits: SearchHit[]
  /** Questions Google itself associates with the query (Serper peopleAlsoAsk). */
  questions: string[]
  /** "Related searches" from the SERP footer — real demand, phrased by users. */
  related: string[]
  /** Which provider answered, or null when nothing was configured. */
  provider: string | null
  errors: string[]
  /** True when we fell back to the keyless scraper (results are best-effort). */
  degraded: boolean
}

/** A provider's answer. Only Serper fills `questions`/`related`. */
type ProviderResult = { hits: SearchHit[]; questions: string[]; related: string[] }

export type Readable = { url: string; title: string; text: string; bytes: number }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SEARCH_TIMEOUT_MS = 20_000
const FETCH_TIMEOUT_MS = 25_000
/** Per-page cap on extracted text. Hosted web_fetch used 20k tokens; ~40k chars is comparable. */
const MAX_PAGE_CHARS = 40_000
const MAX_RAW_BYTES = 3_000_000

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

async function jsonFetch(url: string, init: RequestInit, timeout = SEARCH_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout), cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Brave — best snippet quality for a general web query. */
async function braveSearch(query: string, count: number): Promise<SearchHit[]> {
  const key = await getSecret('braveSearch')
  if (!key) throw new Error('not configured')
  const body = (await jsonFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, count)}&safesearch=moderate`,
    { headers: { Accept: 'application/json', 'X-Subscription-Token': key } },
  )) as { web?: { results?: { title?: string; url?: string; description?: string }[] } }
  return (body.web?.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: clean(r.title ?? ''), url: r.url as string, snippet: clean((r.description ?? '').replace(/<[^>]+>/g, '')) }))
}

/** Serper.dev — a Google SERP as JSON, so it lines up with what we're trying to rank in. */
async function serperSearch(
  query: string,
  count: number,
  location?: { city: string | null; region: string | null },
): Promise<ProviderResult> {
  const key = await getSecret('serper')
  if (!key) throw new Error('not configured')
  const body = (await jsonFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: query,
      num: Math.min(20, count),
      gl: 'us',
      hl: 'en',
      ...(location?.city ? { location: [location.city, location.region].filter(Boolean).join(', ') } : {}),
    }),
  })) as {
    organic?: { title?: string; link?: string; snippet?: string }[]
    peopleAlsoAsk?: { question?: string }[]
    relatedSearches?: { query?: string }[]
  }
  const hits = (body.organic ?? [])
    .filter((r) => r.link)
    .map((r) => ({ title: clean(r.title ?? ''), url: r.link as string, snippet: clean(r.snippet ?? '') }))
  // peopleAlsoAsk and relatedSearches are the most valuable fields for content
  // planning: they are the questions Google itself associates with the keyword,
  // i.e. the ones a new post should answer.
  const questions = (body.peopleAlsoAsk ?? []).map((q) => clean(q.question ?? '')).filter(Boolean)
  const related = (body.relatedSearches ?? []).map((r) => clean(r.query ?? '')).filter(Boolean)
  return { hits, questions, related }
}

/** Google Programmable Search — 100 free queries/day, reuses the Vault's Google API key. */
async function googleCseSearch(query: string, count: number): Promise<SearchHit[]> {
  const key = await getSecret('googleApiKey')
  const cx = await getSecret('googleCse')
  if (!key || !cx) throw new Error('not configured')
  const body = (await jsonFetch(
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${Math.min(10, count)}&gl=us`,
    {},
  )) as { items?: { title?: string; link?: string; snippet?: string }[] }
  return (body.items ?? [])
    .filter((r) => r.link)
    .map((r) => ({ title: clean(r.title ?? ''), url: r.link as string, snippet: clean(r.snippet ?? '') }))
}

/**
 * Keyless last resort: Bing's HTML SERP. No key, no quota — but it is not
 * Google, it bot-walls intermittently, and it sometimes drops the locale from
 * the query, so results are always flagged `degraded`. Configure Brave or
 * Serper for research quality worth paying for.
 *
 * (DuckDuckGo's HTML endpoint used to serve this role; it now answers HTTP 202
 * with an anti-bot page and zero results, so it is gone.)
 */
async function bingSearch(query: string, count: number): Promise<SearchHit[]> {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-us&count=${Math.min(20, count)}`,
    {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      cache: 'no-store',
      redirect: 'follow',
    },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.text()
  const hits: SearchHit[] = []
  const blocks = body.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []
  for (const block of blocks) {
    if (hits.length >= count) break
    const m = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!m) continue
    // Bing HTML-escapes its own redirect params, so decode before unwrapping.
    const url = unwrapBing(decodeEntities(m[1]))
    if (!/^https?:\/\//i.test(url)) continue
    const sn = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    hits.push({
      title: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim(),
      url,
      snippet: sn ? decodeEntities(sn[1].replace(/<[^>]+>/g, '')).trim() : '',
    })
  }
  return hits
}

/** Bing wraps every organic link as `…/ck/a?…&u=a1<base64url>`. */
function unwrapBing(url: string): string {
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(url)
  if (!m) return url
  try {
    const b = m[1].replace(/-/g, '+').replace(/_/g, '/')
    return Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64').toString('utf8')
  } catch {
    return url
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** Which search backends are usable right now (cheap Vault presence check). */
export async function searchProviders(): Promise<string[]> {
  const out: string[] = []
  // Serper first: it returns the actual Google SERP, which is the thing these
  // sites are trying to rank in. Brave has its own independent index — useful,
  // but the wrong primary signal for "what do competitors rank for on Google".
  if (await getSecret('serper')) out.push('serper')
  if (await getSecret('braveSearch')) out.push('brave')
  if ((await getSecret('googleCse')) && (await getSecret('googleApiKey'))) out.push('google-cse')
  out.push('bing')
  return out
}

export async function webSearch(o: {
  query: string
  count?: number
  location?: { city: string | null; region: string | null }
}): Promise<SearchOutcome> {
  const count = o.count ?? 10
  const errors: string[] = []
  const providers = await searchProviders()
  for (const p of providers) {
    try {
      const raw =
        p === 'brave'
          ? await braveSearch(o.query, count)
          : p === 'serper'
            ? await serperSearch(o.query, count, o.location)
            : p === 'google-cse'
              ? await googleCseSearch(o.query, count)
              : await bingSearch(o.query, count)
      const r: ProviderResult = Array.isArray(raw) ? { hits: raw, questions: [], related: [] } : raw
      if (r.hits.length) {
        return { hits: r.hits, questions: r.questions, related: r.related, provider: p, errors, degraded: p === 'bing' }
      }
      errors.push(`${p}: no results`)
    } catch (err) {
      errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { hits: [], questions: [], related: [], provider: null, errors, degraded: false }
}

/**
 * HTML -> readable text. Deliberately dumb: drop non-content elements, turn
 * headings and list items into line breaks, keep links as "label (url)" so a
 * citation in the model's digest can still be traced to a page.
 */
function extractText(html: string): string {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<\/(h[1-6]|p|li|div|section|tr|br)\s*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
  s = s.replace(/<li[^>]*>/gi, '\n- ')
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const t = String(label).replace(/<[^>]+>/g, '').trim()
    return t ? `${t} (${href})` : ' '
  })
  s = s.replace(/<[^>]+>/g, ' ')
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n')
  return s.trim().slice(0, MAX_PAGE_CHARS)
}

/** Direct fetch. Never throws. */
async function fetchDirect(url: string): Promise<Readable & { error?: string }> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return { url, title: '', text: '', bytes: 0, error: `HTTP ${res.status}` }
    const type = res.headers.get('content-type') ?? ''
    if (!/text\/|html|xml|json/i.test(type)) return { url, title: '', text: '', bytes: 0, error: `unsupported type ${type}` }
    // Read with a hard byte ceiling so one giant page can't blow up the run.
    const raw = (await res.text()).slice(0, MAX_RAW_BYTES)
    const isPlain = /text\/plain/i.test(type)
    const text = isPlain ? clean(raw).slice(0, MAX_PAGE_CHARS) : extractText(raw)
    const title = isPlain ? '' : clean((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) ?? [])[1] ?? '')
    return { url: res.url || url, title, text, bytes: raw.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { url, title: '', text: '', bytes: 0, error: msg.includes('timeout') || msg.includes('aborted') ? 'timed out' : msg }
  }
}

/**
 * Last-resort reader proxy (r.jina.ai). Retailers and big publishers answer
 * bots with 402/403/429; the proxy fetches from its own infrastructure and
 * returns plain text. Only used when a direct fetch fails or comes back
 * nearly empty, and it can still be walled out (Home Depot stays 403), so it
 * is never the only attempt.
 */
async function fetchViaReader(url: string): Promise<(Readable & { error?: string }) | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/plain', 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return null
    let body = await res.text()
    // The proxy prefixes its own header block; read the title from it, then drop it.
    const marker = /Markdown Content:\s*/i.exec(body)
    const head = marker ? body.slice(0, marker.index) : ''
    if (/Target URL returned error|Warning: Target URL/i.test(head)) return null
    const title = clean((/^Title:\s*(.+)$/im.exec(head) ?? [])[1] ?? '')
    body = marker ? body.slice(marker.index + marker[0].length) : body
    const text = body.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_PAGE_CHARS)
    if (text.length < 200) return null
    return { url, title, text, bytes: text.length }
  } catch {
    return null
  }
}

/**
 * Fetch one URL and return its readable text. Never throws — a page that
 * won't load comes back with `text: ''` and the reason in `error`, because one
 * dead competitor page must not fail the week's research.
 */
export async function fetchReadable(url: string): Promise<Readable & { error?: string }> {
  const direct = await fetchDirect(url)
  if (direct.text.length >= 400) return direct
  const proxied = await fetchViaReader(url)
  if (proxied && proxied.text.length > direct.text.length) return proxied
  return direct
}

/**
 * Search several queries, then read the best pages. Deduplicates by URL and by
 * host so a single dominant result doesn't fill the evidence pack.
 */
export async function gatherEvidence(o: {
  queries: string[]
  maxPages: number
  location?: { city: string | null; region: string | null }
  /** Hosts to skip when picking pages to read (our own live site, already in the dossier). */
  skipHosts?: string[]
  perQuery?: number
}): Promise<{
  pages: Readable[]
  sources: { url: string; title: string }[]
  errors: string[]
  usedProvider: string | null
  /** Google's peopleAlsoAsk across every query, deduped. */
  questions: string[]
  /** SERP related-searches across every query, deduped. */
  related: string[]
}> {
  const errors: string[] = []
  const skip = new Set((o.skipHosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, '')))
  const seen = new Set<string>()
  const ranked: { hit: SearchHit; order: number }[] = []
  let usedProvider: string | null = null
  const questions: string[] = []
  const related: string[] = []

  for (const q of o.queries) {
    const res = await webSearch({ query: q, count: o.perQuery ?? 10, location: o.location })
    errors.push(...res.errors.map((e) => `"${q}" -> ${e}`))
    if (res.provider) usedProvider = res.provider
    for (const item of res.questions) if (!questions.includes(item)) questions.push(item)
    for (const item of res.related) if (!related.includes(item)) related.push(item)
    for (const hit of res.hits) {
      const norm = hit.url.split('#')[0]
      if (seen.has(norm)) continue
      const host = ((): string => {
        try {
          return new URL(norm).host.toLowerCase().replace(/^www\./, '')
        } catch {
          return ''
        }
      })()
      if (!host || skip.has(host)) continue
      seen.add(norm)
      ranked.push({ hit: { ...hit, url: norm }, order: ranked.length })
    }
  }

  // Prefer source diversity: no two pages from the same host until every
  // host has had one slot.
  const byHost = new Map<string, { hit: SearchHit; order: number }[]>()
  for (const r of ranked) {
    const h = (() => {
      try {
        return new URL(r.hit.url).host.replace(/^www\./, '').toLowerCase()
      } catch {
        return r.hit.url
      }
    })()
    const list = byHost.get(h) ?? []
    list.push(r)
    byHost.set(h, list)
  }
  const picked: SearchHit[] = []
  let round = 0
  while (picked.length < o.maxPages) {
    let added = false
    for (const list of byHost.values()) {
      if (list[round]) {
        picked.push(list[round].hit)
        added = true
        if (picked.length >= o.maxPages) break
      }
    }
    if (!added) break
    round++
  }

  const pages: (Readable & { error?: string })[] = []
  const results = await Promise.all(picked.map((p) => fetchReadable(p.url)))
  for (const r of results) {
    if (r.text.length < 200) {
      if (r.error) errors.push(`${r.url}: ${r.error}`)
      continue
    }
    pages.push(r)
  }

  return {
    pages,
    sources: [
      ...pages.map((p) => ({ url: p.url, title: p.title || p.url })),
      // A page we couldn't read still counts as a discovered source.
      ...picked.filter((p) => !pages.some((pg) => pg.url === p.url)).map((p) => ({ url: p.url, title: p.title || p.url })),
    ].slice(0, 60),
    errors,
    usedProvider,
    questions: questions.slice(0, 40),
    related: related.slice(0, 40),
  }
}
