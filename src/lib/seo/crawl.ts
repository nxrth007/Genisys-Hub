import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { CrawlResult, PageData } from './types'
import { bareHost, decodeEntities, isAssetPath, parseHtml, resolveHref, urlKey } from './html'

/**
 * Crawl a client's live site the way a non-rendering crawler sees it.
 *
 * Raw HTML only: GPTBot, ClaudeBot and PerplexityBot don't run JavaScript,
 * so anything that isn't in the server's HTML doesn't exist for them.
 * Redirects are followed by hand so every hop is counted. Pages are taken
 * breadth-first in waves — homepage, then its links and the sitemap, then
 * their links — so the same site gives the same page list week to week and
 * the cap keeps the pages closest to the homepage.
 */

export const CRAWLER_UA = 'Mozilla/5.0 (compatible; GenisysSEOBot/1.0; +https://leadgenisys.com)'

/** robots.txt user-agent tokens whose access to "/" the audit reports. */
export const ROBOTS_TOKENS = [
  '*',
  'Googlebot',
  'Bingbot',
  'OAI-SearchBot',
  'GPTBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'ClaudeBot',
  'PerplexityBot',
  'Applebot',
  'Google-Extended',
] as const

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_PAGES = 40
const DEFAULT_CONCURRENCY = 4
/** Whole-crawl budget, so one slow site can't hold a weekly run hostage. */
const DEFAULT_BUDGET_MS = 150_000
const MAX_REDIRECTS = 5
const MAX_HTML_BYTES = 3_000_000
/** RFC 9309 asks parsers to read at least 500 KiB of robots.txt. */
const MAX_ROBOTS_BYTES = 512_000
const ROBOTS_BODY_KEEP = 20_000
const MAX_SITEMAP_BYTES = 10_000_000
const MAX_SITEMAP_URLS = 5000
const MAX_SITEMAP_FILES = 10

const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'

/** Internal paths that are never pages worth a crawl slot. */
const SKIP_PATH = /^\/(?:cdn-cgi|wp-admin|wp-json|wp-login\.php|xmlrpc\.php|~)(?:\/|$)/i

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Fetched = {
  /** Final URL after the redirects that were followed. */
  url: string
  /** null = no HTTP response at all (DNS, TLS, refused, timeout). */
  status: number | null
  redirects: number
  /** Location of the last response, when it was a redirect that wasn't followed. */
  location: string | null
  headers: Headers | null
  body: Buffer | null
  truncated: boolean
  error: string | null
  ms: number
}

type GetOptions = {
  timeoutMs: number
  accept: string
  maxBytes: number
  follow: boolean
  /** Read the body only when this says so; everything else is discarded unread. */
  wantBody: (contentType: string | null, status: number) => boolean
}

function describeNetworkError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `Timed out after ${Math.round(timeoutMs / 1000)}s`
    const code = (err as { cause?: { code?: unknown } }).cause?.code
    if (typeof code === 'string') {
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Domain not found (DNS lookup failed)'
      if (code === 'ECONNREFUSED') return 'Connection refused'
      if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'Connection reset by the server'
      if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return `Timed out after ${Math.round(timeoutMs / 1000)}s`
      if (/CERT|SELF_SIGNED|ALTNAME/i.test(code)) return `TLS certificate problem (${code})`
      if (/SSL|TLS/i.test(code)) return `TLS handshake failed (${code})`
      return `${err.message} (${code})`
    }
    return err.message
  }
  return String(err)
}

/** Free the connection without reading a body we don't need. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    /* already closed */
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total))
      total = maxBytes
      await reader.cancel().catch(() => {})
      return { buf: Buffer.concat(chunks), truncated: true }
    }
    chunks.push(value)
    total += value.byteLength
  }
  return { buf: Buffer.concat(chunks), truncated: false }
}

