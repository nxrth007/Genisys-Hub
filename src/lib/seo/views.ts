import { seoPauseState } from './pause'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import type {
  ReadinessStep,
  SeoIntegrations,
  SeoOverviewResponse,
  SeoPostView,
  SeoRunDetail,
  SeoRunSummary,
  SeoSiteDetail,
  SeoSiteSummary,
  SiteReadiness,
} from './api-types'
import { githubViewer } from './github'
import { gscConfigured } from './gsc'
import { gscConnectStates, type GscConnectState } from './gsc-connect'
import { clientRequestMessage, factGaps, latestIntakeFor, readMeta, type IntakeAnswers } from './client-facts'
import { checkPsiKey } from './psi'
import { lovableChannel } from './lovable'
import { lovableMcpStatus } from './lovable-mcp'
import { liveUrlsFor, type Snapshot } from './pipeline'
import { describeSecret, preferredEntryName } from './secrets'
import { getSeoSettings, nextScheduledRun } from './settings'
import { postCadence, postCount, type Cadence } from './cadence'
import { SEO_ALERT_CHANNEL } from './slack'
import type {
  AuditResult,
  BusinessFacts,
  ChangeFile,
  ClaudeUsage,
  Draft,
  FoundationStatus,
  ResearchResult,
  RunKind,
  RunLogEntry,
  RunStage,
  RunStatus,
  SeoMode,
  SeoPlan,
  SitePlatform,
} from './types'

/** DB rows → the shapes in api-types.ts. Heavy JSON stays out of summaries. */


/** Only the light columns a run summary needs — never the heavy JSON. */
const SUMMARY_SELECT = {
  id: true,
  siteId: true,
  kind: true,
  weekOf: true,
  trigger: true,
  status: true,
  stage: true,
  score: true,
  costUsd: true,
  error: true,
  prUrl: true,
  headline: true,
  findingCounts: true,
  draftCount: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
} satisfies Prisma.SeoRunSelect
type RunSummaryRow = Prisma.SeoRunGetPayload<{ select: typeof SUMMARY_SELECT }>
type SiteRow = Prisma.SeoSiteGetPayload<{ include: { client: { select: { id: true; name: true } } } }>

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

/** `lovableOn`: the Hub can publish in Lovable itself (a sign-in or an API key). */
export function runSummary(r: RunSummaryRow, lovableOn = false): SeoRunSummary {
  return {
    id: r.id,
    siteId: r.siteId,
    kind: r.kind as RunKind,
    weekOf: r.weekOf,
    trigger: r.trigger === 'schedule' ? 'schedule' : 'manual',
    status: r.status as RunStatus,
    stage: r.stage as RunStage,
    score: r.score,
    costUsd: r.costUsd,
    error: r.error,
    prUrl: r.prUrl,
    headline: r.headline,
    counts: (r.findingCounts as unknown as AuditResult['counts'] | null) ?? null,
    drafts: r.draftCount,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    createdAt: r.createdAt.toISOString(),
    hubPublishing: r.status === 'awaiting_publish' && lovableOn && !r.error,
  }
}

