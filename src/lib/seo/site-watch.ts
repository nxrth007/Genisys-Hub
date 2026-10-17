import { prisma } from '@/lib/prisma'
import { fetchPage } from './crawl'
import { gscConnectStates } from './gsc-connect'
import { checkGscHealth, covers } from './gsc-health'
import { gscConfigured, gscInspectUrl } from './gsc'
import { bareHost } from './html'
import { seoAlert } from './slack'

/**
 * Is what the engine shipped still out there, and is Google taking it?
 *
 * A run ends once its posts are live, but a site can lose them afterwards
 * (a Lovable project republished from an old version, another client's
 * build pushed into the repo) and nothing else would notice. Once a day
 * this re-checks every ready site from the outside — homepage, canonical
 * domain, sitemap, every post the Hub calls live, the IndexNow key and the
 * Google verification file — runs the Search Console health check, and
 * inspects each post in Search Console 7 and 14 days after it went live.
 * One Slack digest lists what's wrong, new problems first.
 *
 * Separately, every half hour: a merged run whose posts still aren't live
 * a day later gets one alert, instead of waiting out the 7-day publish watch.
 */

const STATE_KEY = 'seo.watch'
const PUBLISH_STATE_KEY = 'seo.watch.publish'
/** 14:00 UTC = 10 AM New York: after the Monday runs, before the working day gets busy. */
const RUN_HOUR_UTC = 14
const DAY = 86_400_000
const NOT_LIVE_AFTER_MS = DAY
const PUBLISH_CHECK_EVERY_MS = 30 * 60_000
/** Merges older than this are history, not something to chase. */
const NOT_LIVE_LOOKBACK_MS = 30 * DAY
const INDEX_CHECK_DAYS = [7, 14] as const
const PARALLEL = 4
const TIMEOUT_MS = 20_000
const UA = 'Mozilla/5.0 (compatible; GenisysSEOBot/1.0; +https://leadgenisys.com)'

export type WatchProblem = {
  /** Stable across days, so a problem is only "new" once. */
  key: string
  site: string
  level: 'fail' | 'warn' | 'note'
  text: string
}

type WatchState = {
  lastDailyAt: string | null
  /** Problem key → when it was first seen. */
  open: Record<string, string>
  /** Post id → the latest day-mark (7, 14) its Search Console inspection ran for. */
  indexChecks: Record<string, number>
  problems: WatchProblem[]
}

export type WatchResult = { checkedAt: string; sites: number; problems: WatchProblem[]; newCount: number }

const g = globalThis as unknown as { __seoWatchDay?: string; __seoWatch?: Promise<WatchResult> | null; __seoPublishCheckAt?: number }

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function hubUrl(path: string): string {
  return `${(process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')}${path}`
}

async function readJson<T>(key: string): Promise<T | null> {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null)
  if (!row) return null
  try {
    return JSON.parse(row.value) as T
  } catch {
    return null
  }
}

async function writeJson(key: string, v: unknown): Promise<void> {
  const value = JSON.stringify(v)
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function inParallel<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) await fn(items[next++])
    }),
  )
}

async function getText(url: string): Promise<{ status: number; text: string } | { status: 0; error: string }> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
    return { status: res.status, text: res.ok ? await res.text() : '' }
  } catch (err) {
    return { status: 0, error: message(err) }
  }
}

const statusLabel = (r: { status: number; error?: string }) => (r.status ? `HTTP ${r.status}` : (r.error ?? 'no response'))

// ---------------------------------------------------------------------------
// One site, from the outside
// ---------------------------------------------------------------------------

type WatchedSite = {
  id: string
  name: string
  liveUrl: string | null
  indexNowKey: string | null
  foundationStatus: string
  gscProperty: string | null
}

