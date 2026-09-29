/**
 * Shared types for the SEO engine (Hub → SEO).
 *
 * The engine runs once a week per client site: crawl the live site, audit
 * it deterministically, let Claude research and plan the week, write the
 * content, and commit it to the site's GitHub repo (Lovable syncs from
 * there). Everything here is plain data so it can live in Postgres JSON
 * columns and cross the API boundary unchanged.
 */

/** How far the engine may go on its own for a site. */
export type SeoMode =
  /** Audit, plan and draft only — nothing is committed (GHL sites, or no repo yet). */
  | 'audit'
  /** Commit to a branch and open a PR; a person approves in the Hub. */
  | 'review'
  /** Merge and publish automatically when every gate and the build pass. */
  | 'autopilot'

export type SitePlatform = 'lovable-tanstack' | 'lovable-spa' | 'ghl' | 'other' | 'unknown'

export type RunKind = 'weekly' | 'foundation'

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'awaiting_ci'
  | 'awaiting_publish'
  | 'done'
  | 'failed'
  | 'canceled'

export type RunStage =
  | 'collect'
  | 'research'
  | 'plan'
  | 'write'
  | 'commit'
  | 'ship'
  | 'verify'
  | 'report'
  | 'done'

export type FoundationStatus = 'none' | 'proposed' | 'installed'

// ---------------------------------------------------------------------------
// Business facts — the single source of truth for NAP, schema and content.
// Seeded from the onboarding intake and the site repo; editable in the Hub.
// ---------------------------------------------------------------------------

export type BusinessFacts = {
  businessName: string
  /** Plain-English trade, e.g. "Fence contractor", "Concrete contractor". */
  trade: string
  /** schema.org type: HomeAndConstructionBusiness, RoofingContractor, GeneralContractor, … */
  schemaType: string
  primaryCity: string
  /** Two-letter state, e.g. "TX". */
  state: string
  serviceAreas: string[]
  services: { name: string; slug: string | null; notes: string | null }[]
  phone: string | null
  email: string | null
  address: string | null
  /** Service-area business with no customer-facing address. Never recommend showing one. */
  hiddenAddress: boolean
  owner: string | null
  established: number | null
  license: string | null
  insurance: string | null
  warranty: string | null
  hours: string | null
  /** First-party price bands only. Content may not invent prices beyond these or cited sources. */
  pricingNotes: string | null
  differentiators: string[]
  /** Real completed projects — the first-hand facts that keep content out of scaled-content territory. */
  projects: { title: string; city: string | null; service: string | null; details: string }[]
  /** GBP, Yelp, BBB, Facebook, Angi… */
  profiles: { label: string; url: string }[]
  brandVoice: string | null
  /** Claims and phrases content must never use. */
  avoid: string[]
  notes: string | null
}

// ---------------------------------------------------------------------------
// Crawl + audit
// ---------------------------------------------------------------------------

export type PageImage = {
  src: string
  alt: string | null
  width: string | null
  height: string | null
  loading: string | null
  /** Absolutely positioned to fill its box (Tailwind absolute/inset-0, Next.js fill) — can't shift layout, needs no width/height. */
  fill?: boolean
}

export type PageData = {
  requestedUrl: string
  /** Final URL after redirects. */
  url: string
  status: number
  /** Redirect hops followed to reach `url` (0 = none). */
  redirects: number
  ms: number
  bytes: number
  contentType: string | null
  xRobotsTag: string | null
  title: string | null
  metaDescription: string | null
  canonical: string | null
  metaRobots: string | null
  lang: string | null
  hasViewport: boolean
  h1: string[]
  h2: string[]
  /** Words of visible body text in the raw (unrendered) HTML. */
  wordCount: number
  /** og:* and twitter:* meta, keyed by property/name. */
  social: Record<string, string>
  jsonLd: { types: string[]; blocks: unknown[]; parseErrors: number }
  /** Absolute, normalised, same-origin page links. */
  internalLinks: string[]
  externalLinks: string[]
  telLinks: string[]
  images: PageImage[]
  /** http:// subresources on an https page. */
  mixedContent: string[]
  /** First ~800 characters of visible text, for prompts. */
  textSample: string
  /** Raw HTML looks like an empty client-side shell (no real content without JS). */
  clientRenderedShell: boolean
  error: string | null
  /** Words inside <main> (or outside site header/nav/footer when there is none) — the thin-content measure. */
  mainWordCount?: number
  /** Number of <link rel="canonical"> tags; more than one is a conflict. */
  canonicalCount?: number
  /** Distinct 10-digit phone numbers (digits only) in the visible text — for the NAP check. */
  phones?: string[]
}

