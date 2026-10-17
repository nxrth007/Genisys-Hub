import { prisma } from '@/lib/prisma'
import {
  GSC_OAUTH_SCOPES,
  gscConfigured,
  gscGrantedScopes,
  gscInspectUrl,
  gscListSitemaps,
  gscListSites,
  gscTotals,
  type GscInspection,
  type GscSitemap,
} from './gsc'

/**
 * Is Search Console really working, beyond "Google gave us a token"?
 *
 * The dashboard's green dot only proves the sign-in refreshes. This checks
 * what the weekly runs depend on, per connected site: the property is still
 * in the account with enough access, Google is reading the sitemap, the
 * homepage and the newest posts are indexed, and search data comes back.
 * Read-only; the last result is kept so the dashboard can show it.
 */

const RESULT_KEY = 'seo.gsc.health'
const DAY = 86_400_000
/** Newest live posts inspected per site — enough to spot a pattern, cheap on Google's quota. */
const POSTS_PER_SITE = 3
const PARALLEL = 3

export type GscHealthLevel = 'ok' | 'warn' | 'fail'

export type GscSiteHealth = {
  siteId: string
  name: string
  property: string
  level: GscHealthLevel
  /** Plain-English findings, worst first. */
  findings: { level: GscHealthLevel; text: string }[]
  permission: string | null
  sitemaps: GscSitemap[]
  home: GscInspection | null
  posts: GscInspection[]
  last28: { clicks: number; impressions: number } | null
}

export type GscHealth = {
  checkedAt: string
  level: GscHealthLevel
  account: { email: string | null; kind: 'oauth' | 'serviceAccount' | null; findings: { level: GscHealthLevel; text: string }[] }
  sites: GscSiteHealth[]
  /** Active sites with a live URL and no Search Console property yet. */
  notConnected: string[]
}

const worst = (levels: GscHealthLevel[]): GscHealthLevel =>
  levels.includes('fail') ? 'fail' : levels.includes('warn') ? 'warn' : 'ok'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const daysAgo = (iso: string | null, now: number) => (iso ? Math.floor((now - Date.parse(iso)) / DAY) : null)

async function inParallel<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

function originOf(url: string | null): string | null {
  try {
    return url ? new URL(url).origin : null
  } catch {
    return null
  }
}

/** A URL-prefix property only covers URLs under it; a domain property covers the whole domain. */
export function covers(property: string, url: string): boolean {
  if (property.startsWith('sc-domain:')) {
    const domain = property.slice('sc-domain:'.length).toLowerCase()
    try {
      const host = new URL(url).hostname.toLowerCase()
      return host === domain || host.endsWith(`.${domain}`)
    } catch {
      return false
    }
  }
  return url.startsWith(property)
}

