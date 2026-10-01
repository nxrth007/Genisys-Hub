import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { auditSite } from './audit'
import { ClaudeSession } from './claude'
import {
  buildDraft,
  buildOnPageChanges,
  CONTENT_DIR,
  draftBlocked,
  overlayChangeFile,
  PAGES_OVERLAY,
  parsePagesOverlay,
  postChangeFile,
  postText,
  slugify,
} from './content'
import { crawlSite, fetchPage } from './crawl'
import { generateFoundation } from './foundation'
import {
  branchExists,
  closePullRequest,
  commitToNewBranch,
  compareCommits,
  deleteBranch,
  getBranchHead,
  getPullRequest,
  mergePullRequest,
  openPullRequest,
  readFile,
  recentCommits,
  workflowRunsForSha,
} from './github'
import { gscConfigured, gscSubmitSitemap, gscSummary } from './gsc'
import { newIndexNowKey, pingIndexNow } from './indexnow'
import { getLovableDeployment, getLovableProject, lovableConfigured, publishLovableProject } from './lovable'
import { FACTS_SYSTEM, FactsSchema, ONPAGE_SYSTEM, OnPageSchema, PLAN_SYSTEM, PlanSchema, PostDraftSchema, RESEARCH_SYSTEM, WRITER_SYSTEM } from './prompts'
import { runPsi } from './psi'
import { snapshotRepo } from './repo'
import { getSeoSettings, zonedParts } from './settings'
import { seoAlert } from './slack'
import type { CrawlView, SeoSettings } from './api-types'
import type {
  AuditResult,
  BusinessFacts,
  ChangeFile,
  ClaudeUsage,
  CrawlResult,
  Draft,
  OnPageChange,
  GscSummary,
  PsiResult,
  RepoSnapshot,
  ResearchResult,
  RunLogEntry,
  RunStage,
  RunStatus,
  SeoPlan,
  SitePlatform,
} from './types'

/**
 * The stages of one SEO run.
 *
 *   weekly:     collect → research → plan → write → commit → [review / CI] → ship → [publish] → verify → report
 *   foundation: collect → write → commit → [review] → ship → [publish] → verify → report
 *
 * Each stage reads what earlier stages stored on the SeoRun row and writes
 * its own output back before the next begins, through a fenced update
 * that only the current lease holder can make. A deploy or crash mid-run
 * therefore resumes at the stage that didn't finish, and a second Hub
 * instance can never write over the first.
 */

export class LeaseLostError extends Error {}
/** Not a failure: try this stage again later (e.g. someone is editing in Lovable). */
export class DeferError extends Error {
  constructor(message: string, readonly retryInMs: number) {
    super(message)
  }
}
/** Stops the run for good with this message; retrying won't help. */
export class FatalRunError extends Error {}

type SiteRow = Prisma.SeoSiteGetPayload<{ include: { client: { select: { id: true; name: true } } } }>
type RunRow = Prisma.SeoRunGetPayload<object>

export type Snapshot = {
  crawl: CrawlView | null
  psi: PsiResult | null
  gsc: GscSummary | null
  repo: RepoSnapshot | null
  sitePaths: string[]
  platform: SitePlatform
  publish?: {
    mergeSha: string
    deploymentId: string | null
    requestedAt: string | null
    /** Polls spent waiting for Lovable to sync the merge. */
    syncPolls?: number
    /** The Lovable API route failed or never synced; a person publishes by hand. */
    gaveUp?: boolean
  } | null
  /** Publish-poller checks (cheap, frequent). */
  liveChecks?: number
  /** stageVerify's own re-checks after "Mark as published". */
  verifyChecks?: number
  /** Which commit the build check wait is for, and since when. */
  ciWait?: { sha: string; since: string }
  /** The PR head a person approved. Only that commit (or the engine's own) may merge. */
  approvedSha?: string
}

/** Stop looking for a manual Lovable publish after this long; the reviewer can still mark it. */
export const PUBLISH_WATCH_MS = 7 * 24 * 3_600_000
/** A build check that never registers stops blocking a human after this long. */
export const CI_NO_SHOW_MS = 30 * 60_000

export type StageOutcome = { stage: RunStage; status: RunStatus }

export class RunContext {
  private logBuffer: RunLogEntry[]

  constructor(
    public run: RunRow,
    public site: SiteRow,
    readonly settings: SeoSettings,
    private lease: Date,
  ) {
    this.logBuffer = Array.isArray(run.log) ? (run.log as unknown as RunLogEntry[]) : []
  }

  log(stage: RunLogEntry['stage'], msg: string, level: RunLogEntry['level'] = 'info') {
    this.logBuffer.push({ at: new Date().toISOString(), stage, level, msg })
    if (this.logBuffer.length > 300) this.logBuffer = this.logBuffer.slice(-300)
  }

  get currentLease(): Date {
    return this.lease
  }

  /** Push the lease out before a long stage so another worker can't take the run over mid-stage. */
  async renewLease(ms: number): Promise<void> {
    const next = new Date(Date.now() + ms + Math.floor(Math.random() * 1000))
    const res = await prisma.seoRun.updateMany({
      where: { id: this.run.id, leaseUntil: this.lease, status: { not: 'canceled' } },
      data: { leaseUntil: next },
    })
    if (res.count === 0) throw new LeaseLostError(`Lost the lease on run ${this.run.id}`)
    this.lease = next
  }

  get snapshot(): Snapshot | null {
    return (this.run.snapshot as unknown as Snapshot | null) ?? null
  }

  /** Fenced write: fails if another worker took the run over. */
  async save(data: Prisma.SeoRunUpdateManyMutationInput): Promise<void> {
    const res = await prisma.seoRun.updateMany({
      // A reviewer's Cancel also stops a worker mid-run.
      where: { id: this.run.id, leaseUntil: this.lease, status: { not: 'canceled' } },
      data: { ...data, log: this.logBuffer as unknown as Prisma.InputJsonValue },
    })
    if (res.count === 0) throw new LeaseLostError(`Lost the lease on run ${this.run.id}`)
    if (data.leaseUntil instanceof Date) this.lease = data.leaseUntil
    const fresh = await prisma.seoRun.findUnique({ where: { id: this.run.id } })
    if (fresh) this.run = fresh
  }

  async session(): Promise<ClaudeSession> {
    return ClaudeSession.open({
      model: this.settings.model,
      budgetUsd: this.settings.maxCostPerRunUsd,
      usage: (this.run.usage as unknown as ClaudeUsage | null) ?? null,
    })
  }