/** GET with manual redirects: each hop is counted, and a loop or an off-protocol hop stops cleanly. */
async function get(url: string, o: GetOptions): Promise<Fetched> {
  const started = Date.now()
  let current = url
  let redirects = 0
  for (;;) {
    let res: Response
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: { 'User-Agent': CRAWLER_UA, Accept: o.accept, 'Accept-Language': 'en-US,en;q=0.8' },
        signal: AbortSignal.timeout(o.timeoutMs),
      })
    } catch (err) {
      return {
        url: current,
        status: null,
        redirects,
        location: null,
        headers: null,
        body: null,
        truncated: false,
        error: describeNetworkError(err, o.timeoutMs),
        ms: Date.now() - started,
      }
    }

    const location = res.headers.get('location')
    const isRedirect = res.status >= 300 && res.status < 400 && res.status !== 304 && !!location
    if (isRedirect && o.follow) {
      await discard(res)
      const next = resolveHref(location, current)
      const fail = (error: string): Fetched => ({
        url: current,
        status: res.status,
        redirects,
        location,
        headers: res.headers,
        body: null,
        truncated: false,
        error,
        ms: Date.now() - started,
      })
      if (!next || (next.protocol !== 'http:' && next.protocol !== 'https:')) return fail(`Redirects to an invalid location (${location})`)
      if (redirects >= MAX_REDIRECTS) return fail(`More than ${MAX_REDIRECTS} redirects`)
      next.hash = ''
      current = next.href
      redirects++
      continue
    }

    const contentType = res.headers.get('content-type')
    let body: Buffer | null = null
    let truncated = false
    let error: string | null = null
    if (o.wantBody(contentType, res.status)) {
      try {
        const r = await readCapped(res, o.maxBytes)
        body = r.buf
        truncated = r.truncated
      } catch (err) {
        error = `Response body: ${describeNetworkError(err, o.timeoutMs)}`
      }
    } else {
      await discard(res)
    }
    return {
      url: current,
      status: res.status,
      redirects,
      location: isRedirect ? location : null,
      headers: res.headers,
      body,
      truncated,
      error,
      ms: Date.now() - started,
    }
  }
}

function decodeBody(buf: Buffer, contentType: string | null): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1]
  if (!charset) {
    // <meta charset> has to appear in the first 1024 bytes to count.
    const head = buf.subarray(0, 1024).toString('latin1')
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1]
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

// Sticky, and each used at one position only. The single regex these replace,
// /^\s*(?:<!--[\s\S]*?-->\s*)*<html…/, backtracked exponentially on a run of
// "<!---->" (the lazy body can span any number of comments).
const LEADING_SPACE = /\s*/y
const HTML_TAG_AT = /<(?:!doctype\s+html|html|head|body)\b/iy

/** Does `s` start like an HTML document, after any whitespace and complete comments? */
function startsLikeHtml(s: string): boolean {
  let i = 0
  for (;;) {
    LEADING_SPACE.lastIndex = i
    LEADING_SPACE.test(s)
    i = LEADING_SPACE.lastIndex
    if (!s.startsWith('<!--', i)) break
    const close = s.indexOf('-->', i + 4)
    if (close === -1) return false
    i = close + 3
  }
  HTML_TAG_AT.lastIndex = i
  return HTML_TAG_AT.test(s)
}

/** `s` with every complete `<!-- … -->` removed, in one pass. */
function stripComments(s: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const open = s.indexOf('<!--', i)
    const close = open === -1 ? -1 : s.indexOf('-->', open + 4)
    if (close === -1) return out + s.slice(i)
    out += s.slice(i, open)
    i = close + 3
  }
}

/** Does the body itself start like an HTML document? (Content types lie in both directions.) */
function sniffHtml(buf: Buffer | null): boolean {
  if (!buf) return false
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  return startsLikeHtml(buf.subarray(hasBom ? 3 : 0, 1024).toString('latin1'))
}