async function checkSite(
  site: { id: string; name: string; gscProperty: string; liveUrl: string | null },
  listed: { siteUrl: string; permissionLevel: string }[],
  now: number,
): Promise<GscSiteHealth> {
  const property = site.gscProperty
  const findings: GscSiteHealth['findings'] = []
  const result: GscSiteHealth = {
    siteId: site.id, name: site.name, property, level: 'ok', findings,
    permission: null, sitemaps: [], home: null, posts: [], last28: null,
  }
  const done = () => {
    findings.sort((a, b) => ['fail', 'warn', 'ok'].indexOf(a.level) - ['fail', 'warn', 'ok'].indexOf(b.level))
    result.level = worst(findings.map((f) => f.level))
    return result
  }

  // 1. Still in the account, with enough access?
  const entry = listed.find((e) => e.siteUrl === property)
  result.permission = entry?.permissionLevel ?? null
  if (!entry) {
    findings.push({ level: 'fail', text: `${property} isn’t in the connected account’s Search Console any more — the weekly runs get no search data. Re-add it, or clear the property in the site’s Settings so the Hub reconnects it.` })
    return done()
  }
  if (entry.permissionLevel === 'siteUnverifiedUser') {
    findings.push({ level: 'fail', text: 'The account lost its verification for this property (the verification file may have been deleted). Clear the property in the site’s Settings and the Hub re-verifies it.' })
    return done()
  }
  if (entry.permissionLevel === 'siteRestrictedUser') {
    findings.push({ level: 'warn', text: 'Restricted (read-only) access: search data works, but the Hub can’t submit sitemaps. Make the account an Owner or Full user.' })
  }

  const origin = originOf(site.liveUrl)
  const recentPosts = await prisma.seoPost.findMany({
    where: { siteId: site.id, status: 'live', url: { not: null } },
    orderBy: { updatedAt: 'desc' },
    take: POSTS_PER_SITE,
    select: { url: true, title: true, updatedAt: true },
  })

  const [sitemaps, home, totals, posts] = await Promise.allSettled([
    gscListSitemaps(property),
    origin && covers(property, `${origin}/`) ? gscInspectUrl(property, `${origin}/`) : Promise.resolve(null),
    gscTotals(property, new Date(now)),
    Promise.all(
      recentPosts
        .filter((p) => p.url && covers(property, p.url))
        .map(async (p) => ({ inspection: await gscInspectUrl(property, p.url!), title: p.title, liveFor: Math.floor((now - p.updatedAt.getTime()) / DAY) })),
    ),
  ])

  // 2. Sitemap read by Google, without errors?
  if (sitemaps.status === 'rejected') {
    findings.push({ level: 'warn', text: `Couldn’t read the sitemap status: ${message(sitemaps.reason)}` })
  } else {
    result.sitemaps = sitemaps.value
    if (!sitemaps.value.length) {
      findings.push({ level: 'warn', text: 'No sitemap is submitted, so Google finds new posts more slowly. The Hub submits it after the next publish, or submit /sitemap.xml in Search Console.' })
    }
    for (const s of sitemaps.value) {
      const read = daysAgo(s.lastDownloaded, now)
      if (s.errors > 0) findings.push({ level: 'fail', text: `Google reports ${s.errors} error(s) reading ${s.path}. Open Search Console → Sitemaps for details.` })
      else if (s.warnings > 0) findings.push({ level: 'warn', text: `Google reports ${s.warnings} warning(s) for ${s.path}.` })
      if (read === null && !s.isPending) findings.push({ level: 'warn', text: `Google has never read ${s.path}.` })
      else if (read !== null && read > 30) findings.push({ level: 'warn', text: `Google last read ${s.path} ${read} days ago.` })
    }
  }

  // 3. Homepage on Google?
  if (home.status === 'rejected') {
    findings.push({ level: 'warn', text: `Couldn’t inspect the homepage: ${message(home.reason)}` })
  } else if (home.value) {
    result.home = home.value
    const h = home.value
    if (h.verdict !== 'PASS') {
      findings.push({ level: 'fail', text: `The homepage isn’t on Google: “${h.coverageState ?? h.verdict}”.` })
    } else if (h.googleCanonical && h.userCanonical && h.googleCanonical !== h.userCanonical) {
      findings.push({ level: 'warn', text: `Google picked ${h.googleCanonical} as the homepage, not ${h.userCanonical} — check the www/non-www redirect and canonical.` })
    }
  } else if (!origin) {
    findings.push({ level: 'warn', text: 'The site has no live URL, so the homepage wasn’t inspected.' })
  } else {
    findings.push({ level: 'warn', text: `${origin}/ isn’t covered by the property ${property} — the property may be for another domain or the www/non-www twin.` })
  }

  // 4. Are the engine's posts getting indexed?
  if (posts.status === 'rejected') {
    findings.push({ level: 'warn', text: `Couldn’t inspect the newest posts: ${message(posts.reason)}` })
  } else {
    result.posts = posts.value.map((p) => p.inspection)
    for (const p of posts.value) {
      if (p.inspection.verdict === 'PASS') continue
      // Google often takes a week or two to index a new page on a small site.
      const level: GscHealthLevel = p.liveFor >= 14 ? 'warn' : 'ok'
      findings.push({
        level,
        text: `“${p.title}” isn’t indexed yet (${p.inspection.coverageState ?? p.inspection.verdict})${p.liveFor < 14 ? ` — it’s ${p.liveFor} day(s) old, which is normal` : ` after ${p.liveFor} days`}.`,
      })
    }
  }

  // 5. Search data flowing?
  if (totals.status === 'rejected') {
    findings.push({ level: 'fail', text: `Search data didn’t come back: ${message(totals.reason)}` })
  } else {
    result.last28 = { clicks: totals.value.clicks, impressions: totals.value.impressions }
    if (totals.value.impressions === 0) {
      findings.push({ level: 'warn', text: 'No search impressions in the last 28 days. Normal for a brand-new site; otherwise the site may not be indexed.' })
    }
  }

  if (!findings.length) findings.push({ level: 'ok', text: 'Property, sitemap, indexing and search data all look right.' })
  return done()
}