async function checkSite(site: WatchedSite, token: string | null, problems: WatchProblem[]): Promise<void> {
  const origin = originOf(site.liveUrl)
  if (!origin) return
  const host = bareHost(new URL(origin).hostname)
  const add = (key: string, level: WatchProblem['level'], text: string) => problems.push({ key: `${key}:${site.id}`, site: site.name, level, text })

  const home = await fetchPage(origin, { timeoutMs: TIMEOUT_MS })
  if (home.status !== 200 || home.error) {
    add('down', 'fail', `${origin} doesn’t load (${home.error ?? `HTTP ${home.status}`}).`)
    return
  }
  if (home.canonical) {
    let canonicalHost: string | null = null
    try {
      canonicalHost = bareHost(new URL(home.canonical, home.url).hostname)
    } catch {
      canonicalHost = null
    }
    if (canonicalHost && canonicalHost !== host) {
      add('canonical', 'fail', `The homepage’s canonical link points at ${canonicalHost}, not ${host} — Google is told to rank the other domain. The next weekly run’s pull request fixes it once approved.`)
    }
  }

  const sitemap = await getText(`${origin}/sitemap.xml`)
  if (sitemap.status !== 200 || !('text' in sitemap) || !/<(?:urlset|sitemapindex)[\s>]/i.test(sitemap.text)) {
    add('sitemap', 'fail', `${origin}/sitemap.xml isn’t a working sitemap (${statusLabel(sitemap)}${sitemap.status === 200 ? ', not XML' : ''}), so Google can’t read it.`)
  } else {
    const hosts = new Set<string>()
    for (const m of sitemap.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      try {
        hosts.add(bareHost(new URL(m[1]).hostname))
      } catch {
        /* skip */
      }
    }
    const others = [...hosts].filter((h) => h !== host)
    if (others.length) add('sitemap-host', 'fail', `The sitemap lists pages on ${others.join(', ')} instead of ${host}, so Google rejects them.`)
  }

  if (site.indexNowKey && site.foundationStatus === 'installed') {
    const key = await getText(`${origin}/${site.indexNowKey}.txt`)
    if (key.status !== 200 || !('text' in key) || key.text.trim() !== site.indexNowKey) {
      add('indexnow', 'warn', `The IndexNow key file isn’t live (${statusLabel(key)}), so Bing ignores the Hub’s pings — the last merge may never have been published.`)
    }
  }

  if (token && site.gscProperty?.startsWith('http')) {
    const url = `${site.gscProperty.replace(/\/+$/, '')}/${token}`
    const file = await getText(url)
    if (file.status !== 200 || !('text' in file) || !file.text.includes(`google-site-verification: ${token}`)) {
      add('gsc-file', 'fail', `Google’s verification file is gone (${statusLabel(file)}) — Search Console will drop the site’s verification. The live site may be an old version.`)
    }
  }

  const posts = await prisma.seoPost.findMany({
    where: { siteId: site.id, status: 'live', url: { not: null } },
    select: { id: true, title: true, url: true },
  })
  const down: string[] = []
  await inParallel(posts, async (p) => {
    const page = await fetchPage(p.url!, { timeoutMs: TIMEOUT_MS })
    if (page.status !== 200 || page.error) down.push(`“${p.title}” (${page.error && !page.status ? page.error : `HTTP ${page.status}`})`)
  })
  if (down.length) {
    add('posts-down', 'fail', `${down.length} of ${posts.length} live post${posts.length === 1 ? '' : 's'} no longer load: ${down.slice(0, 5).join(', ')}${down.length > 5 ? '…' : ''}. The site was probably republished from an older version — publish the current one in Lovable.`)
  }
}

// ---------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------

const normKey = (text: string) => text.replace(/\d+/g, '#').slice(0, 80)

async function gscProblems(problems: WatchProblem[]): Promise<void> {
  const health = await checkGscHealth()
  for (const f of health.account.findings) {
    if (f.level === 'fail') problems.push({ key: `gsc:account:${normKey(f.text)}`, site: 'Search Console', level: 'fail', text: f.text })
  }
  for (const s of health.sites) {
    for (const f of s.findings) {
      // Warnings are mostly "new site, no impressions yet"; only a post still unindexed after two weeks is worth a ping.
      const stale = f.level === 'warn' && /isn’t indexed yet/.test(f.text)
      if (f.level === 'fail' || stale) problems.push({ key: `gsc:${s.siteId}:${normKey(f.text)}`, site: s.name, level: f.level === 'fail' ? 'fail' : 'warn', text: `Search Console: ${f.text}` })
    }
  }
}

