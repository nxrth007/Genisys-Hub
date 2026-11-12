/**
 * The workflow customize queue: one row per client (GhlCustomizeJob).
 *
 * When the site we built is linked to a client whose GHL sub-account the
 * Hub's worker created, the client's Automation Copy goes into their three
 * Incoming Lead workflows: browser.ts runs Workflow AI with the board's
 * prompts and lets a save through only when every changed step is the
 * Hub's copy. The job runs in the sub-account worker's tick, on the same
 * one browser, when no sub-account is waiting to be created.
 *
 * Automatic runs (the site link, the sweep) are off until switched on in
 * Settings (AppSetting ghlCustomize.auto). "Customize now" on the
 * Automation Copy board always works.
 */
import { Prisma } from '@/generated/prisma/client'
import type { AutomationInputs } from '@/lib/automation-copy'
import { automationCopyDone, boardInputs, markAutomationCopyDone } from '@/lib/automation-copy-server'
import { hubLink } from '@/lib/hub-alerts'
import { prisma } from '@/lib/prisma'
import { STUCK_AFTER_MS, WAITING_AFTER_MS } from '@/lib/ghl-subaccount-worker/alert-text'
import type { CustomizeAlertKind } from '@/lib/ghl-subaccount-worker/alert-text'
import { textCustomizeProblem } from '@/lib/ghl-subaccount-worker/alerts'
import { retryDelayMs, workerEnabled, workerHeadless, workerMode, workerPaused } from '@/lib/ghl-subaccount-worker/config'
import { readBrowserFields } from '@/lib/ghl-subaccount-worker/fields'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, isHeartbeatStale, jobLogEntry } from '@/lib/ghl-subaccount-worker/heartbeat'
import { ghlLabels } from '@/lib/ghl-subaccount-worker/labels'
import { loadLogin, loadSession, makeOtpPuller, saveSession } from '@/lib/ghl-subaccount-worker/session-store'
import { runCustomizeInBrowser, type WorkflowOutcome } from './browser'
import { blankNames, customizeTasks, quoteLinkFor, sameSiteLink } from './copy'
import { autoCustomizeDecision, inFlight } from './eligibility'

export const AUTO_KEY = 'ghlCustomize.auto'
const LEASE_MS = 45 * 60_000
/** Three workflows at a minute or two each, with a retry apiece, fit well inside this. */
const WALL_MS = 40 * 60_000
const MAX_TRIES = 3
const SWEEP_EVERY_MS = 5 * 60_000

class LeaseLost extends Error {
  constructor() {
    super('lease lost')
  }
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))

function environmentFailure(message: string): boolean {
  return /playwright|executable doesn't exist|browserType\.launch|Failed to launch|Cannot find (module|package)|libnss3|error while loading shared libraries/i.test(message)
}

export type CustomizeProgress = Record<string, { status: WorkflowOutcome['status']; note: string; workflowId?: string; at: string }>

export function readProgress(value: unknown): CustomizeProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: CustomizeProgress = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    if (typeof r.status !== 'string') continue
    out[k] = {
      status: r.status as WorkflowOutcome['status'],
      note: typeof r.note === 'string' ? r.note : '',
      ...(typeof r.workflowId === 'string' ? { workflowId: r.workflowId } : {}),
      at: typeof r.at === 'string' ? r.at : '',
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

export async function customizeAutoOn(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTO_KEY } }).catch(() => null)
  return row?.value === 'on'
}