/** Latest two audit scores per site (newest first). */
async function recentScores(siteIds: string[]): Promise<Map<string, number[]>> {
  const rows = await prisma.seoRun.findMany({
    where: { siteId: { in: siteIds }, kind: 'weekly', score: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { siteId: true, score: true },
    take: 400,
  })
  const out = new Map<string, number[]>()
  for (const r of rows) {
    const list = out.get(r.siteId) ?? []
    if (list.length < 2 && r.score != null) list.push(r.score)
    out.set(r.siteId, list)
  }
  return out
}

function siteSummary(
  s: SiteRow,
  latest: RunSummaryRow | null,
  posts: { total: number; live: number },
  scores: number[] = [],
  lovableOn = false,
  foundationLive: boolean | null = null,
): SeoSiteSummary {
  return {
    id: s.id,
    name: s.name,
    clientId: s.clientId,
    clientName: s.client?.name ?? null,
    liveUrl: s.liveUrl,
    repoFullName: s.repoFullName,
    platform: s.platform as SitePlatform,
    mode: s.mode as SeoMode,
    enabled: s.enabled,
    foundationStatus: s.foundationStatus as FoundationStatus,
    foundationLive,
    lastScore: s.lastScore,
    previousScore: scores[1] ?? null,
    lastRunAt: iso(s.lastRunAt),
    latestRun: latest ? runSummary(latest, lovableOn) : null,
    posts,
  }
}

/**
 * Is each site's foundation live? The site row says "installed" from the
 * moment the PR merges; the foundation run only finishes once its files are
 * live on the site. A merged run that hasn't finished = not live yet.
 */
async function foundationLiveBySite(siteIds: string[]): Promise<Map<string, boolean>> {
  const runs = await prisma.seoRun.findMany({
    where: { siteId: { in: siteIds }, kind: 'foundation', mergedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    distinct: ['siteId'],
    select: { siteId: true, status: true, publishedAt: true },
  })
  return new Map(runs.map((r) => [r.siteId, r.status === 'done' || !!r.publishedAt]))
}

async function postCounts(siteIds: string[]): Promise<Map<string, { total: number; live: number }>> {
  const rows = await prisma.seoPost.groupBy({ by: ['siteId', 'status'], where: { siteId: { in: siteIds } }, _count: { _all: true } })
  const out = new Map<string, { total: number; live: number }>()
  for (const r of rows) {
    const c = out.get(r.siteId) ?? { total: 0, live: 0 }
    if (r.status !== 'rejected') c.total += r._count._all
    if (r.status === 'live') c.live += r._count._all
    out.set(r.siteId, c)
  }
  return out
}

/**
 * The road to hands-off publishing, as a checklist. "Required" steps are
 * the ones Autopilot can't ship without; the rest make it better or fully
 * unattended (a Lovable key removes the last human click).
 */
function readinessFor(
  s: SiteRow,
  env: { reviewedShips: number; lovableKey: boolean; gscOk: boolean; scheduleOn: boolean; gscState?: GscConnectState | null; foundationLive?: boolean | null },
): SiteReadiness {
  const step = (id: ReadinessStep['id'], label: string, ok: boolean, required: boolean, detail: string): ReadinessStep => ({ id, label, ok, required, detail })
  const steps: ReadinessStep[] = [
    step('repo', 'GitHub repo linked', !!s.repoFullName, true, s.repoFullName ? s.repoFullName : 'Link the site’s repo in Settings. GoHighLevel sites have none — they stay in Audit mode.'),
    step('facts', 'Business facts recorded', !!s.facts, true, s.facts ? 'Every post is written from these — keep them current.' : 'Recorded automatically on the first run; check them on the Business facts tab.'),
    step('foundation', 'SEO foundation installed', s.foundationStatus === 'installed' && env.foundationLive !== false, true, s.foundationStatus === 'installed' && env.foundationLive === false ? 'Merged on GitHub but not live on the site yet: Lovable hasn’t pulled it or it isn’t published. The Hub nudges Lovable and publishes on its own; open the foundation run to see where it’s stuck.' : s.foundationStatus === 'installed' ? 'Posts, sitemap and llms.txt are wired in and live.' : s.foundationStatus === 'proposed' ? 'The foundation PR is open — approve it on its run page, then publish in Lovable.' : 'One reviewed pull request; the button is above.'),
    step('ci', 'Build check in the repo', s.ciWorkflow, true, s.ciWorkflow ? 'Every engine branch is built before it can merge.' : 'Comes with the foundation; Autopilot won’t merge without it.'),
    step('reviewed', 'A weekly run approved by a person', env.reviewedShips > 0, false, env.reviewedShips > 0 ? `${env.reviewedShips} shipped after review.` : 'Run a week in Review mode first so you’ve seen what the engine writes for this site.'),
    step('publish', 'Publishing without a click', env.lovableKey, false, env.lovableKey ? (s.lovableProjectId ? 'The Hub publishes each merge in Lovable itself.' : 'Lovable is connected; this site\u2019s project is found automatically on its next run.') : 'Connect Lovable on the SEO dashboard (free, one-time sign-in). Until then someone clicks Publish in Lovable after each merge — the engine notices and verifies.'),
    step(
      'gsc',
      'Search Console connected',
      !!s.gscProperty && env.gscOk,
      false,
      !!s.gscProperty && env.gscOk
        ? s.gscProperty!
        : s.gscProperty
          ? `${s.gscProperty} \u2014 but the Hub\u2019s Search Console sign-in isn\u2019t working; reconnect it on the SEO dashboard.`
          : env.gscState
            ? env.gscState.detail
            : env.gscOk
              ? 'The Hub verifies the site with Google and connects it on its own within a few minutes.'
              : 'Connect Search Console on the SEO dashboard (one click) \u2014 the Hub then verifies and connects every site itself.',
    ),
    step('schedule', 'Weekly schedule on', env.scheduleOn && s.enabled, false, env.scheduleOn ? (s.enabled ? 'Runs every week.' : 'This site is skipped by the schedule — flip it on in the Engine card.') : 'Turn the weekly schedule on from the SEO dashboard.'),
    step('mode', 'Autopilot on', s.mode === 'autopilot', false, s.mode === 'autopilot' ? 'Merges on its own when every check passes.' : s.mode === 'review' ? 'A person approves each week’s PR.' : 'Audit mode: plans and drafts only.'),
  ]
  return { ready: steps.filter((x) => x.required).every((x) => x.ok), steps }
}

/** Ramp-then-taper for the site page, from the repo as the last run saw it plus the engine's posts since. */
async function siteCadence(
  s: { id: string; postsPerWeek: number | null; postsNextRun: number | null },
  settings: { postsPerWeek: number; rampTargetPosts: number; steadyPostsPerWeek: number },
): Promise<Cadence | null> {
  const [runs, ledger] = await Promise.all([
    prisma.seoRun.findMany({ where: { siteId: s.id }, orderBy: { createdAt: 'desc' }, take: 3, select: { snapshot: true } }),
    prisma.seoPost.findMany({ where: { siteId: s.id }, select: { slug: true, status: true } }),
  ])
  const repo = runs
    .map((r) => (r.snapshot as { repo?: { blogPosts?: { slug: string }[]; serviceSlugs?: string[] } } | null)?.repo)
    .find((r) => Array.isArray(r?.blogPosts))
  if (!repo) return null
  return postCadence({
    postsNextRun: s.postsNextRun,
    sitePostsPerWeek: s.postsPerWeek,
    rampPostsPerWeek: settings.postsPerWeek,
    rampTargetPosts: settings.rampTargetPosts,
    steadyPostsPerWeek: settings.steadyPostsPerWeek,
    have: postCount((repo.blogPosts ?? []).map((b) => b.slug), ledger),
    serviceCount: repo.serviceSlugs?.length ?? 0,
  })
}

export async function siteDetail(siteId: string): Promise<SeoSiteDetail | null> {
  const s = await prisma.seoSite.findUnique({ where: { id: siteId }, include: { client: { select: { id: true, name: true } } } })
  if (!s) return null
  const [latest, counts, scores, reviewedShips, lovable, gsc, settings, gscStates, intake, foundationLive] = await Promise.all([
    prisma.seoRun.findFirst({ where: { siteId }, orderBy: { createdAt: 'desc' }, select: SUMMARY_SELECT }),
    postCounts([siteId]).then((m) => m.get(siteId) ?? { total: 0, live: 0 }),
    recentScores([siteId]).then((m) => m.get(siteId) ?? []),
    prisma.seoRun.count({ where: { siteId, kind: 'weekly', reviewedBy: { not: null }, mergedAt: { not: null } } }),
    lovableChannel(),
    gscConfigured().catch(() => ({ ok: false, serviceAccountEmail: null })),
    getSeoSettings(),
    gscConnectStates(),
    latestIntakeFor(s.clientId).catch(() => null),
    foundationLiveBySite([siteId]).then((m) => m.get(siteId) ?? null),
  ])
  const facts = (s.facts as unknown as BusinessFacts | null) ?? null
  const meta = readMeta(s.factsMeta)
  const gaps = factGaps(facts, intake)
  return {
    ...siteSummary(s, latest, counts, scores, lovable !== null, foundationLive),
    readiness: readinessFor(s, {
      foundationLive,
      reviewedShips,
      lovableKey: lovable !== null,
      gscOk: gsc.ok,
      scheduleOn: settings.enabled,
      gscState: gscStates[siteId] ?? null,
    }),
    defaultBranch: s.defaultBranch,
    facts: (s.facts as unknown as BusinessFacts | null) ?? null,
    gscProperty: s.gscProperty,
    postsPerWeek: s.postsPerWeek,
    postsNextRun: s.postsNextRun,
    globalPostsPerWeek: settings.postsPerWeek,
    cadence: await siteCadence(s, settings),
    lovableProjectId: s.lovableProjectId,
    client: {
      intake: intake ? { id: intake.id, submittedAt: intake.receivedAt.toISOString(), answers: intakeAnswers(intake) } : null,
      sources: meta.sources,
      changes: meta.changes.slice(0, 15),
      conflicts: meta.conflicts,
      gaps,
      request: clientRequestMessage(facts, gaps, facts?.businessName || s.name),
      synced: !intake || meta.intakeId === intake.id,
    },
    indexNowKey: s.indexNowKey,
    foundationPrUrl: s.foundationPrUrl,
    createdAt: s.createdAt.toISOString(),
  }
}

const INTAKE_LABELS: [keyof IntakeAnswers, string][] = [
  ['businessName', 'Legal business name'],
  ['fullName', 'Filled in by'],
  ['customerPhone', 'Their own phone (the site shows the tracking number)'],
  ['businessAddress', 'Address (never shown for service-area businesses)'],
  ['cities', 'Cities they serve'],
  ['mainServices', 'Main services to promote'],
  ['aboutBusiness', 'About the business'],
  ['whyChooseYou', 'Why customers should choose them'],
  ['promotions', 'Current promotions / offers'],
  ['faqs', 'FAQs + answers'],
  ['socialLinks', 'Social media pages'],
  ['hasGoogleProfile', 'Has a Google Business Profile'],
  ['googleProfileLink', 'Google Business Profile link'],
  ['reviewLinks', 'Review sites they’re on'],
  ['yearStarted', 'Year the business started'],
  ['licenseInfo', 'License'],
  ['website', 'Website they had'],
  ['domainName', 'Domain they’re bringing'],
  ['timeZone', 'Time zone'],
]

function intakeAnswers(i: IntakeAnswers): { label: string; value: string }[] {
  return INTAKE_LABELS.flatMap(([k, label]) => {
    const v = i[k]
    return typeof v === 'string' && v.trim() ? [{ label, value: v.trim() }] : []
  })
}

export async function siteRuns(siteId: string): Promise<SeoRunSummary[]> {
  const [runs, channel] = await Promise.all([
    prisma.seoRun.findMany({ where: { siteId }, orderBy: { createdAt: 'desc' }, take: 30, select: SUMMARY_SELECT }),
    lovableChannel(),
  ])
  return runs.map((r) => runSummary(r, channel !== null))
}

export async function sitePosts(siteId: string): Promise<SeoPostView[]> {
  const posts = await prisma.seoPost.findMany({ where: { siteId }, orderBy: { createdAt: 'desc' }, take: 100 })
  return posts.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    primaryKeyword: p.primaryKeyword,
    status: (['draft', 'committed', 'live', 'rejected'].includes(p.status) ? p.status : 'draft') as SeoPostView['status'],
    url: p.url,
    runId: p.runId,
    createdAt: p.createdAt.toISOString(),
  }))
}

