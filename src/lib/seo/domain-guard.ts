import { prisma } from '@/lib/prisma'
import { fetchPage } from './crawl'
import { branchExists, commitToNewBranch, deleteBranch, getBranchHead, getTree, mergePullRequest, openPullRequest, pushEmptyCommit, readBlob, recentCommits } from './github'
import { gscConfigured, gscSubmitSitemap } from './gsc'
import { newIndexNowKey, pingIndexNow } from './indexnow'
import { lovableChannel, lovableProjectInfo, lovableProjectMatchesRepo, publishLovableProject } from './lovable'
import { lovableMcpDeploy } from './lovable-mcp'
import { lovableHasMerge } from './pipeline'
import { detectLovableProjectId } from './repo'
import {
  bareHost,
  CORE_FILES,
  DOMAIN_GUARD_KEY_PREFIX,
  identityProblem,
  planDomainFix,
  readLook,
  repoBusinessNames,
  scanCandidates,
  SITE_DATA,
  type DomainProblem,
  type LiveLook,
  type LookVerdict,
} from './domain-guard-plan'

/**
 * The domain guard: every live client site tells Google its own domain,
 * with nobody opening Lovable and no Claude or Lovable credits spent.
 *
 * Why: a site's code names its domain in one place (SITE_URL in
 * src/lib/seo.ts). Copies of the template arrive with it blank, or set to
 * whatever domain the onboarding answers named, and nothing moved it once
 * the real domain was connected. On 2026-11-20, 27 live sites answered
 * "Public domain pending confirmation" for their sitemap and 7 told Google
 * (canonical links, sitemap) that they live on another domain. Stable
 * Lift's Search Console showed every sitemap URL as "URL not allowed".
 * The weekly SEO run could fix it (domain-sync.ts), but only with Claude
 * credits and a person's review, and the weekly schedule is off.
 *
 * For each active SEO site with a Site link:
 *   1. Look at the live site the way Google does: the homepage's canonical
 *      link and og:url, and /sitemap.xml (./domain-guard-plan.ts).
 *   2. When it names another domain or none, and that domain is our
 *      Lovable build of this client's site (the live page shows the repo's
 *      business name, and the repo names the client), edit the repo:
 *      SITE_URL, every mention of the wrong domain except email addresses,
 *      the robots.txt Sitemap line, and the site's own IndexNow key. One
 *      small pull request, merged at once. These are string edits; a build
 *      that failed anyway would leave the live site as it was, and the
 *      guard would say so after its publishes.
 *   3. Wait for Lovable to pull the merge (one nudge after 15 minutes),
 *      publish through the Hub's Lovable sign-in (free), and look again.
 *   4. Once the live site names its own domain: submit the sitemap to
 *      Search Console and ping IndexNow (Bing and the others).
 * Then it looks again twice a day, so a later Lovable edit that brings a
 * wrong domain back is caught too.
 *
 * It never touches a repo Lovable or a person changed in the last half
 * hour, a Site link that redirects elsewhere or isn't Lovable, or a repo
 * that isn't plainly this client's live site. Those say why in the
 * client's Sites folder ("On Google") and wait for a person. Production
 * only; SEO_DOMAIN_GUARD=off in the environment stops it.
 */

const KEY_PREFIX = DOMAIN_GUARD_KEY_PREFIX
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const EVERY_MS = MINUTE
/** Sites stepped per minute: two looks, or a commit and a publish. */
const PER_RUN = 2
const OK_RECHECK_MS = 12 * HOUR
const PERSON_RECHECK_MS = 6 * HOUR
/** Lovable diverts its own pushes to `lovable-sync` when main moves under an edit. */
const QUIET_MS = 30 * MINUTE
const NUDGE_AFTER_MS = 15 * MINUTE
const SYNC_GIVE_UP_MS = 75 * MINUTE
const PUBLISH_RETRY_MS = 10 * MINUTE
const MAX_PUBLISHES = 4
/** Without the Hub's Lovable sign-in a person publishes: keep looking this long. */
const MANUAL_PUBLISH_WATCH_MS = 24 * HOUR
const LEASE_MS = 5 * MINUTE
const MAX_FAILURES = 6
const READ_PARALLEL = 6
const UA = 'Mozilla/5.0 (compatible; GenisysSEOBot/1.0; +https://leadgenisys.com)'

