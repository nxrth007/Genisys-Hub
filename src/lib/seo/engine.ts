import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { BudgetExceededError, FatalClaudeError, RefusalError, TruncatedError } from './claude'
import { getPullRequest, GitHubError } from './github'
import {
  advancePublish,
  ciState,
  CI_NO_SHOW_MS,
  cleanupStoppedRun,
  DeferError,
  FatalRunError,
  hubUrl,
  LeaseLostError,
  loadRunContext,
  PUBLISH_WATCH_MS,
  STAGES,
  type RunContext,
} from './pipeline'
import { getSeoSettings, isoWeekLabel, zonedParts } from './settings'
import { advanceSearchConsole } from './gsc-connect'
import { seoAlert } from './slack'
import type { RunStage, RunStatus } from './types'

/**
 * The SEO engine's heartbeat, called from the scheduler's one-minute tick.
 *
 * Each tick: (1) enqueue this week's runs once the schedule is due,
 * (2) nudge runs that are waiting on a build check or a publish, and
 * (3) take ONE runnable run and drive it stage by stage until it finishes
 * or has to wait. One run at a time keeps memory flat on the Hub's single
 * small instance, and it's plenty — a site takes a few minutes.
 *
 * Runs are claimed with a lease (the geocode pattern): `leaseUntil` is set
 * to a unique future timestamp and every write is fenced on it. The lease
 * is renewed before every stage, so a slow stage isn't taken over while it
 * runs; if the process dies, the lease lapses and a later tick resumes from
 * the last persisted stage. Transient failures back off by pushing the
 * lease out; three strikes and the run fails with the error shown.
 */

/** Longer than the slowest single stage (one Claude call is capped at 25 min). */
const LEASE_MS = 40 * 60_000
const MAX_ATTEMPTS = 3
const CI_POLL_MS = 2 * 60_000
const PUBLISH_POLL_MS = 5 * 60_000
/** Consecutive polling errors before a waiting run is failed rather than retried forever. */
const MAX_POLL_ERRORS = 12
/** How long after the scheduled hour a missed weekly slot still fires (covers deploys). */
const CATCH_UP_HOURS = 6

const json = (v: unknown) => v as Prisma.InputJsonValue

export type TickResult = { enqueued: number; advanced: number; failed: number }

/**
 * The scheduler loads this module through instrumentation and the API
 * routes load their own copy, so the in-flight tick lives on globalThis:
 * one worker per process, whichever copy asks.
 */
const g = globalThis as unknown as { __seoTickInFlight?: Promise<TickResult> | null }

export function runSeoTick(): Promise<TickResult> {
  if (!g.__seoTickInFlight) {
    g.__seoTickInFlight = tickSeoEngine().finally(() => {
      g.__seoTickInFlight = null
    })
  }
  return g.__seoTickInFlight
}

