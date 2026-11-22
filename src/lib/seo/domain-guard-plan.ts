/**
 * The domain guard's rules (pure: no I/O). See ./domain-guard.ts.
 *
 * A client site's code names its own domain in one place: SITE_URL in
 * src/lib/seo.ts, sometimes built from `website` in src/data/site.ts.
 * Every canonical link, og:url, the sitemap, llms.txt and the structured
 * data read it. Blank, and the sitemap answers 503 "Public domain pending
 * confirmation": Google gets no page list. Another domain (the client's
 * old site, a name they meant to buy), and every page tells Google the
 * real copy lives elsewhere while Search Console rejects the sitemap
 * ("URL not allowed"). On 2026-11-20, 34 of 53 live client sites had one
 * or the other.
 *
 * readLook: what the live site tells Google, and whether it needs fixing.
 * planDomainFix: the smallest set of file edits that point the code at the
 * domain the site is really served on.
 */

import { nameScore, squashName } from '@/lib/site-match'

/** Each site's state is the AppSetting `seo.domainGuard.<SEO site id>`. */
export const DOMAIN_GUARD_KEY_PREFIX = 'seo.domainGuard.'

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/** "WWW.Acme.com" → "acme.com". */
export function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
}

function urlOf(s: string | null | undefined, base?: string): URL | null {
  if (!s?.trim()) return null
  try {
    return new URL(s.trim(), base)
  } catch {
    return null
  }
}

function hostOf(s: string | null | undefined, base?: string): string | null {
  const u = urlOf(s, base)
  return u && /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : null
}

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)]