/** waiting = not on its own domain yet (a lovable.app address): nothing to fix until it is. */
export type DomainGuardStatus = 'ok' | 'fixing' | 'needs_person' | 'waiting'

export type DomainGuardState = {
  status: DomainGuardStatus
  /** What's true now, in plain words (the client's Sites folder shows it). */
  detail: string
  problem?: DomainProblem | null
  /** The domain the live site is served on: what the code gets pointed at. */
  servedOrigin?: string | null
  wrongHosts?: string[]
  /** Where a fix stands: merged (waiting for Lovable to pull it), published (waiting to see it live). */
  step?: 'merged' | 'published' | null
  prUrl?: string | null
  mergeSha?: string | null
  mergedAt?: number | null
  nudged?: boolean
  publishes?: number
  lastPublishAt?: number | null
  /** A person publishes (the Hub can't): wait for them instead of publishing again. */
  manual?: boolean
  /** The repo head the Hub gave up at: it doesn't try again until the repo changes. */
  gaveUpSha?: string | null
  /** Sitemap pages naming the right domain at the last good look. */
  pages?: number | null
  failures?: number
  /** The last look at the live site. */
  checkedAt: string
  /** When it last went from wrong to right (by the Hub or a person). */
  fixedAt?: string | null
  /** What Google was told after the fix (sitemap submit, IndexNow). */
  submitted?: string | null
  nextAt: number
  leaseUntil?: number | null
}

type GuardSite = {
  id: string
  name: string
  liveUrl: string | null
  repoFullName: string | null
  defaultBranch: string | null
  lovableProjectId: string | null
  indexNowKey: string | null
  gscProperty: string | null
  mode: string
  client: { name: string; hlSiteRequest: { projectId: string | null } | null } | null
}

const SITE_SELECT = {
  id: true,
  name: true,
  liveUrl: true,
  repoFullName: true,
  defaultBranch: true,
  lovableProjectId: true,
  indexNowKey: true,
  gscProperty: true,
  mode: true,
  client: { select: { name: true, hlSiteRequest: { select: { projectId: true } } } },
} as const

/** "acme.org" or "https://acme.org/x" → "https://acme.org"; null when it isn't a web address. */
function originOf(url: string | null | undefined): string | null {
  const s = url?.trim()
  if (!s) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
    return /^https?:$/.test(u.protocol) ? u.origin : null
  } catch {
    return null
  }
}

/** Lovable's own addresses: the site isn't on its domain yet. */
const LOVABLE_HOST_RE = /(?:^|\.)(?:lovable\.app|lovableproject\.com)$/i

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const stamp = (now: number) => new Date(now).toISOString()

// ---------------------------------------------------------------------------
// State (one AppSetting per site, so two sites never overwrite each other)
// ---------------------------------------------------------------------------

function parse(value: string | null | undefined): DomainGuardState | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as unknown
    return v && typeof v === 'object' ? (v as DomainGuardState) : null
  } catch {
    return null
  }
}

export async function domainGuardState(siteId: string): Promise<DomainGuardState | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: `${KEY_PREFIX}${siteId}` } }).catch(() => null)
  return parse(row?.value)
}

/** Every site's last state, by SEO site id. */
export async function domainGuardStates(): Promise<Record<string, DomainGuardState>> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: KEY_PREFIX } } }).catch(() => [])
  const out: Record<string, DomainGuardState> = {}
  for (const r of rows) {
    const s = parse(r.value)
    if (s) out[r.key.slice(KEY_PREFIX.length)] = s
  }
  return out
}

