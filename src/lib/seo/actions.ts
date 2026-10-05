import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import type { CreateSiteBody, RunActionBody, UpdateSiteBody } from './api-types'
import { ClaudeSession } from './claude'
import { fetchPage } from './crawl'
import { enqueueManualRun } from './engine'
import { deleteBranch, getPullRequest, getRepo } from './github'
import { lovableChannel, lovableProjectMatchesRepo, publishLovableProject } from './lovable'
import { lovableMcpDeploy } from './lovable-mcp'
import { ciState, cleanupStoppedRun, deriveFacts, type Snapshot } from './pipeline'
import { FactsSchema } from './prompts'
import { detectLovableProjectId, snapshotRepo } from './repo'
import { getSeoSettings } from './settings'
import type { RunLogEntry, RunStatus, SeoMode } from './types'

/**
 * Writes behind /api/seo/*. Every function validates its own input and
 * throws `SeoInputError` with a message fit to show the person using the
 * page; anything else is a real failure.
 */

export class SeoInputError extends Error {}

const MODES: SeoMode[] = ['audit', 'review', 'autopilot']
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

function normalizeUrl(v: string | null | undefined): string | null {
  const s = v?.trim()
  if (!s) return null
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname.includes('.')) throw new Error()
    u.hash = ''
    return u.toString().replace(/\/$/, '')
  } catch {
    throw new SeoInputError(`"${s}" isn't a valid website address.`)
  }
}

function normalizeRepo(v: string | null | undefined): string | null {
  const s = v?.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '')
  if (!s) return null
  if (!REPO_RE.test(s)) throw new SeoInputError(`"${v}" isn't a GitHub repo — use owner/name, e.g. nxrth007/web-lead-pro.`)
  if (s.toLowerCase() === 'nxrth007/genisys-hub') throw new SeoInputError('That is the Hub itself, not a client site.')
  return s
}

function normalizeMode(v: unknown): SeoMode {
  if (typeof v === 'string' && (MODES as string[]).includes(v)) return v as SeoMode
  throw new SeoInputError('Mode must be audit, review or autopilot.')
}