/** Run every check now. Never throws; failures come back as findings. */
export async function checkGscHealth(): Promise<GscHealth> {
  const now = Date.now()
  const health: GscHealth = {
    checkedAt: new Date(now).toISOString(),
    level: 'ok',
    account: { email: null, kind: null, findings: [] },
    sites: [],
    notConnected: [],
  }
  const acct = health.account.findings

  const configured = await gscConfigured()
  if (!configured.ok) {
    acct.push({ level: 'fail', text: configured.error ?? 'Search Console isn’t connected — SEO → Setup → Connect Search Console.' })
    health.level = 'fail'
    return save(health)
  }
  health.account.email = configured.account ?? configured.serviceAccountEmail

  try {
    const granted = await gscGrantedScopes()
    health.account.kind = granted?.kind ?? null
    if (granted?.kind === 'oauth' && granted.scopes) {
      const missing = GSC_OAUTH_SCOPES.filter((s) => !granted.scopes!.includes(s))
      if (missing.length) {
        acct.push({ level: 'fail', text: `The Google sign-in is missing ${missing.map((m) => m.split('/').pop()).join(' and ')} permission — connect Search Console again and tick every box on Google’s screen.` })
      }
    }
  } catch (err) {
    acct.push({ level: 'warn', text: `Couldn’t read the sign-in’s permissions: ${message(err)}` })
  }

  let listed: { siteUrl: string; permissionLevel: string }[]
  try {
    listed = await gscListSites()
  } catch (err) {
    acct.push({ level: 'fail', text: `Couldn’t list the account’s Search Console properties: ${message(err)}` })
    health.level = 'fail'
    return save(health)
  }

  const sites = await prisma.seoSite.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, gscProperty: true, liveUrl: true },
    orderBy: { name: 'asc' },
  })
  health.notConnected = sites.filter((s) => !s.gscProperty && s.liveUrl).map((s) => s.name)
  const connected = sites.filter((s): s is typeof s & { gscProperty: string } => !!s.gscProperty)
  health.sites = await inParallel(connected, PARALLEL, (s) =>
    checkSite(s, listed, now).catch((err) => ({
      siteId: s.id, name: s.name, property: s.gscProperty, level: 'fail' as const,
      findings: [{ level: 'fail' as const, text: `Check failed: ${message(err)}` }],
      permission: null, sitemaps: [], home: null, posts: [], last28: null,
    })),
  )

  if (!acct.length) acct.push({ level: 'ok', text: `Signed in as ${health.account.email}, with Search Console and Site Verification access.` })
  health.level = worst([...acct.map((f) => f.level), ...health.sites.map((s) => s.level)])
  return save(health)
}

async function save(health: GscHealth): Promise<GscHealth> {
  const value = JSON.stringify(health)
  await prisma.appSetting
    .upsert({ where: { key: RESULT_KEY }, create: { key: RESULT_KEY, value }, update: { value } })
    .catch((err) => console.warn('[seo] couldn’t store the Search Console health check:', err))
  return health
}

export async function lastGscHealth(): Promise<GscHealth | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: RESULT_KEY } }).catch(() => null)
  if (!row) return null
  try {
    return JSON.parse(row.value) as GscHealth
  } catch {
    return null
  }
}