async function save(siteId: string, s: DomainGuardState): Promise<void> {
  const key = `${KEY_PREFIX}${siteId}`
  const value = JSON.stringify(s)
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __domainGuardAt?: number; __domainGuardBusy?: Promise<unknown> | null }

/** One site's step, never two at once in this process. */
async function serial<T>(fn: () => Promise<T>): Promise<T> {
  while (g.__domainGuardBusy) await g.__domainGuardBusy.catch(() => {})
  const p = fn()
  g.__domainGuardBusy = p
  try {
    return await p
  } finally {
    if (g.__domainGuardBusy === p) g.__domainGuardBusy = null
  }
}

export const domainGuardOff = () => /^(off|0|false|no)$/i.test(process.env.SEO_DOMAIN_GUARD ?? '')

/** Scheduler hook: every minute, step up to PER_RUN sites that are due. Production only. */
export async function maybeRunDomainGuard(now = Date.now()): Promise<{ stepped: number; fixed: number } | null> {
  if (process.env.NODE_ENV !== 'production' || domainGuardOff()) return null
  if (g.__domainGuardAt && now - g.__domainGuardAt < EVERY_MS) return null
  if (g.__domainGuardBusy) return null
  g.__domainGuardAt = now
  return serial(async () => {
    const sites: GuardSite[] = await prisma.seoSite.findMany({
      where: { archivedAt: null, enabled: true, AND: [{ liveUrl: { not: null } }, { liveUrl: { not: '' } }] },
      select: SITE_SELECT,
      orderBy: { createdAt: 'asc' },
    })
    const states = await domainGuardStates()
    // A fix under way first, then sites never looked at, then the longest waiting.
    const rank = (s: DomainGuardState | undefined) => (s?.status === 'fixing' ? 0 : s ? 2 : 1)
    const due = sites
      .filter((s) => {
        const st = states[s.id]
        if (!st) return true
        if ((st.leaseUntil ?? 0) > now) return false
        // The Site link moved to another domain (a domain was connected): look now.
        const moved = !!st.servedOrigin && !sameSite(st.servedOrigin, originOf(s.liveUrl)) && st.status !== 'fixing'
        return moved || (st.nextAt ?? 0) <= now
      })
      .sort((a, b) => rank(states[a.id]) - rank(states[b.id]) || (states[a.id]?.nextAt ?? 0) - (states[b.id]?.nextAt ?? 0))
      .slice(0, PER_RUN)
    let fixed = 0
    for (const site of due) {
      const before = states[site.id]
      const after = await stepOne(site, before, now)
      if (after.status === 'ok' && before && before.status !== 'ok') fixed++
    }
    return { stepped: due.length, fixed }
  })
}

/** "Check now" from the Hub: one step for this site, whatever its schedule. */
export async function runDomainGuardFor(siteId: string): Promise<DomainGuardState | null> {
  const site: GuardSite | null = await prisma.seoSite.findUnique({ where: { id: siteId }, select: SITE_SELECT })
  if (!site?.liveUrl?.trim()) return null
  return serial(async () => {
    const st = await domainGuardState(siteId)
    if (st?.leaseUntil && st.leaseUntil > Date.now()) return st
    // Outside production a check only looks: commits and publishes are the deployed Hub's job.
    return stepOne(site, st ?? undefined, Date.now(), { lookOnly: process.env.NODE_ENV !== 'production' || domainGuardOff(), force: true })
  })
}

type StepOpts = { lookOnly?: boolean; force?: boolean }