export async function setCustomizeAuto(on: boolean): Promise<void> {
  const value = on ? 'on' : 'off'
  await prisma.appSetting.upsert({ where: { key: AUTO_KEY }, create: { key: AUTO_KEY, value }, update: { value } })
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/** The board's details, with the free-quote link pointed at the site we built. */
export async function customizeInputs(clientId: string, siteUrl: string | null): Promise<AutomationInputs | null> {
  const board = await boardInputs(clientId)
  if (!board) return null
  return { ...board, quoteLink: quoteLinkFor(siteUrl, board.quoteLink) }
}

function logged(prev: unknown, msg: string): Prisma.InputJsonValue {
  const list = Array.isArray(prev) ? prev : []
  return [...list, jobLogEntry(msg)].slice(-80) as Prisma.InputJsonValue
}

export type QueueResult =
  | { ok: true; status: 'queued' | 'already'; jobId: string }
  | { ok: false; status: 'held' | 'skipped' | 'failed'; reason: string; jobId?: string }

function heldDetail(blanks: string[]): string {
  return `Waiting on the ${blankNames(blanks)}: missing or incomplete on the Automation Copy board, and the copy can't go into GHL like that. Fix it there and the Hub runs it as soon as it's right.`
}

/**
 * Queue a client's workflows. Automatic triggers ('site', 'sweep') follow
 * the rules in eligibility.ts and need the Settings switch on; 'manual'
 * (Customize now) only needs a linked sub-account. A missing detail holds
 * the job instead of pasting a placeholder into GHL.
 */
export async function queueCustomize(clientId: string, opts: { trigger: 'site' | 'sweep' | 'manual'; force?: boolean }): Promise<QueueResult> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      siteUrl: true,
      ghlLocationId: true,
      ghlSubaccountJob: { select: { status: true, locationId: true, detail: true, payload: true } },
      ghlCustomizeJob: { select: { id: true, status: true, siteUrl: true, heartbeatAt: true, updatedAt: true, log: true } },
    },
  })
  if (!c) return { ok: false, status: 'failed', reason: 'Client not found.' }
  if (!c.ghlLocationId) return { ok: false, status: 'skipped', reason: 'This client has no linked GHL sub-account yet.' }
  const job = c.ghlCustomizeJob
  const staleRun = job?.status === 'running' && isHeartbeatStale(job.heartbeatAt, job.updatedAt)
  if (job && inFlight(job.status) && !staleRun) return { ok: true, status: 'already', jobId: job.id }
  if (!opts.force) {
    if (!workerEnabled()) return { ok: false, status: 'skipped', reason: 'The GHL browser worker is switched off.' }
    if (!(await customizeAutoOn())) return { ok: false, status: 'skipped', reason: 'Automatic workflow customizing is off in Settings.' }
    const decision = autoCustomizeDecision({
      archived: !!c.archivedAt,
      siteUrl: c.siteUrl,
      locationId: c.ghlLocationId,
      subaccountJob: c.ghlSubaccountJob ? { status: c.ghlSubaccountJob.status, locationId: c.ghlSubaccountJob.locationId, detail: c.ghlSubaccountJob.detail } : null,
      copyDone: await automationCopyDone(clientId),
      job: job ? { status: job.status, siteUrl: job.siteUrl } : null,
    })
    if (!decision.queue) return { ok: false, status: 'skipped', reason: decision.reason }
  }
  const inputs = await customizeInputs(clientId, c.siteUrl)
  if (!inputs) return { ok: false, status: 'failed', reason: "Couldn't read the client's Automation Copy details." }
  const { blanks } = customizeTasks(inputs)
  const now = new Date()
  const common = {
    locationId: c.ghlLocationId,
    siteUrl: c.siteUrl,
    inputs: inputs as unknown as Prisma.InputJsonValue,
    trigger: opts.trigger,
    attempts: 0,
    leaseUntil: null,
    heartbeatAt: null,
    nextAttemptAt: now,
    lastError: null,
    finishedAt: null,
    progress: Prisma.DbNull,
  }
  const subName = readBrowserFields(c.ghlSubaccountJob?.payload)?.name || c.name
  if (blanks.length) {
    const detail = heldDetail(blanks)
    const row = await prisma.ghlCustomizeJob.upsert({
      where: { clientId },
      create: { clientId, ...common, status: 'held', detail, log: logged(null, `Held (${opts.trigger}): ${detail}`) },
      update: { ...common, status: 'held', detail, log: logged(job?.log, `Held (${opts.trigger}): ${detail}`) },
      select: { id: true },
    })
    await textCustomizeProblem({ key: `${clientId}.${blanks.join(',')}`, kind: 'held', client: c.name, subAccountName: subName, reason: blankNames(blanks), link: hubLink(`/automation-copy/${clientId}`) })
    return { ok: false, status: 'held', reason: detail, jobId: row.id }
  }
  const why = opts.trigger === 'manual' ? 'Customize now was pressed' : opts.trigger === 'site' ? 'the site link was saved' : 'the sweep found the site link'
  const msg = `Queued: ${why}. Website link in the copy: ${inputs.quoteLink}.`
  const row = await prisma.ghlCustomizeJob.upsert({
    where: { clientId },
    create: { clientId, ...common, status: 'queued', detail: null, log: logged(null, msg) },
    update: { ...common, status: 'queued', detail: null, log: logged(job?.log, msg) },
    select: { id: true },
  })
  return { ok: true, status: 'queued', jobId: row.id }
}