export type CrawlResult = {
  origin: string
  startUrl: string
  fetchedAt: string
  /** http:// → https:// behaviour for the start URL. */
  httpToHttps: { status: number | null; location: string | null } | null
  /** The www / non-www twin of the origin and where it goes. */
  hostTwin: { url: string; status: number | null; location: string | null } | null
  robots: {
    status: number | null
    body: string | null
    sitemaps: string[]
    /** User-agent token → is "/" allowed for it. */
    rootAllowed: Record<string, boolean>
  }
  sitemap: { url: string | null; status: number | null; urls: string[]; error: string | null }
  llmsTxt: { status: number | null }
  soft404: { url: string; status: number | null }
  pages: PageData[]
  errors: string[]
}

export type FindingSeverity = 'P0' | 'P1' | 'P2'

export type Finding = {
  /** Stable check id, e.g. "T4.raw-html". */
  id: string
  severity: FindingSeverity
  status: 'fail' | 'warn' | 'pass'
  title: string
  detail: string
  urls: string[]
  fix: string
  /** The engine can fix this itself (data/content change) once the SEO foundation is installed. */
  fixableByBot: boolean
}

export type AuditResult = {
  /** 0–100, higher is better. */
  score: number
  findings: Finding[]
  counts: { P0: number; P1: number; P2: number; pass: number }
  pagesCrawled: number
}

export type PsiResult = {
  url: string
  strategy: 'mobile'
  fetchedAt: string
  scores: {
    performance: number | null
    seo: number | null
    accessibility: number | null
    bestPractices: number | null
  }
  lab: {
    lcpMs: number | null
    cls: number | null
    tbtMs: number | null
    fcpMs: number | null
    speedIndexMs: number | null
  }
  /** Real-user (CrUX) data when the origin has enough traffic; usually null for small sites. */
  field: { lcpMs: number | null; inpMs: number | null; cls: number | null; category: string | null } | null
  error: string | null
}