function looksLikeHtml(contentType: string | null, buf: Buffer | null): boolean {
  return (!!contentType && /html/i.test(contentType)) || sniffHtml(buf)
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Lovable hosting stamps every response with x-deployment-id: psr…; Wix and Squarespace sign theirs too. */
function hostingFrom(h: Headers | null): PageData['hosting'] {
  if (!h) return null
  if (/^psr/i.test(h.get('x-deployment-id') ?? '')) return 'lovable'
  if (h.get('x-wix-request-id') || /pepyaka/i.test(h.get('server') ?? '')) return 'wix'
  if (/squarespace/i.test(`${h.get('server') ?? ''} ${h.get('x-servedby') ?? ''}`)) return 'squarespace'
  return null
}

function blankPage(requestedUrl: string, r: Fetched): PageData {
  return {
    requestedUrl,
    url: r.url,
    status: r.status ?? 0,
    redirects: r.redirects,
    hosting: hostingFrom(r.headers),
    ms: r.ms,
    bytes: r.body?.byteLength ?? 0,
    contentType: r.headers?.get('content-type') ?? null,
    xRobotsTag: r.headers?.get('x-robots-tag') ?? null,
    title: null,
    metaDescription: null,
    canonical: null,
    metaRobots: null,
    lang: null,
    hasViewport: false,
    h1: [],
    h2: [],
    wordCount: 0,
    social: {},
    jsonLd: { types: [], blocks: [], parseErrors: 0 },
    internalLinks: [],
    externalLinks: [],
    telLinks: [],
    images: [],
    mixedContent: [],
    textSample: '',
    clientRenderedShell: false,
    error: r.error,
    mainWordCount: 0,
    canonicalCount: 0,
    phones: [],
  }
}

function sample(text: string, max = 800): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}\u2026`
}

/**
 * Fetch one page as raw HTML and extract what the audit needs. Never throws:
 * a dead page comes back with status 0 (no response) or its HTTP status,
 * and `error` set when there is no usable HTML.
 */
export async function fetchPage(url: string, opts: { timeoutMs?: number } = {}): Promise<PageData> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const r = await get(url, {
    timeoutMs,
    accept: HTML_ACCEPT,
    maxBytes: MAX_HTML_BYTES,
    follow: true,
    // Error pages are read too — a 404 still has a title worth showing.
    wantBody: (ct) => !ct || /html|xml/i.test(ct),
  })
  const page = blankPage(url, r)
  if (r.status === null) return { ...page, error: r.error ?? 'No response' }
  if (r.error) return page

  if (!looksLikeHtml(page.contentType, r.body) || !r.body) {
    if (r.status >= 200 && r.status < 300) page.error = `Not an HTML page (${page.contentType ?? 'no content type'})`
    return page
  }

  const p = parseHtml(decodeBody(r.body, page.contentType), r.url)
  const self = new URL(r.url)
  const host = bareHost(self.hostname)
  const internal = new Set<string>()
  const external = new Set<string>()
  for (const link of p.links) {
    const u = new URL(link)
    if (bareHost(u.hostname) === host && u.port === self.port) {
      if (isAssetPath(u.pathname) || SKIP_PATH.test(u.pathname)) continue
      // Same site under the other host or scheme is the same page: normalise
      // onto this page's origin, and drop the query — "?utm=…" twins of a
      // page aren't pages of their own.
      internal.add(`${self.protocol}//${self.host}${u.pathname || '/'}`)
    } else if (external.size < 300) {
      external.add(link)
    }
  }

  return {
    ...page,
    title: p.title,
    metaDescription: p.metaDescription,
    canonical: p.canonical,
    metaRobots: p.metaRobots,
    lang: p.lang,
    hasViewport: p.hasViewport,
    h1: p.h1,
    h2: p.h2,
    wordCount: p.wordCount,
    social: p.social,
    jsonLd: p.jsonLd,
    internalLinks: [...internal],
    externalLinks: [...external],
    telLinks: p.telLinks,
    images: p.images,
    mixedContent: p.mixedContent,
    textSample: sample(p.text),
    clientRenderedShell: p.clientRenderedShell,
    error: null,
    mainWordCount: p.mainWordCount,
    canonicalCount: p.canonicalCount,
    phones: p.phones,
  }
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309)
// ---------------------------------------------------------------------------

export type RobotsRules = {
  groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[]
  sitemaps: string[]
}

/**
 * Minimal RFC 9309 parser: groups of user-agent lines followed by
 * allow/disallow rules; a user-agent line after a rule starts a new group.
 * Sitemap lines are global. Common misspellings Google accepts are read.
 */
