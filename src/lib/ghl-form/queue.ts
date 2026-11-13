/**
 * The site-form job: one row per client (GhlFormJob). Right after the browser
 * worker makes a client's GHL sub-account and its snapshot loads, the form
 * from the snapshot ("A Plus Fence & Construction Forms") is made theirs
 * (./browser.ts): the consent checkboxes name their business, and an older
 * sub-account's A Plus logo and policy links go. "Fix the form in GHL" in the
 * client's Sites folder runs it for any linked sub-account, and a slow
 * catch-up goes through every linked client never checked (one at a time,
 * newest first): it only changes what still names A Plus, so forms already
 * fixed by hand are left as they are.
 *
 * Runs in the sub-account worker's tick on the one browser, after sub-account
 * creates and toll-free numbers, before workflow customizing.
 */
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { readProfile } from '@/lib/hl/accounts'
import { retryDelayMs, workerEnabled, workerHeadless, workerMode, workerPaused } from '@/lib/ghl-subaccount-worker/config'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, jobLogEntry } from '@/lib/ghl-subaccount-worker/heartbeat'
import { ghlLabels } from '@/lib/ghl-subaccount-worker/labels'
import { loadLogin, loadSession, makeOtpPuller, saveSession } from '@/lib/ghl-subaccount-worker/session-store'
import { runFormFix } from './browser'
import { consentName, mentionsTemplate } from './plan'

/**
 * The rules a check ran by. 2 (2026-11-13): the form's own Privacy Policy / Terms
 * blocks go wherever they point, and a site form renamed by hand is found and
 * cleaned too (version 1 left Done Rite's). Older checks are done again.
 */
export const FORM_VERSION = 2

const LEASE_MS = 30 * 60_000
const WALL_MS = 20 * 60_000
const MAX_TRIES = 3

class LeaseLost extends Error {
  constructor() {
    super('lease lost')
  }
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))
const logged = (prev: unknown, msg: string): Prisma.InputJsonValue => [...(Array.isArray(prev) ? prev : []), jobLogEntry(msg)].slice(-80) as Prisma.InputJsonValue

function environmentFailure(message: string): boolean {
  return /playwright|executable doesn't exist|browserType\.launch|Failed to launch|Cannot find (module|package)|libnss3|error while loading shared libraries/i.test(message)
}

/** Queue the client's form. A run already queued or under way is left alone. */
export async function queueFormFix(clientId: string, o: { trigger: 'snapshot' | 'manual' | 'catchup'; by?: string }): Promise<{ ok: boolean; reason: string; id?: string }> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, archivedAt: true, ghlLocationId: true, ghlFormJob: { select: { id: true, status: true, log: true } } },
  })
  if (!c) return { ok: false, reason: 'Client not found.' }
  if (c.archivedAt) return { ok: false, reason: 'The client is archived.' }
  if (!c.ghlLocationId) return { ok: false, reason: 'This client has no linked GHL sub-account yet.' }
  const job = c.ghlFormJob
  // A Plus Fence & Construction's own sub-account: its form, name and policy links really are A Plus's.
  if (mentionsTemplate(c.name)) {
    const detail = `This is A Plus Fence & Construction's own sub-account: its form, name and policy links are theirs, so it's left alone.`
    const done = { locationId: c.ghlLocationId, status: 'succeeded', trigger: o.trigger, detail, finishedAt: new Date(), version: FORM_VERSION }
    const row = await prisma.ghlFormJob.upsert({ where: { clientId }, create: { clientId, ...done, log: logged(null, detail) }, update: { ...done, log: logged(job?.log, detail) }, select: { id: true } })
    return { ok: true, reason: detail, id: row.id }
  }
  if (job && (job.status === 'queued' || job.status === 'running')) return { ok: true, reason: 'Already queued.', id: job.id }
  const msg =
    o.trigger === 'manual'
      ? `Queued by ${o.by ?? 'someone'} (Fix the form in GHL).`
      : o.trigger === 'catchup'
        ? 'Queued by the catch-up: a sub-account from before this job, never checked.'
        : 'Queued: the snapshot loaded into their new sub-account.'
  const data = {
    locationId: c.ghlLocationId,
    status: 'queued',
    trigger: o.trigger,
    attempts: 0,
    leaseUntil: null,
    heartbeatAt: null,
    nextAttemptAt: new Date(),
    lastError: null,
    detail: null,
    finishedAt: null,
  }
  const row = await prisma.ghlFormJob.upsert({
    where: { clientId },
    create: { clientId, ...data, log: logged(null, msg) },
    update: { ...data, log: logged(job?.log, msg) },
    select: { id: true },
  })
  return { ok: true, reason: 'Queued: the worker makes the form theirs in a few minutes.', id: row.id }
}

