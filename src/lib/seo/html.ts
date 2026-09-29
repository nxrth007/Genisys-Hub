import type { PageImage } from './types'

/**
 * A small, dependency-free reader for raw server HTML.
 *
 * It sees a page the way GPTBot, ClaudeBot and PerplexityBot do: no
 * JavaScript, no CSS. It is a tokenizer rather than a full HTML5 parser —
 * enough to pull the title, meta, headings, links, images and JSON-LD out
 * of real-world markup (any attribute order or quoting, entities, stray
 * `<`, unclosed tags) without adding cheerio to the server bundle.
 *
 * Also home to the URL and JSON-LD helpers the crawler and the audit
 * share, so audit.ts stays free of network and Node imports.
 */

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c',
  rdquo: '\u201d', bdquo: '\u201e', hellip: '\u2026', bull: '\u2022', middot: '\u00b7', prime: '\u2032',
  Prime: '\u2033', laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', times: '\u00d7', divide: '\u00f7',
  plusmn: '\u00b1', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', sup2: '\u00b2', sup3: '\u00b3',
  cent: '\u00a2', pound: '\u00a3', euro: '\u20ac', yen: '\u00a5', dollar: '$', percnt: '%', num: '#',
  sect: '\u00a7', para: '\u00b6', dagger: '\u2020', Dagger: '\u2021', larr: '\u2190', rarr: '\u2192',
  uarr: '\u2191', darr: '\u2193', harr: '\u2194', check: '\u2713', cross: '\u2717', star: '\u2606',
  starf: '\u2605', hearts: '\u2665', iexcl: '\u00a1', iquest: '\u00bf', excl: '!', quest: '?',
  colon: ':', semi: ';', comma: ',', period: '.', sol: '/', bsol: '\\', lpar: '(', rpar: ')',
  lsqb: '[', rsqb: ']', lcub: '{', rcub: '}', vert: '|', ast: '*', plus: '+', equals: '=', commat: '@',
  aacute: '\u00e1', Aacute: '\u00c1', agrave: '\u00e0', Agrave: '\u00c0', acirc: '\u00e2', auml: '\u00e4',
  Auml: '\u00c4', atilde: '\u00e3', aring: '\u00e5', aelig: '\u00e6', ccedil: '\u00e7', Ccedil: '\u00c7',
  eacute: '\u00e9', Eacute: '\u00c9', egrave: '\u00e8', Egrave: '\u00c8', ecirc: '\u00ea', euml: '\u00eb',
  iacute: '\u00ed', Iacute: '\u00cd', igrave: '\u00ec', icirc: '\u00ee', iuml: '\u00ef', ntilde: '\u00f1',
  Ntilde: '\u00d1', oacute: '\u00f3', Oacute: '\u00d3', ograve: '\u00f2', ocirc: '\u00f4', ouml: '\u00f6',
  Ouml: '\u00d6', otilde: '\u00f5', oslash: '\u00f8', uacute: '\u00fa', Uacute: '\u00da', ugrave: '\u00f9',
  ucirc: '\u00fb', uuml: '\u00fc', Uuml: '\u00dc', yacute: '\u00fd', yuml: '\u00ff', szlig: '\u00df',
}

// Browsers read &#128;–&#159; as Windows-1252, not C1 controls — "&#150;" is an en dash.
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
}

const ENTITY_RE = /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g

/** Decode HTML character references (named, decimal, hex). Unknown names are left as written. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s
  return s.replace(ENTITY_RE, (m: string, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) {
      // Named references only count with their semicolon, so "?a=1&copy=2"
      // in an href stays a query string instead of becoming "?a=1©=2".
      if (!m.endsWith(';')) return m
      return NAMED[name] ?? m
    }
    let cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '', 16)
    if (!Number.isFinite(cp)) return m
    if (CP1252[cp]) cp = CP1252[cp]
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd'
    return String.fromCodePoint(cp)
  })
}

/**
 * Runs of whitespace (nbsp and friends included) that aren't already a
 * single plain space: a run of two or more, or one other space character.
 * Same result as replacing every run, without a million no-op replacements
 * on dense text.
 */
