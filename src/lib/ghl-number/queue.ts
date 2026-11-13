/**
 * The GHL route of a client's toll-free number: the browser worker's job.
 *
 * In the Office, Echo asks whether to buy the client's number in Hell-level
 * or in GHL. For GHL, a person passes GHL's ID check for the client's
 * sub-account (it starts when you go to buy a number there) and presses
 * "Identification complete" (src/lib/hl/number-request.ts), which queues this
 * job. The worker takes the toll-free number bought during the check (or buys
 * one), points its calls at the client's phone, and settles the Office
 * request: bought, back to the ID check (GHL still asks for it), or failed.
 *
 * Runs in the sub-account worker's tick on the one browser, after sub-account
 * creates and before workflow customizing. At most DAILY_BUY_CAP purchases a day.
 */
import { Prisma } from '@/generated/prisma/client'
import { hubLink } from '@/lib/hub-alerts'
import { prisma } from '@/lib/prisma'
import { textNumberEvent } from '@/lib/ghl-subaccount-worker/alerts'
import { retryDelayMs, workerEnabled, workerHeadless, workerMode, workerPaused } from '@/lib/ghl-subaccount-worker/config'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, jobLogEntry } from '@/lib/ghl-subaccount-worker/heartbeat'
import { ghlLabels } from '@/lib/ghl-subaccount-worker/labels'
import { loadLogin, loadSession, makeOtpPuller, saveSession } from '@/lib/ghl-subaccount-worker/session-store'
import { runGhlNumber } from './browser'
import { DAILY_BUY_CAP, displayNumber, underDailyCap } from './plan'

const LEASE_MS = 45 * 60_000
const WALL_MS = 30 * 60_000
const MAX_TRIES = 3

class LeaseLost extends Error {
  constructor() {
    super('lease lost')
  }
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))
const logged = (prev: unknown, msg: string): Prisma.InputJsonValue => [...(Array.isArray(prev) ? prev : []), jobLogEntry(msg)].slice(-80) as Prisma.InputJsonValue

/** Where a person passes GHL's ID check for a sub-account: its Phone System (Add Number → Proceed to Buy starts it). */
export function ghlPhoneSystemLink(locationId: string): string {
  return `https://app.gohighlevel.com/v2/location/${locationId}/settings/phone_system?tab=manage`
}

function environmentFailure(message: string): boolean {
  return /playwright|executable doesn't exist|browserType\.launch|Failed to launch|Cannot find (module|package)|libnss3|error while loading shared libraries/i.test(message)
}

/** "Identification complete": queue the worker for this client. Keeps an earlier run's picked or bought number. */
export async function queueGhlNumber(o: { clientId: string; requestId: string; locationId: string; by: string }): Promise<{ id: string }> {
  const prior = await prisma.ghlNumberJob.findUnique({ where: { clientId: o.clientId }, select: { log: true } })
  const data = {
    requestId: o.requestId,
    locationId: o.locationId,
    status: 'queued',
    attempts: 0,
    leaseUntil: null,
    heartbeatAt: null,
    nextAttemptAt: new Date(),
    lastError: null,
    detail: null,
    finishedAt: null,
  }
  const msg = `Queued by ${o.by}: identification complete.`
  return prisma.ghlNumberJob.upsert({
    where: { clientId: o.clientId },
    create: { clientId: o.clientId, ...data, log: logged(null, msg) },
    update: { ...data, log: logged(prior?.log, msg) },
    select: { id: true },
  })
}

/** The Office request this job answers. */
async function settleRequest(requestId: string, data: Prisma.HlNumberRequestUpdateInput, msg: string): Promise<void> {
  const row = await prisma.hlNumberRequest.findUnique({ where: { id: requestId }, select: { log: true } })
  if (!row) return
  await prisma.hlNumberRequest.update({ where: { id: requestId }, data: { ...data, log: logged(row.log, msg) } })
}

type Live = { id: string; getLease: () => Date; abort: () => void; released: boolean }
let live: Live | null = null
let stopping = false

export async function recoverAbandonedGhlNumbers(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_STALE_MS)
  const stale = await prisma.ghlNumberJob.findMany({
    where: { status: 'running', OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] },
    select: { id: true, log: true },
  })
  let recovered = 0
  for (const row of stale) {
    if (live?.id === row.id && !live.released) continue
    const res = await prisma.ghlNumberJob.updateMany({
      where: { id: row.id, status: 'running', OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }] },
      data: { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: now, log: logged(row.log, 'Recovered a run abandoned by a restarted instance.') },
    })
    recovered += res.count
  }
  return recovered
}