/** Each live post gets inspected once at 7 days and once at 14 days after it went live. */
async function indexChecks(sites: WatchedSite[], done: Record<string, number>, problems: WatchProblem[], now: number): Promise<Record<string, number>> {
  const next: Record<string, number> = {}
  if (!(await gscConfigured()).ok) return done
  const bySite = new Map(sites.filter((s) => s.gscProperty).map((s) => [s.id, s]))
  const posts = await prisma.seoPost.findMany({
    where: { siteId: { in: [...bySite.keys()] }, status: 'live', url: { not: null } },
    select: { id: true, siteId: true, title: true, url: true, updatedAt: true, runId: true },
  })
  const runIds = [...new Set(posts.map((p) => p.runId).filter((id): id is string => !!id))]
  const publishedAt = new Map(
    (await prisma.seoRun.findMany({ where: { id: { in: runIds } }, select: { id: true, publishedAt: true } })).map((r) => [r.id, r.publishedAt]),
  )
  const due: { post: (typeof posts)[number]; site: WatchedSite; mark: number; age: number }[] = []
  for (const p of posts) {
    const site = bySite.get(p.siteId)!
    const age = Math.floor((now - ((p.runId && publishedAt.get(p.runId)) || p.updatedAt).getTime()) / DAY)
    if (age > 30) continue
    const prev = done[p.id] ?? 0
    next[p.id] = prev
    const mark = [...INDEX_CHECK_DAYS].reverse().find((d) => age >= d && prev < d)
    if (mark && covers(site.gscProperty!, p.url!)) due.push({ post: p, site, mark, age })
  }
  await inParallel(due, async ({ post, site, mark, age }) => {
    try {
      const r = await gscInspectUrl(site.gscProperty!, post.url!)
      next[post.id] = mark
      if (r.verdict === 'PASS') return
      problems.push({
        key: `index${mark}:${post.id}`,
        site: site.name,
        level: mark >= 14 ? 'warn' : 'note',
        text: `“${post.title}” isn’t on Google after ${age} days (${r.coverageState ?? r.verdict}).${mark >= 14 ? ' Check it in Search Console → URL Inspection and request indexing.' : ' Normal so far; it’s checked again at 14 days.'}`,
      })
    } catch (err) {
      problems.push({ key: `index-error:${site.id}`, site: site.name, level: 'warn', text: `Couldn’t inspect “${post.title}” in Search Console: ${message(err)}` })
    }
  })
  return next
}

// ---------------------------------------------------------------------------
// Merged but not live
// ---------------------------------------------------------------------------

async function notLiveRuns(now: number) {
  return prisma.seoRun.findMany({
    where: {
      mergedAt: { lte: new Date(now - NOT_LIVE_AFTER_MS), gte: new Date(now - NOT_LIVE_LOOKBACK_MS) },
      publishedAt: null,
      status: { in: ['awaiting_publish', 'done'] },
    },
    select: { id: true, kind: true, weekOf: true, mergedAt: true, site: { select: { name: true, liveUrl: true } } },
  })
}

const notLiveText = (r: Awaited<ReturnType<typeof notLiveRuns>>[number], now: number) =>
  `${r.kind === 'foundation' ? 'The SEO foundation' : `Week ${r.weekOf}`} merged ${Math.floor((now - r.mergedAt!.getTime()) / 3_600_000)} hours ago and still isn’t live on ${r.site.liveUrl ?? 'the site'}. Publish it in Lovable. ${hubUrl(`/seo/runs/${r.id}`)}`

/** Every half hour from the scheduler: one alert per merged run that isn't live a day later. */
export async function maybeCheckStalePublishes(now = Date.now()): Promise<number> {
  if (g.__seoPublishCheckAt && now - g.__seoPublishCheckAt < PUBLISH_CHECK_EVERY_MS) return 0
  g.__seoPublishCheckAt = now
  const runs = await notLiveRuns(now)
  if (!runs.length) return 0
  const state = (await readJson<{ alerted: string[] }>(PUBLISH_STATE_KEY)) ?? { alerted: [] }
  const fresh = runs.filter((r) => !state.alerted.includes(r.id))
  if (!fresh.length) return 0
  for (const r of fresh) await seoAlert(`:rotating_light: *SEO* — ${r.site.name}: ${notLiveText(r, now)}`)
  await writeJson(PUBLISH_STATE_KEY, { alerted: [...fresh.map((r) => r.id), ...state.alerted].slice(0, 200) })
  return fresh.length
}

// ---------------------------------------------------------------------------
// The daily check
// ---------------------------------------------------------------------------

