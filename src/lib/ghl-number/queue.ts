/**
 * The toll-free number queue: one GhlNumberJob per client.
 *
 * When a client's sub-account is ready (the Hub's worker created it and the
 * snapshot loaded), Atlas asks in the Office: "Purchase a toll-free number for
 * <client> and transfer it to their sub-account?" (status awaiting_approval,
 * and a text). Yes queues it; the worker then buys a number in the number bank
 * (Lead Genisys, which has done GHL's one-time identity check), moves exactly
 * that number into the client's sub-account with GHL's Move Numbers, and makes
 * sure its calls ring the client's phone. No drops it. An admin can also start
 * one from the client's sub-account page (existing clients).
 *
 * Runs in the sub-account worker's tick on the one browser, after sub-account
 * creates and before workflow customizing. At most DAILY_BUY_CAP purchases a day.
 */
import { Prisma } from '@/generated/prisma/client'
import { boardInputs } from '@/lib/automation-copy-server'
import { getAgencyContext, getLocation } from '@/lib/ghl-agency'
import { hubLink } from '@/lib/hub-alerts'
import { prisma } from '@/lib/prisma'
import { STUCK_AFTER_MS, WAITING_AFTER_MS, type NumberAlertKind } from '@/lib/ghl-subaccount-worker/alert-text'
import { textNumberEvent } from '@/lib/ghl-subaccount-worker/alerts'
import { retryDelayMs, workerEnabled, workerHeadless, workerMode, workerPaused } from '@/lib/ghl-subaccount-worker/config'
import { readBrowserFields } from '@/lib/ghl-subaccount-worker/fields'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, isHeartbeatStale, jobLogEntry } from '@/lib/ghl-subaccount-worker/heartbeat'
import { ghlLabels } from '@/lib/ghl-subaccount-worker/labels'
import { loadLogin, loadSession, makeOtpPuller, saveSession } from '@/lib/ghl-subaccount-worker/session-store'
import { runNumberInBrowser } from './browser'
import { autoNumberDecision, DAILY_BUY_CAP, displayNumber, e164, underDailyCap } from './plan'

/** Lead Genisys, chosen by Alex on 2026-11-12 as the number bank. AppSetting ghlNumber.bank overrides it. */
export const DEFAULT_BANK_LOCATION_ID = 'Un2gpKogY08n03cothWm'
const ASK_KEY = 'ghlNumber.ask'
const SINCE_KEY = 'ghlNumber.since'
const BANK_KEY = 'ghlNumber.bank'
const LEASE_MS = 45 * 60_000
const WALL_MS = 30 * 60_000
const MAX_TRIES = 3
const SWEEP_EVERY_MS = 5 * 60_000

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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Ask for a number when a new sub-account is ready. On unless switched off in Settings. */
export async function numberAskOn(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: ASK_KEY } }).catch(() => null)
  return row?.value !== 'off'
}

export async function setNumberAsk(on: boolean): Promise<void> {
  const value = on ? 'on' : 'off'
  await prisma.appSetting.upsert({ where: { key: ASK_KEY }, create: { key: ASK_KEY, value }, update: { value } })
  if (on) await numberSince()
}

/** When asking started: only sub-accounts created after it are asked about by themselves. */
export async function numberSince(now = new Date()): Promise<Date> {
  const row = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  if (row?.value && !Number.isNaN(Date.parse(row.value))) return new Date(row.value)
  try {
    await prisma.appSetting.create({ data: { key: SINCE_KEY, value: now.toISOString() } })
  } catch {
    // Another process recorded it first.
  }
  const again = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  return new Date(again?.value && !Number.isNaN(Date.parse(again.value)) ? again.value : now.toISOString())
}

export async function bankLocationId(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: BANK_KEY } }).catch(() => null)
  const id = row?.value?.trim()
  return id || DEFAULT_BANK_LOCATION_ID
}

// ---------------------------------------------------------------------------
// Asking, approving, starting
// ---------------------------------------------------------------------------

export type NumberQueueResult = { ok: true; status: string; jobId: string } | { ok: false; reason: string }

/** The sub-account's name as GHL shows it now; the name it was created with when GHL can't be asked. */
async function subAccountNameNow(locationId: string, fallback: string | null): Promise<string | null> {
  try {
    const loc = await getLocation(await getAgencyContext(), locationId)
    if (loc?.name) return loc.name
  } catch (err) {
    console.warn('[ghl-number] sub-account name lookup:', describe(err))
  }
  return fallback
}

const IN_HAND = new Set(['awaiting_approval', 'queued', 'running'])