export async function runDetail(runId: string): Promise<SeoRunDetail | null> {
  const r = await prisma.seoRun.findUnique({ where: { id: runId } })
  if (!r) return null
  const [site, channel] = await Promise.all([
    prisma.seoSite.findUnique({ where: { id: r.siteId }, select: { name: true, repoFullName: true, liveUrl: true, indexNowKey: true } }),
    lovableChannel(),
  ])
  const snap = r.snapshot as unknown as Snapshot | null
  const { drafts: _count, ...summary } = runSummary(r, channel !== null)
  void _count
  return {
    ...summary,
    siteName: site?.name ?? 'Unknown site',
    // The repo this run committed to, even if the site has since moved.
    repoFullName: r.repoFullName ?? snap?.repo?.fullName ?? site?.repoFullName ?? null,
    branch: r.branch,
    commitSha: r.commitSha,
    prNumber: r.prNumber,
    ciStatus: r.ciStatus,
    mergedAt: iso(r.mergedAt),
    publishedAt: iso(r.publishedAt),
    audit: (r.audit as unknown as AuditResult | null) ?? null,
    crawl: snap?.crawl ?? null,
    psi: snap?.psi ?? null,
    gsc: snap?.gsc ?? null,
    research: (r.research as unknown as ResearchResult | null) ?? null,
    plan: (r.plan as unknown as SeoPlan | null) ?? null,
    drafts: Array.isArray(r.drafts) ? (r.drafts as unknown as Draft[]) : [],
    changes: Array.isArray(r.changes) ? (r.changes as unknown as ChangeFile[]) : [],
    usage: (r.usage as unknown as ClaudeUsage | null) ?? null,
    log: Array.isArray(r.log) ? (r.log as unknown as RunLogEntry[]) : [],
    reviewedBy: r.reviewedBy,
    publishing: snap?.publish
      ? {
          channel,
          attempts: snap.publish.mcpAttempts ?? (snap.publish.deploymentId ? 1 : 0),
          lastRequestedAt: snap.publish.requestedAt ?? null,
          gaveUp: !!snap.publish.gaveUp,
          waitingFor: liveUrlsFor(r.kind, site?.liveUrl ?? null, Array.isArray(r.drafts) ? (r.drafts as unknown as Draft[]) : [], site?.indexNowKey ?? null),
          servedUrl: snap.lovableServedUrl ?? null,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

let githubCheck: { at: number; login: string | null; error: string | null } | null = null

async function githubStatus(present: boolean): Promise<{ login: string | null; error: string | null }> {
  if (!present) return { login: null, error: null }
  if (githubCheck && Date.now() - githubCheck.at < 5 * 60_000) return githubCheck
  try {
    const me = await githubViewer()
    githubCheck = { at: Date.now(), login: me.login, error: null }
  } catch (err) {
    githubCheck = { at: Date.now(), login: null, error: err instanceof Error ? err.message : 'GitHub rejected the token.' }
  }
  return githubCheck
}

export async function integrations(): Promise<SeoIntegrations> {
  const [anthropic, github, google, lovable, gsc, psiKey, mcp, gscStates, gscSites] = await Promise.all([
    describeSecret('anthropic'),
    describeSecret('github'),
    describeSecret('googleApiKey'),
    describeSecret('lovable'),
    gscConfigured().catch(() => ({ ok: false, serviceAccountEmail: null, account: null, error: null })),
    checkPsiKey(),
    lovableMcpStatus(),
    gscConnectStates(),
    prisma.seoSite.findMany({ where: { archivedAt: null }, select: { id: true, name: true, gscProperty: true, liveUrl: true }, orderBy: { name: 'asc' } }),
  ])
  const gh = await githubStatus(github.present)
  return {
    anthropic: {
      ok: anthropic.present,
      source: anthropic.source,
      detail: anthropic.present
        ? `Using ${anthropic.source === 'vault' ? `Vault entry "${anthropic.entryName}"` : 'the ANTHROPIC_API_KEY environment variable'}.`
        : `Add a Vault entry named "${preferredEntryName('anthropic')}" with the Claude API key (sk-ant-…).`,
    },
    github: {
      ok: github.present && !!gh.login,
      login: gh.login,
      detail: !github.present
        ? `Add a Vault entry named "${preferredEntryName('github')}": a fine-grained token on nxrth007 with Contents, Pull requests and Workflows (read & write) plus Actions (read), for the client site repos.`
        : gh.login
          ? `Connected as ${gh.login} (Vault entry "${github.entryName}").`
          : `The token in "${github.entryName}" didn't work: ${gh.error ?? 'unknown error'}`,
    },
    pagespeed: {
      ok: psiKey.state === 'ok',
      detail:
        psiKey.state === 'ok'
          ? `Working — using "${google.entryName}".`
          : psiKey.state === 'missing'
            ? 'Optional, but speed scores need it: Google no longer serves PageSpeed without a key. Add a Vault entry "Google API Key" (Google Cloud → Credentials) with the PageSpeed Insights API enabled.'
            : `Found "${google.entryName}", but it doesn't work for PageSpeed: ${psiKey.detail} Either fix that key, or add a separate Vault entry "Google API Key" restricted to the PageSpeed Insights API — the Hub prefers that name. Runs still work; they just skip speed scores.`,
    },
    searchConsole: {
      ok: gsc.ok,
      serviceAccountEmail: gsc.serviceAccountEmail,
      account: gsc.account,
      googleProject: /^(\d{6,})-/.exec(process.env.AUTH_GOOGLE_ID ?? '')?.[1] ?? null,
      sites: gscSites.map((s) => {
        const st = gscStates[s.id]
        return {
          siteId: s.id,
          name: s.name,
          property: s.gscProperty,
          status: s.gscProperty ? 'connected' : st && st.status !== 'connected' ? st.status : 'waiting',
          detail: s.gscProperty ? s.gscProperty : st ? st.detail : s.liveUrl ? 'Queued \u2014 the Hub gets to it within a few minutes.' : 'No site URL yet.',
        }
      }),
      detail: gsc.ok
        ? gsc.account
          ? `Connected as ${gsc.account}. The Hub verifies each site with Google and adds it to this account\u2019s Search Console on its own.`
          : `Service account ${gsc.serviceAccountEmail} \u2014 add it as a user on each site's Search Console property, then set the property on the site page. Connecting a Google account below does all of that automatically.`
        : gsc.account
          ? `${gsc.account} is connected, but Google rejected it: ${gsc.error ?? 'unknown error'}. Connect again below.`
          : 'Optional, and the best source of keyword data. Connect it below once \u2014 the Hub then connects every site by itself.',
    },
    lovable: {
      ok: lovable.present || mcp.connected,
      channel: lovable.present ? 'api' : mcp.connected ? 'mcp' : null,
      account: mcp.account,
      broken: lovable.present ? null : mcp.broken,
      missingScopes: lovable.present ? [] : mcp.missingScopes,
      detail: lovable.present
        ? 'Publishing through the Lovable API key in the Vault.'
        : mcp.connected && mcp.missingScopes.length
          ? `Signed in to Lovable${mcp.account ? ` as ${mcp.account}` : ''}. That sign-in predates workspace access, which the Lovable \u2192 GitHub watch on the Clients page needs \u2014 reconnect below. Publishing is unaffected.`
          : mcp.connected
            ? `Signed in to Lovable${mcp.account ? ` as ${mcp.account}` : ''} — merges publish themselves a few minutes after they land.`
          : mcp.broken
            ? `The Lovable sign-in stopped working (${mcp.broken}). Connect again below.`
            : 'Optional. Connect Lovable below (free, one-time sign-in) and merges publish themselves. Until then someone clicks Publish in Lovable after each merge; the engine watches for it.',
    },
    slackChannel: SEO_ALERT_CHANNEL,
  }
}

export async function overview(): Promise<SeoOverviewResponse> {
  const [settings, sites, clients, integ, pause] = await Promise.all([
    getSeoSettings(),
    prisma.seoSite.findMany({
      where: { archivedAt: null },
      include: { client: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.client.findMany({
      // Clients with no site, or whose site was archived (re-adding restores it).
      where: { archivedAt: null, OR: [{ seoSite: null }, { seoSite: { archivedAt: { not: null } } }] },
      select: { id: true, name: true, siteUrl: true },
      orderBy: { name: 'asc' },
    }),
    integrations(),
    seoPauseState(),
  ])
  const ids = sites.map((s) => s.id)
  const [latestRuns, counts, scores, spend, liveFoundations] = await Promise.all([
    // One light query per site: `distinct` would still read every run's row.
    Promise.all(ids.map((id) => prisma.seoRun.findFirst({ where: { siteId: id }, orderBy: { createdAt: 'desc' }, select: SUMMARY_SELECT }))).then((rows) =>
      rows.filter((r): r is RunSummaryRow => !!r),
    ),
    postCounts(ids),
    recentScores(ids),
    prisma.seoRun.aggregate({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
    foundationLiveBySite(ids),
  ])
  const latestBySite = new Map(latestRuns.map((r) => [r.siteId, r]))
  return {
    paused: pause.paused,
    pause,
    integrations: integ,
    settings,
    nextRunAt: nextScheduledRun(settings, new Date()),
    sites: sites.map((s) =>
      siteSummary(s, latestBySite.get(s.id) ?? null, counts.get(s.id) ?? { total: 0, live: 0 }, scores.get(s.id) ?? [], integ.lovable.channel !== null, liveFoundations.get(s.id) ?? null),
    ),
    clients,
    spend: { last30DaysUsd: Math.round((spend._sum.costUsd ?? 0) * 100) / 100, runsLast30Days: spend._count._all },
  }
}