export async function createSite(body: CreateSiteBody): Promise<string> {
  const name = body.name?.trim()
  if (!name) throw new SeoInputError('Give the site a name.')
  const liveUrl = normalizeUrl(body.liveUrl)
  const repoFullName = normalizeRepo(body.repoFullName)
  if (!liveUrl && !repoFullName) throw new SeoInputError('Add the live URL, the GitHub repo, or both.')
  const mode = normalizeMode(body.mode ?? (repoFullName ? 'review' : 'audit'))
  if (mode !== 'audit' && !repoFullName) throw new SeoInputError('Review and autopilot need a GitHub repo; use audit mode for sites without one.')

  let archivedSiteId: string | null = null
  if (body.clientId) {
    const client = await prisma.client.findUnique({ where: { id: body.clientId }, select: { id: true, seoSite: { select: { id: true, archivedAt: true } } } })
    if (!client) throw new SeoInputError('That client no longer exists.')
    if (client.seoSite && !client.seoSite.archivedAt) throw new SeoInputError('That client already has an SEO site.')
    // Re-adding an archived client brings its site (and history) back.
    archivedSiteId = client.seoSite?.id ?? null
  }

  let defaultBranch: string | null = null
  if (repoFullName) {
    try {
      defaultBranch = (await getRepo(repoFullName)).defaultBranch
    } catch (err) {
      throw new SeoInputError(`Couldn't open ${repoFullName} on GitHub: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  if (archivedSiteId) {
    await prisma.seoSite.update({
      where: { id: archivedSiteId },
      data: { name, liveUrl, repoFullName, defaultBranch, mode, enabled: true, archivedAt: null, foundationStatus: 'none', foundationPrUrl: null },
    })
    return archivedSiteId
  }
  const site = await prisma.seoSite.create({
    data: { clientId: body.clientId || null, name, liveUrl, repoFullName, defaultBranch, mode },
    select: { id: true },
  })
  return site.id
}

export async function updateSite(id: string, body: UpdateSiteBody): Promise<void> {
  const site = await prisma.seoSite.findUnique({ where: { id }, select: { id: true, repoFullName: true, mode: true } })
  if (!site) throw new SeoInputError('Site not found.')
  const data: Prisma.SeoSiteUpdateInput = {}

  if (body.name !== undefined) {
    const n = body.name.trim()
    if (!n) throw new SeoInputError('The name can’t be empty.')
    data.name = n
  }
  if (body.liveUrl !== undefined) data.liveUrl = normalizeUrl(body.liveUrl)
  let repo = site.repoFullName
  if (body.repoFullName !== undefined) {
    repo = normalizeRepo(body.repoFullName)
    data.repoFullName = repo
    if (repo) {
      try {
        data.defaultBranch = (await getRepo(repo)).defaultBranch
      } catch (err) {
        throw new SeoInputError(`Couldn't open ${repo} on GitHub: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    } else {
      data.defaultBranch = null
    }
    // A different repo means a different foundation state; the next run re-detects it.
    data.foundationStatus = 'none'
    data.foundationPrUrl = null
  }
  const mode = body.mode !== undefined ? normalizeMode(body.mode) : (site.mode as SeoMode)
  if (mode !== 'audit' && !repo) throw new SeoInputError('Review and autopilot need a GitHub repo.')
  if (body.mode !== undefined) data.mode = mode
  if (body.enabled !== undefined) data.enabled = !!body.enabled
  if (body.facts !== undefined) {
    const parsed = FactsSchema.safeParse(body.facts)
    if (!parsed.success) {
      const i = parsed.error.issues[0]
      throw new SeoInputError(`Business facts: ${i.path.join('.') || 'value'} — ${i.message}`)
    }
    data.facts = parsed.data as unknown as Prisma.InputJsonValue
  }
  if (body.gscProperty !== undefined) {
    const g = body.gscProperty?.trim() || null
    if (g && !/^(sc-domain:[a-z0-9.-]+|https?:\/\/.+\/)$/i.test(g)) {
      throw new SeoInputError('Search Console property is "sc-domain:example.com" or a URL prefix ending in "/", e.g. "https://www.example.com/".')
    }
    data.gscProperty = g
  }
  if (body.lovableProjectId !== undefined) data.lovableProjectId = body.lovableProjectId?.trim() || null

  await prisma.seoSite.update({ where: { id }, data })
}

/**
 * Point a client at the GitHub repo its site lives in (or clear it).
 *
 * The client's SEO site is created on demand and brought back if it was
 * archived. Linking a repo moves an Audit-mode site to Review — the engine
 * may now open pull requests, and a person approves each one. Clearing the
 * repo drops it back to Audit.
 */
export async function assignClientRepo(clientId: string, repoFullName: string | null): Promise<{ siteId: string; repoFullName: string | null; mode: SeoMode }> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, siteUrl: true, archivedAt: true, seoSite: { select: { id: true, mode: true, archivedAt: true, repoFullName: true } } },
  })
  if (!client) throw new SeoInputError('That client no longer exists.')
  if (client.archivedAt) throw new SeoInputError('Unarchive the client first.')

  const repo = normalizeRepo(repoFullName)
  if (repo) {
    const taken = await prisma.seoSite.findFirst({
      where: { repoFullName: { equals: repo, mode: 'insensitive' }, archivedAt: null, NOT: { clientId } },
      select: { name: true },
    })
    if (taken) throw new SeoInputError(`${repo} is already linked to ${taken.name}.`)
  }

  let siteId = client.seoSite?.id ?? null
  if (!siteId) {
    siteId = (await prisma.seoSite.create({ data: { clientId, name: client.name, liveUrl: client.siteUrl, mode: 'audit', enabled: true }, select: { id: true } })).id
  } else if (client.seoSite?.archivedAt) {
    await prisma.seoSite.update({ where: { id: siteId }, data: { archivedAt: null, enabled: true } })
  }

  const current = (client.seoSite?.mode as SeoMode | undefined) ?? 'audit'
  const mode: SeoMode = repo ? (current === 'audit' ? 'review' : current) : 'audit'
  if (repo !== (client.seoSite?.repoFullName ?? null) || mode !== current) {
    await updateSite(siteId, { repoFullName: repo, mode })
  }
  return { siteId, repoFullName: repo, mode }
}