type Live = { id: string; getLease: () => Date; abort: () => void; released: boolean }
let live: Live | null = null
let stopping = false

/**
 * A run whose instance died mid-way (the 2 GB instance ran out of memory, or a
 * crash) is not tried again by itself: it ends as failed, and "Fix the form in
 * GHL" starts it again. Re-queuing it could crash the Hub over and over.
 */
export async function recoverAbandonedFormFixes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_STALE_MS)
  const stale = await prisma.ghlFormJob.findMany({
    where: { status: 'running', OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] },
    select: { id: true, log: true },
  })
  let recovered = 0
  for (const row of stale) {
    if (live?.id === row.id && !live.released) continue
    const res = await prisma.ghlFormJob.updateMany({
      where: { id: row.id, status: 'running', OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] },
      data: {
        status: 'failed',
        leaseUntil: null,
        heartbeatAt: null,
        finishedAt: now,
        detail: 'The Hub restarted in the middle of this run (it may have run out of memory), so it was stopped rather than tried again. Press Fix the form in GHL to run it again.',
        log: logged(row.log, 'The instance died mid-run (out of memory or a crash): stopped, not retried.'),
      },
    })
    recovered += res.count
  }
  return recovered
}

export async function releaseLiveFormFix(message: string): Promise<void> {
  stopping = true
  const current = live
  if (!current || current.released) return
  current.released = true
  current.abort()
  const lease = current.getLease()
  const row = await prisma.ghlFormJob.findFirst({ where: { id: current.id, leaseUntil: lease, status: 'running' }, select: { log: true } })
  if (!row) return
  await prisma.ghlFormJob.updateMany({
    where: { id: current.id, leaseUntil: lease, status: 'running' },
    data: { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(), log: logged(row.log, message) },
  })
}

async function claim(): Promise<{ id: string; lease: Date } | null> {
  const now = new Date()
  const due: Prisma.GhlFormJobWhereInput = { status: 'queued', nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }
  const next = await prisma.ghlFormJob.findFirst({ where: due, orderBy: { nextAttemptAt: 'asc' }, select: { id: true } })
  if (!next) return null
  const lease = new Date(now.getTime() + LEASE_MS + Math.floor(Math.random() * 1000))
  const res = await prisma.ghlFormJob.updateMany({ where: { id: next.id, ...due }, data: { status: 'running', leaseUntil: lease, heartbeatAt: new Date(), attempts: { increment: 1 } } })
  return res.count === 1 ? { id: next.id, lease } : null
}

async function saveJob(id: string, lease: Date, data: Prisma.GhlFormJobUpdateManyMutationInput): Promise<void> {
  const res = await prisma.ghlFormJob.updateMany({ where: { id, leaseUntil: lease }, data })
  if (res.count === 0) throw new LeaseLost()
}

async function appendLog(id: string, lease: Date, msg: string): Promise<void> {
  const row = await prisma.ghlFormJob.findFirst({ where: { id, leaseUntil: lease }, select: { log: true } })
  if (!row) throw new LeaseLost()
  await saveJob(id, lease, { log: logged(row.log, msg) })
}

/** Keep the latest page image (where it stopped, or the end); the Sites folder links it. */
async function saveShot(id: string, lease: Date, step: string, image: Buffer): Promise<void> {
  try {
    await saveJob(id, lease, { shot: Uint8Array.from(image), shotStep: step.slice(0, 180) })
  } catch {
    // A missing picture never stops the run.
  }
}