const SPACE_RUN = /[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]{2,}|[^\S ]|\u200b/g

/** Decode, turn nbsp and friends into spaces, collapse whitespace. */
export function cleanText(s: string): string {
  return decodeEntities(s).replace(SPACE_RUN, ' ').trim()
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Attrs = Record<string, string>

type Visitor = {
  open: (name: string, attrs: Attrs, selfClosing: boolean) => void
  close: (name: string) => void
  /** Raw (undecoded) text between tags. */
  text: (raw: string) => void
  /** Content of script/style/title/textarea/noscript/…, verbatim. */
  rawText: (name: string, attrs: Attrs, content: string) => void
}

/**
 * Elements whose content is not markup. noscript is here because crawlers
 * parse with scripting on, where its content is inert text; iframe content
 * is fallback text nobody sees.
 */
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes'])
const rawTextClose = new Map<string, RegExp>()
function closeTagRe(name: string): RegExp {
  let re = rawTextClose.get(name)
  if (!re) {
    re = new RegExp(`</${name}(?=[\\s/>])`, 'gi')
    rawTextClose.set(name, re)
  }
  return re
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

/**
 * Walk the document the way the HTML tokenizer does for the parts we need:
 * quotes only matter inside attribute values, a `<` that doesn't open a
 * tag is text, and an unterminated tag or comment swallows the rest.
 * Linear time; no backtracking regex over the whole page.
 */
function tokenize(html: string, v: Visitor): void {
  const n = html.length
  let i = 0
  let textStart = 0

  const flushText = (end: number) => {
    if (end > textStart) v.text(html.slice(textStart, end))
  }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    const c = html.charCodeAt(lt + 1)

    // <!-- comment -->, <!doctype>, <![CDATA[ … ]]>, <? … >
    if (c === 33 /* ! */ || c === 63 /* ? */) {
      flushText(lt)
      let end: number
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4)
        end = close === -1 ? n : close + 3
      } else {
        const close = html.indexOf('>', lt + 2)
        end = close === -1 ? n : close + 1
      }
      i = textStart = end
      continue
    }

    // </name …>
    if (c === 47 /* / */) {
      const c2 = html.charCodeAt(lt + 2)
      if (!isAlpha(c2)) {
        // "</>" is dropped; "</ …" is a bogus comment.
        flushText(lt)
        const close = html.indexOf('>', lt + 2)
        i = textStart = close === -1 ? n : close + 1
        continue
      }
      let j = lt + 2
      while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 47 && html.charCodeAt(j) !== 62) j++
      const name = html.slice(lt + 2, j).toLowerCase()
      const close = html.indexOf('>', j)
      flushText(lt)
      v.close(name)
      i = textStart = close === -1 ? n : close + 1
      continue
    }

    if (!isAlpha(c)) {
      // A literal "<" in text ("a < b").
      i = lt + 1
      continue
    }

    // <name attr=value …>
    let j = lt + 1
    while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 47 && html.charCodeAt(j) !== 62) j++
    const name = html.slice(lt + 1, j).toLowerCase()
    const attrs: Attrs = {}
    let selfClosing = false
    let ended = false
    while (j < n) {
      const ch = html.charCodeAt(j)
      if (isSpace(ch)) {
        j++
        continue
      }
      if (ch === 62 /* > */) {
        ended = true
        j++
        break
      }
      if (ch === 47 /* / */) {
        selfClosing = html.charCodeAt(j + 1) === 62
        j++
        continue
      }
      // Attribute name: up to whitespace, "/", ">" or "=" (a leading "=" belongs to the name).
      const nameStart = j
      j++
      while (j < n) {
        const d = html.charCodeAt(j)
        if (isSpace(d) || d === 47 || d === 62 || d === 61) break
        j++
      }
      const attrName = html.slice(nameStart, j).toLowerCase()
      while (j < n && isSpace(html.charCodeAt(j))) j++
      let value = ''
      if (html.charCodeAt(j) === 61 /* = */) {
        j++
        while (j < n && isSpace(html.charCodeAt(j))) j++
        const q = html.charCodeAt(j)
        if (q === 34 || q === 39) {
          const close = html.indexOf(q === 34 ? '"' : "'", j + 1)
          const end = close === -1 ? n : close
          value = html.slice(j + 1, end)
          j = close === -1 ? n : close + 1
        } else {
          const vs = j
          while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 62) j++
          value = html.slice(vs, j)
        }
      }
      // Duplicate attributes: the first one wins, as in browsers.
      if (attrName && !(attrName in attrs)) attrs[attrName] = decodeEntities(value)
    }
    if (!ended) {
      // "<div class=… EOF" — browsers drop the unfinished tag.
      i = textStart = n
      break
    }

    flushText(lt)
    v.open(name, attrs, selfClosing)

    if (RAW_TEXT.has(name)) {
      const re = closeTagRe(name)
      re.lastIndex = j
      const m = re.exec(html)
      const contentEnd = m ? m.index : n
      v.rawText(name, attrs, html.slice(j, contentEnd))
      let after = n
      if (m) {
        const gt = html.indexOf('>', m.index)
        after = gt === -1 ? n : gt + 1
      }
      v.close(name)
      i = textStart = after
      continue
    }
    i = textStart = j
  }
  flushText(n)
}