export function parseRobots(body: string): RobotsRules {
  const groups: RobotsRules['groups'] = []
  const sitemaps: string[] = []
  let current: RobotsRules['groups'][number] | null = null
  let lastWasAgent = false

  for (const rawLine of body.replace(/^\ufeff/, '').split(/\r\n|\r|\n/)) {
    // A comment runs from "#" to the end of the line. (Not /#.*$/: that is
    // quadratic on a run of "#" followed by a U+2028, which "." won't cross.)
    const hash = rawLine.indexOf('#')
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim()
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim().toLowerCase().replace(/\s+/g, '-')
    const value = line.slice(colon + 1).trim()

    if (key === 'user-agent' || key === 'useragent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      // The product token is the leading run of letters, "_" and "-"
      // ("Googlebot/2.1" → googlebot); "*" is the catch-all.
      const token = value === '*' ? '*' : (/^[A-Za-z_-]+/.exec(value)?.[0] ?? '').toLowerCase()
      if (token) current.agents.push(token)
      lastWasAgent = true
      continue
    }
    if (key === 'sitemap' || key === 'site-map') {
      if (value) sitemaps.push(value)
      continue
    }
    if (/^(?:allow|disallow|dissallow|dissalow|disalow|diasllow|disallaw)$/.test(key)) {
      lastWasAgent = false
      if (!current || !value) continue // "Disallow:" with no path allows everything
      const pattern = value.startsWith('/') || value.startsWith('*') ? value : `/${value}`
      current.rules.push({ allow: key === 'allow', pattern })
      continue
    }
    // crawl-delay, host, clean-param…: ignored, and they don't end a group.
    lastWasAgent = false
  }
  return { groups, sitemaps }
}

/**
 * Does a robots.txt path pattern match? `*` is any run of characters and a
 * trailing `$` anchors the end. Matched without a regex: a pattern such as
 * `/*a*a*a…b` compiled to `.*` chains backtracks polynomially, and the file
 * is the client's to write. Placing each literal piece at its leftmost fit
 * is enough for `*`-only globs.
 */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*')
  const first = parts[0]
  if (!path.startsWith(first)) return false
  if (parts.length === 1) return !anchored || path.length === first.length
  let pos = first.length
  for (let k = 1; k < parts.length - 1; k++) {
    if (!parts[k]) continue
    const at = path.indexOf(parts[k], pos)
    if (at === -1) return false
    pos = at + parts[k].length
  }
  const last = parts[parts.length - 1]
  if (!anchored) return path.indexOf(last, pos) !== -1
  return path.length - last.length >= pos && path.endsWith(last)
}

function groupsFor(rules: RobotsRules, token: string) {
  return rules.groups.filter((g) => g.agents.includes(token))
}

/**
 * May `token` fetch `path`? The most specific group wins (Applebot falls
 * back to Googlebot's rules, as Apple documents), then the longest
 * matching rule, with allow winning a tie.
 */
export function robotsAllows(rules: RobotsRules, token: string, path: string): boolean {
  const t = token.toLowerCase()
  let groups = groupsFor(rules, t)
  if (!groups.length && t === 'applebot') groups = groupsFor(rules, 'googlebot')
  if (!groups.length) groups = groupsFor(rules, '*')
  let best: { len: number; allow: boolean } | null = null
  for (const g of groups) {
    for (const r of g.rules) {
      if (!patternMatches(r.pattern, path)) continue
      const len = r.pattern.length
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow }
    }
  }
  return best ? best.allow : true
}

async function loadRobots(origin: string, timeoutMs: number): Promise<CrawlResult['robots'] & { note: string | null }> {
  const url = `${origin}/robots.txt`
  const opts: GetOptions = { timeoutMs, accept: 'text/plain,*/*;q=0.5', maxBytes: MAX_ROBOTS_BYTES, follow: true, wantBody: (_ct, s) => s < 300 }
  let r = await get(url, opts)
  // One retry: an unreachable or 5xx robots.txt means "crawl nothing" to
  // Google, so a single blip must not become a P0 finding.
  if (r.status === null || r.status >= 500) {
    await new Promise((res) => setTimeout(res, 1500))
    r = await get(url, opts)
  }

  const all = (v: boolean) => Object.fromEntries(ROBOTS_TOKENS.map((t) => [t, v])) as Record<string, boolean>
  if (r.status === null) {
    return { status: null, body: null, sitemaps: [], rootAllowed: all(false), note: `robots.txt unreachable: ${r.error}` }
  }
  if (r.status >= 500) {
    return { status: r.status, body: null, sitemaps: [], rootAllowed: all(false), note: `robots.txt returned HTTP ${r.status}` }
  }
  // 4xx (and a redirect chain that never lands) = no robots.txt = everything allowed.
  if (r.status >= 300 || !r.body) return { status: r.status, body: null, sitemaps: [], rootAllowed: all(true), note: null }

  const body = decodeBody(r.body, r.headers?.get('content-type') ?? null)
  if (sniffHtml(r.body)) {
    // An SPA answering every path with its app shell. Crawlers find no
    // valid lines in it, which means no rules and no Sitemap.
    return {
      status: r.status,
      body: body.slice(0, ROBOTS_BODY_KEEP),
      sitemaps: [],
      rootAllowed: all(true),
      note: 'robots.txt is served as an HTML page, not a text file',
    }
  }
  const rules = parseRobots(body)
  const sitemaps = [
    ...new Set(
      rules.sitemaps.map((s) => resolveHref(s, origin)?.href).filter((s): s is string => !!s && /^https?:/i.test(s)),
    ),
  ]
  return {
    status: r.status,
    body: body.slice(0, ROBOTS_BODY_KEEP),
    sitemaps,
    rootAllowed: Object.fromEntries(ROBOTS_TOKENS.map((t) => [t, robotsAllows(rules, t, '/')])),
    note: null,
  }
}

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