/** One step, its result saved. Never throws. */
async function stepOne(site: GuardSite, st: DomainGuardState | undefined, now: number, opts: StepOpts = {}): Promise<DomainGuardState> {
  // Held while it works, so a second process (a rolling deploy) leaves this site alone.
  const held: DomainGuardState = st ?? { status: 'fixing', detail: 'Checking the site.', checkedAt: stamp(now), nextAt: now }
  await save(site.id, { ...held, leaseUntil: now + LEASE_MS }).catch(() => {})
  let next: DomainGuardState
  try {
    next = await step(site, st, now, opts)
    next = { ...next, failures: 0 }
  } catch (err) {
    const failures = (st?.failures ?? 0) + 1
    const stuck = failures >= MAX_FAILURES
    console.warn(`[domain-guard] ${site.name}: ${message(err)}`)
    next = {
      ...(st ?? { checkedAt: stamp(now) }),
      status: stuck ? 'needs_person' : (st?.status ?? 'fixing'),
      detail: stuck ? `Stopped after ${failures} failed tries: ${message(err)}` : (st?.detail ?? 'Checking the site.'),
      failures,
      nextAt: now + (stuck ? PERSON_RECHECK_MS : Math.min(60, 2 ** failures) * MINUTE),
    }
  }
  next = { ...next, leaseUntil: null }
  await save(site.id, next).catch((err) => console.warn(`[domain-guard] ${site.name}: couldn’t save: ${message(err)}`))
  return next
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

async function step(site: GuardSite, st: DomainGuardState | undefined, now: number, opts: StepOpts): Promise<DomainGuardState> {
  const base = { ...(st ?? {}), checkedAt: stamp(now) }
  const origin = originOf(site.liveUrl)
  if (!origin) return { ...base, status: 'needs_person', detail: 'The Site link in the Hub isn’t a web address. Fix it at the top of this folder.', step: null, nextAt: now + PERSON_RECHECK_MS }
  if (LOVABLE_HOST_RE.test(new URL(origin).hostname)) {
    return {
      ...base,
      status: 'waiting',
      detail: `Not on its own domain yet (${new URL(origin).host}). Once a domain is connected, the Hub points the site’s code at it.`,
      problem: null,
      step: null,
      servedOrigin: origin,
      nextAt: now + HOUR,
    }
  }
  if (!opts.lookOnly && st?.status === 'fixing' && st.step === 'merged') return afterMerge(site, st, now)
  const look = await lookAt(origin)
  const verdict = readLook(look)

  if (verdict.kind === 'ok') return wentRight(site, base, verdict, now, opts)
  if (verdict.kind === 'person') {
    // servedOrigin = the address looked at, so a new Site link is looked at straight away.
    return { ...base, status: 'needs_person', detail: verdict.summary, problem: null, step: null, servedOrigin: origin, nextAt: now + PERSON_RECHECK_MS }
  }

  // Published but not live yet: publish again after a while, then hand it to a person.
  if (!opts.lookOnly && st?.status === 'fixing' && st.step === 'published') return notLiveYet(site, { ...st, checkedAt: base.checkedAt, problem: verdict.problem }, verdict, now)

  const told = { ...base, problem: verdict.problem, servedOrigin: verdict.servedOrigin, wrongHosts: verdict.wrongHosts }
  if (opts.lookOnly) {
    return { ...told, status: st?.status === 'needs_person' ? 'needs_person' : 'fixing', detail: `${verdict.summary} The Hub fixes it on its next pass.`, nextAt: now }
  }
  if (site.mode === 'audit') {
    return { ...told, status: 'needs_person', detail: `${verdict.summary} This site is in Audit mode in SEO, so the Hub doesn’t change its code.`, step: null, nextAt: now + PERSON_RECHECK_MS }
  }
  return startFix(site, told, verdict, look, now, !!opts.force)
}

async function wentRight(
  site: GuardSite,
  base: Partial<DomainGuardState> & { checkedAt: string },
  verdict: Extract<LookVerdict, { kind: 'ok' }>,
  now: number,
  opts: StepOpts,
): Promise<DomainGuardState> {
  const wasWrong = base.status === 'fixing' || base.status === 'needs_person'
  let submitted = base.submitted ?? null
  // Fixed since the last look (by the Hub or a person): tell Google straight away.
  if (wasWrong && !opts.lookOnly) submitted = await tellSearchEngines(site, verdict.servedOrigin)
  return {
    ...base,
    status: 'ok',
    detail: verdict.summary,
    problem: null,
    servedOrigin: verdict.servedOrigin,
    wrongHosts: [],
    step: null,
    pages: verdict.pages,
    fixedAt: wasWrong ? stamp(now) : (base.fixedAt ?? null),
    submitted,
    nextAt: now + OK_RECHECK_MS,
  }
}

async function startFix(
  site: GuardSite,
  base: Partial<DomainGuardState> & { checkedAt: string },
  verdict: Extract<LookVerdict, { kind: 'fix' }>,
  look: LiveLook,
  now: number,
  force = false,
): Promise<DomainGuardState> {
  const person = (detail: string, recheckMs = PERSON_RECHECK_MS): DomainGuardState => ({ ...base, status: 'needs_person', detail, step: null, nextAt: now + recheckMs })
  const repo = site.repoFullName
  if (!repo) return person(`${verdict.summary} No GitHub repo is linked to this client, so the Hub can’t fix it: pick the Repo at the top of this folder.`)
  const branch = site.defaultBranch || 'main'

  // Someone (or Forge) working in Lovable: wait for a quiet half hour.
  const [last] = await recentCommits(repo, branch, 1)
  if (last?.byLovable && now - Date.parse(last.date) < QUIET_MS) {
    return { ...base, status: 'fixing', detail: `${verdict.summary} Waiting for a quiet half hour in Lovable before changing the code.`, step: null, nextAt: now + 10 * MINUTE }
  }

  const head = await getBranchHead(repo, branch)
  // Gave up on this exact code before (published and still wrong, or not this client's repo): wait for a
  // change, unless a person pressed Check now.
  if (!force && base.status === 'needs_person' && base.gaveUpSha && base.gaveUpSha === head.sha) {
    return person(base.detail ?? verdict.summary)
  }
  const tree = await getTree(repo, head.treeSha)
  const paths = tree.entries.filter((e) => e.type === 'blob').map((e) => e.path)
  const blobs = new Map(tree.entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]))
  const core = await readAll(repo, CORE_FILES.filter((p) => blobs.has(p)).map((path) => ({ path, sha: blobs.get(path)! })))

  // Is this repo the build on that domain, and this client's? Asked before reading the rest.
  const siteData = core.find((f) => f.path === SITE_DATA)?.content ?? null
  const who = identityProblem({
    repo,
    repoNames: repoBusinessNames(siteData),
    live: { title: look.title, siteName: look.siteName },
    hubNames: [site.name, site.client?.name ?? ''].filter(Boolean),
    origin: verdict.servedOrigin,
  })
  if (who) return { ...person(`${verdict.summary} ${who}`), gaveUpSha: head.sha }

  // Moving off another domain: every text file that could name it.
  const rest = verdict.wrongHosts.length ? scanCandidates(tree.entries).filter((p) => !CORE_FILES.includes(p)) : []
  const files = [...core, ...(await readAll(repo, rest.map((path) => ({ path, sha: blobs.get(path)! }))))]

  const key = site.indexNowKey ?? (await claimIndexNowKey(site.id))
  const plan = planDomainFix({ files, repoPaths: paths, servedOrigin: verdict.servedOrigin, wrongHosts: verdict.wrongHosts, indexNowKey: key })
  if (plan.unresolved) return { ...person(`${verdict.summary} ${plan.unresolved}`), gaveUpSha: head.sha }

  const host = new URL(verdict.servedOrigin).host
  const publishOnly = (): Promise<DomainGuardState> =>
    // The code already names this domain: the live site is an older publish.
    afterMerge(
      site,
      { ...base, status: 'fixing', detail: `The code already names ${host}; publishing it.`, step: 'merged', mergeSha: head.sha, mergedAt: now - NUDGE_AFTER_MS, nudged: true, publishes: 0, manual: false, prUrl: null, nextAt: now },
      now,
    )
  if (!plan.changes.length) return publishOnly()

  // Not under seo/**: that would start the repo's build check, which nothing here waits for.
  const ghBranch = `genisys/domain-${site.id.slice(-6)}`
  if (await branchExists(repo, ghBranch)) await deleteBranch(repo, ghBranch)
  const title = `Point the site at ${host}`
  const commit = await commitToNewBranch({
    fullName: repo,
    baseBranch: branch,
    baseSha: head.sha,
    branch: ghBranch,
    files: plan.changes.map((c) => ({ path: c.path, content: c.content })),
    message: `${title}\n\n${plan.notes.join('\n')}\n\nCanonical links, og:url, the sitemap and structured data now name the domain this site is published on. Made by the Genisys Hub's domain guard.`,
  })
  if (commit.unchanged) return publishOnly()
  const pr = await openPullRequest({
    fullName: repo,
    head: ghBranch,
    base: branch,
    title,
    body: [
      `## ${title}`,
      '',
      verdict.summary,
      '',
      ...plan.notes.map((n) => `- ${n}`),
      '',
      '### Files',
      ...plan.changes.map((c) => `- \`${c.path}\` — ${c.existed ? 'updated' : 'new'}: ${c.reason}`),
      '',
      '_Opened and merged by the Genisys Hub’s domain guard (no Claude, no Lovable credits). The Hub publishes it in Lovable and checks the live site._',
    ].join('\n'),
  })
  const merged = await mergePullRequest(repo, pr.number, commit.commitSha, `${title} (#${pr.number})`)
  await deleteBranch(repo, ghBranch).catch(() => {})
  console.log(`[domain-guard] ${site.name}: merged ${pr.url} (${plan.changes.length} file(s)) — ${verdict.problem}`)
  return {
    ...base,
    status: 'fixing',
    detail: `${verdict.summary} Fixed in the code (${plan.changes.length} file${plan.changes.length === 1 ? '' : 's'}); waiting for Lovable to pick it up, then publishing.`,
    step: 'merged',
    prUrl: pr.url,
    mergeSha: merged.sha,
    mergedAt: now,
    nudged: false,
    publishes: 0,
    lastPublishAt: null,
    manual: false,
    gaveUpSha: null,
    nextAt: now + 3 * MINUTE,
  }
}