/** Parse an attribute string such as `href="/a" rel=nofollow data-x`. Lowercased names; decoded values. */
export function parseAttributes(src: string): Record<string, string> {
  let out: Attrs = {}
  tokenize(`<x ${src}>`, {
    open: (_n, attrs) => {
      out = attrs
    },
    close: () => {},
    text: () => {},
    rawText: () => {},
  })
  return out
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Hostname without a leading "www." — the www and bare hosts are one site. */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

/**
 * Identity of a page for de-duplication: host (www-insensitive) plus path,
 * without the trailing slash, query or hash. http/https collapse too —
 * they are one page with a redirect problem, not two pages.
 */
export function urlKey(u: string): string {
  try {
    const x = new URL(u)
    const p = x.pathname || '/'
    // Trailing slashes off by hand: /\/+$/ is quadratic on a long run of
    // slashes that isn't at the end, and page links are untrusted.
    let end = p.length
    while (end > 1 && p.charCodeAt(end - 1) === 47 /* / */) end--
    return bareHost(x.hostname) + (x.port ? `:${x.port}` : '') + p.slice(0, end)
  } catch {
    return u
  }
}

const ASSET_EXT =
  /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp4|m4v|mov|webm|avi|mkv|mp3|m4a|wav|ogg|flac|zip|rar|7z|gz|tgz|tar|css|js|mjs|cjs|json|xml|txt|csv|tsv|xlsx?|docx?|pptx?|odt|rtf|woff2?|ttf|otf|eot|map|rss|atom|ics|vcf|apk|dmg|exe|msi)$/i

/** A path that names a file rather than a page. */
export function isAssetPath(pathname: string): boolean {
  return ASSET_EXT.test(pathname)
}

/** Resolve an href the way a browser does (tabs/newlines stripped), or null. */
export function resolveHref(href: string, base: string): URL | null {
  const h = href.replace(/[\t\n\r]/g, '').trim()
  if (!h) return null
  try {
    return new URL(h, base)
  } catch {
    return null
  }
}

/** Absolute http(s) URL as written — relative paths, protocol-relative and other schemes are not. */
export function isAbsoluteHttpUrl(s: string | null | undefined): boolean {
  return !!s && /^https?:\/\/[^/\s]/i.test(s.trim())
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

export type JsonLdNode = Record<string, unknown>

/**
 * Top-level entities of JSON-LD blocks: each block, the items of a block
 * that is an array, and the members of `@graph` — the nodes a search engine
 * treats as things on the page. Nested values (an address, an offer) are
 * properties of those, not entities of their own.
 */
export function jsonLdNodes(blocks: unknown[]): JsonLdNode[] {
  const out: JsonLdNode[] = []
  const visit = (v: unknown, depth: number) => {
    if (depth > 3 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1)
      return
    }
    const o = v as JsonLdNode
    if ('@type' in o) out.push(o)
    const graph = o['@graph']
    if (Array.isArray(graph)) for (const g of graph) visit(g, depth + 1)
    else if (graph && typeof graph === 'object') visit(graph, depth + 1)
  }
  for (const b of blocks) visit(b, 0)
  return out
}