export async function archiveSite(id: string): Promise<void> {
  const site = await prisma.seoSite.findUnique({ where: { id }, select: { id: true, repoFullName: true } })
  if (!site) throw new SeoInputError('Site not found.')
  await prisma.seoSite.update({ where: { id }, data: { archivedAt: new Date(), enabled: false } })
  // Stop everything in flight: a worker mid-stage fails its next fenced
  // write, and open PRs are closed so nothing merges into an archived site.
  const stoppable = ['queued', 'running', 'awaiting_ci', 'awaiting_review', 'awaiting_publish', 'failed']
  const active = await prisma.seoRun.findMany({ where: { siteId: id, status: { in: stoppable } }, select: { id: true } })
  for (const r of active) {
    const res = await prisma.seoRun.updateMany({
      where: { id: r.id, status: { in: stoppable } },
      data: { status: 'canceled', finishedAt: new Date(), leaseUntil: null, error: 'Site archived.' },
    })
    if (!res.count) continue
    const fresh = await prisma.seoRun.findUniqueOrThrow({ where: { id: r.id } })
    await cleanupStoppedRun(fresh, site, 'Site archived').catch((err) => console.error('[seo] archive clean-up failed:', err))
  }
}

export async function startRun(siteId: string, kind: 'weekly' | 'foundation'): Promise<string> {
  const site = await prisma.seoSite.findUnique({ where: { id: siteId }, select: { archivedAt: true, repoFullName: true, liveUrl: true, foundationStatus: true } })
  if (!site || site.archivedAt) throw new SeoInputError('Site not found.')
  if (kind === 'foundation') {
    if (!site.repoFullName) throw new SeoInputError('Link the site’s GitHub repo first.')
    if (!site.liveUrl) throw new SeoInputError('Set the live URL (the real domain) first — the sitemap and canonicals are built from it.')
    if (site.foundationStatus === 'installed') throw new SeoInputError('The SEO foundation is already installed.')
  }
  try {
    return await enqueueManualRun(siteId, kind)
  } catch (err) {
    throw new SeoInputError(err instanceof Error ? err.message : 'Couldn’t start the run.')
  }
}

/** Re-derive business facts now (≈30–60 s). Overwrites the stored facts. */
export async function reseedFacts(siteId: string): Promise<void> {
  const site = await prisma.seoSite.findUnique({ where: { id: siteId }, include: { client: { select: { id: true, name: true } } } })
  if (!site) throw new SeoInputError('Site not found.')
  const settings = await getSeoSettings()
  const [repo, home] = await Promise.all([
    site.repoFullName ? snapshotRepo(site.repoFullName).catch(() => null) : Promise.resolve(null),
    site.liveUrl ? fetchPage(site.liveUrl).catch(() => null) : Promise.resolve(null),
  ])
  const session = await ClaudeSession.open({ model: settings.model, budgetUsd: 2 })
  const facts = await deriveFacts({ site, session, repo, homepageText: home?.textSample ?? null })
  await prisma.seoSite.update({ where: { id: siteId }, data: { facts: facts as unknown as Prisma.InputJsonValue } })
}

const ACTIVE: RunStatus[] = ['queued', 'running', 'awaiting_ci', 'awaiting_review', 'awaiting_publish']

