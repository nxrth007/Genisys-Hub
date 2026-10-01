import { getBranchHead, getRepo, getTree, readBlob, recentCommits } from './github'
import type { RepoFile, RepoSnapshot, SitePlatform } from './types'

/**
 * What a site's repo looks like right now — the engine's view of the code
 * before it plans or writes anything.
 *
 * One snapshot per run, all read at a single commit (the default branch's
 * head when the snapshot starts), so the file list, the key files and the
 * facts parsed out of them can't disagree with each other even if Lovable
 * pushes mid-run.
 *
 * The facts that keep generated content honest come from the template's
 * data files: existing post slugs (never reuse one), `projectPhotos` keys
 * (the only images a post may reference) and service slugs (the only
 * service pages a post may link to). Those files are TypeScript, not JSON,
 * so they're read with a small comment- and string-aware scanner rather
 * than a naive regex — a "}" or "slug:" inside a paragraph of copy must not
 * derail it.
 */

const MAX_PATHS = 3000
const FILE_CHAR_CAP = 40_000
const TOTAL_CHAR_CAP = 250_000
/** Below this much budget left, a file isn't worth including as a stub. */
const MIN_FILE_SLICE = 1000
/** None of the files read here should come close; anything bigger is skipped. */
const MAX_READ_BYTES = 2_000_000
const READ_CONCURRENCY = 6
const CONTENT_POSTS_INCLUDED = 3

/** Dependency and build-output folders — never source, and they'd crowd real paths out of the cap. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.output', '.wrangler', '.vercel', '.netlify', '.nitro', '.turbo', '.cache'])

/** Key files Claude sees verbatim, most important first (the total cap is spent in this order). */
const KEY_FILES = [
  'package.json',
  'AGENTS.md',
  'public/robots.txt',
  'src/data/site.ts',
  'src/data/blog.ts',
  'src/lib/seo.ts',
  'src/routes/__root.tsx',
  'src/routes/blog.$slug.tsx',
  'src/routes/blog.index.tsx',
  'src/routes/services.$slug.tsx',
  'src/routes/index.tsx',
  'src/content/seo.config.json',
  'tsconfig.json',
]
/**
 * Every page route, after the key files. The first foundation only saw
 * four routes and so could only make four canonicals absolute; a change
 * that applies to "every route" needs every route in front of it.
 */
const PAGE_ROUTE_RE = /^src\/routes\/[^/]+\.tsx$/
const MAX_PAGE_ROUTES = 40
/** sitemap[.]xml.ts, llms[.]txt.ts and friends, wherever they sit under src/routes. */
const SEO_ROUTE_RE = /^src\/routes\/(?:.*\/)?(?:sitemap|llms)[^/]*$/i
/** index.html is the SPA shell (older Lovable apps); the public/ files are static fallbacks worth auditing. */
const EXTRA_FILES = ['index.html', 'public/sitemap.xml', 'public/llms.txt']
const CONTENT_POST_RE = /^src\/content\/blog\/[^/]+\.json$/i
const ROUTE_FILE_RE = /\.(?:tsx|ts|jsx|js)$/i