/** A node's @type values, with any schema.org IRI prefix removed. */
export function nodeTypes(node: JsonLdNode): string[] {
  const t = node['@type']
  const list = Array.isArray(t) ? t : [t]
  return list
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim().replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, ''))
}

type JsonLdParse = { value: unknown; strict: boolean } | null

function parseJsonLd(raw: string): JsonLdParse {
  // Some CMSes wrap the JSON in an HTML comment or CDATA for ancient parsers.
  const s = raw
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^(?:\/\/\s*)?<!\[CDATA\[/, '')
    .replace(/(?:\/\/\s*)?\]\]>$/, '')
    .trim()
  if (!s) return null
  try {
    return { value: JSON.parse(s), strict: true }
  } catch {
    // Keep what a lenient consumer would still read (raw newlines inside
    // strings, trailing commas) so types are known — but it still counts
    // as a parse error, because a strict validator rejects it.
    try {
      const relaxed = s.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1')
      return { value: JSON.parse(relaxed), strict: false }
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Page extraction
// ---------------------------------------------------------------------------

export type ParsedHtml = {
  title: string | null
  metaDescription: string | null
  /** The canonical href exactly as written (decoded, trimmed) — relative stays relative. */
  canonical: string | null
  canonicalCount: number
  /** Every robots/googlebot meta, joined. */
  metaRobots: string | null
  lang: string | null
  hasViewport: boolean
  /** Text of each H1/H2 in order; an empty heading is kept as ''. */
  h1: string[]
  h2: string[]
  /** All visible body text, whitespace-collapsed. */
  text: string
  wordCount: number
  /** Words inside <main>, or outside site-level header/nav/footer/aside when there is no <main>. */
  mainWordCount: number
  /** og:*, twitter:* and article:* meta, keyed by lowercased property/name. First wins. */
  social: Record<string, string>
  jsonLd: { types: string[]; blocks: unknown[]; parseErrors: number }
  /** Absolute http(s) <a href> targets, hash removed, de-duplicated, document order. */
  links: string[]
  telLinks: string[]
  images: PageImage[]
  /** http:// subresources, when the page itself is https. */
  mixedContent: string[]
  /** Distinct 10-digit North American phone numbers found in the visible text. */
  phones: string[]
  clientRenderedShell: boolean
}

/**
 * Tags that don't break a word: "<b>W</b>ord" is one word, "<p>a</p><p>b</p>" is two.
 * <a> is deliberately not here — nav links sit back to back with no space
 * between them ("…</a><a>…") and would otherwise read as one long word.
 */
const INLINE = new Set([
  'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'kbd', 'mark', 'q',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins',
])
/** Containers whose content is never visible page text. */
const HIDDEN_CONTAINERS = new Set(['svg', 'math', 'template', 'object'])
/** Site chrome, when it isn't inside <main>/<article>. */
const CHROME = new Set(['header', 'nav', 'footer', 'aside'])
/** Body elements that are plumbing, not content, for the empty-shell check. */
const NON_CONTENT = new Set(['script', 'noscript', 'style', 'link', 'meta', 'template', 'br', 'base'])

/**
 * An SPA mount point (`<div id="root"></div>`) and the ids frameworks use for
 * one. Emptiness is worked out from the tokenizer, not a regex over the raw
 * page: the old pattern backtracked quadratically on crafted markup.
 */
const MOUNT_TAGS = new Set(['div', 'main', 'section', 'body', 'app-root'])
const MOUNT_ID = /^(?:root|app|__next|__nuxt|svelte|q-app)$/i

const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?([2-9]\d{2})[\s.\-]?(\d{4})/g

const MAX_LINKS = 1000
const MAX_IMAGES = 300

const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c <= 0x24f)
const ONE_SPACE = /\s/

/** Whitespace-separated runs holding at least one letter or digit. One pass, no word array. */
function countWords(s: string): number {
  let n = 0
  let counted = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 32 || (c < 128 ? c >= 9 && c <= 13 : ONE_SPACE.test(s[i]))) {
      counted = false
    } else if (!counted && isWordChar(c)) {
      n++
      counted = true
    }
  }
  return n
}

