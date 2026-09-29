import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import type { CreateSiteBody, RunActionBody, UpdateSiteBody } from './api-types'
import { ClaudeSession } from './claude'
import { fetchPage } from './crawl'
import { enqueueManualRun } from './engine'
import { getPullRequest, getRepo } from './github'
import { ciState, cleanupStoppedRun, deriveFacts, type Snapshot } from './pipeline'
import { FactsSchema } from './prompts'
import { snapshotRepo } from './repo'
import { getSeoSettings } from './settings'
import type { RunStatus, SeoMode } from './types'

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

export async function archiveSite(id: string): Promise<void> {
  const site = await prisma.seoSite.findUnique({ where: { id }, select: { id: true, repoFullName: true } })
  if (!site) throw new SeoInputError('Site not found.')
  await prisma.seoSite.update({ where: { id }, data: { archivedAt: new Date(), enabled: false } })
  // Stop everything in flight: a worker mid-stage fails its next fenced
  // write, and open PRs are closed so nothing merges into an archived site.
  const active = await prisma.seoRun.findMany({ where: { siteId: id, status: { in: ['queued', 'running', 'awaiting_ci', 'awaiting_review', 'awaiting_publish'] } }, select: { id: true } })
  for (const r of active) {
    const res = await prisma.seoRun.updateMany({
      where: { id: r.id, status: { in: ['queued', 'running', 'awaiting_ci', 'awaiting_review', 'awaiting_publish'] } },
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
      if (run.ciStatus === 'failure') {
        // The last check failed — but someone may have pushed a fix or re-run
        // it since. Ask GitHub about the PR's current head before refusing.
        const snap = run.snapshot as unknown as Snapshot | null
        const fullName = run.repoFullName ?? snap?.repo?.fullName ?? site.repoFullName
        if (fullName && run.prNumber) {
          const pr = await getPullRequest(fullName, run.prNumber)
          const ci = await ciState(fullName, pr.headSha)
          if (ci.state === 'failure') {
            throw new SeoInputError('The build check still fails on this branch, so merging would break the site. Fix the PR or reject it.')
          }
        }
      }
      const res = await prisma.seoRun.updateMany({
        where: { id: runId, status: 'awaiting_review' },
        data: { status: 'queued', stage: 'ship', reviewedBy: email, leaseUntil: null, error: null, ciStatus: null },
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
        data: { status: 'queued', stage: 'verify', reviewedBy: email, leaseUntil: null },
      })
      if (!res.count) throw new SeoInputError('This run isn’t waiting to be published.')
      return
    }
    case 'retry': {
      if (run.status !== 'failed') throw new SeoInputError('Only a failed run can be retried.')
      // A foundation that never reached a PR is regenerated from scratch:
      // its whole-file rewrites were based on a repo that has since moved on.
      const restart = run.kind === 'foundation' && !run.prNumber
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