function listWords(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? ''
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every mention of `wrongBare` (with or without "www.") as a host becomes
 * `rightHost`. Never inside an email address ("info@acme.com" is a real
 * mailbox and stays), another host ("mail.acme.com", "myacme.com") or a
 * longer domain ("acme.com.au", "acme.community").
 */
export function replaceHost(text: string, wrongBare: string, rightHost: string): { text: string; count: number } {
  const wrong = bareHost(wrongBare)
  if (!wrong || bareHost(rightHost) === wrong) return { text, count: 0 }
  const re = new RegExp(`(?<![A-Za-z0-9@._%+-])(?:www\\.)?${escapeRe(wrong)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9-])`, 'gi')
  let count = 0
  const out = text.replace(re, () => {
    count++
    return rightHost
  })
  return { text: out, count }
}

// ---------------------------------------------------------------------------
// What the live site says
// ---------------------------------------------------------------------------

export type LiveLook = {
  /** The client's Site link in the Hub. */
  siteUrl: string
  /** Homepage fetch: status, where it ended up after redirects, who serves it. */
  status: number
  error: string | null
  finalUrl: string | null
  hosting: 'lovable' | 'wix' | 'squarespace' | null | undefined
  /** The homepage's <link rel="canonical"> and og:url, as written. */
  canonical: string | null
  ogUrl: string | null
  /** The homepage's <title> and og:site_name: whose site this is. */
  title: string | null
  siteName: string | null
  /** GET /sitemap.xml: status and body (null when it didn't answer). */
  sitemap: { status: number; body: string | null }
}

export type DomainProblem = 'wrong_domain' | 'sitemap_wrong_host' | 'sitemap_pending' | 'sitemap_broken'

export type LookVerdict =
  | { kind: 'ok'; servedOrigin: string; pages: number; summary: string }
  | { kind: 'fix'; servedOrigin: string; problem: DomainProblem; wrongHosts: string[]; summary: string }
  | { kind: 'person'; summary: string }

const PENDING_RE = /pending confirmation/i

/** The sitemap's <loc> hosts and count, and whether it is a sitemap at all. */
export function readSitemap(s: LiveLook['sitemap']): { xml: boolean; pending: boolean; hosts: string[]; count: number } {
  const body = s.body ?? ''
  const xml = s.status === 200 && /<(?:urlset|sitemapindex)[\s>]/i.test(body)
  const hosts: string[] = []
  let count = 0
  if (xml) {
    for (const m of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      count++
      const h = hostOf(m[1])
      if (h) hosts.push(h)
    }
  }
  return { xml, pending: !xml && PENDING_RE.test(body), hosts: unique(hosts), count }
}

/**
 * Does the live site tell Google the right domain? `person` means the Hub
 * mustn't touch it: the site doesn't load, its Site link redirects to
 * another host, or it isn't our Lovable build.
 */
export function readLook(look: LiveLook): LookVerdict {
  const site = urlOf(look.siteUrl)
  if (!site || !/^https?:$/.test(site.protocol)) return { kind: 'person', summary: 'The Site link in the Hub isn’t a web address.' }
  if (look.status !== 200 || look.error) {
    return { kind: 'person', summary: `${site.origin} doesn’t load (${look.error ?? `HTTP ${look.status}`}), so the Hub can’t check what it tells Google.` }
  }
  const served = urlOf(look.finalUrl) ?? site
  const host = bareHost(served.hostname)
  if (host !== bareHost(site.hostname)) {
    return {
      kind: 'person',
      summary: `${site.origin} redirects to ${served.origin}. Set the client’s Site link to ${served.origin} and the Hub takes it from there.`,
    }
  }
  if (look.hosting !== 'lovable') {
    const who = look.hosting === 'wix' ? 'a Wix site' : look.hosting === 'squarespace' ? 'a Squarespace site' : 'not served by Lovable'
    return { kind: 'person', summary: `${served.origin} is ${who}, so it isn’t the site the Hub built. The Hub only fixes its own builds.` }
  }
  const servedOrigin = served.origin
  const sm = readSitemap(look.sitemap)
  const declared = unique([hostOf(look.canonical, servedOrigin), hostOf(look.ogUrl, servedOrigin)].filter((h): h is string => !!h))
  const wrongDeclared = unique(declared.map(bareHost).filter((h) => h !== host))
  const wrongSitemap = unique(sm.hosts.map(bareHost).filter((h) => h !== host))
  const wrongHosts = unique([...wrongDeclared, ...wrongSitemap])

  if (wrongDeclared.length) {
    return {
      kind: 'fix',
      servedOrigin,
      problem: 'wrong_domain',
      wrongHosts,
      summary: `Every page tells Google its real address is on ${listWords(wrongHosts)}, not ${host}${wrongSitemap.length ? ', and the sitemap lists pages there too' : ''}. Google indexes the other domain or nothing.`,
    }
  }
  if (wrongSitemap.length) {
    return {
      kind: 'fix',
      servedOrigin,
      problem: 'sitemap_wrong_host',
      wrongHosts,
      summary: `The sitemap lists its ${sm.count} pages on ${listWords(wrongSitemap)} instead of ${host}, so Search Console rejects every one (“URL not allowed”).`,
    }
  }
  if (!sm.xml) {
    return sm.pending
      ? {
          kind: 'fix',
          servedOrigin,
          problem: 'sitemap_pending',
          wrongHosts: [],
          summary: `The site’s code was never told its domain: the sitemap answers “Public domain pending confirmation”, and pages carry no canonical link. Google gets no page list.`,
        }
      : {
          kind: 'fix',
          servedOrigin,
          problem: 'sitemap_broken',
          wrongHosts: [],
          summary: `${servedOrigin}/sitemap.xml doesn’t answer with a sitemap (HTTP ${look.sitemap.status || 'no answer'}), so Google gets no page list.`,
        }
  }
  return {
    kind: 'ok',
    servedOrigin,
    pages: sm.count,
    summary: `Canonical links and all ${sm.count} sitemap page${sm.count === 1 ? '' : 's'} name ${host}.`,
  }
}

// ---------------------------------------------------------------------------
// Whose site
// ---------------------------------------------------------------------------

/**
 * The business's names in the repo's site data (src/data/site.ts): name,
 * displayName, legalName, businessName, read from the `business` block only
 * (services and social links have a `name` too). Values may hold an
 * apostrophe ("Jake's Property Maintenance").
 */
export function repoBusinessNames(siteTs: string | null | undefined): string[] {
  if (!siteTs) return []
  const at = siteTs.search(/export\s+const\s+business\b/)
  const start = Math.max(0, at)
  // The block ends at the first closing brace at the start of a line ("};").
  const end = siteTs.slice(start).search(/\n\}\s*;?/)
  const body = siteTs.slice(start, end > 0 ? start + end : start + 6000)
  const names: string[] = []
  for (const key of ['name', 'displayName', 'legalName', 'businessName']) {
    const m = new RegExp(`(?<![A-Za-z0-9_$])["']?${key}["']?\\s*:\\s*(["'\`])((?:(?!\\1)[^\\\\\\n]|\\\\.){2,120})\\1`).exec(body)
    if (m) names.push(m[2].replace(/\\(.)/g, '$1').trim())
  }
  return unique(names)
}