/**
 * Put a request in the Office for this client's number (and text the team).
 * 'subaccount' and 'sweep' follow the rules in plan.ts; 'manual' only needs a
 * linked sub-account.
 */
export async function askForNumber(clientId: string, trigger: 'subaccount' | 'sweep' | 'manual'): Promise<NumberQueueResult> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      ghlLocationId: true,
      ghlSubaccountJob: { select: { status: true, locationId: true, detail: true, finishedAt: true, payload: true } },
      ghlNumberJob: { select: { id: true, status: true, log: true } },
    },
  })
  if (!c) return { ok: false, reason: 'Client not found.' }
  if (!c.ghlLocationId) return { ok: false, reason: 'This client has no linked GHL sub-account yet.' }
  const job = c.ghlNumberJob
  if (job && (IN_HAND.has(job.status) || job.status === 'succeeded')) return { ok: true, status: job.status, jobId: job.id }
  if (trigger !== 'manual') {
    if (!workerEnabled()) return { ok: false, reason: 'The GHL browser worker is switched off.' }
    const decision = autoNumberDecision({
      archived: !!c.archivedAt,
      locationId: c.ghlLocationId,
      subaccountJob: c.ghlSubaccountJob
        ? { status: c.ghlSubaccountJob.status, locationId: c.ghlSubaccountJob.locationId, detail: c.ghlSubaccountJob.detail, finishedAt: c.ghlSubaccountJob.finishedAt }
        : null,
      job: job ? { status: job.status } : null,
      autoSince: (await numberAskOn()) ? await numberSince() : null,
    })
    if (!decision.queue) return { ok: false, reason: decision.reason }
  }
  const msg = `Waiting for approval in the Office (${trigger === 'manual' ? 'asked from the client page' : 'the sub-account is ready'}).`
  const subName = await subAccountNameNow(c.ghlLocationId, readBrowserFields(c.ghlSubaccountJob?.payload)?.name || null)
  const data = {
    locationId: c.ghlLocationId,
    locationName: subName,
    status: 'awaiting_approval',
    trigger,
    attempts: 0,
    leaseUntil: null,
    heartbeatAt: null,
    nextAttemptAt: new Date(),
    lastError: null,
    detail: null,
    finishedAt: null,
  }
  const row = await prisma.ghlNumberJob.upsert({
    where: { clientId },
    create: { clientId, ...data, log: logged(null, msg) },
    update: { ...data, log: logged(job?.log, msg) },
    select: { id: true },
  })
  await textNumberEvent({ key: row.id, kind: 'approve', client: c.name, subAccountName: subName || c.name, reason: subName ?? '', link: hubLink('/office') })
  return { ok: true, status: 'awaiting_approval', jobId: row.id }
}

/** Yes or No on an Office request. */
export async function decideNumber(jobId: string, decision: 'yes' | 'no', by: string): Promise<NumberQueueResult> {
  const job = await prisma.ghlNumberJob.findUnique({ where: { id: jobId }, select: { id: true, status: true, log: true } })
  if (!job) return { ok: false, reason: 'That request is gone.' }
  if (job.status !== 'awaiting_approval') return { ok: false, reason: `It is already ${job.status.replace('_', ' ')}.` }
  const yes = decision === 'yes'
  const res = await prisma.ghlNumberJob.updateMany({
    where: { id: jobId, status: 'awaiting_approval' },
    data: {
      status: yes ? 'queued' : 'declined',
      nextAttemptAt: new Date(),
      finishedAt: yes ? null : new Date(),
      detail: yes ? null : `Declined by ${by}.`,
      log: logged(job.log, yes ? `Approved by ${by}.` : `Declined by ${by}.`),
    },
  })
  if (res.count !== 1) return { ok: false, reason: 'Someone else answered it first.' }
  return { ok: true, status: yes ? 'queued' : 'declined', jobId }
}

/**
 * An admin started it from the client page: that press is the approval. After
 * a purchase that never showed up (pickedNumber and buyStartedAt set, no
 * number), the page asks the admin to check GHL first, so this press also
 * says "it wasn't bought": the run still looks for that number in the bank,
 * and buys a new one only if it isn't there.
 */