/** From the client PATCH: the site we built was linked or changed. Never throws. */
export async function queueCustomizeForSite(clientId: string): Promise<void> {
  try {
    const res = await queueCustomize(clientId, { trigger: 'site' })
    console.log(`[ghl-customize] site link for ${clientId}: ${res.ok ? res.status : `${res.status} (${res.reason})`}`)
  } catch (err) {
    console.warn(`[ghl-customize] site link for ${clientId}:`, describe(err))
  }
}

let lastSweep = 0

/**
 * Every few minutes (when automatic runs are on): queue clients whose site
 * link is in and whose sub-account the worker created, and release held
 * jobs whose missing detail has been filled in.
 */
export async function sweepCustomize(now = Date.now()): Promise<number> {
  if (now - lastSweep < SWEEP_EVERY_MS) return 0
  lastSweep = now
  if (!(await customizeAutoOn())) return 0
  const rows = await prisma.client.findMany({
    where: { archivedAt: null, siteUrl: { not: null }, ghlLocationId: { not: null }, ghlSubaccountJob: { is: { status: 'succeeded' } } },
    select: { id: true, siteUrl: true, ghlCustomizeJob: { select: { status: true, siteUrl: true } } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })
  let queued = 0
  for (const r of rows) {
    const job = r.ghlCustomizeJob
    if (job && inFlight(job.status)) continue
    if (job?.status === 'held') {
      // Released once the blank is filled; still blank stays held without another text.
      const inputs = await customizeInputs(r.id, r.siteUrl)
      if (!inputs || customizeTasks(inputs).blanks.length) continue
      const res = await queueCustomize(r.id, { trigger: 'sweep', force: true })
      if (res.ok && res.status === 'queued') queued += 1
      continue
    }
    if (job && sameSiteLink(job.siteUrl, r.siteUrl)) continue
    const res = await queueCustomize(r.id, { trigger: 'sweep' })
    if (res.ok && res.status === 'queued') queued += 1
  }
  return queued
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

type Live = { id: string; getLease: () => Date; abort: () => void; released: boolean; since: number }
let live: Live | null = null
let stopping = false

export async function recoverAbandonedCustomize(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_STALE_MS)
  const stale = await prisma.ghlCustomizeJob.findMany({
    where: { status: 'running', OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] },
    select: { id: true, log: true },
  })
  let recovered = 0
  for (const row of stale) {
    if (live?.id === row.id && !live.released) continue
    const res = await prisma.ghlCustomizeJob.updateMany({
      where: { id: row.id, status: 'running', OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] },
      data: { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: now, log: logged(row.log, 'Recovered a run abandoned by a restarted instance.') },
    })
    recovered += res.count
  }
  return recovered
}

/** On shutdown: stop the browser and give the job back to the queue. */
export async function releaseLiveCustomize(message: string): Promise<void> {
  stopping = true
  const current = live
  if (!current || current.released) return
  current.released = true
  current.abort()
  const lease = current.getLease()
  const row = await prisma.ghlCustomizeJob.findFirst({ where: { id: current.id, leaseUntil: lease, status: 'running' }, select: { log: true } })
  if (!row) return
  await prisma.ghlCustomizeJob.updateMany({
    where: { id: current.id, leaseUntil: lease, status: 'running' },
    data: { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(), log: logged(row.log, message) },
  })
}

async function claimCustomize(): Promise<{ id: string; lease: Date } | null> {
  const now = new Date()
  const due: Prisma.GhlCustomizeJobWhereInput = { status: 'queued', nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }
  const next = await prisma.ghlCustomizeJob.findFirst({ where: due, orderBy: { nextAttemptAt: 'asc' }, select: { id: true } })
  if (!next) return null
  const lease = new Date(now.getTime() + LEASE_MS + Math.floor(Math.random() * 1000))
  const res = await prisma.ghlCustomizeJob.updateMany({
    where: { id: next.id, ...due },
    data: { status: 'running', leaseUntil: lease, heartbeatAt: new Date(), attempts: { increment: 1 } },
  })
  return res.count === 1 ? { id: next.id, lease } : null
}

async function saveJob(id: string, lease: Date, data: Prisma.GhlCustomizeJobUpdateManyMutationInput): Promise<void> {
  const res = await prisma.ghlCustomizeJob.updateMany({ where: { id, leaseUntil: lease }, data })
  if (res.count === 0) throw new LeaseLost()
}

