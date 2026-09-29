import type { AuditResult, BusinessFacts, CrawlResult, Finding, FindingSeverity, PageData, PsiResult } from './types'
import { bareHost, isAbsoluteHttpUrl, jsonLdNodes, nodeTypes, resolveHref, urlKey, type JsonLdNode } from './html'

/**
 * Deterministic technical audit of one crawl — the playbook's §5 checklist
 * (T1–T28; T15 field data only when PageSpeed has it, T29 needs Search
 * Console and lives elsewhere).
 *
 * Pure: the same crawl, facts and PageSpeed result always give the same
 * findings and score, so a week-over-week delta means the site changed,
 * not the auditor. Everything is judged on raw HTML, which is what the
 * non-rendering AI crawlers get. Where evidence is thin the audit stays
 * quiet rather than guess — a false P0 costs more trust than a missed P2.
 */

const PENALTY: Record<FindingSeverity, number> = { P0: 15, P1: 6, P2: 2 }
const SEVERITY_ORDER: Record<FindingSeverity, number> = { P0: 0, P1: 1, P2: 2 }
const STATUS_ORDER: Record<Finding['status'], number> = { fail: 0, warn: 1, pass: 2 }
const MAX_URLS = 25

/** Blocking these hides the site from search and AI answers (playbook T5). */
const SEARCH_BOTS = ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Applebot']
/** Training and user-fetch agents: blocking them is a choice with a cost, not an outage. */
const OTHER_BOTS = ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'Google-Extended']

const LOCAL_BUSINESS_TYPES = new Set([
  'LocalBusiness', 'HomeAndConstructionBusiness', 'GeneralContractor', 'RoofingContractor', 'Electrician',
  'HVACBusiness', 'HousePainter', 'Locksmith', 'MovingCompany', 'Plumber', 'ProfessionalService',
  'AutomotiveBusiness', 'EmergencyService', 'FinancialService', 'HomeGoodsStore', 'LegalService',
  'RealEstateAgent', 'MedicalBusiness', 'Dentist', 'HealthAndBeautyBusiness', 'LodgingBusiness',
  'FoodEstablishment', 'Store', 'ChildCare', 'DryCleaningOrLaundry', 'EntertainmentBusiness',
  'SportsActivityLocation', 'SelfStorage', 'TravelAgency', 'EmploymentAgency', 'RecyclingCenter',
])
const ARTICLE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'Report', 'LiveBlogPosting'])

/** Directory/social roots that show up as "sameAs" or footer icons before anyone fills in the real profile. */
const PROFILE_HOSTS =
  /(?:^|\.)(?:facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|tiktok\.com|pinterest\.com|yelp\.com|google\.com|g\.page|bbb\.org|angi\.com|angieslist\.com|homeadvisor\.com|nextdoor\.com|houzz\.com|thumbtack\.com)$/i

const isLocalBusinessType = (t: string) => LOCAL_BUSINESS_TYPES.has(t) || (/(?:Business|Contractor)$/.test(t) && t !== 'Business')

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

type Kind = 'home' | 'service' | 'blog' | 'contact' | 'utility' | 'other'

const BLOG_RE = /^\/(?:blog|posts?|articles?|news|insights|resources|guides)\/[^/]+\/?$/i
const SERVICE_RE = /^\/services?\/[^/]+\/?$/i
const CONTACT_RE = /^\/(?:contact|contact-us|get-a-quote|quote|free-estimate|request-a-quote)\/?$/i
const UTILITY_RE =
  /^\/(?:privacy|privacy-policy|terms|terms-of-service|terms-of-use|terms-and-conditions|legal|disclaimer|cookies?|cookie-policy|accessibility|thank-you|thanks|sitemap|login|sign-?in|account|cart|checkout|search|404)(?:\/|$)/i
const ABOUT_RE = /^\/(?:about|about-us|our-story|our-team|company|who-we-are|meet-the-owner)\/?$/i

function pathOf(u: string): string {
  try {
    return new URL(u).pathname || '/'
  } catch {
    return u
  }
}