/** Merged: once Lovable has the merge, publish it. */
async function afterMerge(site: GuardSite, st: DomainGuardState, now: number): Promise<DomainGuardState> {
  const repo = site.repoFullName!
  const branch = site.defaultBranch || 'main'
  const channel = await lovableChannel()
  const projectId = channel ? await projectFor(site, repo, branch) : null
  if (!channel || !projectId) {
    // A person publishes; the Hub keeps looking and finishes on its own once it's live.
    const why = !channel ? 'The Hub isn’t signed in to Lovable (SEO → Setup → Connect Lovable)' : 'The Hub can’t tell which Lovable project this site is'
    return {
      ...st,
      status: 'fixing',
      detail: `Fixed in the code. ${why}, so click Publish in Lovable to put it live. The Hub notices on its own.`,
      step: 'published',
      manual: true,
      lastPublishAt: st.lastPublishAt ?? now,
      nextAt: now + 10 * MINUTE,
    }
  }

  const info = await lovableProjectInfo(projectId)
  const synced = await lovableHasMerge(repo, st.mergeSha!, info?.latestCommitSha ?? null)
  if (!synced) {
    const waited = now - (st.mergedAt ?? now)
    if (waited > SYNC_GIVE_UP_MS) {
      // Opening the project makes Lovable pull, and a later look publishes it (the code then already matches).
      return {
        ...st,
        status: 'needs_person',
        detail: 'Fixed in the code, but Lovable hasn’t picked the change up from GitHub after an hour. Open the project in Lovable once (that makes it sync), then Publish.',
        step: null,
        nextAt: now + 30 * MINUTE,
      }
    }
    let nudged = st.nudged ?? false
    if (!nudged && waited >= NUDGE_AFTER_MS) {
      // GitHub tells Lovable about every push; an empty commit is a second chance.
      await pushEmptyCommit(repo, branch, 'Sync to Lovable').catch((err) => console.warn(`[domain-guard] ${site.name}: nudge failed: ${message(err)}`))
      nudged = true
    }
    return { ...st, status: 'fixing', detail: 'Fixed in the code; waiting for Lovable to pick it up from GitHub, then publishing.', nudged, nextAt: now + 3 * MINUTE }
  }
  return publish(site, st, projectId, channel, now)
}

