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
 * Then, once the client's site link is in, the same job fills GHL's toll-free
 * registration form from the client's filing (the one Hell-level files with
 * Twilio) and stops before sending: Echo asks in the Office, and "Send it"
 * runs it again and presses Send Information for Verification.
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
import { HlInputError } from '@/lib/hl/http'
import { tollFreeFiling } from '@/lib/hl/verification'
import { runGhlNumber, runGhlRegistration } from './browser'
import { DAILY_BUY_CAP, displayNumber, underDailyCap } from './plan'
import { blankFields, formRows, ghlFormFields, rowsChanged, type GhlForm } from './register-plan'

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
    phase: 'number',
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
  if (job.phase === 'register') return executeRegistration(id, lease)
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
      // Next: GHL's toll-free registration, once the site is live (it's filled, then waits for an OK).
      await queueGhlRegistration(client.id).catch((err) => console.warn('[ghl-number] registration after purchase:', describe(err)))
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

/**
 * Queue GHL's toll-free registration for a client whose number is in GHL. By
 * itself (after the purchase, when the site link comes in, the sweep) it only
 * starts a registration that never ran; `again` fills it again after a hold or
 * a stop; `approve` fills it again and sends it. It waits for the site link,
 * since GHL's reviewers check the site's opt-in form and policy pages.
 */
export async function queueGhlRegistration(clientId: string, o: { approve?: boolean; again?: boolean; by?: string } = {}): Promise<{ ok: boolean; reason: string }> {
  const job = await prisma.ghlNumberJob.findUnique({
    where: { clientId },
    select: { id: true, status: true, phase: true, phoneNumber: true, registration: true, requestId: true, log: true, client: { select: { siteUrl: true, archivedAt: true } } },
  })
  if (!job?.phoneNumber) return { ok: false, reason: 'The client has no number in GHL yet.' }
  if (job.client.archivedAt) return { ok: false, reason: 'The client is archived.' }
  if (job.status === 'running') return { ok: false, reason: job.phase === 'register' ? 'The worker is filling GHL’s form right now.' : 'The worker is still getting the number.' }
  if (job.phase === 'number' && job.status !== 'succeeded' && job.status !== 'needs_human') return { ok: false, reason: 'The number isn’t settled in GHL yet.' }
  const request = await prisma.hlNumberRequest.findUnique({ where: { id: job.requestId }, select: { status: true, route: true } })
  if (request?.status !== 'bought' || request.route !== 'ghl') return { ok: false, reason: 'The Office request doesn’t show this number as bought in GHL.' }
  if (job.registration === 'submitted') return { ok: false, reason: 'The registration was already sent.' }
  if (!o.approve && !o.again && job.registration !== 'none' && job.registration !== 'waiting_site') return { ok: true, reason: job.registration }
  if (!job.client.siteUrl?.trim()) {
    if (job.registration !== 'waiting_site') await prisma.ghlNumberJob.update({ where: { id: job.id }, data: { registration: 'waiting_site', log: logged(job.log, 'Toll-free registration waits for the site link.') } })
    return { ok: false, reason: 'It waits for the site link (GHL’s reviewers check the live site).' }
  }
  await prisma.ghlNumberJob.update({
    where: { id: job.id },
    data: {
      phase: 'register',
      status: 'queued',
      registration: o.approve ? 'approved' : 'queued',
      attempts: 0,
      leaseUntil: null,
      heartbeatAt: null,
      nextAttemptAt: new Date(),
      log: logged(
        job.log,
        o.approve
          ? `Registration approved by ${o.by ?? 'someone'}: the worker fills GHL’s form again and sends it.`
          : o.again
            ? `Registration to be filled again (${o.by ?? 'someone'}), then held for an OK.`
            : 'Toll-free registration queued: filled, then held for an OK in the Office.',
      ),
    },
  })
  return { ok: true, reason: o.approve ? 'approved' : 'queued' }
}