const LOC_OPEN = /<loc>/gi
const LOC_CLOSE = /<\/loc>/gi

/**
 * Every `<loc>` value, in order (CDATA and entities undone), up to the URL cap.
 * A linear scan: a lazy regex rescanned to the end from each unterminated
 * `<loc>`, which on a hostile sitemap was quadratic. The first `<loc>` with no
 * closer ends the scan, as it ended every match of that regex.
 */
function sitemapLocs(xml: string): string[] {
  const out: string[] = []
  LOC_OPEN.lastIndex = 0
  while (out.length < MAX_SITEMAP_URLS && LOC_OPEN.exec(xml)) {
    const start = LOC_OPEN.lastIndex
    LOC_CLOSE.lastIndex = start
    if (!LOC_CLOSE.exec(xml)) break
    let v = xml.slice(start, LOC_CLOSE.lastIndex - 6).trim()
    if (v.slice(0, 9).toUpperCase() === '<![CDATA[') v = v.slice(9).trim()
    if (v.endsWith(']]>')) v = v.slice(0, -3).trim()
    const loc = decodeEntities(v).trim()
    if (loc) out.push(loc)
    LOC_OPEN.lastIndex = LOC_CLOSE.lastIndex
  }
  return out
}

function sitemapKind(text: string): 'urlset' | 'index' | 'html' | 'text' | 'unknown' {
  const head = stripComments(text.slice(0, 4000))
  if (/<urlset[\s>]/i.test(head)) return 'urlset'
  if (/<sitemapindex[\s>]/i.test(head)) return 'index'
  if (startsLikeHtml(head)) return 'html'
  const lines = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length && lines.every((l) => /^https?:\/\/\S+$/i.test(l))) return 'text'
  return 'unknown'
}