async function publish(site: GuardSite, st: DomainGuardState, projectId: string, channel: 'api' | 'mcp', now: number): Promise<DomainGuardState> {
  if (channel === 'mcp') await lovableMcpDeploy(projectId)
  else await publishLovableProject(projectId)
  const publishes = (st.publishes ?? 0) + 1
  console.log(`[domain-guard] ${site.name}: published in Lovable (${publishes} of ${MAX_PUBLISHES})`)
  return {
    ...st,
    status: 'fixing',
    detail: 'Fixed in the code and published in Lovable; checking the live site.',
    step: 'published',
    manual: false,
    publishes,
    lastPublishAt: now,
    nextAt: now + 4 * MINUTE,
  }
}

/** Published (or waiting for a person to publish), but the live site still says the old thing. */
async function notLiveYet(site: GuardSite, st: DomainGuardState, verdict: Extract<LookVerdict, { kind: 'fix' }>, now: number): Promise<DomainGuardState> {
  const headSha = async () => (await getBranchHead(site.repoFullName!, site.defaultBranch || 'main').catch(() => null))?.sha ?? null
  if (st.manual) {
    // Their Publish click is the next step; keep looking for a day, then less often.
    const waited = now - (st.mergedAt ?? st.lastPublishAt ?? now)
    if (waited < MANUAL_PUBLISH_WATCH_MS) return { ...st, status: 'fixing', nextAt: now + 10 * MINUTE }
    return { ...st, status: 'needs_person', step: null, gaveUpSha: await headSha(), nextAt: now + PERSON_RECHECK_MS }
  }
  const since = now - (st.lastPublishAt ?? 0)
  if (since < PUBLISH_RETRY_MS) return { ...st, status: 'fixing', detail: 'Published in Lovable; waiting for the live site to show it.', nextAt: now + 3 * MINUTE }
  const publishes = st.publishes ?? 0
  if (publishes >= MAX_PUBLISHES) {
    return {
      ...st,
      status: 'needs_person',
      detail: `${verdict.summary} The fix is in the code${st.prUrl ? ` (${st.prUrl})` : ''}, but after ${publishes} publishes the live site still shows the old version. Open the project in Lovable: if it shows a build error, ask Lovable to fix it, then Publish.`,
      step: null,
      gaveUpSha: await headSha(),
      nextAt: now + PERSON_RECHECK_MS,
    }
  }
  const channel = await lovableChannel()
  const projectId = channel ? await projectFor(site, site.repoFullName!, site.defaultBranch || 'main') : null
  if (!channel || !projectId) return { ...st, status: 'fixing', manual: true, nextAt: now + 10 * MINUTE }
  return publish(site, st, projectId, channel, now)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The live site as Google sees it: the homepage's tags and the sitemap. */
async function lookAt(siteUrl: string): Promise<LiveLook> {
  const origin = new URL(siteUrl).origin
  const home = await fetchPage(`${origin}/`, { timeoutMs: 20_000 })
  let served = origin
  try {
    served = new URL(home.url || origin).origin
  } catch {
    served = origin
  }
  return {
    siteUrl: origin,
    status: home.status,
    error: home.error,
    finalUrl: home.url || null,
    hosting: home.hosting,
    canonical: home.canonical,
    ogUrl: home.social?.['og:url'] ?? null,
    title: home.title,
    siteName: home.social?.['og:site_name'] ?? null,
    // A fresh copy, never one a cache kept from before the last publish.
    sitemap: await getText(`${served}/sitemap.xml?fresh=${Date.now().toString(36)}`),
  }
}

async function getText(url: string): Promise<{ status: number; body: string | null }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    return { status: res.status, body: (await res.text()).slice(0, 2_000_000) }
  } catch {
    return { status: 0, body: null }
  }
}