/** The Office answer on GHL's toll-free registration: send what was filled, hold it, or fill it again. */
export async function decideGhlRegistration(
  jobId: string,
  decision: 'submit' | 'hold' | 'retry',
  by: string,
): Promise<{ ok: true; status: string; detail: string } | { ok: false; reason: string }> {
  const job = await prisma.ghlNumberJob.findUnique({ where: { id: jobId }, select: { id: true, clientId: true, registration: true, log: true } })
  if (!job) return { ok: false, reason: 'That registration is gone.' }
  const now = job.registration.replace(/_/g, ' ')
  if (decision === 'hold') {
    if (job.registration !== 'review' && job.registration !== 'needs_human') return { ok: false, reason: `There’s nothing to hold (it’s ${now}).` }
    await prisma.ghlNumberJob.update({ where: { id: jobId }, data: { registration: 'held', log: logged(job.log, `Registration held by ${by}.`) } })
    return { ok: true, status: 'held', detail: 'On hold. Fill it again from the client’s folder in Sites.' }
  }
  if (decision === 'submit' && job.registration !== 'review') return { ok: false, reason: `It isn’t waiting for an OK (it’s ${now}).` }
  if (decision === 'retry' && !['review', 'held', 'needs_human'].includes(job.registration)) return { ok: false, reason: `It can’t be filled again while it’s ${now}.` }
  const res = await queueGhlRegistration(job.clientId, decision === 'submit' ? { approve: true, by } : { again: true, by })
  if (!res.ok) return { ok: false, reason: res.reason }
  return decision === 'submit'
    ? { ok: true, status: 'approved', detail: 'The worker fills GHL’s form again and sends it, in a few minutes.' }
    : { ok: true, status: 'queued', detail: 'The worker fills GHL’s form again and asks you before sending.' }
}

const asJson = (v: unknown) => v as Prisma.InputJsonValue