async function execute(id: string, lease: Date): Promise<string> {
  const job = await prisma.ghlFormJob.findFirst({
    where: { id, leaseUntil: lease },
    include: { client: { select: { id: true, name: true, archivedAt: true, ghlLocationId: true, hlAccount: { select: { profile: true } } } } },
  })
  if (!job) return 'lost'
  const ac = new AbortController()
  live = { id, getLease: () => lease, abort: () => ac.abort(), released: false }
  const client = job.client
  const note = (msg: string) => appendLog(id, lease, msg).catch(() => {})
  const finish = (status: string, detail: string, extra: Prisma.GhlFormJobUpdateManyMutationInput = {}) =>
    saveJob(id, lease, { status, detail: detail.slice(0, 4000), lastError: status === 'succeeded' ? null : detail.slice(0, 4000), leaseUntil: null, heartbeatAt: null, finishedAt: new Date(), version: FORM_VERSION, ...extra })
  let timer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  try {
    if (client.archivedAt) {
      await finish('failed', 'The client is archived, so the form was left alone.')
      return 'failed'
    }
    if (mentionsTemplate(client.name)) {
      await finish('succeeded', "This is A Plus Fence & Construction's own sub-account: its form, name and policy links are theirs, so it's left alone.")
      return 'succeeded'
    }
    const locationId = client.ghlLocationId ?? job.locationId
    if (workerMode() !== 'create') {
      await finish('needs_human', "The GHL worker is in dry-run mode, so the form wasn't changed.")
      return 'needs_human'
    }
    const business = consentName({ businessName: readProfile(client.hlAccount?.profile).businessName, clientName: client.name })
    await note(`Making the site form ${client.name}'s (${locationId}): the consent checkboxes name "${business}".`)
    timer = setTimeout(() => ac.abort(), WALL_MS)
    heartbeat = setInterval(() => {
      void prisma.ghlFormJob.updateMany({ where: { id, status: 'running', leaseUntil: lease }, data: { heartbeatAt: new Date() } }).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    const otp = makeOtpPuller(client.id, note)
    const result = await runFormFix({
      clientName: client.name,
      locationId,
      businessName: business,
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
      },
      onNote: note,
      capture: (step, image) => saveShot(id, lease, step, image),
      onFormId: async (formId) => {
        await saveJob(id, lease, { formId })
      },
    })
    if (result.storageState) await saveSession(result.storageState).catch(() => {})
    await note(result.detail)
    const extra = result.formId ? { formId: result.formId } : {}
    if (result.status === 'done') {
      await finish('succeeded', result.detail, extra)
      return 'succeeded'
    }
    if (result.status === 'needs_human') {
      await finish('needs_human', result.detail, extra)
      return 'needs_human'
    }
    throw new Error(result.detail)
  } catch (err) {
    if (live?.released || stopping) return 'released'
    if (err instanceof LeaseLost) return 'lost'
    const message = describe(err)
    if (ac.signal.aborted) {
      await finish('failed', `Stopped after ${Math.round(WALL_MS / 60_000)} minutes without finishing the form. ${message}`.slice(0, 2000)).catch(() => {})
      return 'failed'
    }
    if (environmentFailure(message) || job.attempts >= MAX_TRIES) {
      await finish('failed', (environmentFailure(message) ? `The browser didn't start: ${message}` : `Gave up after ${job.attempts} tries: ${message}`).slice(0, 2000)).catch(() => {})
      return 'failed'
    }
    const wait = retryDelayMs(job.attempts)
    await note(`Will try the form again in ${Math.round(wait / 60_000)} min (try ${job.attempts} of ${MAX_TRIES}): ${message}`.slice(0, 2000))
    await saveJob(id, lease, { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(Date.now() + wait), lastError: message.slice(0, 2000) }).catch(() => {})
    return 'retry'
  } finally {
    if (timer) clearTimeout(timer)
    if (heartbeat) clearInterval(heartbeat)
    if (live?.id === id) live = null
  }
}

/** One tick from the sub-account worker: recover, and (when the browser is free) run one queued form. */
const CATCHUP_GAP_MS = 3 * 60_000
let lastCatchup = 0

/**
 * The catch-up for sub-accounts made before this job (Alex, 2026-11-13: many
 * were fixed by hand, a few may still need it): when no form is queued or
 * running, queue the next linked client never checked, newest first, at most
 * one every few minutes, so the worker (and the 2 GB instance) is never swamped.
 */
async function catchUp(now = Date.now()): Promise<void> {
  if (now - lastCatchup < CATCHUP_GAP_MS) return
  lastCatchup = now
  if (await prisma.ghlFormJob.count({ where: { status: { in: ['queued', 'running'] } } })) return
  const next = await prisma.client.findFirst({
    // Never checked, or checked by older rules (and not waiting on a person under these).
    where: {
      archivedAt: null,
      ghlLocationId: { not: null },
      OR: [{ ghlFormJob: { is: null } }, { ghlFormJob: { is: { version: { lt: FORM_VERSION }, status: { notIn: ['queued', 'running'] } } } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (next) await queueFormFix(next.id, { trigger: 'catchup' })
}

export async function formFixTick(opts: { runBrowser: boolean }): Promise<{ claimed: boolean; outcome?: string }> {
  if (!workerEnabled()) return { claimed: false }
  await recoverAbandonedFormFixes().catch((err) => console.warn('[ghl-form] recovery:', describe(err)))
  if (opts.runBrowser && workerMode() === 'create' && !workerPaused()) await catchUp().catch((err) => console.warn('[ghl-form] catch-up:', describe(err)))
  if (!opts.runBrowser || workerPaused() || stopping) return { claimed: false }
  const claimed = await claim()
  if (!claimed) return { claimed: false }
  const outcome = await execute(claimed.id, claimed.lease).catch((err) => {
    if (err instanceof LeaseLost) return 'lost'
    throw err
  })
  return { claimed: true, outcome: `form:${outcome}` }
}