export async function releaseLiveGhlNumber(message: string): Promise<void> {
  stopping = true
  const current = live
  if (!current || current.released) return
  current.released = true
  current.abort()
  const lease = current.getLease()
  const row = await prisma.ghlNumberJob.findFirst({ where: { id: current.id, leaseUntil: lease, status: 'running' }, select: { log: true } })
  if (!row) return
  await prisma.ghlNumberJob.updateMany({
    where: { id: current.id, leaseUntil: lease, status: 'running' },
    data: { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(), log: logged(row.log, message) },
  })
}

async function claim(): Promise<{ id: string; lease: Date } | null> {
  const now = new Date()
  const due: Prisma.GhlNumberJobWhereInput = { status: 'queued', nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }
  const next = await prisma.ghlNumberJob.findFirst({ where: due, orderBy: { nextAttemptAt: 'asc' }, select: { id: true } })
  if (!next) return null
  const lease = new Date(now.getTime() + LEASE_MS + Math.floor(Math.random() * 1000))
  const res = await prisma.ghlNumberJob.updateMany({ where: { id: next.id, ...due }, data: { status: 'running', leaseUntil: lease, heartbeatAt: new Date(), attempts: { increment: 1 } } })
  return res.count === 1 ? { id: next.id, lease } : null
}

async function saveJob(id: string, lease: Date, data: Prisma.GhlNumberJobUpdateManyMutationInput): Promise<void> {
  const res = await prisma.ghlNumberJob.updateMany({ where: { id, leaseUntil: lease }, data })
  if (res.count === 0) throw new LeaseLost()
}

async function appendLog(id: string, lease: Date, msg: string): Promise<void> {
  const row = await prisma.ghlNumberJob.findFirst({ where: { id, leaseUntil: lease }, select: { log: true } })
  if (!row) throw new LeaseLost()
  await saveJob(id, lease, { log: logged(row.log, msg) })
}

async function saveShot(id: string, lease: Date, step: string, image: Buffer): Promise<void> {
  const label = step.slice(0, 180)
  try {
    const shot = await prisma.ghlNumberJobShot.create({ data: { jobId: id, step: label, mime: 'image/jpeg', data: Uint8Array.from(image) }, select: { id: true } })
    const older = await prisma.ghlNumberJobShot.findMany({ where: { jobId: id }, orderBy: { createdAt: 'desc' }, skip: 10, select: { id: true } })
    if (older.length) await prisma.ghlNumberJobShot.deleteMany({ where: { id: { in: older.map((r) => r.id) } } })
    await appendLog(id, lease, `Screenshot ${shot.id} at step ${label}`)
  } catch (err) {
    await appendLog(id, lease, `Screenshot save failed at step ${label}: ${describe(err).slice(0, 300)}`).catch(() => {})
  }
}