async function appendLog(id: string, lease: Date, msg: string): Promise<void> {
  const row = await prisma.ghlCustomizeJob.findFirst({ where: { id, leaseUntil: lease }, select: { log: true } })
  if (!row) throw new LeaseLost()
  await saveJob(id, lease, { log: logged(row.log, msg) })
}

/** For notes after the lease is given up (the job has finished). */
async function appendLogFree(id: string, msg: string): Promise<void> {
  const row = await prisma.ghlCustomizeJob.findUnique({ where: { id }, select: { log: true } })
  if (row) await prisma.ghlCustomizeJob.update({ where: { id }, data: { log: logged(row.log, msg) } })
}

async function saveShot(id: string, lease: Date, step: string, image: Buffer): Promise<void> {
  const label = step.slice(0, 180)
  try {
    const shot = await prisma.ghlCustomizeJobShot.create({ data: { jobId: id, step: label, mime: 'image/jpeg', data: Uint8Array.from(image) }, select: { id: true } })
    const older = await prisma.ghlCustomizeJobShot.findMany({ where: { jobId: id }, orderBy: { createdAt: 'desc' }, skip: 10, select: { id: true } })
    if (older.length) await prisma.ghlCustomizeJobShot.deleteMany({ where: { id: { in: older.map((r) => r.id) } } })
    await appendLog(id, lease, `Screenshot ${shot.id} at step ${label}`)
  } catch (err) {
    await appendLog(id, lease, `Screenshot save failed at step ${label}: ${describe(err).slice(0, 300)}`).catch(() => {})
  }
}