function findPhones(text: string): string[] {
  const out = new Set<string>()
  PHONE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PHONE_RE.exec(text))) {
    // No lookbehind at ES2017: check the digit boundary by hand so an
    // order number or a longer digit run doesn't read as a phone.
    const before = m.index > 0 ? text.charCodeAt(m.index - 1) : 0
    const after = text.charCodeAt(m.index + m[0].length)
    if ((before >= 48 && before <= 57) || (after >= 48 && after <= 57)) continue
    out.add(`${m[1]}${m[2]}${m[3]}`)
  }
  return [...out]
}

/** Resolve a subresource URL; data:/blob: URIs are shortened so a base64 image can't bloat the result. */
function resolveSrc(raw: string, base: string): string {
  const s = raw.trim()
  if (/^(?:data|blob):/i.test(s)) return s.length > 64 ? `${s.slice(0, 61)}...` : s
  return resolveHref(s, base)?.href ?? s
}

/**
 * An image positioned absolutely over its container (a hero background:
 * Tailwind "absolute inset-0", Next.js fill, inline position:absolute)
 * takes no space in the layout, so it can't cause a shift without
 * width/height. Class names are the only signal without CSS.
 */
function fillsBox(a: Attrs): boolean {
  if (a['data-nimg'] === 'fill') return true
  if (/position\s*:\s*(?:absolute|fixed)/i.test(a.style ?? '')) return true
  const cls = ` ${(a.class ?? '').toLowerCase()} `
  return / (?:absolute|fixed) /.test(cls) && / (?:inset-0|h-full|size-full) /.test(cls)
}

/** First candidate URL of a srcset ("a.jpg 1x, b.jpg 2x"). */
function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(/,\s+/)
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean)
}

/**
 * Extract what the SEO audit needs from one page of raw HTML.
 * `pageUrl` is the final URL the HTML came from; relative URLs resolve
 * against it (or against `<base href>` when the page declares one).
 */