export async function startNumberNow(clientId: string, by: string): Promise<NumberQueueResult> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { ghlLocationId: true, ghlNumberJob: { select: { id: true, status: true, heartbeatAt: true, updatedAt: true, log: true, pickedNumber: true, buyStartedAt: true, phoneNumber: true } } },
  })
  if (!c) return { ok: false, reason: 'Client not found.' }
  if (!c.ghlLocationId) return { ok: false, reason: 'This client has no linked GHL sub-account yet.' }
  const job = c.ghlNumberJob
  const stale = job?.status === 'running' && isHeartbeatStale(job.heartbeatAt, job.updatedAt)
  if (job && (job.status === 'queued' || (job.status === 'running' && !stale))) return { ok: true, status: job.status, jobId: job.id }
  const unfinished = !!job?.pickedNumber && !!job.buyStartedAt && !job.phoneNumber
  const data = {
    locationId: c.ghlLocationId,
    status: 'queued',
    trigger: 'manual',
    attempts: 0,
    leaseUntil: null,
    heartbeatAt: null,
    nextAttemptAt: new Date(),
    lastError: null,
    detail: null,
    finishedAt: null,
    ...(unfinished ? { buyStartedAt: null } : {}),
  }
  const msg = unfinished
    ? `Started by ${by} from the client page, after checking that ${displayNumber(job!.pickedNumber!)} wasn't bought.`
    : `Started by ${by} from the client page.`
  const row = await prisma.ghlNumberJob.upsert({
    where: { clientId },
    create: { clientId, ...data, log: logged(null, msg) },
    update: { ...data, log: logged(job?.log, msg) },
    select: { id: true },
  })
  return { ok: true, status: 'queued', jobId: row.id }
}

/** From the sub-account worker, once GHL has loaded the snapshot into a sub-account it created. Never throws. */
export async function numberAfterCreate(clientId: string): Promise<void> {
  try {
    const res = await askForNumber(clientId, 'subaccount')
    console.log(`[ghl-number] after create ${clientId}: ${res.ok ? res.status : res.reason}`)
  } catch (err) {
    console.warn(`[ghl-number] after create ${clientId}:`, describe(err))
  }
}

let lastSweep = 0