async function executeCustomize(id: string, claimedLease: Date): Promise<string> {
  const lease = claimedLease
  const job = await prisma.ghlCustomizeJob.findFirst({
    where: { id, leaseUntil: lease },
    include: { client: { select: { id: true, name: true, siteUrl: true, archivedAt: true, ghlLocationId: true, ghlSubaccountJob: { select: { payload: true } } } } },
  })
  if (!job) return 'lost'
  const ac = new AbortController()
  live = { id, getLease: () => lease, abort: () => ac.abort(), released: false, since: Date.now() }
  const client = job.client
  const subName = readBrowserFields(client.ghlSubaccountJob?.payload)?.name || client.name
  const boardLink = hubLink(`/automation-copy/${client.id}`)
  const note = (msg: string) => appendLog(id, lease, msg).catch(() => {})
  const textTeam = (kind: CustomizeAlertKind, reason: string, link = boardLink) =>
    textCustomizeProblem({ key: id, kind, client: client.name, subAccountName: subName, reason, link })
  const finish = (status: string, detail: string) =>
    saveJob(id, lease, { status, detail: detail.slice(0, 4000), lastError: status === 'succeeded' ? null : detail.slice(0, 4000), leaseUntil: null, heartbeatAt: null, finishedAt: new Date() })
  const needsHuman = async (detail: string): Promise<string> => {
    await note(detail)
    await finish('needs_human', detail)
    await textTeam('needs_human', detail)
    return 'needs_human'
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  try {
    if (client.archivedAt) {
      await note('The client is archived, so nothing was changed.')
      await finish('failed', 'The client is archived, so nothing was changed.')
      return 'failed'
    }
    const locationId = client.ghlLocationId
    if (!locationId) return await needsHuman('The client has no linked GHL sub-account anymore, so nothing was changed.')
    const inputs = await customizeInputs(client.id, client.siteUrl)
    if (!inputs) return await needsHuman("Couldn't read the client's Automation Copy details.")
    const { tasks, blanks } = customizeTasks(inputs)
    if (blanks.length) {
      const detail = heldDetail(blanks)
      await note(detail)
      await finish('held', detail)
      await textTeam('held', blankNames(blanks))
      return 'held'
    }
    const progress = readProgress(job.progress)
    const pending = tasks.filter((t) => !['done', 'already'].includes(progress[t.id]?.status ?? ''))
    await saveJob(id, lease, { locationId, siteUrl: client.siteUrl, inputs: inputs as unknown as Prisma.InputJsonValue })

    const succeed = async (): Promise<string> => {
      const detail = `Put the Hub's copy into the ${tasks.length} Incoming Lead workflows (website link ${inputs.quoteLink}). Every changed step was checked before it was saved.`
      await note(detail)
      await finish('succeeded', detail)
      const marked = await markAutomationCopyDone(client.id).catch((err) => ({ error: describe(err) }))
      const tracker = marked && 'tracker' in marked ? marked.tracker : null
      await appendLogFree(
        id,
        marked && 'error' in marked
          ? `Couldn't mark the Automation Copy board done: ${marked.error}`
          : `Marked the Automation Copy board done. Onboarding tracker: ${tracker ? (tracker.ok ? `"Automations Configuration" ${tracker.action === 'already' ? 'was already checked' : 'checked'}` : tracker.detail) : 'not updated'}.`,
      ).catch(() => {})
      return 'succeeded'
    }
    if (!pending.length) return await succeed()

    const save = workerMode() === 'create'
    await note(`Customizing ${pending.map((t) => `"${t.name}"`).join(', ')} in "${subName}" (${locationId}). ${save ? 'Saving each one that checks out.' : 'Dry-run mode: nothing will be saved.'}`)
    timer = setTimeout(() => ac.abort(), WALL_MS)
    await prisma.ghlCustomizeJob.updateMany({ where: { id, leaseUntil: lease }, data: { heartbeatAt: new Date() } })
    heartbeat = setInterval(() => {
      void prisma.ghlCustomizeJob.updateMany({ where: { id, status: 'running', leaseUntil: lease }, data: { heartbeatAt: new Date() } }).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    const otp = makeOtpPuller(client.id, note)
    const result = await runCustomizeInBrowser({
      locationId,
      clientName: client.name,
      tasks: pending,
      save,
      labels: ghlLabels(process.env.GHL_SUBACCOUNT_WORKER_LABELS),
      login: await loadLogin(),
      storageState: await loadSession(),
      headless: workerHeadless(),
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
      signal: ac.signal,
      pullOtp: (ms) => otp.pull(ms),
      onOtpPrompt: async (detail) => {
        otp.noteCodeSent()
        await note(detail)
        await saveJob(id, lease, { detail }).catch(() => {})
        await textTeam('code', '', hubLink('/settings#ghl-subaccounts'))
      },
      onNote: note,
      capture: (step, image) => saveShot(id, lease, step, image),
      onOutcome: async (o) => {
        progress[o.id] = { status: o.status, note: o.detail.slice(0, 1000), ...(o.workflowId ? { workflowId: o.workflowId } : {}), at: new Date().toISOString() }
        await saveJob(id, lease, { progress: progress as unknown as Prisma.InputJsonValue }).catch(() => {})
        await note(`${o.name}: ${o.status}. ${o.detail}`)
      },
    })
    if (result.storageState) await saveSession(result.storageState).catch((err) => console.warn('[ghl-customize] session save:', describe(err)))
    if (result.stopped) {
      if (result.stopped.status === 'needs_human') return await needsHuman(result.stopped.detail)
      throw new Error(result.stopped.detail)
    }
    const human = result.outcomes.filter((o) => o.status === 'needs_human')
    if (human.length) return await needsHuman(human.map((o) => `${o.name}: ${o.detail}`).join(' '))
    const errors = result.outcomes.filter((o) => o.status === 'error')
    if (errors.length) throw new Error(errors.map((o) => `${o.name}: ${o.detail}`).join(' '))
    if (result.outcomes.some((o) => o.status === 'rehearsed')) {
      const detail = 'Dry run: Workflow AI made the edits and they matched the copy, but nothing was saved because the worker is in dry-run mode.'
      await note(detail)
      await finish('dry_run', detail)
      return 'dry_run'
    }
    return await succeed()
  } catch (err) {
    if (live?.released || stopping) return 'released'
    if (err instanceof LeaseLost) return 'lost'
    const message = describe(err)
    if (ac.signal.aborted) {
      const detail = `Stopped after ${Math.round(WALL_MS / 60_000)} minutes without finishing. ${message}`.slice(0, 2000)
      await note(detail)
      await finish('failed', detail).catch(() => {})
      await textTeam('failed', detail)
      return 'failed'
    }
    if (environmentFailure(message) || job.attempts >= MAX_TRIES) {
      const detail = environmentFailure(message) ? `The browser didn't start: ${message}` : `Gave up after ${job.attempts} tries: ${message}`
      await note(detail)
      await finish('failed', detail).catch(() => {})
      await textTeam('failed', detail)
      return 'failed'
    }
    const wait = retryDelayMs(job.attempts)
    const detail = `Will try again in ${Math.round(wait / 60_000)} min (try ${job.attempts} of ${MAX_TRIES}): ${message}`.slice(0, 2000)
    await note(detail)
    await saveJob(id, lease, { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(Date.now() + wait), lastError: message.slice(0, 2000), detail }).catch(() => {})
    return 'retry'
  } finally {
    if (timer) clearTimeout(timer)
    if (heartbeat) clearInterval(heartbeat)
    if (live?.id === id) live = null
  }
}

/**
 * One tick, run from the sub-account worker's tick: recover, sweep, and
 * (when the browser is free) run one queued job.
 */
export async function customizeTick(opts: { runBrowser: boolean }): Promise<{ queued: number; claimed: boolean; outcome?: string }> {
  if (!workerEnabled()) return { queued: 0, claimed: false }
  await recoverAbandonedCustomize().catch((err) => console.warn('[ghl-customize] recovery:', describe(err)))
  const queued = await sweepCustomize().catch((err) => {
    console.warn('[ghl-customize] sweep:', describe(err))
    return 0
  })
  if (!opts.runBrowser || workerPaused() || stopping) return { queued, claimed: false }
  const claimed = await claimCustomize()
  if (!claimed) return { queued, claimed: false }
  const outcome = await executeCustomize(claimed.id, claimed.lease).catch((err) => {
    if (err instanceof LeaseLost) return 'lost'
    throw err
  })
  return { queued, claimed: true, outcome }
}

/** Text the team when a customize run has gone on far too long, or queued jobs aren't being picked up. */
export async function watchCustomizeStalls(now = Date.now()): Promise<void> {
  const current = live
  if (current && !current.released && now - current.since > STUCK_AFTER_MS) {
    const row = await prisma.ghlCustomizeJob.findUnique({ where: { id: current.id }, select: { clientId: true, client: { select: { name: true } } } })
    if (row) {
      await textCustomizeProblem({
        key: current.id,
        kind: 'stuck',
        client: row.client.name,
        reason: `It started ${Math.round((now - current.since) / 60_000)} minutes ago.`,
        link: hubLink(`/automation-copy/${row.clientId}`),
      })
    }
  }
  const overdue = await prisma.ghlCustomizeJob.findMany({
    where: { status: 'queued', nextAttemptAt: { lt: new Date(now - WAITING_AFTER_MS) } },
    orderBy: { nextAttemptAt: 'asc' },
    take: 5,
    select: { id: true, clientId: true, nextAttemptAt: true, client: { select: { name: true } } },
  })
  for (const job of overdue) {
    await textCustomizeProblem({
      key: job.id,
      kind: 'waiting',
      client: job.client.name,
      reason: `${Math.round((now - job.nextAttemptAt.getTime()) / 60_000)} minutes`,
      link: hubLink(`/automation-copy/${job.clientId}`),
    })
  }
}

// ---------------------------------------------------------------------------
// What the board shows
// ---------------------------------------------------------------------------

export async function customizeView(clientId: string) {
  const [client, job, auto] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: { siteUrl: true, ghlLocationId: true, ghlSubaccountJob: { select: { status: true, locationId: true, detail: true } } },
    }),
    prisma.ghlCustomizeJob.findUnique({
      where: { clientId },
      select: {
        id: true,
        status: true,
        attempts: true,
        detail: true,
        lastError: true,
        siteUrl: true,
        trigger: true,
        progress: true,
        log: true,
        nextAttemptAt: true,
        heartbeatAt: true,
        finishedAt: true,
        updatedAt: true,
        shots: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, step: true, createdAt: true } },
      },
    }),
    customizeAutoOn(),
  ])
  if (!client) return null
  const sj = client.ghlSubaccountJob
  const madeByHub = !!sj && sj.status === 'succeeded' && sj.locationId === client.ghlLocationId && !/^(linked the existing|the client was already linked)/i.test((sj.detail ?? '').trim())
  return {
    auto,
    workerOn: workerEnabled(),
    mode: workerMode(),
    client: { siteUrl: client.siteUrl, locationId: client.ghlLocationId, madeByHub },
    job: job
      ? {
          ...job,
          progress: readProgress(job.progress),
          log: (Array.isArray(job.log) ? job.log : []).slice(-60),
          nextAttemptAt: job.nextAttemptAt.toISOString(),
          heartbeatAt: job.heartbeatAt?.toISOString() ?? null,
          finishedAt: job.finishedAt?.toISOString() ?? null,
          updatedAt: job.updatedAt.toISOString(),
          shots: job.shots.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
          stale: job.status === 'running' && isHeartbeatStale(job.heartbeatAt, job.updatedAt),
        }
      : null,
  }
}

export type CustomizeView = NonNullable<Awaited<ReturnType<typeof customizeView>>>