async function readAll(repo: string, items: { path: string; sha: string }[]): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(READ_PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const it = items[next++]
        out.push({ path: it.path, content: await readBlob(repo, it.sha) })
      }
    }),
  )
  return out
}

/** This site's own IndexNow key; a key another process saved first wins. */
async function claimIndexNowKey(siteId: string): Promise<string> {
  const fresh = newIndexNowKey()
  await prisma.seoSite.updateMany({ where: { id: siteId, indexNowKey: null }, data: { indexNowKey: fresh } })
  const row = await prisma.seoSite.findUnique({ where: { id: siteId }, select: { indexNowKey: true } })
  return row?.indexNowKey ?? fresh
}

/**
 * The site's Lovable project: set on the site, else Forge's copy, else the
 * id in the repo's image metadata, each checked against Lovable (a remixed
 * repo carries the template's id). Throws when Lovable can't be asked, so
 * the step is tried again rather than handed to a person.
 */
async function projectFor(site: GuardSite, repo: string, branch: string): Promise<string | null> {
  if (site.lovableProjectId) return site.lovableProjectId
  let unsure = false
  const tryId = async (id: string | null): Promise<string | null> => {
    if (!id) return null
    const verdict = await lovableProjectMatchesRepo(id, repo, branch)
    if (verdict === 'unknown') unsure = true
    return verdict === 'yes' ? id : null
  }
  const found = (await tryId(site.client?.hlSiteRequest?.projectId ?? null)) ?? (await tryId(await detectLovableProjectId(repo).catch(() => null)))
  if (found) {
    await prisma.seoSite.update({ where: { id: site.id }, data: { lovableProjectId: found } })
    site.lovableProjectId = found
    return found
  }
  if (unsure) throw new Error('Couldn’t reach Lovable to confirm which project this site is.')
  return null
}