  async saveUsage(session: ClaudeSession, extra: Prisma.SeoRunUpdateManyMutationInput = {}): Promise<void> {
    await this.save({
      ...extra,
      usage: session.usage as unknown as Prisma.InputJsonValue,
      costUsd: session.usage.costUsd,
    })
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function hubUrl(path: string): string {
  const base = (process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}${path}`
}

function originOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function json<T>(v: T): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue
}

function crawlView(c: CrawlResult): CrawlView {
  const { pages, ...rest } = c
  return {
    ...rest,
    robots: { ...rest.robots, body: rest.robots.body ? rest.robots.body.slice(0, 4000) : null },
    sitemap: { ...rest.sitemap, urls: rest.sitemap.urls.slice(0, 500) },
    pages: pages.map((p) => ({
      url: p.url,
      status: p.status,
      title: p.title,
      description: p.metaDescription,
      h1: p.h1[0] ?? null,
      wordCount: p.wordCount,
      ms: p.ms,
      jsonLdTypes: p.jsonLd.types,
    })),
  }
}

/** Repo snapshots can be large; keep what later stages read. */
function trimRepo(r: RepoSnapshot): RepoSnapshot {
  let budget = 260_000
  const files = r.files.map((f) => {
    const take = Math.max(0, Math.min(f.content.length, budget))
    budget -= take
    return { ...f, content: f.content.slice(0, take), truncated: f.truncated || take < f.content.length }
  })
  return { ...r, paths: r.paths.slice(0, 2500), files }
}

/**
 * A site served from a builder's subdomain (*.lovable.app, *.vercel.app…)
 * can rank, but it can't carry the business's own brand, GBP website link
 * or email reputation, and moving later throws away what it earned.
 */
function withHostingChecks(audit: AuditResult, crawl: CrawlResult): AuditResult {
  let host = ''
  try {
    host = new URL(crawl.startUrl).hostname
  } catch {
    return audit
  }
  const builder = /\.(lovable\.app|lovableproject\.com|vercel\.app|netlify\.app|pages\.dev|web\.app)$/i.test(host)
  const finding = {
    id: 'H1.custom-domain',
    severity: 'P1' as const,
    status: builder ? ('fail' as const) : ('pass' as const),
    title: builder ? 'Site is on a builder subdomain, not the business’s own domain' : 'Site is on its own domain',
    detail: builder
      ? `${host} works, but rankings, the Google Business Profile link and AI citations should build up on the business's own domain from day one.`
      : host,
    urls: builder ? [crawl.startUrl] : [],
    fix: builder ? 'Connect the custom domain in Lovable (Settings → Domains), make it primary, then update the live URL here.' : '',
    fixableByBot: false,
  }
  const findings = [...audit.findings, finding]
  const counts = { ...audit.counts }
  if (builder) counts.P1 += 1
  else counts.pass += 1
  return { ...audit, findings, counts, score: builder ? Math.max(0, audit.score - 6) : audit.score }
}

function detectPlatform(repo: RepoSnapshot | null, crawl: CrawlResult | null): SitePlatform {
  if (repo) return repo.platform
  const home = crawl?.pages[0]
  if (!home) return 'unknown'
  const blob = [home.url, ...home.images.map((i) => i.src), ...home.internalLinks.slice(0, 5)].join(' ')
  // GoHighLevel funnels serve assets from their own storage; the Lovable
  // template also loads GHL's chat widget, so the widget alone proves nothing.
  if (/msgsndr|filesafe\.space|leadconnectorhq\.com\/(?!widgets)|gohighlevel/i.test(blob)) return 'ghl'
  return 'other'
}

function sitePaths(crawl: CrawlResult | null, repo: RepoSnapshot | null): string[] {
  const paths = new Set<string>(['/'])
  for (const p of crawl?.pages ?? []) {
    try {
      if (p.status < 400) paths.add(new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    } catch {
      /* skip */
    }
  }
  for (const s of repo?.serviceSlugs ?? []) paths.add(`/services/${s}`)
  for (const b of repo?.blogPosts ?? []) paths.add(`/blog/${b.slug}`)
  return [...paths].sort()
}

async function latestIntake(clientId: string | null) {
  if (!clientId) return null
  return prisma.clientIntake.findFirst({
    where: { clientId },
    orderBy: { receivedAt: 'desc' },
    select: {
      businessName: true,
      fullName: true,
      businessAddress: true,
      customerPhone: true,
      cities: true,
      website: true,
      aboutBusiness: true,
      mainServices: true,
      promotions: true,
      socialLinks: true,
      whyChooseYou: true,
      faqs: true,
      timeZone: true,
      domainName: true,
    },
  })
}

// ---------------------------------------------------------------------------
// Business facts
// ---------------------------------------------------------------------------

export async function deriveFacts(o: {
  site: SiteRow
  session: ClaudeSession
  repo: RepoSnapshot | null
  homepageText: string | null
}): Promise<BusinessFacts> {
  const intake = await latestIntake(o.site.clientId)
  const siteTs = o.repo?.files.find((f) => f.path === 'src/data/site.ts')?.content ?? null
  const context = [
    `Business: ${o.site.name}${o.site.liveUrl ? ` — ${o.site.liveUrl}` : ''}`,
    intake ? `\n## Onboarding answers\n${JSON.stringify(intake, null, 2)}` : '\n## Onboarding answers\n(none on file)',
    siteTs ? `\n## Website source: src/data/site.ts\n${siteTs.slice(0, 40_000)}` : '',
    o.homepageText ? `\n## Homepage text (raw HTML, no JS)\n${o.homepageText.slice(0, 6_000)}` : '',
  ].join('\n')
  const facts = await o.session.structured({
    label: 'facts',
    system: FACTS_SYSTEM,
    context,
    task: 'Extract the business facts.',
    schema: FactsSchema,
    effort: 'medium',
    maxTokens: 16_000,
  })
  return { ...facts, state: facts.state.toUpperCase().slice(0, 2) }
}

// ---------------------------------------------------------------------------
// Dossier — the shared, cacheable context for research, plan and writing
// ---------------------------------------------------------------------------

function dossier(ctx: RunContext, facts: BusinessFacts | null, audit: AuditResult | null, history: string): string {
  const s = ctx.snapshot
  const site = ctx.site
  const lines: string[] = [
    `# Client site: ${site.name}`,
    `Live URL: ${site.liveUrl ?? '(none)'}`,
    `Platform: ${s?.platform ?? site.platform}. Engine mode: ${site.mode}. Repo: ${site.repoFullName ?? '(none — audit only)'}. SEO foundation: ${site.foundationStatus}.`,
    '',
    '## Business facts (the only first-party facts you may use)',
    facts ? JSON.stringify(facts, null, 2) : '(not recorded yet)',
  ]
  if (audit) {
    lines.push('', `## Technical audit — score ${audit.score}/100 (P0 ${audit.counts.P0}, P1 ${audit.counts.P1}, P2 ${audit.counts.P2}, passing ${audit.counts.pass})`)
    for (const f of audit.findings.filter((x) => x.status !== 'pass')) {
      lines.push(`- [${f.severity} ${f.status}] ${f.id} — ${f.title}: ${f.detail}${f.urls.length ? ` (${f.urls.slice(0, 3).join(', ')})` : ''}`)
    }
  }
  if (s?.crawl) {
    lines.push('', `## Pages crawled (${s.crawl.pages.length}) — url | status | title | h1 | words | schema`)
    for (const p of s.crawl.pages.slice(0, 50)) {
      lines.push(`- ${p.url} | ${p.status} | ${p.title ?? '—'} | ${p.h1 ?? '—'} | ${p.wordCount} | ${p.jsonLdTypes.join(',') || '—'}`)
    }
  }
  if (s?.repo) {
    lines.push('', `## Site code (${s.repo.fullName}, ${s.repo.platform}${s.repo.template ? `, ${s.repo.template} template` : ''})`)
    lines.push(`Routes: ${s.repo.routes.join(', ') || '—'}`)
    lines.push(`Service slugs: ${s.repo.serviceSlugs.join(', ') || '—'}`)
    lines.push(`Existing posts (${s.repo.blogPosts.length}): ${s.repo.blogPosts.map((b) => `${b.slug} — ${b.title}`).join(' | ') || '—'}`)
    const siteTs = s.repo.files.find((f) => f.path === 'src/data/site.ts')
    if (siteTs) lines.push('', '### src/data/site.ts (site copy and data)', siteTs.content.slice(0, 20_000))
  }
  if (s?.gsc && !s.gsc.error) {
    const g = s.gsc
    lines.push(
      '',
      `## Google Search Console (${g.range.start} → ${g.range.end} vs prior 28 days)`,
      `Clicks ${g.totals.clicks} (prior ${g.prior.clicks}), impressions ${g.totals.impressions} (prior ${g.prior.impressions}), CTR ${(g.totals.ctr * 100).toFixed(1)}%, avg position ${g.totals.position.toFixed(1)}.`,
      'Top queries: ' + g.topQueries.slice(0, 20).map((r) => `"${r.query}" ${r.clicks}c/${r.impressions}i pos ${r.position.toFixed(1)}`).join('; '),
      'Striking distance: ' + (g.striking.slice(0, 15).map((r) => `"${r.query}" → ${r.page} pos ${r.position.toFixed(1)}, ${r.impressions}i`).join('; ') || 'none'),
    )
  } else {
    lines.push('', '## Google Search Console', s?.gsc?.error ? `Unavailable: ${s.gsc.error}` : 'Not connected — no query data; rely on research for demand.')
  }
  if (s?.psi && !s.psi.error) {
    const p = s.psi
    const pct = (n: number | null) => (n == null ? '—' : String(Math.round(n * 100)))
    lines.push(
      '',
      `## PageSpeed (mobile, lab) — performance ${pct(p.scores.performance)}, SEO ${pct(p.scores.seo)}, accessibility ${pct(p.scores.accessibility)}, best practices ${pct(p.scores.bestPractices)}; LCP ${p.lab.lcpMs ?? '—'}ms, CLS ${p.lab.cls ?? '—'}, TBT ${p.lab.tbtMs ?? '—'}ms`,
    )
  }
  lines.push('', '## Recent engine history', history || 'First run for this site.')
  return lines.join('\n')
}

async function historyFor(ctx: RunContext): Promise<string> {
  const runs = await prisma.seoRun.findMany({
    where: { siteId: ctx.site.id, kind: 'weekly', id: { not: ctx.run.id }, status: { not: 'canceled' } },
    orderBy: { createdAt: 'desc' },
    take: 4,
    select: { weekOf: true, score: true, plan: true, status: true },
  })
  const posts = await prisma.seoPost.findMany({
    where: { siteId: ctx.site.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { slug: true, title: true, primaryKeyword: true, status: true, createdAt: true },
  })
  const lines = runs.map((r) => {
    const plan = r.plan as unknown as SeoPlan | null
    return `- ${r.weekOf}: score ${r.score ?? '—'}, ${r.status}. ${plan?.headline ?? ''}`
  })
  if (posts.length) {
    lines.push('Posts the engine has already drafted (never repeat these topics or keywords):')
    for (const p of posts) lines.push(`- ${p.slug} — "${p.title}" [${p.primaryKeyword}] (${p.status})`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export async function stageCollect(ctx: RunContext): Promise<StageOutcome> {
  const site = ctx.site
  if (!site.liveUrl && !site.repoFullName) throw new FatalRunError('This site has neither a live URL nor a repo to work from.')

  ctx.log('collect', `Crawling ${site.liveUrl ?? '(no live URL)'}${site.repoFullName ? ` and reading ${site.repoFullName}` : ''}`)
  const [crawl, psi, repo, gsc] = await Promise.all([
    site.liveUrl ? crawlSite(site.liveUrl, { maxPages: ctx.run.kind === 'foundation' ? 5 : 40 }) : Promise.resolve(null),
    site.liveUrl && ctx.run.kind === 'weekly' ? runPsi(site.liveUrl) : Promise.resolve(null),
    site.repoFullName ? snapshotRepo(site.repoFullName) : Promise.resolve(null),
    (async () => {
      if (!site.gscProperty || ctx.run.kind !== 'weekly') return null
      const g = await gscConfigured()
      return g.ok ? gscSummary(site.gscProperty, new Date()) : null
    })(),
  ])

  const platform = detectPlatform(repo, crawl)
  const facts = (site.facts as unknown as BusinessFacts | null) ?? null
  const audit = crawl ? withHostingChecks(auditSite(crawl, facts, psi), crawl) : null
  const snapshot: Snapshot = {
    crawl: crawl ? crawlView(crawl) : null,
    psi,
    gsc,
    repo: repo ? trimRepo(repo) : null,
    sitePaths: sitePaths(crawl, repo),
    platform,
  }
  if (crawl) ctx.log('collect', `Crawled ${crawl.pages.length} pages; audit score ${audit?.score ?? '—'}`)
  if (repo) ctx.log('collect', `Repo ${repo.fullName} @ ${repo.headSha.slice(0, 7)} — ${repo.platform}, foundation ${repo.foundationInstalled ? 'installed' : 'not installed'}`)
  if (psi?.error) ctx.log('collect', `PageSpeed unavailable: ${psi.error}`, 'warn')
  if (gsc?.error) ctx.log('collect', `Search Console unavailable: ${gsc.error}`, 'warn')

  // Keep the site row in step with what the repo actually says.
  const siteUpdate: Prisma.SeoSiteUpdateInput = { platform }
  if (repo) {
    siteUpdate.defaultBranch = repo.defaultBranch
    if (repo.foundationInstalled && site.foundationStatus !== 'installed') siteUpdate.foundationStatus = 'installed'
    siteUpdate.ciWorkflow = repo.hasCiWorkflow
  }
  if (audit && ctx.run.kind === 'weekly') {
    siteUpdate.lastScore = audit.score
    siteUpdate.lastRunAt = new Date()
  }
  let derivedFacts: Prisma.InputJsonValue | null = null
  if (!site.facts && (repo || crawl)) {
    let session: ClaudeSession | null = null
    try {
      session = await ctx.session()
      derivedFacts = json(await deriveFacts({ site, session, repo, homepageText: crawl?.pages[0]?.textSample ?? null }))
    } catch (err) {
      // Facts sharpen the plan but the run can proceed without them.
      ctx.log('collect', `Couldn't record business facts: ${err instanceof Error ? err.message : String(err)}`, 'warn')
    } finally {
      if (session) await ctx.saveUsage(session)
    }
  }
  await prisma.seoSite.update({ where: { id: site.id }, data: siteUpdate })
  if (derivedFacts) {
    // Someone may have saved facts by hand while this stage ran; theirs win.
    const res = await prisma.seoSite.updateMany({
      where: { id: site.id, facts: { equals: Prisma.AnyNull } },
      data: { facts: derivedFacts },
    })
    ctx.log(
      'collect',
      res.count
        ? 'Recorded business facts from the intake and site — review them on the site page'
        : 'Business facts were saved by hand while collecting — kept those',
    )
  }
  ctx.site = (await prisma.seoSite.findUnique({ where: { id: site.id }, include: { client: { select: { id: true, name: true } } } })) ?? ctx.site

  const weekly = ctx.run.kind === 'weekly'
  await ctx.save({
    snapshot: json(snapshot),
    audit: audit ? json(audit) : undefined,
    // Foundation runs crawl a handful of pages; their score isn't comparable.
    score: weekly ? (audit?.score ?? null) : null,
    findingCounts: weekly && audit ? json(audit.counts) : undefined,
  })
  return { stage: ctx.run.kind === 'foundation' ? 'write' : 'research', status: 'running' }
}

export async function stageResearch(ctx: RunContext): Promise<StageOutcome> {
  const facts = (ctx.site.facts as unknown as BusinessFacts | null) ?? null
  const audit = (ctx.run.audit as unknown as AuditResult | null) ?? null
  const session = await ctx.session()
  const intake = await latestIntake(ctx.site.clientId)
  try {
    const research = await session.research({
      label: 'research',
      system: RESEARCH_SYSTEM,
      context: dossier(ctx, facts, audit, await historyFor(ctx)),
      task: `Run date ${zonedParts(new Date(), ctx.settings.timeZone).ymd}. The live site is ${ctx.site.liveUrl ?? '(not live yet)'}${ctx.site.liveUrl ? ` — you may fetch ${ctx.site.liveUrl} and its pages` : ''}. Research this week's biggest opportunities as described.`,
      location: {
        city: facts?.primaryCity || null,
        region: facts?.state || null,
        timezone: ianaZone(intake?.timeZone) ?? ctx.settings.timeZone,
      },
      maxSearches: 12,
      maxFetches: 10,
    })
    ctx.log('research', `Research done: ${research.sources.length} sources${research.toolErrors.length ? `, tool errors: ${research.toolErrors.join(', ')}` : ''}`)
    await ctx.saveUsage(session, { research: json(research) })
  } catch (err) {
    await ctx.saveUsage(session)
    throw err
  }
  return { stage: 'plan', status: 'running' }
}

/** The intake's time zone only if it's a real IANA name ("America/Chicago"), never free text. */
function ianaZone(tz: string | null | undefined): string | null {
  const v = tz?.trim()
  if (!v || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(v)) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v })
    return v
  } catch {
    return null
  }
}

function clampNum(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
}

export async function stagePlan(ctx: RunContext): Promise<StageOutcome> {
  const facts = (ctx.site.facts as unknown as BusinessFacts | null) ?? null
  const audit = (ctx.run.audit as unknown as AuditResult | null) ?? null
  const research = (ctx.run.research as unknown as ResearchResult | null) ?? null
  const repo = ctx.snapshot?.repo ?? null
  const canCommit = !!repo && ctx.site.mode !== 'audit' && ctx.site.foundationStatus === 'installed'
  const postsAllowed = ctx.settings.postsPerWeek

  const session = await ctx.session()
  try {
    const raw = await session.structured({
      label: 'plan',
      system: PLAN_SYSTEM,
      context: dossier(ctx, facts, audit, await historyFor(ctx)),
      task: [
        `Run date ${zonedParts(new Date(), ctx.settings.timeZone).ymd}. New posts allowed this week: ${postsAllowed}.${postsAllowed > 3 ? ' That is a ceiling, not a target: each brief must stand on distinct, real facts and real local demand; return fewer when they would otherwise overlap or run thin.' : ''}`,
        canCommit
          ? 'The SEO foundation is installed: the engine will write and commit the content briefs you choose, and it can apply title and meta-description fixes to existing pages itself (owner "engine", category "on_page", targetUrl = the page, exact new title/description in `action`). Page copy, routes and templates are still for people.'
          : repo
            ? 'The engine will draft the content but cannot commit yet: the SEO foundation is not installed on this repo. Include a P1 quick win (owner "genisys") to install it — it is one button on the site page in the Genisys Hub → SEO, which opens a reviewed pull request.'
            : 'This site has no code repo the engine can commit to (e.g. a GoHighLevel site). The engine drafts content for a person to paste into the site builder; site changes are for people.',
        `Service slugs you may use: ${(repo?.serviceSlugs ?? []).join(', ') || '(none)'}.`,
        '',
        '## Research notes (with sources)',
        research?.digest || '(research unavailable this week)',
      ].join('\n'),
      schema: PlanSchema,
      effort: 'high',
      maxTokens: 32_000,
    })

    // Structured outputs can't express ranges; enforce them here.
    const taken = new Set([...(repo?.blogPosts.map((b) => b.slug) ?? [])])
    const ledger = await prisma.seoPost.findMany({ where: { siteId: ctx.site.id }, select: { slug: true } })
    for (const p of ledger) taken.add(p.slug)
    const content = []
    for (const b of raw.content) {
      if (content.length >= postsAllowed) break
      let slug = slugify(b.slug || b.title)
      if (!slug || taken.has(slug)) slug = slugify(`${b.slug || b.title}-${zonedParts(new Date(), ctx.settings.timeZone).ymd.slice(0, 4)}`)
      if (!slug || taken.has(slug)) continue
      taken.add(slug)
      content.push({ ...b, slug })
    }
    const ids = new Set<string>()
    const plan: SeoPlan = {
      ...raw,
      quickWins: raw.quickWins.slice(0, 8).map((q, i) => {
        let id = q.id || `qw-${i + 1}`
        if (ids.has(id)) id = `${id}-${i + 1}`
        ids.add(id)
        return {
          ...q,
          id,
          impact: clampNum(Math.round(q.impact), 1, 5),
          effort: clampNum(Math.round(q.effort), 1, 5),
          confidence: clampNum(q.confidence, 0.2, 1),
          lovablePrompt: q.owner === 'genisys' ? q.lovablePrompt : null,
        }
      }),
      content,
      humanTasks: raw.humanTasks.slice(0, 6),
      clientInputs: raw.clientInputs.slice(0, 8),
    }
    ctx.log('plan', `Plan: ${plan.quickWins.length} quick wins, ${plan.content.length} post brief(s) — ${plan.headline}`)
    await ctx.saveUsage(session, { plan: json(plan), headline: plan.headline.slice(0, 500) })
  } catch (err) {
    await ctx.saveUsage(session)
    throw err
  }
  return { stage: 'write', status: 'running' }
}

export async function stageWrite(ctx: RunContext): Promise<StageOutcome> {
  if (ctx.run.kind === 'foundation') return writeFoundation(ctx)

  const plan = (ctx.run.plan as unknown as SeoPlan | null) ?? null
  const facts = (ctx.site.facts as unknown as BusinessFacts | null) ?? null
  const research = (ctx.run.research as unknown as ResearchResult | null) ?? null
  const snap = ctx.snapshot
  const repo = snap?.repo ?? null
  const drafts: Draft[] = Array.isArray(ctx.run.drafts) ? (ctx.run.drafts as unknown as Draft[]) : []
  const briefs = (plan?.content ?? []).filter((b) => !drafts.some((d) => (d.briefSlug ?? d.post.slug) === slugify(b.slug)))
  if (!briefs.length) return { stage: 'commit', status: 'running' }

  // This run's own rows (from an interrupted attempt) aren't "existing" posts.
  const ledger = (
    await prisma.seoPost.findMany({ where: { siteId: ctx.site.id }, select: { slug: true, title: true, body: true, runId: true } })
  ).filter((p) => p.runId !== ctx.run.id)
  const existing = [
    ...(repo?.blogPosts ?? []).map((b) => ({ slug: b.slug, title: b.title, text: null as string | null })),
    ...ledger.map((p) => {
      const body = p.body as unknown as Draft['post'] | null
      return { slug: p.slug, title: p.title, text: body?.sections ? postText(body) : null }
    }),
    ...drafts.map((d) => ({ slug: d.post.slug, title: d.post.title, text: postText(d.post) })),
  ]
  const date = zonedParts(new Date(), ctx.settings.timeZone).ymd
  const author = facts?.owner || facts?.businessName || ctx.site.name
  const brand = facts?.businessName || ctx.site.name

  const writerContext = [
    `# Writing for ${brand}${ctx.site.liveUrl ? ` (${ctx.site.liveUrl})` : ''}`,
    '## Business facts (the only first-party facts you may use)',
    facts ? JSON.stringify(facts, null, 2) : '(not recorded — write only from cited sources and general, clearly non-specific guidance)',
    '',
    `## Pages that exist on the site (use only these for internal links)\n${(snap?.sitePaths ?? ['/']).join('\n')}`,
    '',
    `## Allowed image keys (real project photos)\n${repo?.imageKeys.join(', ') || '(none — use null)'}`,
    `## Service slugs\n${repo?.serviceSlugs.join(', ') || '(none — use null)'}`,
    '',
    `## Existing posts (don't duplicate)\n${existing.map((e) => `- ${e.slug}: ${e.title}`).join('\n') || '(none)'}`,
    '',
    '## Research notes (with sources)',
    research?.digest.slice(0, 30_000) || '(none)',
  ].join('\n')

  const session = await ctx.session()
  try {
    for (const brief of briefs) {
      // Several posts can outlast one lease; renew before each so no other
      // worker can take the run over mid-write.
      await ctx.renewLease(40 * 60_000)
      const before = session.spentUsd
      const raw = await session.structured({
        label: `write:${brief.slug}`,
        system: WRITER_SYSTEM,
        context: writerContext,
        task: `Write this post. Brief:\n${JSON.stringify(brief, null, 2)}\n\nUse the slug "${slugify(brief.slug)}".`,
        schema: PostDraftSchema,
        effort: 'medium',
        maxTokens: 32_000,
      })
      const draft = buildDraft(
        { ...raw, slug: slugify(brief.slug) },
        {
          date,
          author,
          imageKeys: repo?.imageKeys ?? [],
          serviceSlugs: repo?.serviceSlugs ?? [],
          sitePaths: snap?.sitePaths ?? [],
          existing,
          facts,
          brand,
        },
        Math.round((session.spentUsd - before) * 100) / 100,
      )
      draft.briefSlug = slugify(brief.slug)
      drafts.push(draft)
      existing.push({ slug: draft.post.slug, title: draft.post.title, text: postText(draft.post) })
      await prisma.seoPost.upsert({
        where: { siteId_slug: { siteId: ctx.site.id, slug: draft.post.slug } },
        create: {
          siteId: ctx.site.id,
          runId: ctx.run.id,
          slug: draft.post.slug,
          title: draft.post.title,
          primaryKeyword: draft.post.primaryKeyword,
          status: 'draft',
          body: json(draft.post),
        },
        update: { runId: ctx.run.id, title: draft.post.title, primaryKeyword: draft.post.primaryKeyword, body: json(draft.post), status: 'draft' },
      })
      const blocked = draft.gates.filter((g) => g.blocking && !g.ok)
      ctx.log('write', `Drafted "${draft.post.title}"${blocked.length ? ` — needs a look: ${blocked.map((g) => g.id).join(', ')}` : ''}`, blocked.length ? 'warn' : 'info')
      await ctx.saveUsage(session, { drafts: json(drafts), draftCount: drafts.length })
    }
    await writeOnPage(ctx, session, drafts)
  } catch (err) {
    await ctx.saveUsage(session)
    throw err
  }
  return { stage: 'commit', status: 'running' }
}

/**
 * Title and meta-description fixes the plan assigned to the engine, applied
 * through the foundation's pages.json overlay. Stores the run's full
 * change set (posts + overlay) so the commit stage ships both.
 */
async function writeOnPage(ctx: RunContext, session: ClaudeSession, drafts: Draft[]): Promise<void> {
  const plan = (ctx.run.plan as unknown as SeoPlan | null) ?? null
  const snap = ctx.snapshot
  const repo = snap?.repo ?? null
  const paths = new Set(repo?.paths ?? [])
  const postFiles = () => drafts.map((d) => postChangeFile(d.post, paths.has(`${CONTENT_DIR}/${d.post.slug}.json`)))

  const wins = (plan?.quickWins ?? []).filter((w) => w.owner === 'engine' && w.category === 'on_page' && w.targetUrl)
  const canApply = !!repo && ctx.site.mode !== 'audit' && (repo.foundationInstalled || ctx.site.foundationStatus === 'installed') && paths.has(PAGES_OVERLAY)
  if (!wins.length || !canApply) {
    if (wins.length && repo && !paths.has(PAGES_OVERLAY)) {
      ctx.log('write', `${wins.length} title/description fix(es) were planned, but the site has no ${PAGES_OVERLAY} yet — install (or re-run) the SEO foundation.`, 'warn')
    }
    await ctx.save({ changes: json(postFiles()) })
    return
  }

  const origin = originOf(ctx.site.liveUrl)
  const pages = new Map<string, { title: string | null; description: string | null }>()
  for (const p of snap?.crawl?.pages ?? []) {
    try {
      const u = new URL(p.url)
      if (origin && u.origin !== origin) continue
      if (p.status >= 400) continue
      pages.set(u.pathname.replace(/\/+$/, '') || '/', { title: p.title, description: p.description })
    } catch {
      /* skip */
    }
  }
  const facts = (ctx.site.facts as unknown as BusinessFacts | null) ?? null
  const current = parsePagesOverlay(await readFile(repo.fullName, PAGES_OVERLAY, repo.headSha).catch(() => null))

  const out = await session.structured({
    label: 'on-page',
    system: ONPAGE_SYSTEM,
    context: [
      `# ${facts?.businessName ?? ctx.site.name}`,
      '## Business facts',
      facts ? JSON.stringify(facts, null, 2) : '(none recorded)',
      '',
      '## Pages (path | current title | current description)',
      ...[...pages.entries()].map(([path, v]) => `- ${path} | ${current[path]?.title ?? v.title ?? '—'} | ${current[path]?.description ?? v.description ?? '—'}`),
    ].join('\n'),
    task: `Apply these approved fixes:\n${wins.map((w) => `- ${w.targetUrl}: ${w.title} — ${w.action}${w.evidence ? ` (evidence: ${w.evidence})` : ''}`).join('\n')}`,
    schema: OnPageSchema,
    effort: 'medium',
    maxTokens: 8_000,
  })
  const proposed: OnPageChange[] = out.changes
  const { applied, skipped, overlay } = buildOnPageChanges(proposed, { current, pages, brand: facts?.businessName ?? ctx.site.name })
  for (const s of skipped) ctx.log('write', `Skipped title/description change for ${s.path}: ${s.why}`, 'warn')
  const changes: ChangeFile[] = postFiles()
  if (applied.length) {
    changes.push(overlayChangeFile(overlay, applied, true))
    ctx.log('write', `Title/description fixes ready for ${applied.length} page(s): ${applied.map((a) => a.path).join(', ')}`)
  } else {
    ctx.log('write', 'No title/description change passed the checks this week.')
  }
  await ctx.saveUsage(session, { changes: json(changes) })
}

async function writeFoundation(ctx: RunContext): Promise<StageOutcome> {
  const repo = ctx.snapshot?.repo
  if (!repo) throw new FatalRunError('The foundation needs a linked repo.')
  if (repo.foundationInstalled) {
    ctx.log('write', 'The SEO foundation is already installed on this repo — nothing to do.')
    await prisma.seoSite.update({ where: { id: ctx.site.id }, data: { foundationStatus: 'installed' } })
    return { stage: 'report', status: 'running' }
  }
  if (repo.platform !== 'lovable-tanstack') {
    throw new FatalRunError(`The SEO foundation supports Lovable TanStack Start sites; this repo looks like "${repo.platform}".`)
  }
  const siteUrl = originOf(ctx.site.liveUrl)
  if (!siteUrl) throw new FatalRunError('Set the site’s live URL (its real domain) before installing the foundation.')
  const shadowing = ['public/sitemap.xml', 'public/llms.txt'].filter((f) => repo.paths.includes(f))
  if (shadowing.length) {
    // A static file wins over the new server route, and the engine never deletes files.
    throw new FatalRunError(`Delete ${shadowing.join(' and ')} in Lovable first — a static copy would hide the generated one — then run the foundation again.`)
  }

  const indexNowKey = ctx.site.indexNowKey ?? newIndexNowKey()
  if (!ctx.site.indexNowKey) await prisma.seoSite.update({ where: { id: ctx.site.id }, data: { indexNowKey } })

  const session = await ctx.session()
  try {
    const result = await generateFoundation({ session, repo, siteUrl, indexNowKey })
    if (result.refused.length) ctx.log('write', `Refused paths outside the foundation allowlist: ${result.refused.join(', ')}`, 'warn')
    for (const n of result.reviewerNotes) ctx.log('write', `Reviewer note: ${n}`)
    ctx.log('write', `Foundation: ${result.files.length} files — ${result.summary}`)
    await ctx.saveUsage(session, { changes: json(result.files) })
  } catch (err) {
    await ctx.saveUsage(session)
    throw err
  }
  return { stage: 'commit', status: 'running' }
}

function prBody(ctx: RunContext, changes: ChangeFile[], drafts: Draft[]): string {
  const plan = (ctx.run.plan as unknown as SeoPlan | null) ?? null
  const lines = [
    ctx.run.kind === 'foundation'
      ? '## SEO foundation\n\nOne-time change so the Genisys SEO engine can publish weekly posts as data files, and so search engines and AI crawlers get a sitemap, llms.txt, absolute canonicals and richer article schema.'
      : `## ${plan?.headline ?? 'Weekly SEO update'}\n\n${plan?.summary ?? ''}`,
    '',
    '### Files',
    ...changes.map((c) => `- \`${c.path}\` — ${c.existed ? 'updated' : 'new'}: ${c.reason}`),
  ]
  if (drafts.length) {
    lines.push('', '### Content checks')
    for (const d of drafts) {
      lines.push(`**${d.post.title}**`)
      for (const g of d.gates) lines.push(`- ${g.ok ? '✅' : g.blocking ? '⛔' : '⚠️'} ${g.id}: ${g.detail}`)
    }
  }
  lines.push('', `Review and ship from the Genisys Hub: ${hubUrl(`/seo/runs/${ctx.run.id}`)}`, '', '_Opened by the Genisys SEO engine. Please merge from the Hub so it can publish and verify._')
  return lines.join('\n')
}

export async function stageCommit(ctx: RunContext): Promise<StageOutcome> {
  const repo = ctx.snapshot?.repo ?? null
  const drafts: Draft[] = Array.isArray(ctx.run.drafts) ? (ctx.run.drafts as unknown as Draft[]) : []

  let changes: ChangeFile[]
  if (ctx.run.kind === 'foundation') {
    changes = Array.isArray(ctx.run.changes) ? (ctx.run.changes as unknown as ChangeFile[]) : []
  } else {
    const committable = !!repo && ctx.site.mode !== 'audit' && (repo.foundationInstalled || ctx.site.foundationStatus === 'installed')
    // The write stage stores the full change set (posts + title/description
    // overlay); older runs only have drafts.
    const stored: ChangeFile[] = Array.isArray(ctx.run.changes) ? (ctx.run.changes as unknown as ChangeFile[]) : []
    const paths = new Set(repo?.paths ?? [])
    changes = stored.length ? stored : drafts.map((d) => postChangeFile(d.post, paths.has(`${CONTENT_DIR}/${d.post.slug}.json`)))
    if (!committable || !changes.length) {
      ctx.log(
        'commit',
        !repo
          ? 'No repo linked — drafts are ready to copy into the site builder.'
          : ctx.site.mode === 'audit'
            ? 'Audit mode — nothing committed.'
            : !changes.length
              ? 'No new content or fixes this week — nothing to commit.'
              : 'SEO foundation not installed — drafts kept in the Hub. Install the foundation to let the engine publish.',
      )
      return { stage: 'report', status: 'running' }
    }
  }
  if (!changes.length || !repo) {
    ctx.log('commit', 'Nothing to commit.')
    return { stage: 'report', status: 'running' }
  }

  // Resume safety: the commit and PR may already exist from an interrupted attempt.
  if (!ctx.run.prNumber) {
    const branch = ctx.run.branch ?? `seo/${ctx.run.kind === 'foundation' ? 'foundation' : ctx.run.weekOf.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${ctx.run.id.slice(-6)}`
    let commitSha = ctx.run.commitSha
    if (!commitSha && (await branchExists(repo.fullName, branch))) {
      // Interrupted after the branch was pushed but before we recorded it:
      // this run's branch name is unique, so its head is our commit.
      commitSha = (await getBranchHead(repo.fullName, branch)).sha
      ctx.log('commit', `Recovered the commit already on ${branch} (${commitSha.slice(0, 7)})`)
      await ctx.save({ branch, commitSha, changes: json(changes), repoFullName: repo.fullName })
    }
    if (!commitSha) {
      const title = ctx.run.kind === 'foundation' ? 'SEO foundation (Genisys SEO engine)' : `SEO ${ctx.run.weekOf}: ${drafts.map((d) => d.post.title).join('; ').slice(0, 180)}`
      const res = await commitToNewBranch({
        fullName: repo.fullName,
        baseBranch: repo.defaultBranch,
        // Foundation files are whole-file rewrites of what Claude read: branch
        // from that commit so later Lovable edits merge (or conflict) instead
        // of being silently reverted.
        baseSha: ctx.run.kind === 'foundation' ? repo.headSha : undefined,
        branch,
        files: changes.map((c) => ({ path: c.path, content: c.content })),
        message: title,
      })
      if (res.unchanged) {
        ctx.log('commit', 'Every file already matches the live branch — nothing to commit.')
        return { stage: 'report', status: 'running' }
      }
      commitSha = res.commitSha
      ctx.log('commit', `Committed ${changes.length} file(s) to ${branch} (${commitSha.slice(0, 7)})`)
      try {
        await ctx.save({ branch, commitSha, changes: json(changes), repoFullName: repo.fullName })
      } catch (err) {
        // Canceled while committing: don't leave an untracked branch behind.
        if (err instanceof LeaseLostError) await deleteBranch(repo.fullName, branch).catch(() => {})
        throw err
      }
    }
    const pr = await openPullRequest({
      fullName: repo.fullName,
      head: branch,
      base: repo.defaultBranch,
      title: ctx.run.kind === 'foundation' ? 'SEO foundation — Genisys SEO engine' : `SEO ${ctx.run.weekOf} — ${drafts.length} new post${drafts.length === 1 ? '' : 's'}`,
      body: prBody(ctx, changes, drafts),
    })
    ctx.log('commit', `Opened PR #${pr.number}`)
    try {
      await ctx.save({ prNumber: pr.number, prUrl: pr.url })
    } catch (err) {
      // Canceled while the PR was opening: close it rather than orphan it.
      if (err instanceof LeaseLostError) {
        await closePullRequest(repo.fullName, pr.number, 'Canceled from the Genisys Hub.').catch(() => {})
        await deleteBranch(repo.fullName, branch).catch(() => {})
      }
      throw err
    }
    if (ctx.run.kind === 'foundation') {
      await prisma.seoSite.update({ where: { id: ctx.site.id }, data: { foundationStatus: 'proposed', foundationPrUrl: pr.url } })
    }
    for (const d of drafts) {
      await prisma.seoPost.updateMany({
        where: { siteId: ctx.site.id, slug: d.post.slug },
        data: { status: 'committed', path: `${CONTENT_DIR}/${d.post.slug}.json` },
      })
    }
  }

  const blocked = drafts.some(draftBlocked)
  const autopilot = ctx.run.kind === 'weekly' && ctx.site.mode === 'autopilot' && !blocked && !!repo.hasCiWorkflow
  if (autopilot) {
    ctx.log('commit', 'Autopilot: waiting for the build check before merging')
    return { stage: 'ship', status: 'awaiting_ci' }
  }
  if (ctx.site.mode === 'autopilot' && ctx.run.kind === 'weekly') {
    ctx.log('commit', blocked ? 'Autopilot paused: a content check needs a human.' : 'Autopilot paused: the repo has no build check yet (install the SEO foundation).', 'warn')
  }
  await seoAlert(`:mag: *SEO* — ${ctx.site.name}: ${ctx.run.kind === 'foundation' ? 'SEO foundation' : `week ${ctx.run.weekOf}`} is ready for review. ${hubUrl(`/seo/runs/${ctx.run.id}`)}`)
  return { stage: 'ship', status: 'awaiting_review' }
}

/** CI state for the run's commit: 'success' | 'failure' | 'pending' | 'none'. */
export async function ciState(fullName: string, sha: string): Promise<{ state: 'success' | 'failure' | 'pending' | 'none'; url: string | null }> {
  const runs = await workflowRunsForSha(fullName, sha)
  const verify = runs.filter((r) => /seo-verify/i.test(r.name))
  const relevant = verify.length ? verify : runs
  if (!relevant.length) return { state: 'none', url: null }
  const latest = relevant[0]
  if (latest.status !== 'completed') return { state: 'pending', url: latest.url }
  return { state: latest.conclusion === 'success' ? 'success' : 'failure', url: latest.url }
}

/** Lovable diverts its own pushes to `lovable-sync` if main moves under an active edit session. */
const LOVABLE_QUIET_MS = 30 * 60_000

async function someoneEditingInLovable(ctx: RunContext, fullName: string, branch: string): Promise<boolean> {
  const [last] = await recentCommits(fullName, branch, 1)
  if (last?.byLovable && Date.now() - Date.parse(last.date) < LOVABLE_QUIET_MS) return true
  if (ctx.site.lovableProjectId && (await lovableConfigured())) {
    const project = await getLovableProject(ctx.site.lovableProjectId).catch(() => null)
    if (project?.lastEditedAt && Date.now() - Date.parse(project.lastEditedAt) < LOVABLE_QUIET_MS) return true
  }
  return false
}

export async function stageShip(ctx: RunContext): Promise<StageOutcome> {
  const repo = ctx.snapshot?.repo
  const fullName = ctx.run.repoFullName ?? repo?.fullName
  if (!repo || !fullName || !ctx.run.prNumber || !ctx.run.commitSha) throw new FatalRunError('Nothing to ship: no pull request on this run.')

  // A site archived, paused or taken off autopilot since this run started
  // must not merge on the run's own say-so.
  if (ctx.site.archivedAt) throw new FatalRunError('The site was archived — not merging.')
  const approvedSha = ctx.snapshot?.approvedSha ?? null
  if (!approvedSha && (ctx.site.mode !== 'autopilot' || !ctx.site.enabled)) {
    ctx.log('ship', 'The site is no longer on autopilot — waiting for a reviewer.', 'warn')
    return { stage: 'ship', status: 'awaiting_review' }
  }

  const pr = await getPullRequest(fullName, ctx.run.prNumber)
  let mergeSha: string
  if (pr.merged) {
    ctx.log('ship', `PR #${ctx.run.prNumber} was already merged`)
    mergeSha = pr.mergeCommitSha ?? ctx.run.commitSha
  } else {
    if (pr.state === 'closed') throw new FatalRunError(`PR #${ctx.run.prNumber} was closed without merging.`)
    // Only merge what was reviewed: the engine's own commit, or exactly the
    // head a person approved. Anything pushed after that needs a new look.
    if (pr.headSha !== ctx.run.commitSha && pr.headSha !== approvedSha) {
      ctx.log('ship', `The PR branch changed (${pr.headSha.slice(0, 7)}) since it was ${approvedSha ? 'approved' : 'committed'} — needs a reviewer.`, 'warn')
      await ctx.save({ snapshot: json({ ...ctx.snapshot, approvedSha: undefined }) })
      return { stage: 'ship', status: 'awaiting_review' }
    }
    if (pr.headSha !== ctx.run.commitSha) ctx.log('ship', `Merging the approved head ${pr.headSha.slice(0, 7)} (changed after the engine's commit)`)
    const ci = await ciState(fullName, pr.headSha)
    const wait = ctx.snapshot?.ciWait?.sha === pr.headSha ? ctx.snapshot.ciWait : { sha: pr.headSha, since: new Date().toISOString() }
    await ctx.save({ ciStatus: ci.state, snapshot: json({ ...ctx.snapshot, ciWait: wait }) })
    if (ci.state === 'pending') return { stage: 'ship', status: 'awaiting_ci' }
    if (ci.state === 'failure') {
      ctx.log('ship', `The build check failed${ci.url ? ` (${ci.url})` : ''} — not merging.`, 'error')
      return { stage: 'ship', status: 'awaiting_review' }
    }
    // The foundation PR adds the check itself, so it expects one too.
    const expectCi = ctx.run.kind === 'foundation' || !!ctx.snapshot?.repo?.hasCiWorkflow
    if (ci.state === 'none' && expectCi) {
      // A check that hasn't registered yet is pending; one that never shows up
      // for this commit (Actions disabled, minutes exhausted) shouldn't block a human forever.
      if (Date.now() - Date.parse(wait.since) < CI_NO_SHOW_MS) return { stage: 'ship', status: 'awaiting_ci' }
      ctx.log('ship', 'No build check ever ran on this commit — merging on the reviewer’s approval.', 'warn')
    }
    if (await someoneEditingInLovable(ctx, fullName, repo.defaultBranch)) {
      throw new DeferError('Someone is editing this site in Lovable — waiting for a quiet half hour before merging.', 10 * 60_000)
    }
    const title = `${ctx.run.kind === 'foundation' ? 'SEO foundation' : `SEO ${ctx.run.weekOf}`} (#${ctx.run.prNumber})`
    const merged = await mergePullRequest(fullName, ctx.run.prNumber, pr.headSha, title)
    mergeSha = merged.sha
    ctx.log('ship', `Merged PR #${ctx.run.prNumber} into ${repo.defaultBranch} (${mergeSha.slice(0, 7)})`)
    if (ctx.run.branch) await deleteBranch(fullName, ctx.run.branch).catch(() => {})
  }
  await ctx.save({ mergedAt: new Date() })
  if (ctx.run.kind === 'foundation') {
    await prisma.seoSite.update({ where: { id: ctx.site.id }, data: { foundationStatus: 'installed' } })
  }

  const snap = ctx.snapshot
  await ctx.save({ snapshot: json({ ...snap, publish: { mergeSha, deploymentId: null, requestedAt: null }, liveChecks: 0 }) })
  if (ctx.site.lovableProjectId && (await lovableConfigured())) {
    ctx.log('ship', 'Waiting for Lovable to sync the merge, then publishing through the Lovable API')
  } else {
    ctx.log('ship', 'Merged. The live site updates when someone clicks Publish in Lovable — the engine will notice and verify.')
    await seoAlert(`:rocket: *SEO* — ${ctx.site.name}: merged. Click *Publish* in Lovable to put it live. ${hubUrl(`/seo/runs/${ctx.run.id}`)}`)
  }
  return { stage: 'verify', status: 'awaiting_publish' }
}

/** URLs that must be live for this run to count as published. */
function expectedLiveUrls(ctx: RunContext): string[] {
  const origin = originOf(ctx.site.liveUrl)
  if (!origin) return []
  if (ctx.run.kind === 'foundation') return [`${origin}/sitemap.xml`]
  const drafts: Draft[] = Array.isArray(ctx.run.drafts) ? (ctx.run.drafts as unknown as Draft[]) : []
  return drafts.map((d) => `${origin}/blog/${d.post.slug}`)
}

/** Is this URL serving what the run expects? Sitemaps are XML, posts are HTML. */
async function isLive(url: string, kind: 'sitemap' | 'page'): Promise<boolean> {
  if (kind === 'page') {
    const page = await fetchPage(url, { timeoutMs: 20_000 })
    return page.status === 200 && !page.error
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5', 'User-Agent': 'Mozilla/5.0 (compatible; GenisysSEOBot/1.0; +https://leadgenisys.com)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status !== 200 || !res.body) return false
    // Read a bounded prefix — enough to see the root element — then stop.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let head = ''
    while (head.length < 8000) {
      const { done, value } = await reader.read()
      if (done) break
      head += decoder.decode(value, { stream: true })
    }
    await reader.cancel().catch(() => {})
    return /<(?:urlset|sitemapindex)[\s>]/i.test(head)
  } catch {
    return false
  }
}

/** Are the run's new URLs live? Cheap enough to call from the poller. */
export async function liveCheck(ctx: RunContext): Promise<{ live: string[]; missing: string[] }> {
  const urls = expectedLiveUrls(ctx)
  const live: string[] = []
  const missing: string[] = []
  for (const u of urls) {
    if (await isLive(u, ctx.run.kind === 'foundation' ? 'sitemap' : 'page')) live.push(u)
    else missing.push(u)
  }
  return { live, missing }
}

/**
 * Advance an awaiting_publish run: drive the Lovable API when configured,
 * and always look for the new pages — a person may publish by hand at any
 * time. Returns true when everything is live.
 */
export async function advancePublish(ctx: RunContext): Promise<boolean> {
  const snap = ctx.snapshot
  const publish = snap?.publish
  const fullName = ctx.run.repoFullName ?? snap?.repo?.fullName ?? null
  if (publish && !publish.gaveUp && ctx.site.lovableProjectId && (await lovableConfigured())) {
    const giveUp = async (why: string) => {
      ctx.log('verify', `${why} — publish it in Lovable by hand; the engine keeps watching for it`, 'error')
      await ctx.save({ snapshot: json({ ...ctx.snapshot, publish: { ...publish, gaveUp: true } }) })
      await seoAlert(`:warning: *SEO* — ${ctx.site.name}: ${why}. Click *Publish* in Lovable. ${hubUrl(`/seo/runs/${ctx.run.id}`)}`)
    }
    try {
      if (!publish.deploymentId) {
        const project = await getLovableProject(ctx.site.lovableProjectId)
        const latest = project.latestCommitSha
        let synced = !!latest && (latest.startsWith(publish.mergeSha) || publish.mergeSha.startsWith(latest))
        if (!synced && latest && fullName) {
          // Lovable may have committed on top of the merge (e.g. a regenerated
          // route tree); the merge is in if it's an ancestor of Lovable's head.
          const cmp = await compareCommits(fullName, publish.mergeSha, latest).catch(() => null)
          synced = cmp?.status === 'identical' || cmp?.status === 'ahead'
        }
        if (synced) {
          const dep = await publishLovableProject(ctx.site.lovableProjectId)
          ctx.log('verify', `Asked Lovable to publish (deployment ${dep.deploymentId})`)
          await ctx.save({ snapshot: json({ ...snap, publish: { ...publish, deploymentId: dep.deploymentId, requestedAt: new Date().toISOString() } }) })
        } else {
          const syncPolls = (publish.syncPolls ?? 0) + 1
          // ~1 hour: Lovable missed GitHub's webhook (it never re-pulls on its own).
          if (syncPolls >= 12) await giveUp('Lovable hasn\u2019t picked up the merge from GitHub after an hour')
          else await ctx.save({ snapshot: json({ ...snap, publish: { ...publish, syncPolls } }) })
        }
      } else {
        const dep = await getLovableDeployment(ctx.site.lovableProjectId, publish.deploymentId)
        if (dep.errorClass) await giveUp(`Lovable\u2019s publish failed (${dep.errorClass})`)
        else if (dep.done) ctx.log('verify', `Lovable published${dep.url ? ` → ${dep.url}` : ''}`)
      }
    } catch (err) {
      ctx.log('verify', `Lovable API: ${err instanceof Error ? err.message : String(err)}`, 'warn')
    }
  }
  const { missing } = await liveCheck(ctx)
  await ctx.save({ snapshot: json({ ...ctx.snapshot, liveChecks: (ctx.snapshot?.liveChecks ?? 0) + 1 }) })
  return missing.length === 0
}

/** After this many checks with pages still missing, finish anyway and say so. */
const MAX_LIVE_CHECKS = 12

export async function stageVerify(ctx: RunContext): Promise<StageOutcome> {
  const { live, missing } = await liveCheck(ctx)
  const checks = (ctx.snapshot?.verifyChecks ?? 0) + 1
  // Only hand the run back while the publish poller still watches it.
  const watched = !!ctx.run.mergedAt && Date.now() - ctx.run.mergedAt.getTime() < PUBLISH_WATCH_MS
  if (missing.length) {
    if (checks < MAX_LIVE_CHECKS && watched) {
      // Marked published but the deploy may still be rolling out — keep watching.
      ctx.log('verify', `Not live yet: ${missing.join(', ')} — checking again in a few minutes`, 'warn')
      await ctx.save({ snapshot: json({ ...ctx.snapshot, verifyChecks: checks }) })
      return { stage: 'verify', status: 'awaiting_publish' }
    }
    ctx.log('verify', `Still not live after ${checks} checks: ${missing.join(', ')} — finishing; check the site's blog URLs`, 'warn')
  }
  if (live.length) {
    ctx.log('verify', `Live: ${live.join(', ')}`)
    await ctx.save({ publishedAt: new Date() })
    const drafts: Draft[] = Array.isArray(ctx.run.drafts) ? (ctx.run.drafts as unknown as Draft[]) : []
    for (const d of drafts) {
      const url = live.find((u) => u.endsWith(`/blog/${d.post.slug}`))
      if (url) await prisma.seoPost.updateMany({ where: { siteId: ctx.site.id, slug: d.post.slug }, data: { status: 'live', url } })
    }
    const origin = originOf(ctx.site.liveUrl)
    if (origin && ctx.site.indexNowKey) {
      const host = new URL(origin).host
      const res = await pingIndexNow({ host, key: ctx.site.indexNowKey, urls: [...live, `${origin}/sitemap.xml`] })
      ctx.log('verify', `IndexNow: ${res.ok ? 'accepted' : 'not accepted'} — ${res.detail}`, res.ok ? 'info' : 'warn')
    }
    if (origin && ctx.site.gscProperty && (await gscConfigured()).ok) {
      try {
        await gscSubmitSitemap(ctx.site.gscProperty, `${origin}/sitemap.xml`)
        ctx.log('verify', 'Submitted the sitemap to Search Console')
      } catch (err) {
        ctx.log('verify', `Search Console sitemap submit failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
      }
    }
  }
  return { stage: 'report', status: 'running' }
}

export async function stageReport(ctx: RunContext): Promise<StageOutcome> {
  const plan = (ctx.run.plan as unknown as SeoPlan | null) ?? null
  const drafts: Draft[] = Array.isArray(ctx.run.drafts) ? (ctx.run.drafts as unknown as Draft[]) : []
  const prev = await prisma.seoRun.findFirst({
    where: { siteId: ctx.site.id, kind: 'weekly', id: { not: ctx.run.id }, score: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { score: true },
  })
  if (ctx.run.kind === 'weekly') {
    const delta = ctx.run.score != null && prev?.score != null ? ctx.run.score - prev.score : null
    const changes: ChangeFile[] = Array.isArray(ctx.run.changes) ? (ctx.run.changes as unknown as ChangeFile[]) : []
    const fixes = changes.find((c) => c.path === PAGES_OVERLAY)?.reason ?? null
    const topWins = (plan?.quickWins ?? []).slice(0, 3)
    const owner = (o: string) => (o === 'engine' ? 'engine' : o === 'genisys' ? 'Genisys' : 'client')
    const lines = [
      `:bar_chart: *SEO weekly — ${ctx.site.name}* (${ctx.run.weekOf})`,
      `Score ${ctx.run.score ?? '—'}${delta != null ? ` (${delta >= 0 ? '+' : ''}${delta})` : ''} · ${drafts.length} post${drafts.length === 1 ? '' : 's'}${fixes ? ` · ${fixes.split(':')[0].toLowerCase()}` : ''} · $${ctx.run.costUsd.toFixed(2)}`,
      plan?.headline ? `> ${plan.headline}` : '',
      topWins.length ? `Top wins: ${topWins.map((w, i) => `${i + 1}) ${w.title} _(${owner(w.owner)})_`).join('  ')}` : '',
      drafts.length ? `Posts: ${drafts.map((d) => `“${d.post.title}”`).join(', ')}` : '',
      ctx.run.publishedAt ? 'New content is live.' : ctx.run.prUrl ? `PR: ${ctx.run.prUrl}` : drafts.length ? 'Drafts are in the Hub, ready to copy.' : '',
      hubUrl(`/seo/runs/${ctx.run.id}`),
    ].filter(Boolean)
    await seoAlert(lines.join('\n'))
  } else if (ctx.run.mergedAt) {
    await seoAlert(`:white_check_mark: *SEO* — ${ctx.site.name}: SEO foundation installed. Weekly posts can now publish. ${hubUrl(`/seo/runs/${ctx.run.id}`)}`)
  }
  ctx.log('report', 'Run complete')
  await ctx.save({ finishedAt: new Date() })
  return { stage: 'done', status: 'done' }
}

/**
 * A stopped run (rejected, canceled, dismissed): close its PR and branch in
 * the repo it actually committed to, and release its drafts — unless the PR
 * turned out to be merged already, in which case nothing is undone.
 */
export async function cleanupStoppedRun(run: RunRow, site: { id: string; repoFullName: string | null }, reason: string | null): Promise<{ merged: boolean }> {
  const snap = run.snapshot as unknown as Snapshot | null
  const fullName = run.repoFullName ?? snap?.repo?.fullName ?? site.repoFullName
  let merged = !!run.mergedAt
  if (fullName && run.prNumber && !merged) {
    const pr = await getPullRequest(fullName, run.prNumber).catch(() => null)
    merged = !!pr?.merged
    if (!merged) {
      await closePullRequest(fullName, run.prNumber, reason ? `Closed from the Genisys Hub: ${reason}` : 'Closed from the Genisys Hub.').catch(() => {})
      if (run.branch) await deleteBranch(fullName, run.branch).catch(() => {})
    }
  } else if (fullName && run.branch && !run.prNumber && !merged) {
    // Branch pushed but the PR never opened (interrupted mid-commit).
    await deleteBranch(fullName, run.branch).catch(() => {})
  }
  if (merged) return { merged: true }
  const drafts: Draft[] = Array.isArray(run.drafts) ? (run.drafts as unknown as Draft[]) : []
  for (const d of drafts) {
    await prisma.seoPost.updateMany({ where: { siteId: site.id, slug: d.post.slug, status: { not: 'live' } }, data: { status: 'rejected' } })
  }
  if (run.kind === 'foundation') {
    await prisma.seoSite.updateMany({ where: { id: site.id, foundationStatus: 'proposed' }, data: { foundationStatus: 'none', foundationPrUrl: null } })
  }
  return { merged: false }
}

export const STAGES: Record<Exclude<RunStage, 'done'>, (ctx: RunContext) => Promise<StageOutcome>> = {
  collect: stageCollect,
  research: stageResearch,
  plan: stagePlan,
  write: stageWrite,
  commit: stageCommit,
  ship: stageShip,
  verify: stageVerify,
  report: stageReport,
}

export async function loadRunContext(runId: string, lease: Date): Promise<RunContext | null> {
  const run = await prisma.seoRun.findUnique({ where: { id: runId } })
  if (!run) return null
  const site = await prisma.seoSite.findUnique({ where: { id: run.siteId }, include: { client: { select: { id: true, name: true } } } })
  if (!site) return null
  return new RunContext(run, site, await getSeoSettings(), lease)
}