/** The few entities a page title or og:site_name carries, for comparing names. */
function decodeBasic(s: string): string {
  return s
    .replace(/&#x27;|&#39;|&apos;|&rsquo;|&lsquo;|[‘’]/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;|&#38;/gi, '&')
}

/** Lowercase letters and digits, "&" as "and", a trailing LLC/Inc/Corp/Co dropped. */
function plainName(s: string): string {
  return decodeBasic(s)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(?:llc|inc|corp|co)$/, '')
}

/** Two spellings of one business: "Done Rite Appliance Repair CO" ~ "Done Rite Appliance Repair Co.". */
export function sameBusiness(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false
  const pa = plainName(a)
  const pb = plainName(b)
  // Short names ("BNB Contractors", "GTC Services") lose too much to trade-word stripping: compare as written.
  if (pa.length >= 3 && pa === pb) return true
  if (pa.length >= 6 && pb.length >= 6 && (pa.includes(pb) || pb.includes(pa))) return true
  const x = squashName(decodeBasic(a))
  const y = squashName(decodeBasic(b))
  if (x.length >= 3 && x === y) return true
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true
  return nameScore(decodeBasic(a), decodeBasic(b)) >= 0.6
}

/**
 * Is the repo the build serving this domain, and this client's? The live
 * homepage must show the repo's business name, and the repo must name the
 * client. Null when both hold, else why not (in plain words).
 */
export function identityProblem(o: {
  repo: string
  repoNames: string[]
  live: { title: string | null; siteName: string | null }
  hubNames: string[]
  origin: string
}): string | null {
  if (!o.repoNames.length) return `${o.repo} has no business name in src/data/site.ts, so the Hub can’t confirm it is the site on ${o.origin}. Fix it by hand, or check the Repo picked for this client.`
  const shown = [o.live.siteName, o.live.title].filter((s): s is string => !!s?.trim())
  const liveMatch = o.repoNames.some((n) => shown.some((s) => sameBusiness(n, s)))
  if (!liveMatch) {
    return `${o.origin} shows “${shown[0] ?? 'no title'}”, but ${o.repo} is “${o.repoNames[0]}”. The Repo picked for this client may be the wrong one, so the Hub left it alone.`
  }
  const hubMatch = o.repoNames.some((n) => o.hubNames.some((h) => sameBusiness(n, h)))
  if (!hubMatch) {
    return `${o.repo} is “${o.repoNames[0]}”, which doesn’t look like ${o.hubNames.filter(Boolean)[0] ?? 'this client'}. Check the client’s Site and Repo before the Hub changes it.`
  }
  return null
}

// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------

export const SEO_LIB = 'src/lib/seo.ts'
export const ROBOTS = 'public/robots.txt'
export const SEO_CONFIG = 'src/content/seo.config.json'
export const SITE_DATA = 'src/data/site.ts'