/** Re-submit the sitemap to Search Console and ping IndexNow. Never throws; says what happened. */
async function tellSearchEngines(site: GuardSite, origin: string): Promise<string> {
  const said: string[] = []
  const sitemap = `${origin}/sitemap.xml`
  if (site.gscProperty) {
    try {
      if ((await gscConfigured()).ok) {
        await gscSubmitSitemap(site.gscProperty, sitemap)
        said.push('Sitemap re-submitted to Google Search Console')
      }
    } catch (err) {
      said.push(`Search Console didn’t take the sitemap (${message(err)})`)
    }
  } else {
    said.push('Not in Search Console yet (the Hub adds it on its own)')
  }
  const key = (await prisma.seoSite.findUnique({ where: { id: site.id }, select: { indexNowKey: true } }).catch(() => null))?.indexNowKey
  if (key) {
    const file = await getText(`${origin}/${key}.txt`)
    if (file.status === 200 && file.body?.trim() === key) {
      const r = await pingIndexNow({ host: new URL(origin).host, key, urls: [`${origin}/`, sitemap] })
      said.push(r.ok ? 'IndexNow pinged (Bing and others)' : `IndexNow: ${r.detail}`)
    }
  }
  return said.join('. ')
}

/** For the Sites folder: the hosts compared case-insensitively, www aside. */
export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  try {
    return !!a && !!b && bareHost(new URL(a).hostname) === bareHost(new URL(b).hostname)
  } catch {
    return false
  }
}