async function execute(id: string, lease: Date): Promise<string> {
  const job = await prisma.ghlNumberJob.findFirst({ where: { id, leaseUntil: lease }, include: { client: { select: { id: true, name: true, archivedAt: true } } } })
  if (!job) return 'lost'
  const request = await prisma.hlNumberRequest.findUnique({ where: { id: job.requestId }, select: { id: true, forwardTo: true } })
  const ac = new AbortController()
  live = { id, getLease: () => lease, abort: () => ac.abort(), released: false }
  const client = job.client
  const office = hubLink('/office')
  const note = (msg: string) => appendLog(id, lease, msg).catch(() => {})
  const finish = (status: string, detail: string, extra: Prisma.GhlNumberJobUpdateManyMutationInput = {}) =>
    saveJob(id, lease, { status, detail: detail.slice(0, 4000), lastError: status === 'succeeded' ? null : detail.slice(0, 4000), leaseUntil: null, heartbeatAt: null, finishedAt: new Date(), ...extra })
  const failed = async (detail: string): Promise<string> => {
    await note(detail)
    await finish('failed', detail).catch(() => {})
    if (request) await settleRequest(request.id, { status: 'failed', detail }, detail).catch(() => {})
    await textNumberEvent({ key: id, kind: 'failed', client: client.name, reason: detail, link: office })
    return 'failed'
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  try {
    if (client.archivedAt) return await failed('The client is archived, so nothing was bought.')
    if (!request) return await failed('The Office question this answers is gone, so nothing was bought.')
    if (!job.phoneNumber && !job.pickedNumber) {
      const day = await prisma.ghlNumberJob.count({ where: { id: { not: id }, buyStartedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } } })
      if (!underDailyCap(day)) {
        const detail = `The Hub already bought ${day} numbers in GHL in the last 24 hours (the limit is ${DAILY_BUY_CAP}), so this one waits an hour.`
        await note(detail)
        await saveJob(id, lease, { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(Date.now() + 60 * 60_000), detail })
        return 'capped'
      }
    }
    const save = workerMode() === 'create'
    await note(`Getting ${client.name}'s toll-free number in GHL (${job.locationId}). Calls should ring ${request.forwardTo ? displayNumber(request.forwardTo) : '(no phone on file)'}. ${save ? '' : 'Dry-run mode: nothing will be bought.'}`.trim())

    timer = setTimeout(() => ac.abort(), WALL_MS)
    heartbeat = setInterval(() => {
      void prisma.ghlNumberJob.updateMany({ where: { id, status: 'running', leaseUntil: lease }, data: { heartbeatAt: new Date() } }).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    const otp = makeOtpPuller(client.id, note)
    const result = await runGhlNumber({
      clientName: client.name,
      locationId: job.locationId,
      businessPhone: request.forwardTo ?? '',
      state: { pickedNumber: job.pickedNumber, buyStartedAt: job.buyStartedAt, phoneNumber: job.phoneNumber },
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
      },
      onNote: note,
      capture: (step, image) => saveShot(id, lease, step, image),
      onPicked: async (number) => {
        await saveJob(id, lease, { pickedNumber: number, buyStartedAt: new Date() })
      },
      onBuyAbandoned: async () => {
        await saveJob(id, lease, { pickedNumber: null, buyStartedAt: null }).catch(() => {})
      },
      onNumber: async (number) => {
        await saveJob(id, lease, { phoneNumber: number })
      },
    })
    if (result.storageState) await saveSession(result.storageState).catch(() => {})
    await note(result.detail)
    if (result.status === 'done' || (result.status === 'needs_human' && result.phoneNumber)) {
      // The number is the client's either way; a forwarding problem is said in the detail.
      await finish(result.status === 'done' ? 'succeeded' : 'needs_human', result.detail, { phoneNumber: result.phoneNumber, ...(result.forwardsTo ? { forwardsTo: result.forwardsTo } : {}) })
      await settleRequest(
        request.id,
        { status: 'bought', route: 'ghl', number: result.phoneNumber, forwardTo: result.forwardsTo ?? request.forwardTo, detail: result.detail },
        `${result.adopted ? 'Took' : 'Bought'} ${displayNumber(result.phoneNumber!)} in GHL. ${result.detail}`,
      )
      return result.status === 'done' ? 'succeeded' : 'needs_human'
    }
    if (result.status === 'needs_identity') {
      await finish('needs_identity', result.detail)
      await settleRequest(request.id, { status: 'awaiting_identity', detail: result.detail }, result.detail)
      return 'needs_identity'
    }
    if (result.status === 'rehearsed') {
      await finish('dry_run', result.detail)
      await settleRequest(request.id, { status: 'awaiting_identity', detail: result.detail }, result.detail)
      return 'dry_run'
    }
    if (result.status === 'needs_human') {
      await finish('needs_human', result.detail)
      await settleRequest(request.id, { status: 'failed', detail: result.detail }, result.detail)
      await textNumberEvent({ key: id, kind: 'failed', client: client.name, reason: result.detail, link: office })
      return 'needs_human'
    }
    throw new Error(result.detail)
  } catch (err) {
    if (live?.released || stopping) return 'released'
    if (err instanceof LeaseLost) return 'lost'
    const message = describe(err)
    if (ac.signal.aborted) return await failed(`Stopped after ${Math.round(WALL_MS / 60_000)} minutes without finishing. ${message}`.slice(0, 2000))
    // Past "Proceed to Buy", a retry only looks for that number; it never buys blind (browser.ts).
    if (environmentFailure(message) || job.attempts >= MAX_TRIES) {
      return await failed(environmentFailure(message) ? `The browser didn't start: ${message}` : `Gave up after ${job.attempts} tries: ${message}`)
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

/** One tick from the sub-account worker: recover, and (when the browser is free) run one queued job. */
export async function ghlNumberTick(opts: { runBrowser: boolean }): Promise<{ claimed: boolean; outcome?: string }> {
  if (!workerEnabled()) return { claimed: false }
  await recoverAbandonedGhlNumbers().catch((err) => console.warn('[ghl-number] recovery:', describe(err)))
  if (!opts.runBrowser || workerPaused() || stopping) return { claimed: false }
  const claimed = await claim()
  if (!claimed) return { claimed: false }
  const outcome = await execute(claimed.id, claimed.lease).catch((err) => {
    if (err instanceof LeaseLost) return 'lost'
    throw err
  })
  return { claimed: true, outcome }
}