async function tickSeoEngine(): Promise<TickResult> {
  const result: TickResult = { enqueued: 0, advanced: 0, failed: 0 }
  result.enqueued = await enqueueWeeklyIfDue(new Date())
  await pollWaitingRuns()
  // Cheap, and never throws: connecting sites to Search Console happens between runs.
  await advanceSearchConsole()
  const outcome = await processNextRun()
  if (outcome === 'advanced') result.advanced = 1
  if (outcome === 'failed') result.failed = 1
  return result
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export async function enqueueWeeklyIfDue(now: Date): Promise<number> {
  const settings = await getSeoSettings()
  if (!settings.enabled) return 0
  const p = zonedParts(now, settings.timeZone)
  // Due from the scheduled hour for a few hours, so a deploy landing on the
  // exact minute can't skip a week.
  if (p.weekday !== settings.weekday || p.hour < settings.hour || p.hour >= settings.hour + CATCH_UP_HOURS) return 0
  // A slot that had already begun when the schedule was turned on or moved
  // waits for next week — switching it on mustn't fire every site at once.
  const slotStart = new Date(now)
  slotStart.setUTCMinutes(0, 0, 0)
  slotStart.setTime(slotStart.getTime() - (p.hour - settings.hour) * 3_600_000)
  if (settings.armedAt && Date.parse(settings.armedAt) > slotStart.getTime()) return 0

  const weekOf = isoWeekLabel(now, settings.timeZone)
  const sites = await prisma.seoSite.findMany({
    where: { enabled: true, archivedAt: null },
    select: { id: true, name: true },
  })
  if (!sites.length) return 0
  // A site whose earlier week hasn't shipped sits this week out: a new run
  // would be planned without those posts and could write the same topics
  // again. The skip is recorded as this week's run, so it shows on the site
  // page and (being this week's row) is never re-decided by later ticks.
  const open = await prisma.seoRun.findMany({
    where: {
      siteId: { in: sites.map((s) => s.id) },
      kind: 'weekly',
      weekOf: { not: weekOf },
      status: { in: ['queued', 'running', 'awaiting_ci', 'awaiting_review'] },
    },
    select: { siteId: true, weekOf: true },
  })
  const waiting = new Map(open.map((o) => [o.siteId, o.weekOf]))
  // Unique (siteId, kind, weekOf) makes this idempotent across ticks and instances.
  const res = await prisma.seoRun.createMany({
    data: sites
      .filter((s) => !waiting.has(s.id))
      .map((s) => ({ siteId: s.id, kind: 'weekly', weekOf, trigger: 'schedule', status: 'queued', stage: 'collect' })),
    skipDuplicates: true,
  })
  const skippedSites = sites.filter((s) => waiting.has(s.id))
  if (skippedSites.length) {
    const skipped = await prisma.seoRun.createMany({
      data: skippedSites.map((s) => ({
        siteId: s.id,
        kind: 'weekly',
        weekOf,
        trigger: 'schedule',
        status: 'canceled',
        stage: 'collect',
        finishedAt: now,
        error: `Skipped this week: the ${waiting.get(s.id)} run is still waiting for review. Approve or reject it, then use Run weekly now.`,
      })),
      skipDuplicates: true,
    })
    if (skipped.count) {
      const names = skippedSites.map((s) => s.name).join(', ')
      await seoAlert(`:hourglass: *SEO* — skipped ${weekOf} for ${names}: last week’s run is still waiting for review. ${hubUrl('/seo')}`)
    }
  }
  if (res.count) console.log(`[seo] enqueued ${res.count} weekly run(s) for ${weekOf}`)
  return res.count
}

/** Queue a run by hand ("Run now"). Manual runs never collide with the scheduled one. */
export async function enqueueManualRun(siteId: string, kind: 'weekly' | 'foundation'): Promise<string> {
  const settings = await getSeoSettings()
  const active = await prisma.seoRun.findFirst({
    where: { siteId, kind, status: { in: ['queued', 'running', 'awaiting_ci', 'awaiting_review', 'awaiting_publish'] } },
    select: { id: true, status: true },
  })
  if (active) throw new Error(`This site already has a ${kind} run in progress (${active.status.replace('_', ' ')}). Finish or cancel it first.`)
  const weekOf = `${isoWeekLabel(new Date(), settings.timeZone)}-m${Date.now().toString(36)}`
  const run = await prisma.seoRun.create({
    data: { siteId, kind, weekOf, trigger: 'manual', status: 'queued', stage: 'collect' },
    select: { id: true },
  })
  return run.id
}

// ---------------------------------------------------------------------------
// Claim + process
// ---------------------------------------------------------------------------

function newLease(from: number, ms: number): Date {
  // A unique lease value doubles as the fencing token.
  return new Date(from + ms + Math.floor(Math.random() * 1000))
}

async function claim(runId: string, now: Date): Promise<Date | null> {
  const lease = newLease(now.getTime(), LEASE_MS)
  const res = await prisma.seoRun.updateMany({
    where: {
      id: runId,
      OR: [
        { status: 'queued', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { status: 'running', leaseUntil: { lt: now } },
      ],
    },
    data: { status: 'running', leaseUntil: lease },
  })
  return res.count ? lease : null
}

async function processNextRun(): Promise<'idle' | 'advanced' | 'failed'> {
  const now = new Date()
  const candidates = await prisma.seoRun.findMany({
    where: {
      OR: [
        { status: 'queued', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { status: 'running', leaseUntil: { lt: now } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 5,
    select: { id: true },
  })
  for (const c of candidates) {
    const lease = await claim(c.id, now)
    if (!lease) continue
    return driveRun(c.id, lease)
  }
  return 'idle'
}

function classify(err: unknown): { fatal: boolean; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof FatalRunError || err instanceof FatalClaudeError || err instanceof BudgetExceededError || err instanceof TruncatedError) {
    return { fatal: true, message }
  }
  if (err instanceof RefusalError) {
    // Declined because the fallback model had no capacity: a later retry can succeed.
    return { fatal: !err.recommendedModel, message }
  }
  if (err instanceof GitHubError) {
    // Permissions and validation don't fix themselves; rate limits and 5xx might.
    const perm = err.acceptedPermissions ? ` The GitHub token needs: ${err.acceptedPermissions}.` : ''
    return { fatal: err.status === 401 || err.status === 403 || err.status === 404 || err.status === 422, message: `${message}${perm}` }
  }
  if (/not configured|Add a Vault entry/i.test(message)) return { fatal: true, message }
  return { fatal: false, message }
}

export async function driveRun(runId: string, lease: Date): Promise<'advanced' | 'failed'> {
  let ctx: RunContext | null = null
  try {
    ctx = await loadRunContext(runId, lease)
    if (!ctx) return 'failed'
    if (ctx.site.archivedAt) {
      ctx.log('engine', 'The site was archived — run canceled', 'warn')
      await ctx.save({ status: 'canceled', finishedAt: new Date(), leaseUntil: null })
      await cleanupStoppedRun(ctx.run, ctx.site, 'Site archived').catch(() => {})
      return 'advanced'
    }
    if (!ctx.run.startedAt) await ctx.save({ startedAt: new Date() })
    await ctx.save({ attempts: { increment: 1 } })

    let stage = ctx.run.stage as RunStage
    for (let guard = 0; guard < 12 && stage !== 'done'; guard++) {
      const fn = STAGES[stage]
      if (!fn) throw new FatalRunError(`Unknown stage "${stage}"`)
      await ctx.renewLease(LEASE_MS)
      const out = await fn(ctx)
      const waiting = out.status !== 'running'
      await ctx.save({
        stage: out.stage,
        status: out.status,
        attempts: 0,
        error: null,
        // Release the lease when the run has to wait or is finished.
        leaseUntil: waiting ? null : ctx.currentLease,
      })
      stage = out.stage
      if (waiting) break
    }
    return 'advanced'
  } catch (err) {
    if (err instanceof LeaseLostError) return 'advanced'
    if (err instanceof DeferError && ctx) {
      // Not a failure: leave it running and look again later, without using up an attempt.
      ctx.log(ctx.run.stage as RunStage, err.message)
      await ctx
        .save({ attempts: Math.max(0, ctx.run.attempts - 1), leaseUntil: new Date(Date.now() + err.retryInMs) })
        .catch(() => {})
      return 'advanced'
    }
    const { fatal, message } = classify(err)
    const attempts = ctx?.run.attempts ?? 1
    const giveUp = fatal || attempts >= MAX_ATTEMPTS
    console.error(`[seo] run ${runId} failed at ${ctx?.run.stage ?? '?'} (attempt ${attempts}):`, err)
    if (ctx) {
      ctx.log(ctx.run.stage as RunStage, message, 'error')
      await ctx
        .save(
          giveUp
            ? { status: 'failed', error: message, leaseUntil: null, finishedAt: new Date() }
            : // Back off: leave it "running" with the lease pushed out; a later tick retries.
              { error: `Retrying after: ${message}`, leaseUntil: new Date(Date.now() + attempts * 5 * 60_000) },
        )
        .catch(() => {})
      if (giveUp) {
        await seoAlert(`:warning: *SEO* — ${ctx.site.name}: ${ctx.run.kind} run failed at *${ctx.run.stage}*: ${message}`)
      }
    }
    return giveUp ? 'failed' : 'advanced'
  }
}

// ---------------------------------------------------------------------------
// Waiting runs: build checks and publishes
// ---------------------------------------------------------------------------

async function pollWaitingRuns(): Promise<void> {
  const now = Date.now()
  const waiting = await prisma.seoRun.findMany({
    where: {
      // Skip runs someone is actively polling (lease held and not expired).
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date(now) } }],
      AND: [
        {
          OR: [
            { status: 'awaiting_ci', updatedAt: { lt: new Date(now - CI_POLL_MS) } },
            { status: 'awaiting_publish', updatedAt: { lt: new Date(now - PUBLISH_POLL_MS) }, mergedAt: { gt: new Date(now - PUBLISH_WATCH_MS) } },
          ],
        },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: 5,
    select: { id: true, status: true, attempts: true },
  })
  for (const w of waiting) {
    try {
      if (w.status === 'awaiting_ci') await pollCi(w.id)
      else await pollPublish(w.id)
    } catch (err) {
      // Someone acted on the run mid-check (reject, cancel, mark published): not an error.
      if (err instanceof LeaseLostError) continue
      console.error(`[seo] polling run ${w.id} failed:`, err)
      const message = err instanceof Error ? err.message : String(err)
      const attempts = w.attempts + 1
      // Guarded on the status it was polled in, so a human's action always wins.
      if (attempts >= MAX_POLL_ERRORS) {
        const res = await prisma.seoRun
          .updateMany({
            where: { id: w.id, status: w.status },
            data: { status: 'failed', error: `Stopped after ${attempts} failed checks: ${message}`, finishedAt: new Date(), leaseUntil: null },
          })
          .catch(() => ({ count: 0 }))
        if (res.count) {
          const run = await prisma.seoRun.findUnique({ where: { id: w.id }, select: { site: { select: { name: true } } } }).catch(() => null)
          await seoAlert(`:warning: *SEO* — ${run?.site.name ?? 'a site'}: gave up waiting on a run after repeated errors: ${message}`)
        }
      } else {
        // Count the failure and touch updatedAt so a broken run doesn't starve the others.
        await prisma.seoRun
          .updateMany({ where: { id: w.id, status: w.status }, data: { attempts, error: `Check failed (${attempts}/${MAX_POLL_ERRORS}): ${message}` } })
          .catch(() => {})
      }
    }
  }
  await retireStalePublishes()
}

/**
 * A merge nobody published within the watch window: stop waiting and
 * finish the run (it reports what's still missing) instead of leaving it
 * in awaiting_publish forever.
 */
async function retireStalePublishes(): Promise<void> {
  const stale = await prisma.seoRun.findMany({
    where: { status: 'awaiting_publish', mergedAt: { lte: new Date(Date.now() - PUBLISH_WATCH_MS) }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    select: { id: true },
    take: 5,
  })
  for (const s of stale) {
    await prisma.seoRun
      .updateMany({ where: { id: s.id, status: 'awaiting_publish' }, data: { status: 'queued', stage: 'report', leaseUntil: null, error: 'Never saw the new pages go live within 7 days of the merge.' } })
      .catch(() => {})
  }
}

async function withLease<T>(runId: string, status: RunStatus, fn: (ctx: RunContext) => Promise<T>): Promise<T | null> {
  const now = new Date()
  const lease = newLease(now.getTime(), 5 * 60_000)
  // An expired lease (a poller that died mid-check) is fair game.
  const got = await prisma.seoRun.updateMany({
    where: { id: runId, status, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: lease },
  })
  if (!got.count) return null
  try {
    const ctx = await loadRunContext(runId, lease)
    if (!ctx) return null
    return await fn(ctx)
  } finally {
    await prisma.seoRun
      .updateMany({ where: { id: runId, leaseUntil: lease }, data: { leaseUntil: null, updatedAt: new Date() } })
      .catch(() => {})
  }
}

async function pollCi(runId: string): Promise<void> {
  await withLease(runId, 'awaiting_ci', async (ctx) => {
    const fullName = ctx.run.repoFullName ?? ctx.snapshot?.repo?.fullName
    if (!fullName || !ctx.run.commitSha || !ctx.run.prNumber) return
    const approvedSha = ctx.snapshot?.approvedSha ?? null
    if (ctx.site.archivedAt || (!approvedSha && (ctx.site.mode !== 'autopilot' || !ctx.site.enabled))) {
      ctx.log('ship', 'The site is no longer on autopilot — handing to a reviewer', 'warn')
      await ctx.save({ status: 'awaiting_review', attempts: 0 })
      return
    }
    // Check the PR as it is now, not the commit the engine first made.
    const pr = await getPullRequest(fullName, ctx.run.prNumber)
    if (pr.merged || pr.state === 'closed') {
      // Merged or closed on GitHub directly — let the ship stage sort it out.
      await ctx.save({ status: 'queued', stage: 'ship', attempts: 0 })
      return
    }
    if (pr.headSha !== ctx.run.commitSha && pr.headSha !== approvedSha) {
      ctx.log('ship', `The PR branch changed (${pr.headSha.slice(0, 7)}) — needs a reviewer`, 'warn')
      await ctx.save({ status: 'awaiting_review', attempts: 0 })
      return
    }
    const ci = await ciState(fullName, pr.headSha)
    if (ci.state === 'pending' || ci.state === 'none') {
      // A repo whose check never starts shouldn't wait forever — per commit.
      const wait = ctx.snapshot?.ciWait
      if (wait?.sha !== pr.headSha) {
        await ctx.save({ ciStatus: ci.state, attempts: 0, snapshot: json({ ...ctx.snapshot, ciWait: { sha: pr.headSha, since: new Date().toISOString() } }) })
        return
      }
      if (ci.state === 'none' && Date.now() - Date.parse(wait.since) > CI_NO_SHOW_MS) {
        ctx.log('ship', 'No build check ran for this commit — handing to a reviewer', 'warn')
        await ctx.save({ status: 'awaiting_review', ciStatus: 'none', attempts: 0 })
      } else {
        await ctx.save({ ciStatus: ci.state, attempts: 0 })
      }
      return
    }
    if (ci.state === 'failure') {
      ctx.log('ship', `Build check failed${ci.url ? ` (${ci.url})` : ''} — needs a reviewer`, 'error')
      await ctx.save({ status: 'awaiting_review', ciStatus: 'failure', attempts: 0 })
      await seoAlert(`:x: *SEO* — ${ctx.site.name}: the build check failed on ${ctx.run.branch}. ${ci.url ?? ''}`)
      return
    }
    ctx.log('ship', 'Build check passed')
    await ctx.save({ status: 'queued', stage: 'ship', ciStatus: 'success', attempts: 0 })
  })
}

async function pollPublish(runId: string): Promise<void> {
  await withLease(runId, 'awaiting_publish', async (ctx) => {
    const live = await advancePublish(ctx)
    if (live) {
      ctx.log('verify', 'New pages are live')
      await ctx.save({ status: 'queued', stage: 'verify', attempts: 0 })
    } else {
      await ctx.save({ attempts: 0 })
    }
  })
}
