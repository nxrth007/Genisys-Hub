/**
 * Response shapes for /api/seo/* — shared by the route handlers and the
 * /seo pages so the two cannot drift. Dates are ISO strings.
 */

import type {
  AuditResult,
  BusinessFacts,
  ChangeFile,
  ClaudeUsage,
  CrawlResult,
  Draft,
  FoundationStatus,
  GscSummary,
  PsiResult,
  ResearchResult,
  RunKind,
  RunLogEntry,
  RunStage,
  RunStatus,
  SeoMode,
  SeoPlan,
  SitePlatform,
} from './types'

export type IntegrationState = { ok: boolean; detail: string }

export type SeoIntegrations = {
  /** Claude API key — required. */
  anthropic: IntegrationState & { source: 'vault' | 'env' | null }
  /** GitHub token for nxrth007 — required to commit. */
  github: IntegrationState & { login: string | null }
  /** Google API key for PageSpeed Insights — optional (keyless works, throttled). */
  pagespeed: IntegrationState
  /** Search Console service account — optional, unlocks query data. */
  searchConsole: IntegrationState & { serviceAccountEmail: string | null }
  /** Lovable API key — optional, unlocks auto-publish (Business plan). */
  lovable: IntegrationState
  /** Slack channel the weekly summary goes to. */
  slackChannel: string
}

export type SeoSettings = {
  /** Weekly schedule on/off. Manual runs work either way. */
  enabled: boolean
  /** 0 = Sunday … 6 = Saturday, in `timeZone`. */
  weekday: number
  /** 0–23, in `timeZone`. */
  hour: number
  timeZone: string
  model: string
  /** New posts per site per week (0–2). */
  postsPerWeek: number
  /** A run stops calling Claude once it has spent this much. */
  maxCostPerRunUsd: number
  /** When the schedule was last turned on or moved; a slot that began before this doesn't fire. */
  armedAt?: string
}

export type SeoRunSummary = {
  id: string
  siteId: string
  kind: RunKind
  weekOf: string
  trigger: 'schedule' | 'manual'
  status: RunStatus
  stage: RunStage
  score: number | null
  costUsd: number
  error: string | null
  prUrl: string | null
  headline: string | null
  counts: AuditResult['counts'] | null
  drafts: number
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type SeoSiteSummary = {
  id: string
  name: string
  clientId: string | null
  clientName: string | null
  liveUrl: string | null
  repoFullName: string | null
  platform: SitePlatform
  mode: SeoMode
  enabled: boolean
  foundationStatus: FoundationStatus
  lastScore: number | null
  /** Score from the run before the latest scored one, for the week-over-week delta. */
  previousScore: number | null
  lastRunAt: string | null
  latestRun: SeoRunSummary | null
  posts: { total: number; live: number }
}

export type SeoOverviewResponse = {
  integrations: SeoIntegrations
  settings: SeoSettings
  /** Next scheduled weekly run, or null when the schedule is off. */
  nextRunAt: string | null
  sites: SeoSiteSummary[]
  /** Active clients that don't have an SEO site yet, for the "Add site" picker. */
  clients: { id: string; name: string; siteUrl: string | null }[]
  spend: { last30DaysUsd: number; runsLast30Days: number }
}

export type SeoSiteDetail = SeoSiteSummary & {
  defaultBranch: string | null
  facts: BusinessFacts | null
  gscProperty: string | null
  lovableProjectId: string | null
  indexNowKey: string | null
  foundationPrUrl: string | null
  createdAt: string
}

export type SeoPostView = {
  id: string
  slug: string
  title: string
  primaryKeyword: string
  status: 'draft' | 'committed' | 'live' | 'rejected'
  url: string | null
  runId: string | null
  createdAt: string
}

export type SeoSiteDetailResponse = {
  site: SeoSiteDetail
  runs: SeoRunSummary[]
  posts: SeoPostView[]
}

/** Crawl as stored on the run — pages trimmed to what the UI shows. */
export type CrawlView = Omit<CrawlResult, 'pages'> & {
  pages: {
    url: string
    status: number
    title: string | null
    h1: string | null
    wordCount: number
    ms: number
    jsonLdTypes: string[]
  }[]
}

/** Summary fields plus the full payload; `drafts` is the drafts themselves here, not a count. */
export type SeoRunDetail = Omit<SeoRunSummary, 'drafts'> & {
  siteName: string
  repoFullName: string | null
  branch: string | null
  commitSha: string | null
  prNumber: number | null
  ciStatus: string | null
  mergedAt: string | null
  publishedAt: string | null
  audit: AuditResult | null
  crawl: CrawlView | null
  psi: PsiResult | null
  gsc: GscSummary | null
  research: ResearchResult | null
  plan: SeoPlan | null
  drafts: Draft[]
  changes: ChangeFile[]
  usage: ClaudeUsage | null
  log: RunLogEntry[]
  reviewedBy: string | null
}

export type SeoRunDetailResponse = { run: SeoRunDetail }

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export type CreateSiteBody = {
  clientId: string | null
  name: string
  liveUrl: string | null
  repoFullName: string | null
  mode: SeoMode
}

export type UpdateSiteBody = Partial<{
  name: string
  liveUrl: string | null
  repoFullName: string | null
  mode: SeoMode
  enabled: boolean
  facts: BusinessFacts
  gscProperty: string | null
  lovableProjectId: string | null
}>

/** POST /api/seo/runs/[id] — the reviewer's actions on a run. */
export type RunActionBody =
  | { action: 'approve' }
  | { action: 'reject'; reason?: string }
  | { action: 'mark_published' }
  | { action: 'cancel' }
  | { action: 'retry' }