export async function snapshotRepo(fullName: string): Promise<RepoSnapshot> {
  const repo = await getRepo(fullName)
  // Canonical name from GitHub: follows renames and fixes case.
  const name = repo.fullName
  const head = await getBranchHead(name, repo.defaultBranch)
  const [tree, commits] = await Promise.all([getTree(name, head.treeSha), recentCommits(name, head.sha, 1)])

  const blobs = new Map<string, { sha: string; size: number | null }>()
  for (const e of tree.entries) if (e.type === 'blob') blobs.set(e.path, { sha: e.sha, size: e.size })
  const allPaths = [...blobs.keys()]
  const has = (p: string) => blobs.has(p)

  const paths = allPaths
    .filter((p) => !p.split('/').slice(0, -1).some((seg) => SKIP_DIRS.has(seg)))
    .slice(0, MAX_PATHS)

  const contentPostPaths = allPaths.filter((p) => CONTENT_POST_RE.test(p))
  const keyPaths = unique([
    ...KEY_FILES.filter(has),
    ...allPaths.filter((p) => SEO_ROUTE_RE.test(p)),
    ...EXTRA_FILES.filter(has),
    ...allPaths.filter((p) => PAGE_ROUTE_RE.test(p)).sort().slice(0, MAX_PAGE_ROUTES),
  ])

  // Blobs by sha, not paths by ref: everything comes from the same tree.
  const texts = new Map<string, string | null>()
  await mapLimit(unique([...keyPaths, ...contentPostPaths]), READ_CONCURRENCY, async (p) => {
    const b = blobs.get(p)
    texts.set(p, !b || (b.size ?? 0) > MAX_READ_BYTES ? null : await readBlob(name, b.sha))
  })

  const pkg = parseJsonObject(texts.get('package.json'))
  const platform = detectPlatform(pkg, allPaths)

  const siteTs = texts.get('src/data/site.ts') ?? null
  const blogTs = texts.get('src/data/blog.ts') ?? null
  const site = siteTs ? scanSource(siteTs) : null
  const imageKeys = site ? objectKeys(site, 'projectPhotos') : []
  const serviceSlugs = site ? unique(arrayItems(site, 'services', ['slug']).map((i) => i.slug).filter(isString)) : []

  const contentPosts = contentPostPaths.map((p) => {
    const file = p.slice(p.lastIndexOf('/') + 1).replace(/\.json$/i, '')
    // Bad JSON still reserves its slug: the file exists, so the URL may too.
    const j = parseJsonObject(texts.get(p))
    const slug = str(j?.slug) ?? file
    return { path: p, file, slug, title: str(j?.title) ?? slug, date: str(j?.updated) ?? str(j?.date) ?? '' }
  })

  const blogPosts: RepoSnapshot['blogPosts'] = []
  const seenPost = new Set<string>()
  const addPost = (slug: string, title: string, source: 'data' | 'content') => {
    const k = `${source}:${slug}`
    if (seenPost.has(k)) return
    seenPost.add(k)
    blogPosts.push({ slug, title, source })
  }
  if (blogTs) for (const p of dataBlogPosts(scanSource(blogTs))) addPost(p.slug, p.title, 'data')
  for (const p of contentPosts) addPost(p.slug, p.title, 'content')

  // Newest posts by their own date (YYYY-MM-DD sorts as text), then file name.
  const newestContent = [...contentPosts]
    .sort((a, b) => b.date.localeCompare(a.date) || b.file.localeCompare(a.file))
    .slice(0, CONTENT_POSTS_INCLUDED)
    .map((p) => p.path)

  const files: RepoFile[] = []
  let budget = TOTAL_CHAR_CAP
  for (const p of [...keyPaths, ...newestContent]) {
    const text = texts.get(p)
    if (text == null || budget < MIN_FILE_SLICE) continue
    const cap = Math.min(FILE_CHAR_CAP, budget)
    const truncated = text.length > cap
    const content = truncated ? safeSlice(text, cap) : text
    budget -= content.length
    files.push({ path: p, content, truncated })
  }

  let routes = allPaths.filter((p) => p.startsWith('src/routes/') && ROUTE_FILE_RE.test(p))
  // Older Lovable SPAs keep pages in src/pages (react-router), not file routes.
  if (routes.length === 0 && platform === 'lovable-spa') {
    routes = allPaths.filter((p) => p.startsWith('src/pages/') && ROUTE_FILE_RE.test(p))
  }

  const last = commits[0]
  return {
    fullName: name,
    defaultBranch: repo.defaultBranch,
    headSha: head.sha,
    htmlUrl: repo.htmlUrl,
    platform,
    template: has('src/data/site.ts') && has('src/data/blog.ts') ? 'genisys-lovable' : null,
    foundationInstalled: has('src/content/seo.config.json'),
    paths,
    routes,
    files,
    blogPosts,
    imageKeys,
    serviceSlugs,
    lastCommit: last
      ? { sha: last.sha, author: last.author, date: last.date, message: last.message, byLovable: last.byLovable }
      : null,
    hasCiWorkflow: has('.github/workflows/seo-verify.yml'),
  }
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

function detectPlatform(pkg: Record<string, unknown> | null, paths: string[]): SitePlatform {
  if (!pkg) return 'other'
  const deps = new Set([
    ...Object.keys(asObject(pkg.dependencies)),
    ...Object.keys(asObject(pkg.devDependencies)),
    ...Object.keys(asObject(pkg.peerDependencies)),
  ])
  // .lovable/ ships with current templates; older Lovable SPAs only carry
  // lovable-tagger (the editor's component tagger) in devDependencies.
  const lovable =
    paths.some((p) => p.startsWith('.lovable/')) ||
    [...deps].some((d) => d.startsWith('@lovable.dev/') || d === 'lovable-tagger')
  if (deps.has('@tanstack/react-start')) return lovable ? 'lovable-tanstack' : 'other'
  if (deps.has('vite') && deps.has('react') && lovable) return 'lovable-spa'
  return 'other'
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

type Scan = {
  src: string
  /** `src` with comments and string contents blanked; same length, same indices. */
  masked: string
  /** Bracket depth before each index of `masked`. */
  depth: Int32Array
}

/**
 * Blank comment bodies and string/template contents (keeping newlines and
 * the quote characters), so brackets, commas and keys can be found
 * structurally while values are read back from the original at the same
 * index. Regex literals aren't recognised — data files don't use them.
 */
function maskSource(src: string): string {
  const out = src.split('')
  const n = src.length
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }

  /** From an opening ' or ", returns the index just past the closing quote. */
  const skipString = (start: number, q: string): number => {
    let k = start + 1
    while (k < n && src[k] !== q && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1
    blank(start + 1, k)
    return k + 1
  }

  /** From an opening backtick; `${…}` expressions are blanked along with the text. */
  const skipTemplate = (start: number): number => {
    let k = start + 1
    while (k < n && src[k] !== '`') {
      if (src[k] === '\\') k += 2
      else if (src[k] === '$' && src[k + 1] === '{') k = skipCode(k + 2, true)
      else k++
    }
    blank(start + 1, k)
    return k + 1
  }

  /** Code until end of input, or (untilBrace) until the "}" closing a template expression. */
  const skipCode = (start: number, untilBrace: boolean): number => {
    let depth = 0
    let k = start
    while (k < n) {
      const c = src[k]
      if (c === '"' || c === "'") k = skipString(k, c)
      else if (c === '`') k = skipTemplate(k)
      else if (c === '/' && src[k + 1] === '/') {
        const end = src.indexOf('\n', k)
        const stop = end === -1 ? n : end
        blank(k, stop)
        k = stop
      } else if (c === '/' && src[k + 1] === '*') {
        const end = src.indexOf('*/', k + 2)
        const stop = end === -1 ? n : end + 2
        blank(k, stop)
        k = stop
      } else {
        if (untilBrace) {
          if (c === '{') depth++
          else if (c === '}') {
            if (depth === 0) return k + 1
            depth--
          }
        }
        k++
      }
    }
    return n
  }

  skipCode(0, false)
  return out.join('')
}

function scanSource(src: string): Scan {
  const masked = maskSource(src)
  const depth = new Int32Array(masked.length + 1)
  let d = 0
  for (let i = 0; i < masked.length; i++) {
    depth[i] = d
    const c = masked[i]
    if (c === '{' || c === '[' || c === '(') d++
    else if (c === '}' || c === ']' || c === ')') d = Math.max(0, d - 1)
  }
  depth[masked.length] = d
  return { src, masked, depth }
}

function matchingClose(s: Scan, open: number): number {
  const outer = s.depth[open]
  for (let j = open + 1; j < s.masked.length; j++) {
    const c = s.masked[j]
    if ((c === '}' || c === ']' || c === ')') && s.depth[j + 1] === outer) return j
  }
  return -1
}

/**
 * The `{…}` or `[…]` literal a `const name = …` declaration is initialised
 * with, as [openIndex, closeIndex]. Tolerates a type annotation and a
 * wrapper call (`Object.freeze(…)`, `makeList(…)`) around the literal.
 */
function declarationBody(s: Scan, name: string, open: '{' | '['): [number, number] | null {
  const re = new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${name}(?![\\w$])`, 'g')
  for (let m = re.exec(s.masked); m; m = re.exec(s.masked)) {
    const after = m.index + m[0].length
    let eq = -1
    for (let k = after; k < Math.min(after + 400, s.masked.length); k++) {
      const c = s.masked[k]
      if (c === ';') break
      if (c === '=' && s.masked[k + 1] !== '>' && s.masked[k + 1] !== '=') {
        eq = k
        break
      }
    }
    if (eq === -1) continue
    const at = s.masked.indexOf(open, eq + 1)
    if (at === -1 || !/^[\s\w$.(]*$/.test(s.masked.slice(eq + 1, at))) continue
    const close = matchingClose(s, at)
    if (close !== -1) return [at, close]
  }
  return null
}

/** Top-level elements of the literal opened at `open`, as [start, end) ranges. */
function topLevelItems(s: Scan, open: number, close: number): [number, number][] {
  const inner = s.depth[open] + 1
  const out: [number, number][] = []
  let from = open + 1
  for (let j = open + 1; j < close; j++) {
    if (s.masked[j] === ',' && s.depth[j] === inner) {
      out.push([from, j])
      from = j + 1
    }
  }
  out.push([from, close])
  return out.filter(([a, b]) => s.masked.slice(a, b).trim() !== '')
}

type Prop = { key: string; at: number; value: number; depth: number }

/**
 * Object property keys in [from, to): `key:`, `"key":` or `'key':`, each
 * directly after "{" or "," — which rules out ternaries and type
 * annotations. `value` is the index of the value's first character.
 */
function propsIn(s: Scan, from: number, to: number): Prop[] {
  const out: Prop[] = []
  const slice = s.masked.slice(from, to)
  const re = /(?<![\w$])([A-Za-z_$][\w$]*)\s*:(?!:)|(["'])( *)\2\s*:/g
  for (let m = re.exec(slice); m; m = re.exec(slice)) {
    const at = from + m.index
    let p = at - 1
    while (p >= 0 && /\s/.test(s.masked[p])) p--
    if (p >= 0 && s.masked[p] !== '{' && s.masked[p] !== ',') continue
    const key = m[1] ?? unescapeJs(s.src.slice(at + 1, at + 1 + m[3].length))
    let value = at + m[0].length
    while (value < to && /\s/.test(s.masked[value])) value++
    out.push({ key, at, value, depth: s.depth[at] })
  }
  return out
}

/** The string literal starting at `pos`, or null if it's anything else (or a template with `${}`). */
function literalAt(s: Scan, pos: number): string | null {
  const q = s.masked[pos]
  if (q !== '"' && q !== "'" && q !== '`') return null
  const close = s.masked.indexOf(q, pos + 1)
  if (close === -1) return null
  const raw = s.src.slice(pos + 1, close)
  if (q === '`' && raw.includes('${')) return null
  return unescapeJs(raw)
}

/** Keys of `const name = { … }`, in order. Spreads and computed keys are skipped. */
function objectKeys(s: Scan, name: string): string[] {
  const body = declarationBody(s, name, '{')
  if (!body) return []
  const inner = s.depth[body[0]] + 1
  const props = propsIn(s, body[0] + 1, body[1]).filter((p) => p.depth === inner)
  const keys: string[] = []
  for (const [a, b] of topLevelItems(s, body[0], body[1])) {
    let start = a
    while (start < b && /\s/.test(s.masked[start])) start++
    if (s.masked.startsWith('...', start)) continue
    const prop = props.find((p) => p.at === start)
    if (prop) keys.push(prop.key)
    else {
      // Shorthand `{ logo, patio }`.
      const bare = s.masked.slice(start, b).trim()
      if (/^[A-Za-z_$][\w$]*$/.test(bare)) keys.push(bare)
    }
  }
  return unique(keys)
}

/**
 * For each element of `const name = [ … ]`, the string values of `fields`
 * on the element's outermost object — `{ slug: "…" }` directly or wrapped
 * as `makePost({ slug: "…" })`. Nested objects (sections, faqs) are ignored.
 */
function arrayItems(s: Scan, name: string, fields: string[]): Record<string, string | null>[] {
  const body = declarationBody(s, name, '[')
  if (!body) return []
  const out: Record<string, string | null>[] = []
  for (const [a, b] of topLevelItems(s, body[0], body[1])) {
    const props = propsIn(s, a, b).filter((p) => fields.includes(p.key))
    if (props.length === 0) continue
    const depth = Math.min(...props.map((p) => p.depth))
    const row: Record<string, string | null> = {}
    for (const f of fields) {
      const p = props.find((x) => x.key === f && x.depth === depth)
      row[f] = p ? literalAt(s, p.value) : null
    }
    out.push(row)
  }
  return out
}

/**
 * Posts in src/data/blog.ts. Prefers the `blogPosts` array; if the file is
 * shaped differently, falls back to pairing every literal `slug:` with the
 * next `title:` at the same depth.
 */
function dataBlogPosts(s: Scan): { slug: string; title: string }[] {
  const fromArray = arrayItems(s, 'blogPosts', ['slug', 'title'])
    .filter((r): r is { slug: string; title: string | null } => typeof r.slug === 'string' && r.slug !== '')
    .map((r) => ({ slug: r.slug, title: r.title || r.slug }))
  if (fromArray.length > 0) return fromArray

  const props = propsIn(s, 0, s.masked.length).filter((p) => p.key === 'slug' || p.key === 'title')
  const out: { slug: string; title: string }[] = []
  props.forEach((p, i) => {
    if (p.key !== 'slug') return
    const slug = literalAt(s, p.value)
    if (!slug) return
    let title: string | null = null
    for (const q of props.slice(i + 1)) {
      if (q.depth !== p.depth) continue
      if (q.key === 'slug') break
      title = literalAt(s, q.value)
      break
    }
    out.push({ slug, title: title || slug })
  })
  return out
}

/** Undo JS string escapes: \n, \t, \', \", \\, \xNN, \uNNNN, \u{…}, line continuations. */
function unescapeJs(raw: string): string {
  if (!raw.includes('\\')) return raw
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, e: string) => {
    if (e.length > 1 && (e[0] === 'u' || e[0] === 'x')) {
      const hex = e[1] === '{' ? e.slice(2, -1) : e.slice(1)
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return e
      }
    }
    switch (e) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case 'v':
        return '\v'
      case '0':
        return '\0'
      case '\n':
      case '\r':
      case '\r\n':
        return ''
      default:
        return e
    }
  })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const isString = (v: string | null | undefined): v is string => typeof v === 'string' && v !== ''

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null
  try {
    // Editors on Windows sometimes save JSON with a BOM, which JSON.parse rejects.
    const v: unknown = JSON.parse(text.replace(/^﻿/, ''))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

/** Cut to `max` chars without leaving half of a surrogate pair at the end. */
function safeSlice(text: string, max: number): string {
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