async function loadSitemaps(origin: string, declared: string[], timeoutMs: number): Promise<CrawlResult['sitemap']> {
  const roots = declared.length ? declared.slice(0, 5) : [`${origin}/sitemap.xml`]
  const urls = new Set<string>()
  const errors: string[] = []
  let files = 0
  // Which file to report as "the" sitemap: the first that yielded URLs, else the first tried.
  const seen: { primary: { url: string; status: number | null } | null; first: { url: string; status: number | null } | null } = {
    primary: null,
    first: null,
  }

  const visit = async (url: string, depth: number): Promise<void> => {
    if (files >= MAX_SITEMAP_FILES || urls.size >= MAX_SITEMAP_URLS) return
    files++
    const r = await get(url, {
      timeoutMs: Math.max(timeoutMs, 20_000),
      accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
      maxBytes: MAX_SITEMAP_BYTES,
      follow: true,
      wantBody: (_ct, s) => s < 300,
    })
    if (depth === 0 && !seen.first) seen.first = { url, status: r.status }
    const where = urlKey(url) === urlKey(`${origin}/sitemap.xml`) ? 'sitemap.xml' : url
    if (r.status === null) return void errors.push(`${where}: ${r.error}`)
    if (r.status >= 300 || !r.body) return void errors.push(`${where}: HTTP ${r.status}`)

    let buf = r.body
    // .xml.gz served as a file (not Content-Encoding) arrives still gzipped.
    // Inflated text gets the same 10 MB bound as a plain sitemap.
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        buf = gunzipSync(buf, { maxOutputLength: MAX_SITEMAP_BYTES })
      } catch (err) {
        const tooBig = (err as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE'
        return void errors.push(
          tooBig
            ? `${where}: the gzipped sitemap inflates to more than ${MAX_SITEMAP_BYTES / 1_000_000} MB`
            : `${where}: couldn't decompress the gzipped sitemap`,
        )
      }
    }
    const text = decodeBody(buf, r.headers?.get('content-type') ?? null)
    const kind = sitemapKind(text)
    if (kind === 'html') return void errors.push(`${where}: returned an HTML page, not a sitemap`)
    if (kind === 'unknown') return void errors.push(`${where}: not a sitemap (no <urlset> or <sitemapindex>)`)

    if (kind === 'index') {
      const children = sitemapLocs(text)
      if (!children.length) return void errors.push(`${where}: sitemap index lists no sitemaps`)
      if (!seen.primary) seen.primary = { url, status: r.status }
      // One level of nesting, as the spec allows; deeper indexes are rare and usually a mistake.
      if (depth === 0) for (const child of children) await visit(child, 1)
      return
    }
    const locs = kind === 'text' ? text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l)) : sitemapLocs(text)
    if (!locs.length) return void errors.push(`${where}: no <loc> entries`)
    if (!seen.primary) seen.primary = { url, status: r.status }
    for (const loc of locs) {
      if (urls.size >= MAX_SITEMAP_URLS) break
      urls.add(loc)
    }
  }

  for (const root of roots) await visit(root, 0)
  const head = seen.primary ?? seen.first
  return {
    url: head?.url ?? null,
    status: head?.status ?? null,
    urls: [...urls],
    error: errors.length ? errors.join('; ') : null,
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** One request, redirects not followed — for "where does this host send people?" */
async function probeRedirect(url: string, timeoutMs: number): Promise<{ status: number | null; location: string | null }> {
  const r = await get(url, { timeoutMs, accept: HTML_ACCEPT, maxBytes: 0, follow: false, wantBody: () => false })
  const loc = r.location ? (resolveHref(r.location, url)?.href ?? r.location) : null
  return { status: r.status, location: loc }
}

/**
 * The www / bare twin worth probing, or null when there isn't one: a
 * platform subdomain like x.lovable.app has no www twin to split traffic.
 */
function twinHost(host: string): string | null {
  const h = host.toLowerCase()
  if (h.startsWith('www.')) return h.slice(4)
  if (/^[\d.]+$/.test(h) || h === 'localhost' || h.includes(':') || h.endsWith('.localhost')) return null
  const labels = h.split('.')
  const apexLabels = /\.(?:co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(h) ? 3 : 2
  return labels.length === apexLabels ? `www.${h}` : null
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Absolute start URL; `implied` when the input had no scheme and https was assumed. */
function normaliseStart(input: string): { url: string; implied: boolean } {
  const s = input.trim()
  const implied = !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  let u: URL
  try {
    u = new URL(implied ? `https://${s}` : s)
  } catch {
    throw new Error(`Not a valid site URL: ${input}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Not a web URL: ${input}`)
  u.hash = ''
  return { url: u.href, implied }
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

export async function crawlSite(
  startUrl: string,
  opts: { maxPages?: number; timeoutMs?: number; concurrency?: number; budgetMs?: number } = {},
): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, 500))
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 8))
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const normalised = normaliseStart(startUrl)
  let start = normalised.url
  const fetchedAt = new Date().toISOString()
  const errors: string[] = []

  // The homepage decides the origin: an apex that redirects to www (or
  // http to https) is audited where visitors actually land.
  let home = await fetchPage(start, { timeoutMs })
  if (home.status === 0 && normalised.implied) {
    // "example.com" with no scheme: https was a guess. If it doesn't answer
    // at all, audit the http site rather than report the business as down.
    const plain = start.replace(/^https:/, 'http:')
    const retry = await fetchPage(plain, { timeoutMs })
    if (retry.status > 0) {
      errors.push(`https://${new URL(start).host} didn't answer (${home.error}); crawled over http`)
      start = plain
      home = retry
    }
  }
  const landed = home.status > 0 && !home.error?.startsWith('Redirects to an invalid')
  const originUrl = new URL(landed ? home.url : start)
  const origin = originUrl.origin
  if (home.status === 0) errors.push(`Homepage: ${home.error ?? 'no response'}`)
  else if (home.status >= 400) errors.push(`Homepage returned HTTP ${home.status}`)
  else if (home.error) errors.push(`Homepage: ${home.error}`)
  if (bareHost(originUrl.hostname) !== bareHost(new URL(start).hostname)) {
    errors.push(`${start} redirects to another site: ${origin}`)
  }

  const twin = twinHost(originUrl.hostname)
  const [robots, llms, soft404, httpToHttps, hostTwin] = await Promise.all([
    loadRobots(origin, timeoutMs),
    get(`${origin}/llms.txt`, {
      timeoutMs,
      accept: 'text/plain,text/markdown;q=0.9,*/*;q=0.5',
      maxBytes: 4096,
      follow: true,
      wantBody: (_ct, s) => s < 300,
    }),
    (async () => {
      const url = `${origin}/__genisys-404-check-${randomUUID().replace(/-/g, '').slice(0, 12)}`
      const r = await get(url, { timeoutMs, accept: HTML_ACCEPT, maxBytes: 0, follow: true, wantBody: () => false })
      return { url, status: r.status }
    })(),
    probeRedirect(`http://${originUrl.host}/`, timeoutMs),
    twin
      ? (async () => {
          const url = `${originUrl.protocol}//${twin}/`
          return { url, ...(await probeRedirect(url, timeoutMs)) }
        })()
      : Promise.resolve(null),
  ])
  if (robots.note) errors.push(robots.note)
  if (llms.status !== null && llms.status < 300 && sniffHtml(llms.body)) {
    errors.push('llms.txt: served an HTML page (the app shell), not a text file')
  }

  const sitemap = await loadSitemaps(origin, robots.sitemaps, timeoutMs)

  // Breadth-first in waves: homepage links, then the sitemap, then
  // whatever those pages link to.
  const pages: PageData[] = [home]
  const queued = new Set<string>([urlKey(start), urlKey(home.url)])
  const recorded = new Set<string>([urlKey(home.url)])
  let frontier: string[] = []
  const enqueue = (u: string) => {
    const k = urlKey(u)
    if (queued.has(k)) return
    queued.add(k)
    frontier.push(u)
  }
  const internal = (raw: string): string | null => {
    const u = resolveHref(raw, origin)
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null
    if (bareHost(u.hostname) !== bareHost(originUrl.hostname) || u.port !== originUrl.port) return null
    if (isAssetPath(u.pathname) || SKIP_PATH.test(u.pathname)) return null
    return `${originUrl.protocol}//${originUrl.host}${u.pathname || '/'}`
  }

  if (home.status >= 200 && home.status < 300) home.internalLinks.forEach(enqueue)
  for (const u of sitemap.urls) {
    const i = internal(u)
    if (i) enqueue(i)
  }

  let outOfTime = false
  while (frontier.length && pages.length < maxPages) {
    if (Date.now() > deadline) {
      outOfTime = true
      break
    }
    const batch = frontier.slice(0, maxPages - pages.length)
    frontier = frontier.slice(batch.length)
    const results = await mapLimit(batch, concurrency, async (u) => (Date.now() > deadline ? null : fetchPage(u, { timeoutMs })))
    for (const p of results) {
      if (!p) {
        outOfTime = true
        continue
      }
      if (pages.length >= maxPages) break
      let finalUrl: URL | null = null
      try {
        finalUrl = new URL(p.url)
      } catch {
        /* keep null */
      }
      if (finalUrl && bareHost(finalUrl.hostname) !== bareHost(originUrl.hostname)) {
        errors.push(`${p.requestedUrl} redirects off-site to ${p.url}`)
        continue
      }
      // A file that slipped past the extension filter isn't a page.
      if (p.status >= 200 && p.status < 300 && p.error?.startsWith('Not an HTML page')) continue
      const k = urlKey(p.url)
      if (recorded.has(k)) continue // two links that redirect to one page
      recorded.add(k)
      queued.add(k)
      pages.push(p)
      if (p.status >= 200 && p.status < 300 && !p.error) p.internalLinks.forEach(enqueue)
    }
  }
  if (outOfTime) errors.push(`Crawl stopped at its ${Math.round((opts.budgetMs ?? DEFAULT_BUDGET_MS) / 1000)}s time budget after ${pages.length} pages`)

  return {
    origin,
    startUrl: start,
    fetchedAt,
    httpToHttps,
    hostTwin,
    robots: { status: robots.status, body: robots.body, sitemaps: robots.sitemaps, rootAllowed: robots.rootAllowed },
    sitemap,
    llmsTxt: { status: llms.status },
    soft404,
    pages,
    errors,
  }
}