/** Every few minutes: ask about ready sub-accounts the create hook missed (a restart, a manual link). */
export async function sweepNumbers(now = Date.now()): Promise<number> {
  if (now - lastSweep < SWEEP_EVERY_MS) return 0
  lastSweep = now
  if (!(await numberAskOn())) return 0
  const since = await numberSince()
  const rows = await prisma.client.findMany({
    where: { archivedAt: null, ghlLocationId: { not: null }, ghlNumberJob: { is: null }, ghlSubaccountJob: { is: { status: 'succeeded', finishedAt: { gte: since } } } },
    select: { id: true },
    take: 50,
  })
  let asked = 0
  for (const r of rows) {
    const res = await askForNumber(r.id, 'sweep')
    if (res.ok && res.status === 'awaiting_approval') asked += 1
  }
  return asked
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

type Live = { id: string; getLease: () => Date; abort: () => void; released: boolean; since: number }
let live: Live | null = null
let stopping = false

export async function recoverAbandonedNumbers(now = new Date()): Promise<number> {
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

export async function releaseLiveNumber(message: string): Promise<void> {
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

async function claimNumber(): Promise<{ id: string; lease: Date } | null> {
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

async function executeNumber(id: string, lease: Date): Promise<string> {
  const job = await prisma.ghlNumberJob.findFirst({
    where: { id, leaseUntil: lease },
    include: { client: { select: { id: true, name: true, archivedAt: true, ghlLocationId: true, ghlSubaccountJob: { select: { payload: true } } } } },
  })
  if (!job) return 'lost'
  const ac = new AbortController()
  live = { id, getLease: () => lease, abort: () => ac.abort(), released: false, since: Date.now() }
  const client = job.client
  const subName = readBrowserFields(client.ghlSubaccountJob?.payload)?.name || client.name
  const pageLink = hubLink(`/clients/${client.id}/toll-free`)
  const note = (msg: string) => appendLog(id, lease, msg).catch(() => {})
  const text = (kind: NumberAlertKind, reason: string, link = pageLink) => textNumberEvent({ key: id, kind, client: client.name, subAccountName: subName, reason, link })
  const finish = (status: string, detail: string, extra: Prisma.GhlNumberJobUpdateManyMutationInput = {}) =>
    saveJob(id, lease, { status, detail: detail.slice(0, 4000), lastError: status === 'succeeded' ? null : detail.slice(0, 4000), leaseUntil: null, heartbeatAt: null, finishedAt: new Date(), ...extra })
  const needsHuman = async (detail: string, kind: NumberAlertKind = 'needs_human'): Promise<string> => {
    await note(detail)
    await finish('needs_human', detail)
    await text(kind, detail)
    return 'needs_human'
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  try {
    if (client.archivedAt) {
      await finish('failed', 'The client is archived, so nothing was bought.')
      return 'failed'
    }
    const clientLocationId = client.ghlLocationId
    if (!clientLocationId) return await needsHuman('The client has no linked GHL sub-account anymore, so nothing was bought.')
    if (!job.phoneNumber && !job.pickedNumber) {
      const day = await prisma.ghlNumberJob.count({ where: { id: { not: id }, buyStartedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } } })
      if (!underDailyCap(day)) {
        const detail = `The Hub already bought ${day} numbers in the last 24 hours (the limit is ${DAILY_BUY_CAP}), so this one waits an hour.`
        await note(detail)
        await saveJob(id, lease, { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(Date.now() + 60 * 60_000), detail })
        await text('cap', '')
        return 'capped'
      }
    }
    const bankId = await bankLocationId()
    const ctx = await getAgencyContext()
    const [bank, sub] = await Promise.all([getLocation(ctx, bankId), getLocation(ctx, clientLocationId)])
    if (!bank?.name) return await needsHuman(`The number bank sub-account (${bankId}) wasn't found in the agency.`)
    if (!sub?.name) return await needsHuman(`The client's sub-account (${clientLocationId}) wasn't found in the agency.`)
    if (bank.id === sub.id) return await needsHuman('The client is linked to the number bank itself, so nothing was bought.')
    await saveJob(id, lease, { locationName: sub.name })
    const board = await boardInputs(client.id)
    const businessPhone = e164(board?.phone)
    const save = workerMode() === 'create'
    await note(`Getting a toll-free number for "${sub.name}" (${clientLocationId}) from "${bank.name}". Calls should ring ${businessPhone ? displayNumber(businessPhone) : '(no phone on file)'}. ${save ? '' : 'Dry-run mode: nothing will be bought.'}`.trim())

    timer = setTimeout(() => ac.abort(), WALL_MS)
    heartbeat = setInterval(() => {
      void prisma.ghlNumberJob.updateMany({ where: { id, status: 'running', leaseUntil: lease }, data: { heartbeatAt: new Date() } }).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    const otp = makeOtpPuller(client.id, note)
    const result = await runNumberInBrowser({
      clientName: client.name,
      clientLocationId,
      clientLocationName: sub.name,
      bankLocationId: bank.id,
      bankName: bank.name,
      businessPhone,
      state: { pickedNumber: job.pickedNumber, buyStartedAt: job.buyStartedAt, phoneNumber: job.phoneNumber, movedAt: job.movedAt },
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
      onBought: async (number) => {
        await saveJob(id, lease, { phoneNumber: number })
      },
      onMoved: async () => {
        await saveJob(id, lease, { movedAt: new Date() })
      },
    })
    if (result.storageState) await saveSession(result.storageState).catch(() => {})
    if (result.status === 'done' || result.status === 'already') {
      const number = result.phoneNumber ? displayNumber(result.phoneNumber) : ''
      await note(result.detail)
      await finish('succeeded', result.detail, { ...(result.phoneNumber ? { phoneNumber: result.phoneNumber } : {}), ...(result.forwardsTo ? { forwardsTo: result.forwardsTo } : {}) })
      if (result.status === 'done') await text('bought', number)
      return 'succeeded'
    }
    if (result.status === 'rehearsed') {
      await note(result.detail)
      await finish('dry_run', result.detail)
      return 'dry_run'
    }
    if (result.status === 'needs_human') return await needsHuman(result.detail, result.identityCheck ? 'id_check' : 'needs_human')
    throw new Error(result.detail)
  } catch (err) {
    if (live?.released || stopping) return 'released'
    if (err instanceof LeaseLost) return 'lost'
    const message = describe(err)
    if (ac.signal.aborted) {
      const detail = `Stopped after ${Math.round(WALL_MS / 60_000)} minutes without finishing. ${message}`.slice(0, 2000)
      await note(detail)
      await finish('failed', detail).catch(() => {})
      await text('failed', detail)
      return 'failed'
    }
    const fresh = await prisma.ghlNumberJob.findUnique({ where: { id }, select: { buyStartedAt: true, phoneNumber: true } }).catch(() => null)
    // Past "Proceed to Buy", a retry only looks for that number; never buys blind (browser.ts).
    if (environmentFailure(message) || job.attempts >= MAX_TRIES) {
      const detail = environmentFailure(message) ? `The browser didn't start: ${message}` : `Gave up after ${job.attempts} tries: ${message}`
      await note(detail)
      await finish('failed', detail).catch(() => {})
      await text('failed', detail)
      return 'failed'
    }
    const wait = retryDelayMs(job.attempts)
    const detail = `Will try again in ${Math.round(wait / 60_000)} min (try ${job.attempts} of ${MAX_TRIES})${fresh?.buyStartedAt && !fresh.phoneNumber ? ', checking first whether the number was bought' : ''}: ${message}`.slice(0, 2000)
    await note(detail)
    await saveJob(id, lease, { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(Date.now() + wait), lastError: message.slice(0, 2000), detail }).catch(() => {})
    return 'retry'
  } finally {
    if (timer) clearTimeout(timer)
    if (heartbeat) clearInterval(heartbeat)
    if (live?.id === id) live = null
  }
}

/** One tick from the sub-account worker: recover, sweep, and (when the browser is free) run one approved job. */
export async function numberTick(opts: { runBrowser: boolean }): Promise<{ asked: number; claimed: boolean; outcome?: string }> {
  if (!workerEnabled()) return { asked: 0, claimed: false }
  await recoverAbandonedNumbers().catch((err) => console.warn('[ghl-number] recovery:', describe(err)))
  const asked = await sweepNumbers().catch((err) => {
    console.warn('[ghl-number] sweep:', describe(err))
    return 0
  })
  if (!opts.runBrowser || workerPaused() || stopping) return { asked, claimed: false }
  const claimed = await claimNumber()
  if (!claimed) return { asked, claimed: false }
  const outcome = await executeNumber(claimed.id, claimed.lease).catch((err) => {
    if (err instanceof LeaseLost) return 'lost'
    throw err
  })
  return { asked, claimed: true, outcome }
}

export async function watchNumberStalls(now = Date.now()): Promise<void> {
  const current = live
  if (current && !current.released && now - current.since > STUCK_AFTER_MS) {
    const row = await prisma.ghlNumberJob.findUnique({ where: { id: current.id }, select: { clientId: true, client: { select: { name: true } } } })
    if (row) await textNumberEvent({ key: current.id, kind: 'stuck', client: row.client.name, reason: `It started ${Math.round((now - current.since) / 60_000)} minutes ago.`, link: hubLink(`/clients/${row.clientId}/toll-free`) })
  }
  const overdue = await prisma.ghlNumberJob.findMany({
    where: { status: 'queued', nextAttemptAt: { lt: new Date(now - WAITING_AFTER_MS) } },
    take: 5,
    select: { id: true, clientId: true, nextAttemptAt: true, client: { select: { name: true } } },
  })
  for (const job of overdue) {
    await textNumberEvent({ key: job.id, kind: 'waiting', client: job.client.name, reason: `${Math.round((now - job.nextAttemptAt.getTime()) / 60_000)} minutes`, link: hubLink(`/clients/${job.clientId}/toll-free`) })
  }
}

// ---------------------------------------------------------------------------
// What the pages show
// ---------------------------------------------------------------------------

export async function numberView(clientId: string) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, ghlLocationId: true, archivedAt: true } })
  if (!client) return null
  const job = await prisma.ghlNumberJob.findUnique({
    where: { clientId },
    select: {
      id: true,
      status: true,
      detail: true,
      locationName: true,
      phoneNumber: true,
      forwardsTo: true,
      pickedNumber: true,
      buyStartedAt: true,
      movedAt: true,
      trigger: true,
      attempts: true,
      log: true,
      nextAttemptAt: true,
      heartbeatAt: true,
      finishedAt: true,
      updatedAt: true,
      shots: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, step: true, createdAt: true } },
    },
  })
  return {
    client: { id: client.id, name: client.name, locationId: client.ghlLocationId, archived: !!client.archivedAt },
    ask: await numberAskOn(),
    mode: workerMode(),
    workerOn: workerEnabled(),
    bankLocationId: await bankLocationId(),
    job: job
      ? {
          ...job,
          log: (Array.isArray(job.log) ? job.log : []).slice(-60),
          buyStartedAt: job.buyStartedAt?.toISOString() ?? null,
          movedAt: job.movedAt?.toISOString() ?? null,
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

export type NumberView = NonNullable<Awaited<ReturnType<typeof numberView>>>

/** The Office's open requests: numbers waiting for a Yes. */
export async function pendingNumberApprovals(): Promise<{ id: string; clientId: string; clientName: string; at: Date }[]> {
  const rows = await prisma.ghlNumberJob.findMany({
    where: { status: 'awaiting_approval', client: { is: { archivedAt: null } } },
    orderBy: { updatedAt: 'asc' },
    take: 20,
    select: { id: true, clientId: true, updatedAt: true, client: { select: { name: true } } },
  })
  return rows.map((r) => ({ id: r.id, clientId: r.clientId, clientName: r.client.name, at: r.updatedAt }))
}