export type GscRow = {
  query: string | null
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export type GscSummary = {
  property: string
  range: { start: string; end: string }
  priorRange: { start: string; end: string }
  totals: { clicks: number; impressions: number; ctr: number; position: number }
  prior: { clicks: number; impressions: number; ctr: number; position: number }
  topQueries: GscRow[]
  topPages: GscRow[]
  /** Striking-distance query×page pairs (avg position 4–20), best opportunity first. */
  striking: (GscRow & { opportunity: number })[]
  error: string | null
}

// ---------------------------------------------------------------------------
// Repo snapshot
// ---------------------------------------------------------------------------

export type RepoFile = { path: string; content: string; truncated: boolean }

export type RepoSnapshot = {
  fullName: string
  defaultBranch: string
  headSha: string
  htmlUrl: string
  platform: SitePlatform
  /** Genisys' shared Lovable template: src/data/site.ts + src/data/blog.ts + src/lib/seo.ts. */
  template: 'genisys-lovable' | null
  /** src/content/seo.config.json exists — weekly runs may commit content files. */
  foundationInstalled: boolean
  /** All file paths (capped). */
  paths: string[]
  /** src/routes/* files, for the page inventory. */
  routes: string[]
  /** Key files, verbatim (capped per file). */
  files: RepoFile[]
  /** Existing posts from src/data/blog.ts and src/content/blog/*.json. */
  blogPosts: { slug: string; title: string; source: 'data' | 'content' }[]
  /** Keys of `projectPhotos` in src/data/site.ts — the only images a post may reference. */
  imageKeys: string[]
  serviceSlugs: string[]
  lastCommit: { sha: string; author: string; date: string; message: string; byLovable: boolean } | null
  /** .github/workflows/seo-verify.yml exists. */
  hasCiWorkflow: boolean
}

// ---------------------------------------------------------------------------
// Plan + content (Claude output, validated with zod in prompts.ts)
// ---------------------------------------------------------------------------

export type PlanItem = {
  id: string
  title: string
  category:
    | 'technical'
    | 'on_page'
    | 'content'
    | 'internal_links'
    | 'schema'
    | 'local_seo'
    | 'gbp'
    | 'reviews'
    | 'citations'
    | 'geo_ai'
  priority: FindingSeverity
  /** 1–5 */
  impact: number
  /** 0.2–1.0 */
  confidence: number
  /** 1–5 */
  effort: number
  targetUrl: string | null
  evidence: string
  /** The exact change to make. */
  action: string
  /** Who does it: this engine, a person at Genisys, or the client (needs their input). */
  owner: 'engine' | 'genisys' | 'client'
  /** For site changes a person makes: a ready-to-paste prompt for Lovable's chat. */
  lovablePrompt: string | null
}

export type ContentBrief = {
  slug: string
  title: string
  primaryKeyword: string
  secondaryKeywords: string[]
  intent: 'informational' | 'commercial' | 'transactional' | 'local'
  contentType: 'cost_guide' | 'permit_guide' | 'case_study' | 'comparison' | 'seasonal' | 'how_to_choose' | 'faq' | 'other'
  targetCity: string | null
  serviceSlug: string | null
  angle: string
  outline: string[]
  /** First-party facts from BusinessFacts the post must use. */
  factsToUse: string[]
  sources: { title: string; url: string }[]
  whyNow: string
}

export type SeoPlan = {
  headline: string
  summary: string
  scorecard: string
  quickWins: PlanItem[]
  content: ContentBrief[]
  humanTasks: { title: string; detail: string; category: 'gbp' | 'reviews' | 'citations' | 'links' | 'site' | 'other' }[]
  clientInputs: string[]
}

/**
 * One blog post as committed to `src/content/blog/<slug>.json` in a site
 * repo with the SEO foundation. The foundation's loader maps it onto the
 * template's BlogPost type (imageKey → projectPhotos[imageKey]).
 */
export type SeoPostFile = {
  slug: string
  title: string
  metaTitle: string
  /** Meta description; also the template's `description`. */
  description: string
  eyebrow: string
  readTime: string
  /** YYYY-MM-DD */
  date: string
  updated: string
  author: string
  serviceSlug: string | null
  imageKey: string | null
  imageAlt: string
  primaryKeyword: string
  /** 40–60 word direct answer shown right under the H1. */
  answer: string
  /** Paragraphs are plain text; inline links use [anchor](/path) and render via the foundation. */
  sections: { heading: string; paragraphs: string[] }[]
  faqs: { q: string; a: string }[]
  sources: { title: string; url: string }[]
}

export type GateResult = {
  id: string
  ok: boolean
  /** Blocking gates stop autopilot and are shown to the reviewer. */
  blocking: boolean
  detail: string
}

export type Draft = {
  post: SeoPostFile
  /** The plan brief's slug this draft answers — resume tracking survives a renamed post slug. */
  briefSlug?: string
  gates: GateResult[]
  /** Markdown/HTML-free plain text rendering, for copy-paste into GHL. */
  plainText: string
  /** Simple HTML rendering, for copy-paste into GHL's blog editor. */
  html: string
  costUsd: number
}

/** A file the engine will create or overwrite in the site repo. Never deletes. */
export type ChangeFile = {
  path: string
  content: string
  reason: string
  /** Whether the file exists on the base branch (update) or not (create). */
  existed: boolean
}

export type RunLogEntry = { at: string; stage: RunStage | 'engine'; level: 'info' | 'warn' | 'error'; msg: string }

export type ClaudeUsage = {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  webSearches: number
  webFetches: number
  costUsd: number
}

export type ResearchResult = {
  digest: string
  sources: { url: string; title: string }[]
  toolErrors: string[]
}