export async function runAction(runId: string, body: RunActionBody, email: string): Promise<void> {
  const run = await prisma.seoRun.findUnique({ where: { id: runId } })
  if (!run) throw new SeoInputError('Run not found.')
  const site = await prisma.seoSite.findUnique({ where: { id: run.siteId }, select: { id: true, repoFullName: true, archivedAt: true } })
  if (!site) throw new SeoInputError('Site not found.')

  switch (body.action) {
    case 'approve': {
      if (run.status !== 'awaiting_review') throw new SeoInputError('Only a run waiting for review can be approved.')
      if (site.archivedAt) throw new SeoInputError('This site is archived.')
      // Approval is for the PR exactly as it stands now: record that head, so
      // anything pushed afterwards needs another look before it can merge.
      const snap = run.snapshot as unknown as Snapshot | null
      const fullName = run.repoFullName ?? snap?.repo?.fullName ?? site.repoFullName
      if (!fullName || !run.prNumber) throw new SeoInputError('This run has no pull request to approve.')
      let pr: Awaited<ReturnType<typeof getPullRequest>>
      try {
        pr = await getPullRequest(fullName, run.prNumber)
      } catch (err) {
        throw new SeoInputError(`Couldn\u2019t check the pull request on GitHub: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
      if (!pr.merged) {
        if (pr.state === 'closed') throw new SeoInputError('The pull request was closed on GitHub. Reject this run and start a new one.')
        // The last check may have failed, but someone may have pushed a fix or
        // re-run it since — judge the current head.
        const ci = await ciState(fullName, pr.headSha)
        if (ci.state === 'failure') {
          throw new SeoInputError('The build check fails on this branch, so merging would break the site. Fix the PR or reject it.')
        }
      }
      const res = await prisma.seoRun.updateMany({
        where: { id: runId, status: 'awaiting_review' },
        data: {
          status: 'queued',
          stage: 'ship',
          reviewedBy: email,
          leaseUntil: null,
          error: null,
          ciStatus: null,
          snapshot: { ...(snap ?? {}), approvedSha: pr.headSha } as unknown as Prisma.InputJsonValue,
        },
      })
      if (!res.count) throw new SeoInputError('Someone else just acted on this run — refresh.')
      return
    }
    case 'reject':
    case 'cancel': {
      // Failed runs can be dismissed too, so they stop asking for attention.
      const allowed: RunStatus[] = body.action === 'reject' ? ['awaiting_review', 'awaiting_ci'] : [...ACTIVE, 'failed']
      const reason = body.action === 'reject' ? body.reason?.trim() || null : null
      // Win the status change first: a worker mid-stage fails its next fenced
      // write and stops, so it can't open or merge a PR after this point.
      const res = await prisma.seoRun.updateMany({
        where: { id: runId, status: { in: allowed } },
        data: {
          status: 'canceled',
          finishedAt: new Date(),
          leaseUntil: null,
          reviewedBy: email,
          error: body.action === 'reject' ? (reason ? `Rejected: ${reason}` : 'Rejected in review.') : run.status === 'failed' ? run.error : 'Canceled.',
        },
      })
      if (!res.count) {
        throw new SeoInputError(body.action === 'reject' ? 'Only a run waiting for review can be rejected.' : 'This run has already finished.')
      }
      const fresh = await prisma.seoRun.findUniqueOrThrow({ where: { id: runId } })
      const { merged } = await cleanupStoppedRun(fresh, site, body.action === 'reject' ? reason ?? 'Rejected' : 'Canceled')
      if (merged) {
        await prisma.seoRun.update({
          where: { id: runId },
          data: { error: 'Stopped, but the pull request had already been merged — its changes are on the site’s main branch.' },
        })
      }
      return
    }
    case 'mark_published': {
      const res = await prisma.seoRun.updateMany({
        where: { id: runId, status: 'awaiting_publish' },
        data: { status: 'queued', stage: 'verify', reviewedBy: email, leaseUntil: null, error: null },
      })
      if (!res.count) throw new SeoInputError('This run isn’t waiting to be published.')
      return
    }
    case 'publish_now': {
      if (run.status !== 'awaiting_publish') throw new SeoInputError('This run isn’t waiting to be published.')
      await publishSiteNow(run.siteId, email)
      return
    }
    case 'retry': {
      if (run.status !== 'failed') throw new SeoInputError('Only a failed run can be retried.')
      // A foundation that never reached a PR is regenerated from scratch:
      // its whole-file rewrites were based on a repo that has since moved on.
      const restart = run.kind === 'foundation' && !run.prNumber
      if (restart && run.branch) {
        // The regenerated commit reuses this run's branch name; the stale one must go.
        const fullName = run.repoFullName ?? (run.snapshot as unknown as Snapshot | null)?.repo?.fullName ?? site.repoFullName
        if (fullName) await deleteBranch(fullName, run.branch).catch(() => {})
      }
      const res = await prisma.seoRun.updateMany({
        where: { id: runId, status: 'failed' },
        data: {
          status: 'queued',
          attempts: 0,
          error: null,
          finishedAt: null,
          leaseUntil: null,
          ...(restart ? { stage: 'collect', changes: Prisma.DbNull, branch: null, commitSha: null } : {}),
        },
      })
      if (!res.count) throw new SeoInputError('Someone else just acted on this run — refresh.')
      return
    }
    default:
      throw new SeoInputError('Unknown action.')
  }
}

/**
 * Publish a site in Lovable right now through the Hub's connection — for a
 * fix that landed outside a run, or a run the Hub handed back. Any run of
 * the site waiting to be published starts its publish checks over.
 */
export async function publishSiteNow(siteId: string, email: string): Promise<{ url: string | null }> {
  const site = await prisma.seoSite.findUnique({ where: { id: siteId } })
  if (!site) throw new SeoInputError('Site not found.')
  const channel = await lovableChannel()
  if (!channel) throw new SeoInputError('Connect Lovable first: SEO → Setup → Connect Lovable.')

  let projectId = site.lovableProjectId
  if (!projectId) {
    const detected = site.repoFullName ? await detectLovableProjectId(site.repoFullName).catch(() => null) : null
    const verdict = detected && site.repoFullName ? await lovableProjectMatchesRepo(detected, site.repoFullName, site.defaultBranch || 'main') : 'no'
    if (!detected || verdict !== 'yes') {
      throw new SeoInputError('The Hub can’t confirm which Lovable project this site is. Paste the project’s link in the site’s Settings, then try again.')
    }
    projectId = detected
    await prisma.seoSite.update({ where: { id: siteId }, data: { lovableProjectId: projectId } })
  }

  let url: string | null = null
  let deploymentId: string | null = null
  try {
    if (channel === 'mcp') url = (await lovableMcpDeploy(projectId)).url
    else deploymentId = (await publishLovableProject(projectId)).deploymentId
  } catch (err) {
    throw new SeoInputError(`Lovable didn’t publish: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  const now = new Date()
  const waiting = await prisma.seoRun.findMany({ where: { siteId, status: 'awaiting_publish' }, select: { id: true, snapshot: true, log: true } })
  for (const r of waiting) {
    const snap = (r.snapshot ?? {}) as unknown as Snapshot
    const log = [
      ...(Array.isArray(r.log) ? (r.log as unknown as RunLogEntry[]) : []),
      { at: now.toISOString(), stage: 'verify', level: 'info', msg: `${email} published it in Lovable from the Hub${url ? ` → ${url}` : ''}` } satisfies RunLogEntry,
    ]
    // Skip a run a poller holds right now; it reads the live site anyway.
    await prisma.seoRun.updateMany({
      where: { id: r.id, status: 'awaiting_publish', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: {
        error: null,
        log: log as unknown as Prisma.InputJsonValue,
        snapshot: {
          ...snap,
          publish: snap.publish
            ? { ...snap.publish, gaveUp: false, syncPolls: 0, mcpAttempts: channel === 'mcp' ? 1 : 0, deploymentId: deploymentId ?? snap.publish.deploymentId, requestedAt: now.toISOString() }
            : null,
        } as unknown as Prisma.InputJsonValue,
      },
    })
  }
  return { url }
}