async function runOnce(opts: { alert: boolean }): Promise<WatchResult> {
  const now = Date.now()
  const prev = (await readJson<WatchState>(STATE_KEY)) ?? { lastDailyAt: null, open: {}, indexChecks: {}, problems: [] }
  const sites: WatchedSite[] = await prisma.seoSite.findMany({
    where: { enabled: true, archivedAt: null, AND: [{ liveUrl: { not: null } }, { liveUrl: { not: '' } }] },
    select: { id: true, name: true, liveUrl: true, indexNowKey: true, foundationStatus: true, gscProperty: true },
    orderBy: { name: 'asc' },
  })
  const tokens = await gscConnectStates().catch(() => ({}) as Awaited<ReturnType<typeof gscConnectStates>>)

  const problems: WatchProblem[] = []
  await inParallel(sites, async (s) => {
    const st = tokens[s.id]
    await checkSite(s, st?.status === 'connected' && st.property === s.gscProperty ? (st.token ?? null) : null, problems).catch((err) =>
      problems.push({ key: `check-error:${s.id}`, site: s.name, level: 'warn', text: `The daily check failed: ${message(err)}` }),
    )
  })
  for (const r of await notLiveRuns(now)) problems.push({ key: `not-live:${r.id}`, site: r.site.name, level: 'fail', text: notLiveText(r, now) })
  await gscProblems(problems).catch((err) => problems.push({ key: 'gsc:check-error', site: 'Search Console', level: 'warn', text: `The health check failed: ${message(err)}` }))
  const checks = await indexChecks(sites, prev.indexChecks ?? {}, problems, now).catch((err) => {
    problems.push({ key: 'index-checks-error', site: 'Search Console', level: 'warn', text: `Post inspections failed: ${message(err)}` })
    return prev.indexChecks ?? {}
  })

  const rank = { fail: 0, warn: 1, note: 2 }
  problems.sort((a, b) => rank[a.level] - rank[b.level] || a.site.localeCompare(b.site))
  const stamp = new Date(now).toISOString()
  const open: Record<string, string> = {}
  for (const p of problems) open[p.key] = prev.open?.[p.key] ?? stamp
  const fresh = problems.filter((p) => !prev.open?.[p.key])

  // A run by hand only shows the result: what counts as new, and which
  // inspections are done, stays for the daily digest to report.
  await writeJson(
    STATE_KEY,
    opts.alert
      ? ({ lastDailyAt: stamp, open, indexChecks: checks, problems } satisfies WatchState)
      : ({ ...prev, problems } satisfies WatchState),
  )
  if (opts.alert && problems.length) await postDigest(problems, fresh)
  return { checkedAt: stamp, sites: sites.length, problems, newCount: fresh.length }
}

async function postDigest(problems: WatchProblem[], fresh: WatchProblem[]): Promise<void> {
  const icon = { fail: ':red_circle:', warn: ':large_orange_circle:', note: ':white_circle:' }
  const line = (p: WatchProblem) => `${icon[p.level]} *${p.site}* — ${p.text}`
  const ongoing = problems.filter((p) => !fresh.includes(p) && p.level !== 'note')
  const lines = [`:stethoscope: *SEO daily check* — ${problems.length} thing${problems.length === 1 ? '' : 's'} to look at`]
  if (fresh.length) lines.push('', '*New since yesterday*', ...fresh.map(line))
  if (ongoing.length) {
    lines.push('', `*Still open* (${ongoing.length})`)
    // Already reported in full; a short reminder keeps the digest readable.
    const bySite = new Map<string, number>()
    for (const p of ongoing) bySite.set(p.site, (bySite.get(p.site) ?? 0) + 1)
    lines.push([...bySite.entries()].map(([s, n]) => `${s} (${n})`).join(', '))
  }
  if (!fresh.length && !ongoing.length) return
  lines.push('', hubUrl('/seo'))
  await seoAlert(lines.join('\n'))
}

/** Run now; one at a time per process. */
export function runSeoWatch(opts: { alert?: boolean } = {}): Promise<WatchResult> {
  if (!g.__seoWatch) {
    g.__seoWatch = runOnce({ alert: opts.alert ?? false }).finally(() => {
      g.__seoWatch = null
    })
  }
  return g.__seoWatch
}

/** Scheduler hook: once a day from RUN_HOUR_UTC. Cheap when it's not time. */
export async function maybeRunSeoWatch(now = new Date()): Promise<WatchResult | null> {
  if (now.getUTCHours() < RUN_HOUR_UTC) return null
  const day = now.toISOString().slice(0, 10)
  if (g.__seoWatchDay === day) return null
  g.__seoWatchDay = day
  // A restart later the same day must not post the digest twice.
  const s = await readJson<WatchState>(STATE_KEY)
  if (s?.lastDailyAt?.slice(0, 10) === day) return null
  return runSeoWatch({ alert: true })
}

/** The last daily check, for the dashboard. */
export async function lastSeoWatch(): Promise<WatchState | null> {
  return readJson<WatchState>(STATE_KEY)
}