export function parseHtml(html: string, pageUrl: string): ParsedHtml {
  const pageIsHttps = pageUrl.toLowerCase().startsWith('https:')
  let base = pageUrl

  let title: string | null = null
  let metaDescription: string | null = null
  let canonical: string | null = null
  let canonicalCount = 0
  const robots: string[] = []
  let lang: string | null = null
  let hasViewport = false
  const social: Record<string, string> = {}
  const blocks: unknown[] = []
  let parseErrors = 0
  const links: string[] = []
  const linkSeen = new Set<string>()
  const telLinks = new Set<string>()
  const images: PageImage[] = []
  const mixed = new Set<string>()

  const h1: string[] = []
  const h2: string[] = []
  let heading: { tag: 'h1' | 'h2'; buf: string[] } | null = null

  const text: string[] = []
  const mainText: string[] = []
  const chromeFreeText: string[] = []

  let hiddenDepth = 0
  let mainDepth = 0
  let articleDepth = 0
  let chromeDepth = 0
  let sawMain = false
  let inBody = false
  let bodyScripts = 0
  let bodyElements = 0
  /** The mount element just opened, while nothing but whitespace or comments has followed it. */
  let mountPending: string | null = null
  let emptyMount = false

  const addMixed = (raw: string | undefined) => {
    if (!pageIsHttps || !raw) return
    const s = raw.trim()
    if (/^http:\/\//i.test(s)) mixed.add(s)
  }

  const endHeading = () => {
    if (!heading) return
    const t = cleanText(heading.buf.join(''))
    ;(heading.tag === 'h1' ? h1 : h2).push(t)
    heading = null
  }

  const pushText = (s: string) => {
    text.push(s)
    if (mainDepth > 0) mainText.push(s)
    if (chromeDepth === 0) chromeFreeText.push(s)
    if (heading) heading.buf.push(s)
  }

  tokenize(html, {
    open(name, a, selfClosing) {
      // Mount tracking comes before any early return: a child element means
      // the mount isn't empty. "/>" is ignored on these tags, as in browsers.
      mountPending = MOUNT_TAGS.has(name) && MOUNT_ID.test((a.id ?? '').trim()) ? name : null
      if (name === 'body') inBody = true
      if (hiddenDepth > 0) {
        if (HIDDEN_CONTAINERS.has(name) && !selfClosing) hiddenDepth++
        return
      }
      if (HIDDEN_CONTAINERS.has(name) && !selfClosing) {
        hiddenDepth++
        return
      }
      if (inBody && !NON_CONTENT.has(name)) bodyElements++
      if (!INLINE.has(name)) pushText(' ')

      switch (name) {
        case 'html':
          if (a.lang?.trim()) lang = a.lang.trim()
          break
        case 'base':
          if (a.href) {
            const b = resolveHref(a.href, pageUrl)
            if (b) base = b.href
          }
          break
        case 'meta': {
          const key = (a.name ?? a.property ?? a.itemprop ?? '').trim().toLowerCase()
          const content = a.content ?? ''
          if (key === 'description') {
            if (metaDescription === null) metaDescription = cleanText(content)
          } else if (key === 'robots' || key === 'googlebot') {
            if (content.trim()) robots.push(content.trim())
          } else if (key === 'viewport') {
            if (content.trim()) hasViewport = true
          } else if (/^(?:og|twitter|article):/.test(key)) {
            if (!(key in social) && content.trim()) social[key] = cleanText(content)
          }
          // Some sites use property="og:…" and name="twitter:…" on the same tag.
          const prop = (a.property ?? '').trim().toLowerCase()
          if (prop && prop !== key && /^(?:og|twitter|article):/.test(prop) && !(prop in social) && content.trim()) {
            social[prop] = cleanText(content)
          }
          break
        }
        case 'link': {
          const rel = (a.rel ?? '').toLowerCase().split(/\s+/)
          if (rel.includes('canonical')) {
            canonicalCount++
            if (canonical === null) canonical = (a.href ?? '').trim()
          }
          if (rel.some((r) => r === 'stylesheet' || r === 'icon' || r === 'preload' || r === 'modulepreload' || r === 'apple-touch-icon' || r === 'manifest')) {
            addMixed(a.href)
          }
          break
        }
        case 'a': {
          const href = a.href
          if (href === undefined) break
          const h = href.trim()
          if (/^tel:/i.test(h)) {
            telLinks.add(h)
            break
          }
          if (/^(?:mailto|javascript|sms|data|fax|skype|whatsapp):/i.test(h) || h.startsWith('#')) break
          const u = resolveHref(h, base)
          if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) break
          u.hash = ''
          if (!linkSeen.has(u.href) && links.length < MAX_LINKS) {
            linkSeen.add(u.href)
            links.push(u.href)
          }
          break
        }
        case 'img': {
          const src = a.src || a['data-src'] || a['data-lazy-src'] || srcsetUrls(a.srcset ?? a['data-srcset'] ?? '')[0] || ''
          addMixed(a.src)
          for (const s of srcsetUrls(a.srcset ?? '')) addMixed(s)
          if (heading && a.alt) heading.buf.push(` ${a.alt} `)
          if (images.length < MAX_IMAGES && src) {
            images.push({
              src: resolveSrc(src, base),
              alt: 'alt' in a ? cleanText(a.alt) : null,
              width: a.width?.trim() || null,
              height: a.height?.trim() || null,
              loading: a.loading?.trim().toLowerCase() || null,
              fill: fillsBox(a),
            })
          }
          break
        }
        case 'source':
          addMixed(a.src)
          for (const s of srcsetUrls(a.srcset ?? '')) addMixed(s)
          break
        case 'iframe':
        case 'embed':
        case 'video':
        case 'audio':
        case 'track':
          addMixed(a.src)
          if (name === 'video') addMixed(a.poster)
          break
        case 'input':
          if ((a.type ?? '').toLowerCase() === 'image') addMixed(a.src)
          break
        case 'h1':
        case 'h2':
          endHeading()
          heading = { tag: name, buf: [] }
          break
        case 'main':
          mainDepth++
          sawMain = true
          break
        case 'article':
          articleDepth++
          break
        default:
          if (CHROME.has(name) && mainDepth === 0 && articleDepth === 0) chromeDepth++
      }
    },

    close(name) {
      if (mountPending === name) emptyMount = true
      mountPending = null
      if (hiddenDepth > 0) {
        if (HIDDEN_CONTAINERS.has(name)) hiddenDepth--
        return
      }
      if (!INLINE.has(name)) pushText(' ')
      if (name === 'h1' || name === 'h2') {
        if (heading?.tag === name) endHeading()
      } else if (name === 'main') {
        mainDepth = Math.max(0, mainDepth - 1)
      } else if (name === 'article') {
        articleDepth = Math.max(0, articleDepth - 1)
      } else if (CHROME.has(name) && chromeDepth > 0 && mainDepth === 0 && articleDepth === 0) {
        chromeDepth--
      }
    },

    text(raw) {
      // Only whitespace keeps a mount empty. (Comments never reach the visitor.)
      if (mountPending && /\S/.test(raw)) mountPending = null
      if (hiddenDepth > 0 || !inBody) {
        // Text before <body> only exists in malformed pages that omit the
        // tag; the parser would put it in the body, so count it.
        if (hiddenDepth > 0 || /^\s*$/.test(raw)) return
        inBody = true
      }
      pushText(decodeEntities(raw))
    },

    rawText(name, a, content) {
      mountPending = null
      if (hiddenDepth > 0) return
      if (name === 'title') {
        if (title === null) title = cleanText(content)
        return
      }
      if (name === 'textarea') {
        pushText(decodeEntities(content))
        return
      }
      if (name !== 'script') return
      if (inBody) bodyScripts++
      addMixed(a.src)
      const type = (a.type ?? '').trim().toLowerCase().split(';')[0]
      if (type !== 'application/ld+json') return
      const parsed = parseJsonLd(content)
      if (!parsed) {
        if (content.trim()) parseErrors++
        return
      }
      if (!parsed.strict) parseErrors++
      blocks.push(parsed.value)
    },
  })
  endHeading()

  const allText = cleanText(text.join(''))
  const wordCount = countWords(allText)
  const mainWordCount = countWords(cleanText((sawMain ? mainText : chromeFreeText).join('')))

  // Sets, not includes(): a page can carry hundreds of thousands of these.
  const types = new Set<string>()
  for (const node of jsonLdNodes(blocks)) for (const t of nodeTypes(node)) types.add(t)

  // An SPA shell: next to no text, and either an empty mount point or a
  // body that is only script tags. Both conditions, so a short but real
  // server-rendered page never reads as a shell.
  const scriptOnlyBody = bodyScripts > 0 && bodyElements <= 5
  const clientRenderedShell = wordCount < 50 && (emptyMount || scriptOnlyBody)

  return {
    title: title || null,
    metaDescription: metaDescription || null,
    canonical: canonical === null ? null : canonical,
    canonicalCount,
    metaRobots: robots.length ? robots.join(', ') : null,
    lang,
    hasViewport,
    h1,
    h2,
    text: allText,
    wordCount,
    mainWordCount,
    social,
    jsonLd: { types: [...types], blocks, parseErrors },
    links,
    telLinks: [...telLinks],
    images,
    mixedContent: [...mixed],
    phones: findPhones(allText),
    clientRenderedShell,
  }
}