function listPaths(urls: string[], max = 5): string {
  const paths = [...new Set(urls.map(pathOf))]
  const shown = paths.slice(0, max).join(', ')
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function isNoindex(p: PageData): boolean {
  return /\b(?:noindex|none)\b/i.test(p.metaRobots ?? '') || /\b(?:noindex|none)\b/i.test(p.xRobotsTag ?? '')
}

/** A 4xx/5xx, or a redirect that never lands (loop, or more than five hops). */
function isDead(p: PageData): boolean {
  return p.status >= 400 || (p.status >= 300 && p.status < 400 && !!p.error)
}
const deadLabel = (p: PageData) => (p.status >= 400 ? String(p.status) : 'redirect loop')

function canonicalOf(p: PageData): URL | null {
  if (!p.canonical) return null
  const u = resolveHref(p.canonical, p.url)
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u : null
}

function isSelfCanonical(p: PageData): boolean {
  const c = canonicalOf(p)
  return !c || urlKey(c.href) === urlKey(p.url)
}

const digitsOf = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')
/** Last ten digits: "+1 (817) 210-5188" and "tel:8172105188" are the same phone. */
const phoneKey = (s: string | null | undefined) => {
  const d = digitsOf(s)
  return d.length >= 10 ? d.slice(-10) : null
}

function wordsOf(p: PageData): number {
  return p.mainWordCount ?? p.wordCount
}

const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(?:llc|inc|co|corp|ltd|company)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type Ctx = {
  crawl: CrawlResult
  facts: BusinessFacts | null
  psi: PsiResult | null
  origin: URL
  /** The start page, when it loaded as HTML. */
  home: PageData | null
  /** Every page that loaded as HTML (2xx), shells included — fine for <head> checks. */
  content: PageData[]
  /** Content pages that aren't empty JS shells — the ones whose body can be judged. */
  real: PageData[]
  /** Content pages a search engine should index: not noindex, canonical to themselves. */
  indexable: PageData[]
  byKey: Map<string, PageData>
  sitemapKeys: Set<string>
  kindOf: (p: PageData) => Kind
  /** Crawl hit its page cap or time budget, so "not linked" can't be proven. */
  partial: boolean
}

function buildCtx(crawl: CrawlResult, facts: BusinessFacts | null, psi: PsiResult | null): Ctx {
  const origin = new URL(crawl.origin)
  const ok = (p: PageData) => p.status >= 200 && p.status < 300 && !p.error
  const content = crawl.pages.filter(ok)
  const first = crawl.pages[0]
  const home = first && ok(first) ? first : null
  const real = content.filter((p) => !p.clientRenderedShell)
  const indexable = content.filter((p) => !isNoindex(p) && isSelfCanonical(p))

  const byKey = new Map<string, PageData>()
  for (const p of crawl.pages) {
    if (!byKey.has(urlKey(p.url))) byKey.set(urlKey(p.url), p)
    if (!byKey.has(urlKey(p.requestedUrl))) byKey.set(urlKey(p.requestedUrl), p)
  }
  const sitemapKeys = new Set(crawl.sitemap.urls.map(urlKey))
  const serviceSlugs = new Set((facts?.services ?? []).map((s) => s.slug?.toLowerCase()).filter((s): s is string => !!s))

  const kindOf = (p: PageData): Kind => {
    if (p === home) return 'home'
    const path = pathOf(p.url)
    if (path === '/') return 'home'
    if (BLOG_RE.test(path)) return 'blog'
    if (SERVICE_RE.test(path)) return 'service'
    const last = path.replace(/\/+$/, '').split('/').pop()?.toLowerCase() ?? ''
    if (serviceSlugs.has(last)) return 'service'
    if (CONTACT_RE.test(path)) return 'contact'
    if (UTILITY_RE.test(path)) return 'utility'
    return 'other'
  }

  const linkedKeys = new Set<string>()
  for (const p of content) for (const l of p.internalLinks) linkedKeys.add(urlKey(l))
  const discovered = new Set([...linkedKeys, ...crawl.sitemap.urls.map(urlKey)])
  const partial = crawl.errors.some((e) => e.startsWith('Crawl stopped')) || [...discovered].some((k) => !byKey.has(k))

  return { crawl, facts, psi, origin, home, content, real, indexable, byKey, sitemapKeys, kindOf, partial }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

type Spec = {
  id: string
  severity: FindingSeverity
  status: Finding['status']
  title: string
  detail: string
  fix: string
  urls?: string[]
  fixableByBot?: boolean
}

function finding(s: Spec): Finding {
  return {
    id: s.id,
    severity: s.severity,
    status: s.status,
    title: s.title,
    detail: s.detail,
    urls: [...new Set(s.urls ?? [])].slice(0, MAX_URLS),
    fix: s.fix,
    fixableByBot: s.status === 'pass' ? false : (s.fixableByBot ?? false),
  }
}

/**
 * One finding per group when the same defect hits blog posts and other
 * pages: posts are data files the engine can rewrite once the foundation is
 * installed; template pages need a person.
 */
function splitByBlog(ctx: Ctx, pages: PageData[], make: (subset: PageData[], blog: boolean) => Finding): Finding[] {
  const blog = pages.filter((p) => ctx.kindOf(p) === 'blog')
  const rest = pages.filter((p) => ctx.kindOf(p) !== 'blog')
  const out: Finding[] = []
  if (rest.length) out.push(make(rest, false))
  if (blog.length) {
    const f = make(blog, true)
    out.push({ ...f, id: `${f.id}.blog`, fixableByBot: true })
  }
  return out
}

// T0 / T1 / T2 / T3 ----------------------------------------------------------

function checkReachable(ctx: Ctx): Finding[] {
  if (ctx.home) return []
  const h = ctx.crawl.pages[0]
  const why = !h
    ? 'The crawler got nothing back.'
    : h.status === 0
      ? `No response: ${h.error ?? 'unknown error'}.`
      : h.error
        ? `HTTP ${h.status}: ${h.error}.`
        : `The homepage answered HTTP ${h.status}.`
  return [
    finding({
      id: 'T0.homepage',
      severity: 'P0',
      status: 'fail',
      title: "The homepage didn't load for a crawler",
      detail: `${why} Nothing on the site can be audited or indexed until it does.`,
      urls: [ctx.crawl.startUrl],
      fix: 'Confirm the site is published and the domain points at it. If it opens in a browser, the host or CDN is likely blocking unknown bots (Cloudflare Bot Fight Mode, WAF rules) — allow search and AI crawlers.',
    }),
  ]
}

function checkHttps(ctx: Ctx): Finding[] {
  const out: Finding[] = []
  if (ctx.origin.protocol !== 'https:') {
    out.push(
      finding({
        id: 'T1.https',
        severity: 'P0',
        status: 'fail',
        title: "The site isn't served over HTTPS",
        detail: `The crawl landed on ${ctx.origin.origin}. Browsers mark it "Not secure" and Google prefers HTTPS URLs.`,
        urls: [ctx.origin.href],
        fix: 'Enable HTTPS on the host (Lovable, Vercel and Netlify do it automatically for connected domains) and 301 every http:// URL to https://.',
      }),
    )
    return out
  }
  const insecure = ctx.content.filter((p) => p.url.startsWith('http:'))
  if (ctx.content.length) out.push(
    insecure.length
      ? finding({
          id: 'T1.https',
          severity: 'P0',
          status: 'fail',
          title: `${plural(insecure.length, 'page')} served over plain http://`,
          detail: `These pages resolved to http:// URLs: ${listPaths(insecure.map((p) => p.url))}.`,
          urls: insecure.map((p) => p.url),
          fix: 'Link to https:// URLs and 301 http:// to https:// at the host.',
        })
      : finding({
          id: 'T1.https',
          severity: 'P0',
          status: 'pass',
          title: 'Every crawled page is on HTTPS',
          detail: `${plural(ctx.content.length, 'page')} checked.`,
          fix: '',
        }),
  )

  const h = ctx.crawl.httpToHttps
  if (h) {
    const loc = h.location ?? ''
    const toHttps = /^https:\/\//i.test(loc)
    const redirect = h.status !== null && h.status >= 300 && h.status < 400
    const base = { id: 'T1.http-redirect', urls: [`http://${ctx.origin.host}/`] }
    if (h.status === null) {
      out.push(
        finding({
          ...base,
          severity: 'P2',
          status: 'warn',
          title: "http:// doesn't answer",
          detail: `http://${ctx.origin.host}/ gave no response, so old http links and people typing the bare domain may hit an error instead of the site.`,
          fix: 'Have the host listen on port 80 and 301 every request to https://.',
        }),
      )
    } else if (redirect && toHttps && (h.status === 301 || h.status === 308)) {
      out.push(finding({ ...base, severity: 'P0', status: 'pass', title: 'http:// permanently redirects to https://', detail: `HTTP ${h.status} → ${loc}`, fix: '' }))
    } else if (redirect && toHttps) {
      out.push(
        finding({
          ...base,
          severity: 'P1',
          status: 'warn',
          title: 'http:// redirects to https:// with a temporary redirect',
          detail: `HTTP ${h.status} → ${loc}. A temporary redirect tells search engines the http:// URL may come back.`,
          fix: 'Make the http → https redirect a 301 (or 308) at the host.',
        }),
      )
    } else if (h.status >= 200 && h.status < 300) {
      out.push(
        finding({
          ...base,
          severity: 'P0',
          status: 'fail',
          title: 'http:// serves the site without redirecting to https://',
          detail: `http://${ctx.origin.host}/ answered HTTP ${h.status} with content, so the http and https versions compete as duplicates and visitors can stay on the insecure one.`,
          fix: 'Add a 301 redirect from every http:// URL to its https:// twin at the host.',
        }),
      )
    } else if (redirect) {
      out.push(
        finding({
          ...base,
          severity: 'P0',
          status: 'fail',
          title: "http:// redirects, but not to https://",
          detail: `HTTP ${h.status} → ${loc || '(no location)'}.`,
          fix: 'Point the http:// redirect at the https:// version of the same URL.',
        }),
      )
    } else {
      out.push(
        finding({
          ...base,
          severity: 'P1',
          status: 'warn',
          title: `http:// answers HTTP ${h.status}`,
          detail: `http://${ctx.origin.host}/ returned ${h.status} instead of redirecting to https://.`,
          fix: 'Have the host 301 every http:// request to https://.',
        }),
      )
    }
  }
  return out
}

function checkHost(ctx: Ctx): Finding[] {
  const out: Finding[] = []
  const t = ctx.crawl.hostTwin
  if (t) {
    let twin = t.url
    try {
      twin = new URL(t.url).host
    } catch {
      /* keep url */
    }
    const base = { id: 'T2.host-twin', urls: [t.url] }
    let dest: URL | null = null
    try {
      dest = t.location ? new URL(t.location) : null
    } catch {
      dest = null
    }
    const redirect = t.status !== null && t.status >= 300 && t.status < 400
    if (t.status === null) {
      out.push(
        finding({
          ...base,
          severity: 'P2',
          status: 'warn',
          title: `${twin} doesn't answer`,
          detail: `The site lives on ${ctx.origin.host}; ${twin} gave no response (no DNS record, or no certificate for it). People who type it get an error page.`,
          fix: `Add ${twin} to the host (DNS + certificate) and 301 it to https://${ctx.origin.host}/.`,
        }),
      )
    } else if (redirect && dest && dest.hostname === ctx.origin.hostname) {
      out.push(
        t.status === 301 || t.status === 308
          ? finding({ ...base, severity: 'P1', status: 'pass', title: `${twin} redirects to ${ctx.origin.host}`, detail: `HTTP ${t.status} → ${t.location}`, fix: '' })
          : finding({
              ...base,
              severity: 'P2',
              status: 'warn',
              title: `${twin} redirects with a temporary redirect`,
              detail: `HTTP ${t.status} → ${t.location}. Search engines may keep both hosts.`,
              fix: `Make the ${twin} → ${ctx.origin.host} redirect a 301.`,
            }),
      )
    } else if (redirect) {
      out.push(
        finding({
          ...base,
          severity: 'P1',
          status: 'fail',
          title: `${twin} doesn't redirect to ${ctx.origin.host}`,
          detail: `HTTP ${t.status} → ${t.location ?? '(no location)'}.`,
          fix: `301 ${twin} (every path) to the same path on https://${ctx.origin.host}.`,
        }),
      )
    } else if (t.status >= 200 && t.status < 300) {
      out.push(
        finding({
          ...base,
          severity: 'P1',
          status: 'fail',
          title: `Both ${ctx.origin.host} and ${twin} serve the site`,
          detail: 'Two hosts with the same pages split links and ranking signals between duplicates.',
          fix: `Pick one host (usually the one on the Google Business Profile) and 301 the other to it, path for path.`,
        }),
      )
    } else {
      out.push(
        finding({
          ...base,
          severity: 'P2',
          status: 'warn',
          title: `${twin} answers HTTP ${t.status}`,
          detail: `${twin} returns an error instead of redirecting to ${ctx.origin.host}.`,
          fix: `301 ${twin} to https://${ctx.origin.host}/.`,
        }),
      )
    }
  }

  const linked = ctx.crawl.pages.slice(1)
  if (!linked.length) return out
  const redirected = linked.filter((p) => p.redirects > 0)
  const chains = redirected.filter((p) => p.redirects > 1)
  out.push(
    redirected.length
      ? finding({
          id: 'T2.redirects',
          severity: 'P2',
          status: 'warn',
          title: `${plural(redirected.length, 'linked URL')} go through a redirect`,
          detail: `Internal links or sitemap entries point at URLs that redirect: ${listPaths(redirected.map((p) => p.requestedUrl))}.${chains.length ? ` ${plural(chains.length, 'is a chain', 'are chains')} of 2+ hops.` : ''}`,
          urls: redirected.map((p) => p.requestedUrl),
          fix: 'Link (and list in the sitemap) the final URL directly — usually a trailing-slash or http/www mismatch in the link.',
        })
      : finding({ id: 'T2.redirects', severity: 'P2', status: 'pass', title: 'Internal links resolve without redirects', detail: `${plural(linked.length, 'linked URL')} checked.`, fix: '' }),
  )
  return out
}

function checkSoft404(ctx: Ctx): Finding[] {
  const s = ctx.crawl.soft404.status
  const base = { id: 'T3.soft-404', urls: [ctx.crawl.soft404.url] }
  if (s === 404 || s === 410) return [finding({ ...base, severity: 'P0', status: 'pass', title: 'Missing pages return a real 404', detail: `HTTP ${s} for a made-up URL.`, fix: '' })]
  if (s !== null && s >= 200 && s < 300) {
    return [
      finding({
        ...base,
        severity: 'P0',
        status: 'fail',
        title: 'Missing pages return 200 (soft 404)',
        detail: `A made-up URL answered HTTP ${s}. Every typo and dead link looks like a real page, so search engines index junk URLs and waste crawl budget — the usual single-page-app fallback.`,
        fix: 'Serve a real 404 status for unknown routes: in TanStack Start give the not-found route a 404 status; for a static SPA configure the host to return 404 for unknown paths instead of index.html.',
      }),
    ]
  }
  if (s === null) return [finding({ ...base, severity: 'P2', status: 'warn', title: "Couldn't test how missing pages respond", detail: 'The probe for a made-up URL got no response.', fix: 'Re-run the audit; if it persists, check the host is reachable.' })]
  return [
    finding({
      ...base,
      severity: s >= 500 ? 'P1' : 'P2',
      status: 'warn',
      title: `Missing pages return HTTP ${s}`,
      detail: `A made-up URL answered ${s} instead of 404.${s >= 500 ? ' Server errors on unknown URLs make the site look unstable to crawlers.' : ''}`,
      fix: 'Return 404 (or 410) for URLs that do not exist.',
    }),
  ]
}

// T4 -------------------------------------------------------------------------

function checkRawHtml(ctx: Ctx): Finding[] {
  const home = ctx.home
  if (!home) return []
  const shells = ctx.content.filter((p) => p.clientRenderedShell)
  const out: Finding[] = []
  if (shells.length) {
    const homeShell = home.clientRenderedShell
    out.push(
      finding({
        id: 'T4.raw-html',
        severity: 'P0',
        status: 'fail',
        title: homeShell ? 'The homepage is an empty JavaScript shell' : `${plural(shells.length, 'page is an', 'pages are')} empty JavaScript shell${shells.length === 1 ? '' : 's'}`,
        detail: `Without JavaScript ${homeShell ? 'the homepage' : listPaths(shells.map((p) => p.url))} has ${home.clientRenderedShell ? `${home.wordCount} words, ${plural(home.h1.length, 'H1')} and no links` : 'next to no content'}. GPTBot, ClaudeBot and PerplexityBot don't run JavaScript, so to them the site is blank; Google renders it later and less reliably. Heading, phone and content checks below skip shell pages — this is the fix that unlocks them.`,
        urls: shells.map((p) => p.url),
        fix: 'Server-render or pre-render the pages: move the site to Lovable’s TanStack Start template (SSR) or enable pre-rendering at the host, so the HTML carries the copy, H1, links, phone and JSON-LD.',
      }),
    )
  } else {
    out.push(
      finding({
        id: 'T4.raw-html',
        severity: 'P0',
        status: 'pass',
        title: 'Content is in the raw HTML',
        detail: `Without JavaScript the homepage has ${home.wordCount} words, ${plural(home.h1.length, 'H1')}, ${plural(home.internalLinks.length, 'internal link')} and JSON-LD: ${home.jsonLd.types.join(', ') || 'none'}.`,
        fix: '',
      }),
    )
    if (home.internalLinks.length < 3) {
      out.push(
        finding({
          id: 'T4.nav-links',
          severity: 'P1',
          status: 'warn',
          title: 'The homepage has almost no crawlable links',
          detail: `Only ${plural(home.internalLinks.length, 'internal <a href> link')} in the raw HTML — navigation built from buttons or JavaScript handlers can't be followed by crawlers.`,
          urls: [home.url],
          fix: 'Render navigation as real <a href="/path"> links.',
        }),
      )
    }
  }
  return out
}

// T5 / T6 / T7 ---------------------------------------------------------------

function checkRobots(ctx: Ctx): Finding[] {
  const r = ctx.crawl.robots
  const url = `${ctx.origin.origin}/robots.txt`
  const isHtml = !!r.body && /^\s*</.test(r.body)
  const out: Finding[] = []
  if (r.status === null) {
    out.push(
      finding({
        id: 'T5.robots',
        severity: 'P1',
        status: 'warn',
        title: "robots.txt couldn't be fetched",
        detail: "Two attempts got no response. If Google can't reach robots.txt it pauses crawling the site.",
        urls: [url],
        fix: 'Check the host serves /robots.txt quickly and reliably.',
      }),
    )
    return out
  }
  if (r.status >= 500) {
    out.push(
      finding({
        id: 'T5.robots',
        severity: 'P0',
        status: 'fail',
        title: `robots.txt returns HTTP ${r.status}`,
        detail: 'A server error on robots.txt makes Google treat the whole site as off-limits until it recovers.',
        urls: [url],
        fix: 'Serve /robots.txt as a static 200 text file.',
      }),
    )
    return out
  }
  if (r.status >= 300) {
    out.push(
      finding({
        id: 'T5.robots',
        severity: 'P2',
        status: 'warn',
        title: 'No robots.txt',
        detail: `/robots.txt answered HTTP ${r.status}. Everything is crawlable, but there is nowhere to point crawlers at the sitemap.`,
        urls: [url],
        fix: 'Add public/robots.txt with "User-agent: *", "Allow: /" and a "Sitemap:" line.',
        fixableByBot: true,
      }),
    )
    return out
  }
  if (isHtml) {
    out.push(
      finding({
        id: 'T5.robots',
        severity: 'P1',
        status: 'warn',
        title: 'robots.txt is an HTML page',
        detail: '/robots.txt returns the app’s HTML instead of a text file, so crawlers get no rules and no Sitemap line.',
        urls: [url],
        fix: 'Add a real public/robots.txt (static files win over the SPA fallback).',
        fixableByBot: true,
      }),
    )
    return out
  }
  out.push(finding({ id: 'T5.robots', severity: 'P0', status: 'pass', title: 'robots.txt is served', detail: `HTTP ${r.status}.`, fix: '' }))

  const blockedSearch = SEARCH_BOTS.filter((b) => r.rootAllowed[b] === false)
  const blockedOther = OTHER_BOTS.filter((b) => r.rootAllowed[b] === false)
  if (blockedSearch.length) {
    out.push(
      finding({
        id: 'T5.robots-bots',
        severity: 'P0',
        status: 'fail',
        title: `robots.txt blocks ${blockedSearch.join(', ')}`,
        detail: `"/" is disallowed for ${blockedSearch.join(', ')}${blockedOther.length ? ` (and ${blockedOther.join(', ')})` : ''}. Blocked search crawlers can't index the site or cite it in AI answers.`,
        urls: [url],
        fix: 'Remove the Disallow rules that cover "/" for these agents. Named groups replace the "*" group, so check every User-agent block.',
      }),
    )
  } else if (blockedOther.length) {
    out.push(
      finding({
        id: 'T5.robots-bots',
        severity: 'P2',
        status: 'warn',
        title: `robots.txt blocks ${blockedOther.join(', ')}`,
        detail: 'Search crawlers are allowed, but these AI agents are not. Blocking training crawlers is a choice — it also means the models learn less about the business, and Google-Extended affects Gemini grounding.',
        urls: [url],
        fix: 'Unless the client asked for it, allow these agents (remove their Disallow: / groups).',
      }),
    )
  } else {
    out.push(finding({ id: 'T5.robots-bots', severity: 'P0', status: 'pass', title: 'Search and AI crawlers are allowed', detail: `"/" is allowed for ${[...SEARCH_BOTS, ...OTHER_BOTS].join(', ')}.`, fix: '' }))
  }

  out.push(
    r.sitemaps.length
      ? finding({ id: 'T5.robots-sitemap', severity: 'P2', status: 'pass', title: 'robots.txt points to the sitemap', detail: r.sitemaps.join(', '), fix: '' })
      : finding({
          id: 'T5.robots-sitemap',
          severity: 'P2',
          status: 'fail',
          title: 'robots.txt has no Sitemap line',
          detail: 'Crawlers that don’t get the sitemap from Search Console find it through robots.txt.',
          urls: [url],
          fix: `Add "Sitemap: ${ctx.origin.origin}/sitemap.xml" to public/robots.txt.`,
          fixableByBot: true,
        }),
  )
  return out
}

function checkSitemap(ctx: Ctx): Finding[] {
  const sm = ctx.crawl.sitemap
  const out: Finding[] = []
  if (!sm.urls.length) {
    out.push(
      finding({
        id: 'T6.sitemap',
        severity: 'P1',
        status: 'fail',
        title: 'No working XML sitemap',
        detail: `${sm.error ?? 'No sitemap found.'} Without one, new pages and posts are found only by following links.`,
        urls: [sm.url ?? `${ctx.origin.origin}/sitemap.xml`],
        fix: 'Generate /sitemap.xml from the site’s routes and posts (absolute https URLs, real lastmod dates) and reference it in robots.txt.',
        fixableByBot: true,
      }),
    )
    return out
  }
  out.push(
    sm.error
      ? finding({
          id: 'T6.sitemap',
          severity: 'P2',
          status: 'warn',
          title: 'Sitemap works, but part of it is broken',
          detail: `${plural(sm.urls.length, 'URL')} read; problems: ${sm.error}.`,
          urls: sm.url ? [sm.url] : [],
          fix: 'Fix or remove the sitemap files that fail (see detail).',
          fixableByBot: true,
        })
      : finding({ id: 'T6.sitemap', severity: 'P1', status: 'pass', title: 'XML sitemap found', detail: `${plural(sm.urls.length, 'URL')} in ${sm.url}.`, fix: '' }),
  )

  const crawled = sm.urls.map((u) => ctx.byKey.get(urlKey(u))).filter((p): p is PageData => !!p)
  const coverage = crawled.length < sm.urls.length ? ` (${crawled.length} of ${sm.urls.length} sitemap URLs were crawled)` : ''

  const broken = crawled.filter(isDead)
  out.push(
    broken.length
      ? finding({
          id: 'T6.sitemap-broken',
          severity: 'P1',
          status: 'fail',
          title: `${plural(broken.length, 'sitemap URL')} ${broken.length === 1 ? 'is' : 'are'} broken`,
          detail: `${broken.map((p) => `${pathOf(p.requestedUrl)} (${deadLabel(p)})`).slice(0, 8).join(', ')}${coverage}.`,
          urls: broken.map((p) => p.requestedUrl),
          fix: 'Remove dead URLs from the sitemap, or restore / redirect the pages.',
        })
      : finding({ id: 'T6.sitemap-broken', severity: 'P1', status: 'pass', title: 'Sitemap URLs load', detail: `No 4xx/5xx among the crawled sitemap URLs${coverage}.`, fix: '' }),
  )

  const offHost = sm.urls.filter((u) => {
    try {
      const x = new URL(u)
      return x.hostname !== ctx.origin.hostname || x.protocol !== ctx.origin.protocol
    } catch {
      return true
    }
  })
  const redirecting = crawled.filter((p) => p.redirects > 0 && !isDead(p))
  const canonicalised = crawled.filter((p) => ctx.content.includes(p) && !isSelfCanonical(p))
  const problems = [
    offHost.length ? `${plural(offHost.length, 'URL')} on another host or scheme (e.g. ${offHost[0]})` : '',
    redirecting.length ? `${plural(redirecting.length, 'URL')} that redirect (${listPaths(redirecting.map((p) => p.requestedUrl), 3)})` : '',
    canonicalised.length ? `${plural(canonicalised.length, 'page')} whose canonical points elsewhere (${listPaths(canonicalised.map((p) => p.url), 3)})` : '',
  ].filter(Boolean)
  if (problems.length) {
    out.push(
      finding({
        id: 'T6.sitemap-hygiene',
        severity: 'P2',
        status: 'warn',
        title: 'Sitemap lists URLs that aren’t the final, canonical ones',
        detail: `${problems.join('; ')}. A sitemap should list only 200, indexable, self-canonical URLs.`,
        urls: [...offHost, ...redirecting.map((p) => p.requestedUrl), ...canonicalised.map((p) => p.url)],
        fix: `List each page once, as its final https://${ctx.origin.host} URL.`,
        fixableByBot: true,
      }),
    )
  }

  const missing = ctx.indexable.filter((p) => !ctx.sitemapKeys.has(urlKey(p.url)) && !ctx.sitemapKeys.has(urlKey(p.requestedUrl)) && ctx.kindOf(p) !== 'utility')
  out.push(
    missing.length
      ? finding({
          id: 'T6.sitemap-coverage',
          severity: 'P2',
          status: 'warn',
          title: `${plural(missing.length, 'indexable page')} missing from the sitemap`,
          detail: listPaths(missing.map((p) => p.url), 8),
          urls: missing.map((p) => p.url),
          fix: 'Generate the sitemap from the full route and post list so every indexable page is in it.',
          fixableByBot: true,
        })
      : finding({ id: 'T6.sitemap-coverage', severity: 'P2', status: 'pass', title: 'Every crawled indexable page is in the sitemap', detail: '', fix: '' }),
  )
  return out
}

function checkNoindex(ctx: Ctx): Finding[] {
  if (!ctx.content.length) return []
  const noindex = ctx.content.filter(isNoindex)
  const inSitemap = noindex.filter((p) => ctx.sitemapKeys.has(urlKey(p.url)) || ctx.sitemapKeys.has(urlKey(p.requestedUrl)))
  const homeBlocked = !!ctx.home && isNoindex(ctx.home)
  if (homeBlocked || inSitemap.length) {
    const hit = [...(homeBlocked && ctx.home ? [ctx.home] : []), ...inSitemap]
    return [
      finding({
        id: 'T7.noindex',
        severity: 'P0',
        status: 'fail',
        title: homeBlocked ? 'The homepage is set to noindex' : `${plural(inSitemap.length, 'sitemap page')} set to noindex`,
        detail: `${listPaths(hit.map((p) => p.url))} carry noindex (meta robots or X-Robots-Tag), so search engines drop them${inSitemap.length ? ' — while the sitemap asks for them to be indexed' : ''}.`,
        urls: hit.map((p) => p.url),
        fix: 'Remove noindex from pages that should rank (often left over from a staging setting), or drop them from the sitemap if they really should stay out.',
      }),
    ]
  }
  const odd = noindex.filter((p) => ctx.kindOf(p) !== 'utility')
  if (odd.length) {
    return [
      finding({
        id: 'T7.noindex',
        severity: 'P2',
        status: 'warn',
        title: `${plural(odd.length, 'page')} set to noindex`,
        detail: `${listPaths(odd.map((p) => p.url))} are excluded from search. Fine if deliberate.`,
        urls: odd.map((p) => p.url),
        fix: 'Confirm each is meant to stay out of search; remove noindex otherwise.',
      }),
    ]
  }
  return [finding({ id: 'T7.noindex', severity: 'P0', status: 'pass', title: 'No unexpected noindex', detail: `${plural(ctx.content.length, 'page')} checked.`, fix: '' })]
}

// T8 -------------------------------------------------------------------------

function checkCanonical(ctx: Ctx): Finding[] {
  const out: Finding[] = []
  const pages = ctx.content.filter((p) => !isNoindex(p))
  const origin = ctx.origin.origin

  const relative = pages.filter((p) => p.canonical && !isAbsoluteHttpUrl(p.canonical))
  if (pages.some((p) => p.canonical)) out.push(
    relative.length
      ? finding({
          id: 'T8.canonical-relative',
          severity: 'P1',
          status: 'fail',
          title: `Relative canonical URLs on ${plural(relative.length, 'page')}`,
          detail: `e.g. <link rel="canonical" href="${relative[0].canonical}"> on ${pathOf(relative[0].url)}. Google asks for absolute canonicals; a relative one breaks as soon as the page is served from a second host (preview domains, www twin, proxies).`,
          urls: relative.map((p) => p.url),
          fix: `Build canonicals from the site's absolute base URL: "${origin}" + path. In the Genisys Lovable template that is the url passed to meta() in src/lib/seo.ts and the canonical link in each route's head().`,
        })
      : finding({ id: 'T8.canonical-relative', severity: 'P1', status: 'pass', title: 'Canonical URLs are absolute', detail: '', fix: '' }),
  )

  const ogRelative = pages.filter((p) => p.social['og:url'] && !isAbsoluteHttpUrl(p.social['og:url']))
  if (pages.some((p) => p.social['og:url'])) out.push(
    ogRelative.length
      ? finding({
          id: 'T8.og-url-relative',
          severity: 'P1',
          status: 'fail',
          title: `Relative og:url on ${plural(ogRelative.length, 'page')}`,
          detail: `e.g. og:url "${ogRelative[0].social['og:url']}" on ${pathOf(ogRelative[0].url)}. Open Graph requires an absolute URL; Facebook, LinkedIn and chat apps can't resolve a path.`,
          urls: ogRelative.map((p) => p.url),
          fix: `Set og:url to "${origin}" + path (same fix as the canonical).`,
        })
      : finding({ id: 'T8.og-url-relative', severity: 'P1', status: 'pass', title: 'og:url values are absolute', detail: '', fix: '' }),
  )

  const homeKey = ctx.home ? urlKey(ctx.home.url) : urlKey(origin)
  const toHome = pages.filter((p) => ctx.kindOf(p) !== 'home' && canonicalOf(p) && urlKey(canonicalOf(p)!.href) === homeKey)
  if (toHome.length >= 2) {
    out.push(
      finding({
        id: 'T8.canonical-home',
        severity: 'P0',
        status: 'fail',
        title: `${plural(toHome.length, 'page')} declare the homepage as canonical`,
        detail: `${listPaths(toHome.map((p) => p.url))} say "the real version of this page is the homepage", so Google folds them into it and they never rank. Usually a canonical set once in the root layout.`,
        urls: toHome.map((p) => p.url),
        fix: 'Give each page a canonical of its own URL (set it per route, not in the root layout).',
      }),
    )
  }

  const conflicts: string[] = []
  const conflictUrls: string[] = []
  for (const p of pages) {
    const why: string[] = []
    if ((p.canonicalCount ?? (p.canonical ? 1 : 0)) > 1) why.push(`${p.canonicalCount} canonical tags`)
    const c = canonicalOf(p)
    if (c) {
      if (bareHost(c.hostname) !== bareHost(ctx.origin.hostname)) why.push(`canonical on another site (${c.host})`)
      else if (c.hostname !== new URL(p.url).hostname || c.protocol !== new URL(p.url).protocol) why.push(`canonical on ${c.protocol}//${c.host}`)
      const target = ctx.byKey.get(urlKey(c.href))
      if (target && isDead(target)) why.push(`canonical target is broken (${deadLabel(target)})`)
    } else if (p.canonical) {
      why.push(`unusable canonical "${p.canonical}"`)
    }
    if (why.length) {
      conflicts.push(`${pathOf(p.url)}: ${why.join(', ')}`)
      conflictUrls.push(p.url)
    }
  }
  if (conflicts.length) {
    out.push(
      finding({
        id: 'T8.canonical-conflict',
        severity: 'P1',
        status: 'fail',
        title: `Canonical problems on ${plural(conflicts.length, 'page')}`,
        detail: conflicts.slice(0, 6).join('; '),
        urls: conflictUrls,
        fix: `Exactly one canonical per page, pointing at its own live https://${ctx.origin.host} URL.`,
      }),
    )
  }

  const missing = pages.filter((p) => !p.canonical)
  if (missing.length) {
    out.push(
      finding({
        id: 'T8.canonical-missing',
        severity: 'P2',
        status: 'warn',
        title: `No canonical on ${plural(missing.length, 'page')}`,
        detail: `${listPaths(missing.map((p) => p.url))}. Search engines then pick the canonical themselves (including query-string and host variants).`,
        urls: missing.map((p) => p.url),
        fix: `Add <link rel="canonical" href="${origin}/path"> to every page.`,
      }),
    )
  }
  return out
}

// T9 / T10 / T11 / T12 / T13 / T20 --------------------------------------------

function duplicates(pages: PageData[], value: (p: PageData) => string | null): PageData[][] {
  const groups = new Map<string, PageData[]>()
  for (const p of pages) {
    const v = value(p)
    if (!v) continue
    const k = v.toLowerCase().replace(/\s+/g, ' ').trim()
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  return [...groups.values()].filter((g) => g.length > 1)
}

function checkTitles(ctx: Ctx): Finding[] {
  const pages = ctx.content.filter((p) => !isNoindex(p))
  if (!pages.length) return []
  const out: Finding[] = []

  const missing = pages.filter((p) => !p.title)
  out.push(
    ...splitByBlog(ctx, missing, (s, blog) =>
      finding({
        id: 'T9.title-missing',
        severity: 'P1',
        status: 'fail',
        title: `${plural(s.length, blog ? 'post' : 'page')} without a <title>`,
        detail: listPaths(s.map((p) => p.url)),
        urls: s.map((p) => p.url),
        fix: 'Give every page a unique title: primary service + city first, brand last, about 50–60 characters.',
      }),
    ),
  )
  if (!missing.length) out.push(finding({ id: 'T9.title-missing', severity: 'P1', status: 'pass', title: 'Every page has a title', detail: `${plural(pages.length, 'page')} checked.`, fix: '' }))

  const badLength = pages.filter((p) => p.title && (p.title.length < 30 || p.title.length > 65))
  out.push(
    ...splitByBlog(ctx, badLength, (s, blog) =>
      finding({
        id: 'T9.title-length',
        severity: 'P2',
        status: 'warn',
        title: `${plural(s.length, blog ? 'post title' : 'title')} outside 30–65 characters`,
        detail: s
          .slice(0, 6)
          .map((p) => `${pathOf(p.url)} (${p.title!.length}): "${p.title}"`)
          .join('; '),
        urls: s.map((p) => p.url),
        fix: 'Aim for 30–65 characters: long titles get truncated in results, very short ones waste the most-weighted text on the page.',
      }),
    ),
  )
  if (!badLength.length) out.push(finding({ id: 'T9.title-length', severity: 'P2', status: 'pass', title: 'Title lengths are in range', detail: '', fix: '' }))

  const dupGroups = duplicates(ctx.indexable, (p) => p.title)
  const dupPages = dupGroups.flat()
  if (ctx.indexable.length > 1) out.push(
    dupGroups.length
      ? finding({
          id: 'T20.duplicate-titles',
          severity: 'P1',
          status: 'fail',
          title: `${plural(dupPages.length, 'page')} share a title`,
          detail: dupGroups
            .slice(0, 4)
            .map((g) => `"${g[0].title}" ×${g.length} (${listPaths(g.map((p) => p.url), 3)})`)
            .join('; '),
          urls: dupPages.map((p) => p.url),
          fix: 'Make each title describe its own page (service, city, topic).',
          fixableByBot: dupPages.every((p) => ctx.kindOf(p) === 'blog'),
        })
      : finding({ id: 'T20.duplicate-titles', severity: 'P1', status: 'pass', title: 'Titles are unique', detail: '', fix: '' }),
  )
  return out
}

function checkDescriptions(ctx: Ctx): Finding[] {
  const pages = ctx.content.filter((p) => !isNoindex(p))
  if (!pages.length) return []
  const out: Finding[] = []

  const missing = pages.filter((p) => !p.metaDescription)
  out.push(
    ...splitByBlog(ctx, missing, (s, blog) =>
      finding({
        id: 'T10.description-missing',
        severity: 'P2',
        status: 'fail',
        title: `${plural(s.length, blog ? 'post' : 'page')} without a meta description`,
        detail: listPaths(s.map((p) => p.url)),
        urls: s.map((p) => p.url),
        fix: 'Write a 70–160 character description per page: what it offers, where, and a reason to click (phone or offer).',
      }),
    ),
  )
  if (!missing.length) out.push(finding({ id: 'T10.description-missing', severity: 'P2', status: 'pass', title: 'Every page has a meta description', detail: '', fix: '' }))

  const badLength = pages.filter((p) => p.metaDescription && (p.metaDescription.length < 70 || p.metaDescription.length > 160))
  out.push(
    ...splitByBlog(ctx, badLength, (s, blog) =>
      finding({
        id: 'T10.description-length',
        severity: 'P2',
        status: 'warn',
        title: `${plural(s.length, blog ? 'post description' : 'meta description')} outside 70–160 characters`,
        detail: s
          .slice(0, 6)
          .map((p) => `${pathOf(p.url)} (${p.metaDescription!.length})`)
          .join(', '),
        urls: s.map((p) => p.url),
        fix: 'Keep descriptions between 70 and 160 characters so the snippet isn’t cut or padded by Google.',
      }),
    ),
  )
  if (!badLength.length) out.push(finding({ id: 'T10.description-length', severity: 'P2', status: 'pass', title: 'Description lengths are in range', detail: '', fix: '' }))

  const dupGroups = duplicates(ctx.indexable, (p) => p.metaDescription)
  const dupPages = dupGroups.flat()
  if (ctx.indexable.length > 1) out.push(
    dupGroups.length
      ? finding({
          id: 'T20.duplicate-descriptions',
          severity: 'P1',
          status: 'fail',
          title: `${plural(dupPages.length, 'page')} share a meta description`,
          detail: dupGroups
            .slice(0, 4)
            .map((g) => `×${g.length}: ${listPaths(g.map((p) => p.url), 3)}`)
            .join('; '),
          urls: dupPages.map((p) => p.url),
          fix: 'Write a description specific to each page.',
          fixableByBot: dupPages.every((p) => ctx.kindOf(p) === 'blog'),
        })
      : finding({ id: 'T20.duplicate-descriptions', severity: 'P1', status: 'pass', title: 'Meta descriptions are unique', detail: '', fix: '' }),
  )
  return out
}

function checkHeadings(ctx: Ctx): Finding[] {
  const pages = ctx.real.filter((p) => !isNoindex(p))
  if (!pages.length) return []
  const out: Finding[] = []
  const bad = pages.filter((p) => p.h1.length !== 1 || !p.h1[0])
  out.push(
    bad.length
      ? finding({
          id: 'T11.h1',
          severity: 'P1',
          status: 'fail',
          title: `${plural(bad.length, 'page')} without exactly one H1`,
          detail: bad
            .slice(0, 8)
            .map((p) => `${pathOf(p.url)}: ${p.h1.length === 0 ? 'no H1' : p.h1.length > 1 ? `${p.h1.length} H1s` : 'empty H1'}`)
            .join('; '),
          urls: bad.map((p) => p.url),
          fix: 'One H1 per page naming the page’s topic (service + city on money pages); demote other H1s to H2.',
          fixableByBot: bad.every((p) => ctx.kindOf(p) === 'blog'),
        })
      : finding({ id: 'T11.h1', severity: 'P1', status: 'pass', title: 'Every page has one H1', detail: `${plural(pages.length, 'page')} checked.`, fix: '' }),
  )

  const dupGroups = duplicates(
    ctx.indexable.filter((p) => !p.clientRenderedShell),
    (p) => (p.h1.length === 1 ? p.h1[0] : null),
  )
  if (dupGroups.length) {
    const dupPages = dupGroups.flat()
    out.push(
      finding({
        id: 'T20.duplicate-h1',
        severity: 'P2',
        status: 'warn',
        title: `${plural(dupPages.length, 'page')} share an H1`,
        detail: dupGroups
          .slice(0, 4)
          .map((g) => `"${g[0].h1[0]}" ×${g.length}`)
          .join('; '),
        urls: dupPages.map((p) => p.url),
        fix: 'Give each page a heading that names its own topic.',
      }),
    )
  }
  return out
}

function checkViewportLang(ctx: Ctx): Finding[] {
  if (!ctx.content.length) return []
  const noViewport = ctx.content.filter((p) => !p.hasViewport)
  const noLang = ctx.content.filter((p) => !p.lang)
  if (!noViewport.length && !noLang.length) {
    return [finding({ id: 'T12.viewport-lang', severity: 'P1', status: 'pass', title: 'Viewport and language are declared', detail: '', fix: '' })]
  }
  return [
    finding({
      id: 'T12.viewport-lang',
      severity: 'P1',
      status: 'fail',
      title: 'Missing viewport or language declaration',
      detail: [
        noViewport.length ? `No <meta name="viewport"> on ${listPaths(noViewport.map((p) => p.url), 3)} — mobile browsers render the desktop layout.` : '',
        noLang.length ? `No <html lang> on ${listPaths(noLang.map((p) => p.url), 3)}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      urls: [...noViewport, ...noLang].map((p) => p.url),
      fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> and <html lang="en"> in the root layout.',
    }),
  ]
}

function checkOpenGraph(ctx: Ctx): Finding[] {
  const pages = ctx.content.filter((p) => !isNoindex(p))
  if (!pages.length) return []
  const out: Finding[] = []
  const noImage = pages.filter((p) => !isAbsoluteHttpUrl(p.social['og:image']))
  // A raw space or "#" means the file name was pasted unencoded: scrapers
  // cut the URL at "#" and request a file that doesn't exist.
  const badImage = pages.filter((p) => !noImage.includes(p) && /[\s#]/.test(p.social['og:image'].trim()))
  const broken = [...noImage, ...badImage]
  const example = badImage[0]?.social['og:image']
  out.push(
    broken.length
      ? finding({
          id: 'T13.og-image',
          severity: 'P2',
          status: 'fail',
          title: `${plural(broken.length, 'page')} without a usable og:image`,
          detail: [
            noImage.length ? `${listPaths(noImage.map((p) => p.url))}: og:image missing or not an absolute URL, so shared links show no picture.` : '',
            example
              ? `${listPaths(badImage.map((p) => p.url))}: og:image "${example}" isn't URL-encoded${example.includes('#') ? ' — everything after "#" is dropped, so the image never loads' : ''}.`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
          urls: broken.map((p) => p.url),
          fix: 'Set an absolute, URL-encoded og:image (at least 1200×630, a real project photo) on every page — rename files with spaces or "#" in them; posts can use their hero image.',
          fixableByBot: broken.every((p) => ctx.kindOf(p) === 'blog'),
        })
      : finding({ id: 'T13.og-image', severity: 'P2', status: 'pass', title: 'Every page has an og:image', detail: '', fix: '' }),
  )

  const missingByKey = new Map<string, number>()
  const affected: PageData[] = []
  for (const p of pages) {
    const miss = ['og:title', 'og:type', 'og:url', 'twitter:card'].filter((k) => !p.social[k])
    if (miss.length) affected.push(p)
    for (const k of miss) missingByKey.set(k, (missingByKey.get(k) ?? 0) + 1)
  }
  if (affected.length) {
    out.push(
      finding({
        id: 'T13.open-graph',
        severity: 'P2',
        status: 'warn',
        title: 'Incomplete Open Graph / Twitter tags',
        detail: [...missingByKey].map(([k, n]) => `${k} missing on ${plural(n, 'page')}`).join('; '),
        urls: affected.map((p) => p.url),
        fix: 'Emit og:title, og:type, og:url (absolute) and twitter:card on every page from the shared meta helper.',
      }),
    )
  }
  return out
}

// T14 ------------------------------------------------------------------------

function checkImages(ctx: Ctx): Finding[] {
  const pages = ctx.real
  if (!pages.length) return []
  const out: Finding[] = []
  const noAlt = new Map<string, string>()
  const noSize = new Map<string, string>()
  let total = 0
  for (const p of pages) {
    for (const img of p.images) {
      total++
      if (img.alt === null && !noAlt.has(img.src)) noAlt.set(img.src, p.url)
      const isData = img.src.startsWith('data:')
      if (!isData && !img.fill && (!img.width || !img.height) && !noSize.has(img.src)) noSize.set(img.src, p.url)
    }
  }
  out.push(
    noAlt.size
      ? finding({
          id: 'T14.img-alt',
          severity: 'P2',
          status: 'fail',
          title: `${plural(noAlt.size, 'image')} without alt text`,
          detail: `No alt attribute on ${plural(noAlt.size, 'distinct image')}, on ${listPaths([...new Set(noAlt.values())], 4)}. Alt text is how search engines and screen readers know what a project photo shows.`,
          urls: [...noAlt.keys()].slice(0, 10),
          fix: 'Describe each photo in plain words (material, job, city); use alt="" only for purely decorative images.',
        })
      : finding({ id: 'T14.img-alt', severity: 'P2', status: 'pass', title: 'Images have alt attributes', detail: `${plural(total, 'image')} checked.`, fix: '' }),
  )
  if (noSize.size) {
    out.push(
      finding({
        id: 'T14.img-dimensions',
        severity: 'P2',
        status: 'warn',
        title: `${plural(noSize.size, 'image')} without width and height`,
        detail: `Images without explicit dimensions shift the layout while loading (CLS). Seen on ${listPaths([...new Set(noSize.values())], 4)}.`,
        urls: [...noSize.keys()].slice(0, 10),
        fix: 'Set width and height attributes (the intrinsic size) on every <img>; CSS can still scale them.',
      }),
    )
  }

  const home = ctx.home
  if (home && !home.clientRenderedShell) {
    const hero = home.images.slice(0, 3).find((i) => Number(i.width) >= 600)
    if (hero?.loading === 'lazy') {
      out.push(
        finding({
          id: 'T14.lcp-lazy',
          severity: 'P2',
          status: 'warn',
          title: 'The homepage hero image is lazy-loaded',
          detail: `${hero.src} is one of the first images and has loading="lazy", which delays the largest paint (LCP).`,
          urls: [hero.src],
          fix: 'Remove loading="lazy" from the hero image and add fetchpriority="high".',
        }),
      )
    }
  }
  return out
}

// T15 (PageSpeed) --------------------------------------------------------------

function checkPsi(ctx: Ctx): Finding[] {
  const psi = ctx.psi
  if (!psi || psi.error) return []
  const out: Finding[] = []
  const pct = (v: number) => Math.round(v * 100)
  const lab = psi.lab
  const labText = [
    lab.lcpMs !== null ? `LCP ${(lab.lcpMs / 1000).toFixed(1)}s` : '',
    lab.tbtMs !== null ? `TBT ${Math.round(lab.tbtMs)}ms` : '',
    lab.cls !== null ? `CLS ${lab.cls.toFixed(2)}` : '',
  ]
    .filter(Boolean)
    .join(', ')

  const perf = psi.scores.performance
  if (perf !== null) {
    out.push(
      perf < 0.9
        ? finding({
            id: 'T15.performance',
            severity: perf < 0.5 ? 'P1' : 'P2',
            status: 'fail',
            title: `Mobile performance score ${pct(perf)}/100`,
            detail: `PageSpeed Insights (lab, mobile) for ${psi.url}${labText ? `: ${labText}` : ''}.`,
            urls: [psi.url],
            fix: 'Compress and resize hero images (WebP/AVIF, ≤ 200 KB), preload the LCP image, and cut unused JavaScript and third-party widgets.',
          })
        : finding({ id: 'T15.performance', severity: 'P2', status: 'pass', title: `Mobile performance score ${pct(perf)}/100`, detail: labText, fix: '' }),
    )
  }
  const seo = psi.scores.seo
  if (seo !== null) {
    out.push(
      seo < 0.9
        ? finding({
            id: 'T15.psi-seo',
            severity: 'P2',
            status: 'fail',
            title: `Lighthouse SEO score ${pct(seo)}/100`,
            detail: `PageSpeed Insights' SEO category for ${psi.url} is below 90.`,
            urls: [psi.url],
            fix: 'Open the PageSpeed report for the failing SEO audits (usually link text, tap targets or crawlable links).',
          })
        : finding({ id: 'T15.psi-seo', severity: 'P2', status: 'pass', title: `Lighthouse SEO score ${pct(seo)}/100`, detail: '', fix: '' }),
    )
  }
  const field = psi.field
  if (field) {
    const poor = [
      field.lcpMs !== null && field.lcpMs > 2500 ? `LCP ${(field.lcpMs / 1000).toFixed(1)}s (> 2.5s)` : '',
      field.inpMs !== null && field.inpMs > 200 ? `INP ${field.inpMs}ms (> 200ms)` : '',
      field.cls !== null && field.cls > 0.1 ? `CLS ${field.cls.toFixed(2)} (> 0.1)` : '',
    ].filter(Boolean)
    out.push(
      poor.length
        ? finding({
            id: 'T15.field-cwv',
            severity: 'P1',
            status: 'fail',
            title: 'Real-user Core Web Vitals fail',
            detail: `Chrome UX Report, 75th percentile of real mobile visits: ${poor.join(', ')}.`,
            urls: [psi.url],
            fix: 'Fix the failing metric first — LCP: image size and server time; INP: heavy scripts and widgets; CLS: image dimensions and late-loading banners.',
          })
        : finding({ id: 'T15.field-cwv', severity: 'P1', status: 'pass', title: 'Real-user Core Web Vitals pass', detail: field.category ? `Overall: ${field.category}` : '', fix: '' }),
    )
  }
  return out
}

// T16 / T17 ------------------------------------------------------------------

function checkPhone(ctx: Ctx): Finding[] {
  const out: Finding[] = []
  const pages = ctx.real
  if (!pages.length) return out

  const noTel = pages.filter((p) => !p.telLinks.length)
  out.push(
    noTel.length
      ? finding({
          id: 'T16.tel-links',
          severity: 'P1',
          status: 'fail',
          title: `${plural(noTel.length, 'page')} without a click-to-call link`,
          detail: `${listPaths(noTel.map((p) => p.url))} have no <a href="tel:…">. Most contractor leads are calls from a phone.`,
          urls: noTel.map((p) => p.url),
          fix: 'Put the phone in the header of every page as <a href="tel:+1XXXXXXXXXX">, visible above the fold on mobile.',
        })
      : finding({ id: 'T16.tel-links', severity: 'P1', status: 'pass', title: 'Every page has a click-to-call link', detail: `${plural(pages.length, 'page')} checked.`, fix: '' }),
  )

  const home = ctx.home && !ctx.home.clientRenderedShell ? ctx.home : null
  const want = phoneKey(ctx.facts?.phone)
  if (want && home) {
    const inText = home.phones ? home.phones.includes(want) : digitsOf(home.textSample).includes(want)
    const telKeys = home.telLinks.map(phoneKey).filter((k): k is string => !!k)
    const telWrong = telKeys.length > 0 && !telKeys.includes(want)
    if (!inText || telWrong) {
      out.push(
        finding({
          id: 'T17.nap-phone',
          severity: 'P0',
          status: 'fail',
          title: "The homepage phone doesn't match the business phone",
          detail: [
            !inText ? `${ctx.facts?.phone} doesn't appear in the homepage text${home.phones?.length ? ` (it shows ${home.phones.map(formatPhone).join(', ')})` : ''}.` : '',
            telWrong ? `The tel: link${telKeys.length > 1 ? 's dial' : ' dials'} ${telKeys.map(formatPhone).join(', ')}.` : '',
            'Name, address and phone must match the Google Business Profile exactly — a mismatch splits the business into two entities for Google and AI assistants.',
          ]
            .filter(Boolean)
            .join(' '),
          urls: [home.url],
          fix: `Show ${ctx.facts?.phone} in the header and footer and use it for every tel: link — or correct the phone in Business Facts if the site is right.`,
        }),
      )
    } else {
      out.push(finding({ id: 'T17.nap-phone', severity: 'P0', status: 'pass', title: 'The homepage shows the business phone', detail: `${ctx.facts?.phone} found in the text and tel: links.`, fix: '' }))
    }
  } else if (!want) {
    const numbers = new Set(pages.flatMap((p) => p.telLinks.map(phoneKey)).filter((k): k is string => !!k))
    if (numbers.size > 1) {
      out.push(
        finding({
          id: 'T17.phone-consistency',
          severity: 'P1',
          status: 'warn',
          title: 'Pages dial different phone numbers',
          detail: `tel: links across the site use ${[...numbers].map(formatPhone).join(', ')}. Add the phone to Business Facts to check it against the listing.`,
          urls: pages.filter((p) => p.telLinks.length).map((p) => p.url),
          fix: 'Use the one number from the Google Business Profile everywhere (a tracking number only via dynamic swapping).',
        }),
      )
    }
  }
  return out
}

function formatPhone(d: string): string {
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d
}

// T18 / T25 -------------------------------------------------------------------

function nodesOf(p: PageData): JsonLdNode[] {
  return jsonLdNodes(p.jsonLd.blocks)
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []

function isPlaceholderProfile(url: string): boolean {
  const s = url.trim()
  if (!s || s === '#' || /^javascript:/i.test(s)) return true
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return true
  }
  const path = u.pathname.replace(/\/+$/, '')
  return PROFILE_HOSTS.test(u.hostname) && path === '' && !u.search
}

function checkSchema(ctx: Ctx): Finding[] {
  const out: Finding[] = []
  const home = ctx.home
  if (home) {
    const nodes = nodesOf(home)
    const types = nodes.flatMap(nodeTypes)
    const business = nodes.find((n) => nodeTypes(n).some(isLocalBusinessType))
    if (business) {
      out.push(finding({ id: 'T18.localbusiness', severity: 'P1', status: 'pass', title: 'LocalBusiness schema on the homepage', detail: `@type ${nodeTypes(business).join(', ')}.`, fix: '' }))
    } else {
      const org = types.includes('Organization')
      out.push(
        finding({
          id: 'T18.localbusiness',
          severity: 'P1',
          status: org ? 'warn' : 'fail',
          title: org ? 'Homepage schema is Organization, not LocalBusiness' : 'No LocalBusiness schema on the homepage',
          detail: `${types.length ? `JSON-LD types found: ${types.join(', ')}.` : 'No JSON-LD in the raw HTML.'} A LocalBusiness subtype (e.g. HomeAndConstructionBusiness, RoofingContractor) with name, phone, address/area served and sameAs is what ties the site to the business entity.`,
          urls: [home.url],
          fix: 'Emit one LocalBusiness-subtype node on the homepage, generated from Business Facts, in the server-rendered HTML.',
        }),
      )
    }

    if (ctx.facts && business) {
      const issues: string[] = []
      const tel = phoneKey(strings(business.telephone)[0])
      const want = phoneKey(ctx.facts.phone)
      if (tel && want && tel !== want) issues.push(`telephone is ${formatPhone(tel)}, Business Facts say ${formatPhone(want)}`)
      const name = strings(business.name)[0]
      if (name && ctx.facts.businessName) {
        const a = normName(name)
        const b = normName(ctx.facts.businessName)
        if (a && b && !a.includes(b) && !b.includes(a)) issues.push(`name is "${name}", Business Facts say "${ctx.facts.businessName}"`)
      }
      if (issues.length) {
        out.push(
          finding({
            id: 'T18.schema-nap',
            severity: 'P1',
            status: 'warn',
            title: "Schema NAP doesn't match Business Facts",
            detail: `${issues.join('; ')}.`,
            urls: [home.url],
            fix: 'Generate the schema from Business Facts (or fix the facts if the site is right) so the name and phone match the Google Business Profile.',
          }),
        )
      }
    }

    if (!home.clientRenderedShell && !types.includes('WebSite')) {
      out.push(
        finding({
          id: 'T25.website-schema',
          severity: 'P2',
          status: 'warn',
          title: 'No WebSite schema on the homepage',
          detail: 'Google uses WebSite (name, url) on the homepage to pick the site name shown in results.',
          urls: [home.url],
          fix: 'Add a WebSite node (name = brand, url = homepage, publisher → the business @id) to the homepage JSON-LD.',
        }),
      )
    }
  }

  const selfRated: string[] = []
  const parseBroken: PageData[] = []
  const placeholders = new Set<string>()
  const placeholderPages: string[] = []
  for (const p of ctx.content) {
    if (p.jsonLd.parseErrors > 0) parseBroken.push(p)
    for (const n of nodesOf(p)) {
      const t = nodeTypes(n)
      if ((t.some(isLocalBusinessType) || t.includes('Organization')) && (n.aggregateRating !== undefined || n.review !== undefined || n.reviews !== undefined)) {
        selfRated.push(p.url)
      }
      for (const s of strings(n.sameAs)) {
        if (isPlaceholderProfile(s)) {
          placeholders.add(s || '(empty)')
          placeholderPages.push(p.url)
        }
      }
    }
  }
  const placeholderLinks = new Set<string>()
  for (const p of ctx.real) for (const l of p.externalLinks) if (isPlaceholderProfile(l)) placeholderLinks.add(l)

  if (ctx.content.length) out.push(
    selfRated.length
      ? finding({
          id: 'T18.self-review',
          severity: 'P1',
          status: 'fail',
          title: 'Review stars marked up on the business itself',
          detail: `aggregateRating/review on the site's own LocalBusiness/Organization node (${listPaths(selfRated, 3)}). Google treats self-served review markup as ineligible and it can draw a manual action.`,
          urls: selfRated,
          fix: 'Remove aggregateRating and review from the business schema. Showing reviews visibly on the page is fine.',
        })
      : finding({ id: 'T18.self-review', severity: 'P1', status: 'pass', title: 'No self-serving review markup', detail: '', fix: '' }),
  )
  if (parseBroken.length) {
    out.push(
      finding({
        id: 'T18.jsonld-errors',
        severity: 'P1',
        status: 'fail',
        title: `Invalid JSON-LD on ${plural(parseBroken.length, 'page')}`,
        detail: `${parseBroken.reduce((n, p) => n + p.jsonLd.parseErrors, 0)} <script type="application/ld+json"> blocks aren't valid JSON (${listPaths(parseBroken.map((p) => p.url), 3)}); strict parsers ignore them entirely.`,
        urls: parseBroken.map((p) => p.url),
        fix: 'Build JSON-LD with JSON.stringify instead of string templates.',
      }),
    )
  }
  if (placeholders.size || placeholderLinks.size) {
    const all = [...placeholders, ...placeholderLinks]
    out.push(
      finding({
        id: 'T18.sameas-placeholder',
        severity: 'P2',
        status: 'fail',
        title: 'Placeholder social profile links',
        detail: [
          placeholders.size ? `Schema sameAs lists ${[...placeholders].join(', ')} — a site root, not the business's profile.` : '',
          placeholderLinks.size ? `The page links to ${[...placeholderLinks].join(', ')} (social icons that go to the network's homepage).` : '',
        ]
          .filter(Boolean)
          .join(' '),
        urls: [...new Set([...placeholderPages, ...all])],
        fix: 'Replace them with the real Facebook/Instagram/Yelp/Google profile URLs from Business Facts, or remove them.',
      }),
    )
  }

  const posts = ctx.real.filter((p) => ctx.kindOf(p) === 'blog' && !isNoindex(p))
  if (posts.length) {
    const noArticle = posts.filter((p) => !nodesOf(p).some((n) => nodeTypes(n).some((t) => ARTICLE_TYPES.has(t))))
    const undated = posts.filter((p) => {
      const articles = nodesOf(p).filter((n) => nodeTypes(n).some((t) => ARTICLE_TYPES.has(t)))
      return articles.length > 0 && articles.every((n) => !strings(n.datePublished)[0])
    })
    out.push(
      noArticle.length
        ? finding({
            id: 'T18.blog-schema',
            severity: 'P2',
            status: 'fail',
            title: `${plural(noArticle.length, 'post')} without Article/BlogPosting schema`,
            detail: listPaths(noArticle.map((p) => p.url)),
            urls: noArticle.map((p) => p.url),
            fix: 'Add a BlogPosting node per post: headline, image, datePublished, dateModified, author (a real person) and publisher → the business.',
            fixableByBot: true,
          })
        : finding({ id: 'T18.blog-schema', severity: 'P2', status: 'pass', title: 'Posts have Article schema', detail: `${plural(posts.length, 'post')} checked.`, fix: '' }),
    )
    out.push(
      undated.length
        ? finding({
            id: 'T18.blog-dates',
            severity: 'P2',
            status: 'fail',
            title: `${plural(undated.length, 'post')} without datePublished`,
            detail: `The Article schema on ${listPaths(undated.map((p) => p.url), 3)} has no datePublished, so search engines and AI assistants can't tell how fresh the post is.`,
            urls: undated.map((p) => p.url),
            fix: 'Add datePublished and dateModified (ISO 8601) to each post’s schema, and show "Updated <date>" on the page.',
            fixableByBot: true,
          })
        : finding({ id: 'T18.blog-dates', severity: 'P2', status: 'pass', title: 'Posts are dated in schema', detail: '', fix: '' }),
    )
  }
  return out
}

// T19 ------------------------------------------------------------------------

function checkLinks(ctx: Ctx): Finding[] {
  const out: Finding[] = []
  const pages = ctx.real
  if (!pages.length) return out

  const broken = new Map<string, { label: string; from: Set<string> }>()
  for (const p of pages) {
    for (const l of p.internalLinks) {
      const target = ctx.byKey.get(urlKey(l))
      if (!target || !isDead(target)) continue
      const e = broken.get(target.requestedUrl) ?? { label: deadLabel(target), from: new Set<string>() }
      e.from.add(p.url)
      broken.set(target.requestedUrl, e)
    }
  }
  out.push(
    broken.size
      ? finding({
          id: 'T19.broken-links',
          severity: 'P1',
          status: 'fail',
          title: `${plural(broken.size, 'broken internal link target')}`,
          detail: [...broken]
            .slice(0, 6)
            .map(([u, e]) => `${pathOf(u)} (${e.label}) linked from ${listPaths([...e.from], 2)}`)
            .join('; '),
          urls: [...broken.keys()],
          fix: 'Point the links at live pages, or 301 the dead URLs to the closest live page.',
        })
      : finding({ id: 'T19.broken-links', severity: 'P1', status: 'pass', title: 'No broken internal links', detail: `Links on ${plural(pages.length, 'page')} checked against the crawl.`, fix: '' }),
  )

  // Inbound links and click depth from the homepage, over the crawled graph.
  const inbound = new Map<string, Set<string>>()
  const graph = new Map<string, string[]>()
  for (const p of pages) {
    const from = urlKey(p.url)
    const to = [...new Set(p.internalLinks.map(urlKey))].filter((k) => k !== from)
    graph.set(from, to)
    for (const k of to) inbound.set(k, (inbound.get(k) ?? new Set()).add(from))
  }

  if (ctx.crawl.sitemap.urls.length) {
    const orphans = pages.filter((p) => {
      const k = urlKey(p.url)
      const listed = ctx.sitemapKeys.has(k) || ctx.sitemapKeys.has(urlKey(p.requestedUrl))
      return listed && ctx.kindOf(p) !== 'home' && !isNoindex(p) && !(inbound.get(k)?.size)
    })
    out.push(
      orphans.length
        ? finding({
            id: 'T19.orphans',
            severity: 'P2',
            status: 'warn',
            title: `${plural(orphans.length, 'sitemap page')} with no internal links`,
            detail: `${listPaths(orphans.map((p) => p.url))} are only reachable through the sitemap${ctx.partial ? ' (among the pages crawled — the crawl did not cover the whole site)' : ''}. Pages nothing links to get little crawl priority or ranking weight.`,
            urls: orphans.map((p) => p.url),
            fix: 'Link each from a relevant hub: the services page, the blog index, or a related post or city page.',
          })
        : finding({ id: 'T19.orphans', severity: 'P2', status: 'pass', title: 'Sitemap pages are linked internally', detail: '', fix: '' }),
    )
  }

  if (ctx.home) {
    const depth = new Map<string, number>([[urlKey(ctx.home.url), 0]])
    const queue = [urlKey(ctx.home.url)]
    while (queue.length) {
      const k = queue.shift()!
      for (const next of graph.get(k) ?? []) {
        if (depth.has(next)) continue
        depth.set(next, depth.get(k)! + 1)
        queue.push(next)
      }
    }
    const deep = pages.filter((p) => (depth.get(urlKey(p.url)) ?? 0) > 3)
    if (deep.length) {
      out.push(
        finding({
          id: 'T19.click-depth',
          severity: 'P2',
          status: 'warn',
          title: `${plural(deep.length, 'page')} more than 3 clicks from the homepage`,
          detail: deep
            .slice(0, 6)
            .map((p) => `${pathOf(p.url)} (${depth.get(urlKey(p.url))} clicks)`)
            .join(', '),
          urls: deep.map((p) => p.url),
          fix: 'Link important pages from the homepage, the main menu or a hub page.',
        }),
      )
    }
  }
  return out
}

// T21 / T23 ------------------------------------------------------------------

function checkThin(ctx: Ctx): Finding[] {
  const pages = ctx.real.filter((p) => !isNoindex(p) && !['utility', 'contact'].includes(ctx.kindOf(p)))
  if (!pages.length) return []
  const minWords = (p: PageData) => (ctx.kindOf(p) === 'service' ? 500 : 300)
  const thin = pages.filter((p) => wordsOf(p) < minWords(p))
  if (!thin.length) {
    return [finding({ id: 'T21.thin-pages', severity: 'P2', status: 'pass', title: 'No thin pages', detail: `${plural(pages.length, 'page')} checked (300 words; 500 on service pages).`, fix: '' })]
  }
  return splitByBlog(ctx, thin, (s, blog) =>
    finding({
      id: 'T21.thin-pages',
      severity: 'P2',
      status: 'warn',
      title: `${plural(s.length, blog ? 'thin post' : 'thin page')}`,
      detail: `Main-content words (excluding header/footer): ${s
        .slice(0, 8)
        .map((p) => `${pathOf(p.url)} ${wordsOf(p)}`)
        .join(', ')}. House thresholds: 300 words, 500 on service pages — flagged for review, not a Google rule.`,
      urls: s.map((p) => p.url),
      fix: blog
        ? 'Expand with first-party detail: real prices, a project, local permit notes, FAQs from real calls.'
        : 'Add what a customer needs to decide: process, materials, price drivers, areas served, real project photos and FAQs.',
    }),
  )
}

function checkMixedContent(ctx: Ctx): Finding[] {
  if (ctx.origin.protocol !== 'https:' || !ctx.content.length) return []
  const resources = new Set<string>()
  const pages: string[] = []
  for (const p of ctx.content) {
    if (!p.mixedContent.length) continue
    pages.push(p.url)
    for (const r of p.mixedContent) resources.add(r)
  }
  return [
    resources.size
      ? finding({
          id: 'T23.mixed-content',
          severity: 'P1',
          status: 'fail',
          title: `Insecure http:// resources on ${plural(pages.length, 'page')}`,
          detail: `${plural(resources.size, 'resource')} load over http:// on https pages (${listPaths(pages, 3)}); browsers block or flag them.`,
          urls: [...resources],
          fix: 'Load every image, script, stylesheet and iframe over https:// (or a relative URL).',
        })
      : finding({ id: 'T23.mixed-content', severity: 'P1', status: 'pass', title: 'No mixed content', detail: '', fix: '' }),
  ]
}

// T27 / T28 ------------------------------------------------------------------

function checkTrust(ctx: Ctx): Finding[] {
  const out: Finding[] = []
  if (ctx.real.length) {
    const known = new Set<string>()
    for (const p of ctx.content) {
      known.add(pathOf(p.url))
      for (const l of p.internalLinks) known.add(pathOf(l))
    }
    const paths = [...known]
    const about = paths.some((p) => ABOUT_RE.test(p))
    const contact = paths.some((p) => CONTACT_RE.test(p))
    const missing = [!about ? 'About' : '', !contact ? 'Contact' : ''].filter(Boolean)
    out.push(
      missing.length
        ? finding({
            id: 'T27.about-contact',
            severity: 'P1',
            status: 'warn',
            title: `No ${missing.join(' or ')} page found`,
            detail: `None of the crawled or linked URLs look like ${missing.join(' / ')} pages. Who runs the business and how to reach them are core trust signals for Google and AI assistants.`,
            urls: [ctx.origin.href],
            fix: `Add ${missing.map((m) => `/${m.toLowerCase()}`).join(' and ')} with the owner, years in business, license, insurance and service area.`,
          })
        : finding({ id: 'T27.about-contact', severity: 'P1', status: 'pass', title: 'About and Contact pages exist', detail: '', fix: '' }),
    )
  }

  const f = ctx.facts
  if (f) {
    const missing = [
      !f.license ? 'license number' : '',
      !f.insurance ? 'insurance' : '',
      !f.established ? 'year established' : '',
      !f.warranty ? 'warranty terms' : '',
      !f.owner ? 'owner name' : '',
    ].filter(Boolean)
    out.push(
      missing.length
        ? finding({
            id: 'T27.eeat-facts',
            severity: 'P2',
            status: 'warn',
            title: 'Trust facts missing from Business Facts',
            detail: `No ${missing.join(', ')} on file. These are the E-E-A-T details a contractor site should show — and the engine can't write them without the client.`,
            fix: `Ask the client for: ${missing.join(', ')}.`,
          })
        : finding({ id: 'T27.eeat-facts', severity: 'P2', status: 'pass', title: 'Trust facts are on file', detail: '', fix: '' }),
    )
  }
  return out
}

function checkLlmsTxt(ctx: Ctx): Finding[] {
  const s = ctx.crawl.llmsTxt.status
  const url = `${ctx.origin.origin}/llms.txt`
  const shell = ctx.crawl.errors.some((e) => e.startsWith('llms.txt:'))
  if (s !== null && s >= 200 && s < 300 && !shell) {
    return [finding({ id: 'T28.llms-txt', severity: 'P2', status: 'pass', title: 'llms.txt is served', detail: 'Optional file present.', fix: '' })]
  }
  if (s !== null && s >= 500) {
    return [
      finding({
        id: 'T28.llms-txt',
        severity: 'P2',
        status: 'fail',
        title: `llms.txt returns HTTP ${s}`,
        detail: 'A server error on llms.txt is scored as a failure by Lighthouse’s agentic-browsing audit; a missing file is not.',
        urls: [url],
        fix: 'Serve llms.txt as a static file, or remove the route so it 404s cleanly.',
        fixableByBot: true,
      }),
    ]
  }
  return [
    finding({
      id: 'T28.llms-txt',
      severity: 'P2',
      status: 'warn',
      title: shell ? 'llms.txt returns the app’s HTML, not a text file' : 'No llms.txt (optional)',
      detail: shell
        ? '/llms.txt answers 200 with the site’s HTML page (single-page-app fallback).'
        : 'Optional and low priority — Google ignores it and it is never a ranking requirement — but it is cheap to generate from the sitemap.',
      urls: [url],
      fix: 'Generate public/llms.txt: business summary, services, areas served, and links to the key pages.',
      fixableByBot: true,
    }),
  ]
}

// ---------------------------------------------------------------------------

export function auditSite(crawl: CrawlResult, facts: BusinessFacts | null, psi: PsiResult | null): AuditResult {
  const ctx = buildCtx(crawl, facts, psi)
  const findings = [
    ...checkReachable(ctx),
    ...checkHttps(ctx),
    ...checkHost(ctx),
    ...checkSoft404(ctx),
    ...checkRawHtml(ctx),
    ...checkRobots(ctx),
    ...checkSitemap(ctx),
    ...checkNoindex(ctx),
    ...checkCanonical(ctx),
    ...checkTitles(ctx),
    ...checkDescriptions(ctx),
    ...checkHeadings(ctx),
    ...checkViewportLang(ctx),
    ...checkOpenGraph(ctx),
    ...checkImages(ctx),
    ...checkPsi(ctx),
    ...checkPhone(ctx),
    ...checkSchema(ctx),
    ...checkLinks(ctx),
    ...checkThin(ctx),
    ...checkMixedContent(ctx),
    ...checkTrust(ctx),
    ...checkLlmsTxt(ctx),
  ].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.id.localeCompare(b.id),
  )

  let penalty = 0
  const counts = { P0: 0, P1: 0, P2: 0, pass: 0 }
  for (const f of findings) {
    if (f.status === 'pass') {
      counts.pass++
      continue
    }
    counts[f.severity]++
    penalty += f.status === 'fail' ? PENALTY[f.severity] : PENALTY[f.severity] / 2
  }

  // A site with a P0 failure (not indexable, blank to AI crawlers, wrong
  // phone…) must never outscore one without, however many small checks it
  // happens to pass or skip.
  const raw = Math.max(0, Math.round(100 - penalty))
  const hasP0 = findings.some((f) => f.severity === 'P0' && f.status === 'fail')
  return {
    score: hasP0 ? Math.min(raw, 49) : raw,
    findings,
    counts,
    pagesCrawled: crawl.pages.length,
  }
}