/** Files read for every fix: where the domain is set, robots.txt and the SEO config. */
export const CORE_FILES = [SEO_LIB, ROBOTS, SEO_CONFIG, SITE_DATA]

const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|mdx?|txt|xml|html?|ya?ml|webmanifest)$/i
const IN_SCOPE = /^(?:src|public|tests?|\.lovable)\/|^[^/]+\.(?:md|html?)$|^vite\.config\.[cm]?[jt]s$/i
const SKIP = /(?:^|\/)(?:node_modules|dist|build|\.output|\.vinxi|\.nitro|\.git)\/|\.asset\.json$|(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|routeTree\.gen\.ts$/i
const MAX_SCAN_BYTES = 300_000
export const MAX_SCAN_FILES = 400

/** Text files that can name the site's domain: the ones read when moving it off another host. */
export function scanCandidates(entries: { path: string; type: string; size: number | null }[]): string[] {
  return entries
    .filter((e) => e.type === 'blob' && (e.size ?? 0) <= MAX_SCAN_BYTES && TEXT_EXT.test(e.path) && IN_SCOPE.test(e.path) && !SKIP.test(e.path))
    .map((e) => e.path)
    .slice(0, MAX_SCAN_FILES)
}

const SITE_URL_RE = /(export\s+const\s+SITE_URL\s*(?::\s*string\s*)?=\s*)(["'`])([^"'`]*)\2/
const SITEMAP_LINE_RE = /^Sitemap:[ \t]*(\S*)[ \t]*$/im

/** SITE_URL as written: a plain string, or an expression (`https://${business.website}`). */
export function readSiteUrl(seoLib: string | null | undefined): { literal: string } | { expression: string } | null {
  const m = seoLib ? SITE_URL_RE.exec(seoLib) : null
  if (!m) return null
  return m[2] === '`' && m[3].includes('${') ? { expression: m[3] } : { literal: m[3].replace(/\/+$/, '') }
}

export type PlannedChange = { path: string; content: string; reason: string; existed: boolean }

export type DomainFixPlan = {
  changes: PlannedChange[]
  /** What the fix does, in plain words (pull request and the Hub). */
  notes: string[]
  /** Set when the domain had to change and the code gave nowhere to change it. */
  unresolved: string | null
}

/**
 * Point the site's code at `servedOrigin`: every mention of a wrong host
 * (never an email address), SITE_URL itself, the robots.txt Sitemap line,
 * and the SEO config with this site's own IndexNow key (remixed sites
 * carry the template's, whose key file proves another site).
 */
export function planDomainFix(o: {
  files: { path: string; content: string }[]
  repoPaths: string[]
  servedOrigin: string
  wrongHosts: string[]
  indexNowKey: string
}): DomainFixPlan {
  const origin = o.servedOrigin.replace(/\/+$/, '')
  const host = new URL(origin).host
  const original = new Map(o.files.map((f) => [f.path, f.content]))
  const next = new Map(original)
  const reasons = new Map<string, string[]>()
  const say = (path: string, why: string) => reasons.set(path, [...(reasons.get(path) ?? []), why])
  const notes: string[] = []
  const wrong = unique(o.wrongHosts.map(bareHost)).filter((h) => h && h !== bareHost(host))

  // 1. Every mention of a wrong host, emails aside.
  let moved = 0
  for (const [path, content] of next) {
    let text = content
    let n = 0
    for (const w of wrong) {
      const r = replaceHost(text, w, host)
      text = r.text
      n += r.count
    }
    if (n) {
      next.set(path, text)
      moved += n
      say(path, `${n} mention${n === 1 ? '' : 's'} of ${listWords(wrong)} now name${n === 1 ? 's' : ''} ${host}`)
    }
  }
  if (moved) notes.push(`Moved ${moved} mention${moved === 1 ? '' : 's'} of ${listWords(wrong)} to ${host} (email addresses left as they are).`)

  // 2. SITE_URL: a blank or other domain becomes this one. An expression
  //    (`https://${business.website}`) follows the site data fixed above.
  const seoLib = next.get(SEO_LIB) ?? null
  const siteUrl = readSiteUrl(seoLib)
  let domainSet = false
  if (seoLib && siteUrl && 'literal' in siteUrl) {
    if (siteUrl.literal !== origin) {
      next.set(SEO_LIB, seoLib.replace(SITE_URL_RE, (_m, head: string, q: string) => `${head}${q}${origin}${q}`))
      say(SEO_LIB, `SITE_URL now names ${origin}${siteUrl.literal ? ` (it said ${siteUrl.literal})` : ' (it was blank)'}`)
      notes.push(
        siteUrl.literal
          ? `SITE_URL said ${siteUrl.literal}; it now names ${origin}, so canonical links, og:url, the sitemap and structured data follow.`
          : `SITE_URL was blank (the sitemap answered “Public domain pending confirmation”); it now names ${origin}.`,
      )
    }
    domainSet = true
  } else if (siteUrl && 'expression' in siteUrl) {
    domainSet = moved > 0 || wrong.length === 0
  }

  // 3. robots.txt names the sitemap.
  const sitemapUrl = `${origin}/sitemap.xml`
  const robots = next.get(ROBOTS)
  if (robots != null) {
    const line = SITEMAP_LINE_RE.exec(robots)
    if (!line) {
      next.set(ROBOTS, `${robots.replace(/\s*$/, '')}\n\nSitemap: ${sitemapUrl}\n`)
      say(ROBOTS, `adds “Sitemap: ${sitemapUrl}”`)
    } else if (line[1] !== sitemapUrl) {
      next.set(ROBOTS, robots.replace(SITEMAP_LINE_RE, `Sitemap: ${sitemapUrl}`))
      say(ROBOTS, `the Sitemap line now names ${sitemapUrl}`)
    }
  }

  // 4. The SEO config: this site's URL and its own IndexNow key, with the key file.
  const configText = next.get(SEO_CONFIG)
  if (configText != null) {
    let config: Record<string, unknown> | null = null
    try {
      const v: unknown = JSON.parse(configText.replace(/^﻿/, ''))
      config = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      config = null
    }
    if (config) {
      const urlNow = typeof config.siteUrl === 'string' ? config.siteUrl.replace(/\/+$/, '') : ''
      const keyNow = typeof config.indexNowKey === 'string' ? config.indexNowKey : null
      if (urlNow !== origin || keyNow !== o.indexNowKey) {
        next.set(SEO_CONFIG, `${JSON.stringify({ ...config, siteUrl: origin, indexNowKey: o.indexNowKey }, null, 2)}\n`)
        say(SEO_CONFIG, `records ${origin} and this site’s own IndexNow key`)
      }
      const keyFile = `public/${o.indexNowKey}.txt`
      if (!o.repoPaths.includes(keyFile) && !next.has(keyFile)) {
        next.set(keyFile, o.indexNowKey)
        say(keyFile, 'IndexNow key file, so Bing and the other IndexNow engines accept the Hub’s pings')
      }
    }
  }

  const changes: PlannedChange[] = []
  for (const [path, content] of next) {
    if (original.get(path) === content) continue
    changes.push({ path, content, reason: `${(reasons.get(path) ?? ['updated']).join('; ')}.`, existed: original.has(path) })
  }

  const unresolved = domainSet
    ? null
    : seoLib == null
      ? `The site’s code has no ${SEO_LIB}, so the Hub can’t tell where it names its domain. Fix it in Lovable.`
      : `The Hub couldn’t find where ${SEO_LIB} sets the site’s domain (SITE_URL). Fix it in Lovable.`
  return { changes, notes, unresolved }
}