/** Fill (and, when approved, send) GHL's toll-free registration form for the client's GHL number. */
async function executeRegistration(id: string, lease: Date): Promise<string> {
  const job = await prisma.ghlNumberJob.findFirst({ where: { id, leaseUntil: lease }, include: { client: { select: { id: true, name: true, archivedAt: true } } } })
  if (!job) return 'lost'
  const request = await prisma.hlNumberRequest.findUnique({ where: { id: job.requestId }, select: { id: true, accountId: true } })
  const ac = new AbortController()
  live = { id, getLease: () => lease, abort: () => ac.abort(), released: false }
  const note = (msg: string) => appendLog(id, lease, msg).catch(() => {})
  /** The run's answer: review (filled, waiting for an OK), submitted, or a stop a person fixes (Echo asks in the Office). */
  const settle = async (registration: 'review' | 'submitted' | 'needs_human', detail: string, extra: Prisma.GhlNumberJobUpdateManyMutationInput = {}): Promise<string> => {
    await note(detail)
    await saveJob(id, lease, {
      phase: 'number',
      status: registration === 'needs_human' ? 'needs_human' : 'succeeded',
      registration,
      regDetail: detail.slice(0, 4000),
      regAt: new Date(),
      leaseUntil: null,
      heartbeatAt: null,
      finishedAt: new Date(),
      ...extra,
    })
    if (registration === 'needs_human') await textNumberEvent({ key: `${id}.reg`, kind: 'verify', client: job.client.name, reason: detail, link: hubLink('/office') })
    return registration
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  try {
    if (job.client.archivedAt) return await settle('needs_human', 'The client is archived, so nothing was filled.')
    if (!request || !job.phoneNumber) return await settle('needs_human', 'The client has no number in GHL on file, so nothing was filled.')
    let form: GhlForm
    try {
      form = ghlFormFields(await tollFreeFiling(request.accountId))
    } catch (err) {
      // What any toll-free filing needs first (the full address, the site's own policy pages, …); anything else is retried.
      if (!(err instanceof HlInputError)) throw err
      return await settle('needs_human', `${describe(err)} Nothing was sent.`)
    }
    const blanks = blankFields(form)
    if (blanks.length) return await settle('needs_human', `GHL's toll-free form needs ${blanks.join(', ')}, which the client's details don't have. Nothing was sent.`)
    const rows = formRows(form)
    // Send only what a person saw: details that changed since are filled again and asked about again.
    const approved = job.registration === 'approved'
    const changed = approved && rowsChanged(job.regFields, form)
    const send = approved && !changed && workerMode() === 'create'
    await note(
      `${send ? 'Sending' : 'Filling'} GHL's toll-free registration for ${displayNumber(job.phoneNumber)}${send ? '' : ' (stopping before Send, for an OK in the Office)'}.${changed ? ' The client’s details changed after the OK.' : ''}`,
    )
    timer = setTimeout(() => ac.abort(), WALL_MS)
    heartbeat = setInterval(() => {
      void prisma.ghlNumberJob.updateMany({ where: { id, status: 'running', leaseUntil: lease }, data: { heartbeatAt: new Date() } }).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    const otp = makeOtpPuller(job.client.id, note)
    const result = await runGhlRegistration({
      clientName: job.client.name,
      locationId: job.locationId,
      number: job.phoneNumber,
      form,
      submit: send,
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
    })
    if (result.storageState) await saveSession(result.storageState).catch(() => {})
    if (result.status === 'review') {
      const why = changed
        ? 'The client’s details changed after the OK, so the Hub filled the form again with the new ones and didn’t send it. '
        : approved && !send
          ? 'Dry-run mode: nothing is sent. '
          : ''
      return await settle('review', `${why}${result.detail}`, { regFields: asJson(rows) })
    }
    if (result.status === 'submitted') return await settle('submitted', result.detail, { regFields: asJson(rows) })
    if (result.status === 'already') return await settle('submitted', result.detail)
    if (result.status === 'needs_human') return await settle('needs_human', result.detail)
    throw new Error(result.detail)
  } catch (err) {
    if (live?.released || stopping) return 'released'
    if (err instanceof LeaseLost) return 'lost'
    const message = describe(err)
    if (ac.signal.aborted) return await settle('needs_human', `Stopped after ${Math.round(WALL_MS / 60_000)} minutes without finishing GHL's toll-free form.`).catch(() => 'lost')
    // Filling is safe to repeat: a run first checks GHL still shows "Verification Required" (browser.ts).
    if (environmentFailure(message) || job.attempts >= MAX_TRIES) {
      return await settle('needs_human', (environmentFailure(message) ? `The browser didn't start: ${message}` : `Gave up on GHL's toll-free form after ${job.attempts} tries: ${message}`).slice(0, 2000)).catch(() => 'lost')
    }
    const wait = retryDelayMs(job.attempts)
    await note(`Will try GHL's toll-free form again in ${Math.round(wait / 60_000)} min (try ${job.attempts} of ${MAX_TRIES}): ${message}`.slice(0, 2000))
    await saveJob(id, lease, { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(Date.now() + wait), lastError: message.slice(0, 2000) }).catch(() => {})
    return 'retry'
  } finally {
    if (timer) clearTimeout(timer)
    if (heartbeat) clearInterval(heartbeat)
    if (live?.id === id) live = null
  }
}

let lastRegSweep = 0

/** Every 10 minutes: registrations whose site link came in while nothing was listening. */
async function sweepRegistrations(now = Date.now()): Promise<void> {
  if (now - lastRegSweep < 10 * 60_000) return
  lastRegSweep = now
  const due = await prisma.ghlNumberJob.findMany({
    where: { phoneNumber: { not: null }, registration: { in: ['none', 'waiting_site'] }, status: { in: ['succeeded', 'needs_human'] }, client: { siteUrl: { not: null }, archivedAt: null } },
    select: { clientId: true },
    take: 10,
  })
  for (const d of due) await queueGhlRegistration(d.clientId).catch(() => {})
}

/** One tick from the sub-account worker: recover, and (when the browser is free) run one queued job. */
export async function ghlNumberTick(opts: { runBrowser: boolean }): Promise<{ claimed: boolean; outcome?: string }> {
  if (!workerEnabled()) return { claimed: false }
  await recoverAbandonedGhlNumbers().catch((err) => console.warn('[ghl-number] recovery:', describe(err)))
  await sweepRegistrations().catch((err) => console.warn('[ghl-number] registration sweep:', describe(err)))
  if (!opts.runBrowser || workerPaused() || stopping) return { claimed: false }
  const claimed = await claim()
  if (!claimed) return { claimed: false }
  const outcome = await execute(claimed.id, claimed.lease).catch((err) => {
    if (err instanceof LeaseLost) return 'lost'
    throw err
  })
  return { claimed: true, outcome }
}
