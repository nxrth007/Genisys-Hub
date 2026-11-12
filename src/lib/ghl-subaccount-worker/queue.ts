/**
 * The sub-account job queue.
 *
 * One row per client. A new onboarding submission enqueues; the
 * scheduler (or the standalone worker process) claims a row with a
 * lease, then either links a sub-account that already has this name
 * or drives the GHL dashboard. Retries back off. A 2FA prompt or a
 * page we no longer recognise waits for a person instead of trying
 * again on its own.
 *
 * Listing sub-accounts by name uses the read API, which Agency
 * Unlimited allows. Creating one does not, so the create itself is
 * the browser.
 */
import { Prisma } from '@/generated/prisma/client'
import { looksLikePhoneNumber, promoteIntakeToClient } from '@/lib/client-from-intake'
import { distinctBusinessNames } from '@/lib/client-name'
import { getAgencyContext, getSnapshotPushStatus, listAllLocations, listSnapshots } from '@/lib/ghl-agency'
import { buildLocationInput, firstNameOf, getGhlSubaccountSettings, linkGhlSubAccount } from '@/lib/ghl-subaccount-provisioning'
import { hubAlert, hubAlertThrottled, hubLink } from '@/lib/hub-alerts'
import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'
import { runCreateInBrowser } from './browser'
import {
  loginFromEnv,
  MAX_ATTEMPTS,
  ONBOARDING_WEBHOOK_SECRET_NAME,
  parseAgencyLogin,
  retryDelayMs,
  subAccountListUrl,
  listUrlOverride,
  VAULT_LOGIN_NAME,
  VAULT_WEBHOOK_SECRET_NAME,
  WORKER_SINCE_GRACE_MS,
  workerEnabled,
  workerHeadless,
  workerMode,
  workerPaused,
  workerRunsBrowser,
} from './config'
import { autoEnqueueAllowed, intakeTimeKnown } from './eligibility'
import { browserFieldsFromLocation, readBrowserFields, resolveSnapshotChoice, snapshotImportState, type BrowserFields } from './fields'
import { ABANDONED_JOB_LOG, AUTO_RETEST_DELAY_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, autoRetestDue, isHeartbeatStale, JOB_WALL_MS, jobLogEntry, mayClaimRequeuedJob, requeueCommitOf, runningCommit, shouldAutoRetest, skipNewerBuildLog } from './heartbeat'
import { ghlLabels } from './labels'
import { fetchLatestSecurityCode, imapSettings } from './otp-mail'
import { openString, sealString } from './session'

const SINCE_KEY = 'ghlSubaccountWorker.since'
const SESSION_KEY = 'ghlSubaccountWorker.session'
const OTP_KEY = 'ghlSubaccountWorker.otp'
const LEASE_MS = 20 * 60 * 1000
const JOB_TIMEOUT_MS = JOB_WALL_MS
const ACTOR = 'ghl-subaccount-worker'

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

export type EnqueueResult =
  | { ok: true; status: 'queued' | 'already'; jobId: string; name: string }
  | { ok: false; status: 'skipped' | 'failed'; reason: string }

export type TickResult = {
  enabled: boolean
  ran: boolean
  enqueued: number
  claimed: boolean
  outcome?: string
  promoted?: number
  recovered?: number
  paused?: boolean
}

class LeaseLost extends Error {
  constructor() {
    super('lease lost')
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function newLease(now: number): Date {
  return new Date(now + LEASE_MS + Math.floor(Math.random() * 1000))
}

/** The first time the worker is on, only submissions from the last few minutes qualify. */
export async function workerCutoff(now = new Date()): Promise<Date> {
  const row = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  if (row?.value && !Number.isNaN(Date.parse(row.value))) return new Date(row.value)
  const since = new Date(now.getTime() - WORKER_SINCE_GRACE_MS)
  try {
    await prisma.appSetting.create({ data: { key: SINCE_KEY, value: since.toISOString() } })
  } catch {
    // Another process recorded it first.
  }
  const again = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  return new Date(again?.value && !Number.isNaN(Date.parse(again.value)) ? again.value : since.toISOString())
}

export async function workerWebhookSecret(): Promise<string | null> {
  const fromEnv = process.env.GHL_SUBACCOUNT_WORKER_WEBHOOK_SECRET?.trim()
  if (fromEnv) return fromEnv
  for (const name of [VAULT_WEBHOOK_SECRET_NAME, ONBOARDING_WEBHOOK_SECRET_NAME]) {
    try {
      const value = (await getSecretByName(name)).trim()
      if (value) return value
    } catch {
      // Try the next place the secret might live.
    }
  }
  return null
}

async function loadLogin(): Promise<{ email: string; password: string } | null> {
  const fromEnv = loginFromEnv()
  if (fromEnv) return fromEnv
  try {
    return parseAgencyLogin(await getSecretByName(VAULT_LOGIN_NAME))
  } catch {
    return null
  }
}

async function loadSession(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: SESSION_KEY } })
  return openString(row?.value)
}

async function saveSession(json: string): Promise<void> {
  if (json.length > 500_000) return
  const value = sealString(json)
  await prisma.appSetting.upsert({
    where: { key: SESSION_KEY },
    create: { key: SESSION_KEY, value },
    update: { value },
  })
}

export async function submitWorkerOtp(code: string, clientId?: string | null): Promise<{ ok: true; requeued: number } | { ok: false; reason: string }> {
  const clean = code.trim()
  if (!/^[A-Za-z0-9]{4,12}$/.test(clean)) {
    return { ok: false, reason: 'Enter the code GHL showed (4–12 letters or digits).' }
  }
  const value = sealString(JSON.stringify({ code: clean, at: new Date().toISOString(), clientId: clientId ?? null }))
  await prisma.appSetting.upsert({
    where: { key: OTP_KEY },
    create: { key: OTP_KEY, value },
    update: { value },
  })
  const res = await prisma.ghlSubaccountJob.updateMany({
    where: {
      status: 'needs_human',
      ...(clientId ? { clientId } : {}),
    },
    data: { status: 'queued', nextAttemptAt: new Date(), leaseUntil: null },
  })
  return { ok: true, requeued: res.count }
}

async function takeWorkerOtp(clientId: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: OTP_KEY } })
  if (!row) return null
  const raw = openString(row.value)
  if (!raw) return null
  let parsed: { code?: unknown; at?: unknown; clientId?: unknown }
  try {
    parsed = JSON.parse(raw) as { code?: unknown; at?: unknown; clientId?: unknown }
  } catch {
    return null
  }
  if (typeof parsed.code !== 'string') return null
  if (typeof parsed.clientId === 'string' && parsed.clientId && parsed.clientId !== clientId) return null
  const at = typeof parsed.at === 'string' ? Date.parse(parsed.at) : NaN
  if (Number.isNaN(at) || Date.now() - at > 5 * 60_000) {
    await prisma.appSetting.delete({ where: { key: OTP_KEY } }).catch(() => {})
    return null
  }
  await prisma.appSetting.delete({ where: { key: OTP_KEY } }).catch(() => {})
  return parsed.code
}

async function pollOtp(clientId: string, waitMs: number): Promise<string | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const code = await takeWorkerOtp(clientId)
    if (code) return code
    const left = deadline - Date.now()
    if (left <= 0) return null
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, left)))
  }
}

type ClientRow = {
  id: string
  name: string
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  website: string | null
  ghlLocationId: string | null
  createdAt: Date
  intakes: Array<{
    id: string
    fullName: string | null
    leadEmail: string | null
    customerPhone: string | null
    businessAddress: string | null
    website: string | null
    timeZone: string | null
    receivedAt: Date
    raw: unknown
  }>
}

async function loadClient(clientId: string): Promise<ClientRow | null> {
  return prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      address: true,
      website: true,
      ghlLocationId: true,
      createdAt: true,
      intakes: {
        orderBy: { receivedAt: 'asc' },
        select: {
          id: true,
          fullName: true,
          leadEmail: true,
          customerPhone: true,
          businessAddress: true,
          website: true,
          timeZone: true,
          receivedAt: true,
          raw: true,
        },
      },
    },
  })
}

function clientFacts(client: ClientRow, opts: { receivedAt?: Date; timeKnown?: boolean; createdNewClient?: boolean }) {
  const earliest = client.intakes[0] ?? null
  const latest = client.intakes[client.intakes.length - 1] ?? null
  const receivedAt = opts.receivedAt ?? earliest?.receivedAt ?? client.createdAt
  const timeKnown = opts.timeKnown ?? (intakeTimeKnown(earliest?.raw) || intakeTimeKnown(latest?.raw))
  const createdNewClient =
    opts.createdNewClient ??
    !(earliest && client.createdAt.getTime() < earliest.receivedAt.getTime() - 60_000)
  return { earliest, latest, receivedAt, timeKnown, createdNewClient }
}

/**
 * Queue a browser create for this client. Idempotent: a client already
 * queued, running, or done is left alone unless `force` (Retry).
 */
export async function enqueueClient(
  clientId: string,
  opts: { trigger: string; force?: boolean; receivedAt?: Date; timeKnown?: boolean; createdNewClient?: boolean },
): Promise<EnqueueResult> {
  if (!workerEnabled()) {
    return { ok: false, status: 'skipped', reason: 'the browser worker is switched off (GHL_SUBACCOUNT_WORKER_ENABLED)' }
  }
  const client = await loadClient(clientId)
  if (!client) return { ok: false, status: 'failed', reason: 'client not found' }
  if (client.ghlLocationId) {
    return { ok: false, status: 'skipped', reason: 'client already has a sub-account' }
  }
  const facts = clientFacts(client, opts)
  if (!opts.force) {
    const since = await workerCutoff()
    const allowed = autoEnqueueAllowed({
      receivedAt: facts.receivedAt,
      since,
      timeKnown: facts.timeKnown,
      createdNewClient: facts.createdNewClient,
      hasLocation: false,
      phoneNamed: looksLikePhoneNumber(client.name.trim()),
    })
    if (!allowed.ok) return { ok: false, status: 'skipped', reason: allowed.reason }
  }

  const settings = await getGhlSubaccountSettings()
  const intake = facts.latest
  const input = buildLocationInput(
    client,
    intake
      ? {
          fullName: intake.fullName,
          leadEmail: intake.leadEmail,
          customerPhone: intake.customerPhone,
          businessAddress: intake.businessAddress,
          website: intake.website,
          timeZone: intake.timeZone,
        }
      : null,
    settings.snapshotId,
  )
  const fields = browserFieldsFromLocation(input, {
    email: client.contactEmail ?? intake?.leadEmail,
    firstName: input.prospectInfo?.firstName ?? firstNameOf(client.contactName ?? intake?.fullName),
    lastName: input.prospectInfo?.lastName,
    snapshotName: process.env.GHL_SUBACCOUNT_SNAPSHOT_NAME?.trim() || null,
  })

  const existing = await prisma.ghlSubaccountJob.findUnique({ where: { clientId } })
  if (existing) {
    const staleRun = existing.status === 'running' && isHeartbeatStale(existing.heartbeatAt, existing.updatedAt)
    if (existing.status === 'running' && !(opts.force && staleRun)) {
      return { ok: true, status: 'already', jobId: existing.id, name: fields.name }
    }
    const parked = existing.status === 'queued'
    const terminal = existing.status === 'succeeded' || existing.status === 'dry_run' || existing.status === 'failed' || existing.status === 'needs_human' || existing.status === 'canceled'
    if (parked || (terminal && !opts.force)) {
      return { ok: true, status: 'already', jobId: existing.id, name: fields.name }
    }
    if (staleRun) {
      const prev = Array.isArray(existing.log) ? existing.log : []
      const log = [...prev, jobLogEntry('Requeued from Settings. The previous run had no heartbeat for more than 3 minutes.')].slice(-60)
      await prisma.ghlSubaccountJob.update({
        where: { id: existing.id },
        data: {
          status: 'queued',
          attempts: 0,
          nextAttemptAt: new Date(),
          leaseUntil: null,
          heartbeatAt: null,
          lastError: null,
          detail: null,
          finishedAt: null,
          trigger: opts.trigger,
          intakeId: intake?.id ?? existing.intakeId,
          payload: fields as Prisma.InputJsonValue,
          log: log as Prisma.InputJsonValue,
        },
      })
      return { ok: true, status: 'queued', jobId: existing.id, name: fields.name }
    }
    await prisma.ghlSubaccountJob.update({
      where: { id: existing.id },
      data: {
        status: 'queued',
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null,
        detail: null,
        finishedAt: null,
        trigger: opts.trigger,
        intakeId: intake?.id ?? existing.intakeId,
        payload: fields as Prisma.InputJsonValue,
      },
    })
    return { ok: true, status: 'queued', jobId: existing.id, name: fields.name }
  }

  try {
    const job = await prisma.ghlSubaccountJob.create({
      data: {
        clientId,
        intakeId: intake?.id ?? null,
        status: 'queued',
        trigger: opts.trigger,
        payload: fields as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    return { ok: true, status: 'queued', jobId: job.id, name: fields.name }
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      const row = await prisma.ghlSubaccountJob.findUnique({ where: { clientId }, select: { id: true } })
      if (row) return { ok: true, status: 'already', jobId: row.id, name: fields.name }
    }
    return { ok: false, status: 'failed', reason: describe(err) }
  }
}

/** Called from ingest when a submission created a new client. */
export async function enqueueGhlSubaccountForNewClient(
  clientId: string,
  receivedAt: Date,
  opts: { timeKnown: boolean },
): Promise<EnqueueResult> {
  return enqueueClient(clientId, { trigger: 'intake', receivedAt, timeKnown: opts.timeKnown, createdNewClient: true })
}

/** Intakes that were attached to a different business get their own client and job. Idempotent. */
export async function enqueueMissedIntakes(): Promise<number> {
  if (!workerEnabled()) return 0
  const since = await workerCutoff()
  const rows = await prisma.clientIntake.findMany({
    where: { receivedAt: { gte: since }, clientId: { not: null } },
    select: {
      id: true,
      businessName: true,
      receivedAt: true,
      client: { select: { name: true } },
    },
  })
  let queued = 0
  for (const row of rows) {
    if (!row.businessName || !row.client || !distinctBusinessNames(row.businessName, row.client.name)) continue
    await prisma.clientIntake.update({ where: { id: row.id }, data: { clientId: null } })
    const promoted = await promoteIntakeToClient(row.id)
    if (!promoted) {
      console.log(`[client-onboarding] GHL browser job skipped for intake ${row.id}: could not create a client for "${row.businessName}"`)
      continue
    }
    const res = await enqueueGhlSubaccountForNewClient(promoted.clientId, row.receivedAt, { timeKnown: true })
    if (!res.ok) console.log(`[client-onboarding] GHL browser job for intake ${row.id} skipped: ${res.reason}`)
    else {
      console.log(`[client-onboarding] GHL browser job for intake ${row.id} ${res.status} as "${res.name}"`)
      if (res.status === 'queued') queued += 1
    }
  }
  return queued
}

export async function sweepEligibleClients(): Promise<number> {
  if (!workerEnabled()) return 0
  const since = await workerCutoff()
  const clients = await prisma.client.findMany({
    where: {
      archivedAt: null,
      ghlLocationId: null,
      ghlSubaccountJob: { is: null },
      intakes: { some: { receivedAt: { gte: since } } },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { id: true },
  })
  let queued = 0
  for (const c of clients) {
    const res = await enqueueClient(c.id, { trigger: 'sweep' })
    if (res.ok && res.status === 'queued') queued += 1
  }
  return queued
}

async function resolveSnapshotName(snapshotId: string): Promise<string> {
  const fromEnv = process.env.GHL_SUBACCOUNT_SNAPSHOT_NAME?.trim()
  if (fromEnv) return fromEnv
  try {
    const ctx = await getAgencyContext()
    const match = (await listSnapshots(ctx)).find((s) => s.id === snapshotId)
    return match?.name?.trim() || ''
  } catch (err) {
    console.warn(`[ghl-subaccount-worker] snapshot name lookup failed: ${describe(err)}`)
    return ''
  }
}

async function findExistingByName(name: string): Promise<{ id: string; name: string } | null> {
  const ctx = await getAgencyContext()
  const { locations } = await listAllLocations(ctx)
  const want = norm(name)
  return locations.find((l) => norm(l.name) === want) ?? null
}

async function saveJob(id: string, lease: Date, data: Prisma.GhlSubaccountJobUpdateManyMutationInput): Promise<void> {
  const res = await prisma.ghlSubaccountJob.updateMany({ where: { id, leaseUntil: lease }, data })
  if (res.count === 0) throw new LeaseLost()
}

async function appendLog(id: string, lease: Date, msg: string): Promise<void> {
  const row = await prisma.ghlSubaccountJob.findFirst({
    where: { id, leaseUntil: lease },
    select: { log: true },
  })
  if (!row) throw new LeaseLost()
  const prev = Array.isArray(row.log) ? row.log : []
  const next = [...prev, jobLogEntry(msg)].slice(-60)
  await saveJob(id, lease, { log: next as Prisma.InputJsonValue })
}

function environmentFailure(message: string): boolean {
  return /playwright|executable doesn't exist|browserType\.launch|Failed to launch|Cannot find (module|package)|libnss3|error while loading shared libraries/i.test(message)
}

async function markClient(clientId: string, status: string, error: string | null): Promise<void> {
  await prisma.client.update({
    where: { id: clientId },
    data: { ghlProvisionStatus: status, ghlProvisionError: error, ghlProvisionedAt: new Date() },
  }).catch((err) => console.error(`[ghl-subaccount-worker] client status ${clientId}:`, err))
}

type LiveJob = { id: string; getLease: () => Date; abort: () => void; released: boolean }
let liveJob: LiveJob | null = null
let shuttingDown = false
let lifecycleInstalled = false

export async function recoverAbandonedJobs(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_STALE_MS)
  const stale = await prisma.ghlSubaccountJob.findMany({
    where: {
      status: 'running',
      OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }],
    },
    select: { id: true, log: true },
  })
  let recovered = 0
  for (const row of stale) {
    if (liveJob?.id === row.id && !liveJob.released) continue
    const prev = Array.isArray(row.log) ? row.log : []
    const log = [...prev, jobLogEntry(ABANDONED_JOB_LOG, now)].slice(-60)
    const res = await prisma.ghlSubaccountJob.updateMany({
      where: {
        id: row.id,
        status: 'running',
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, updatedAt: { lt: cutoff } }],
      },
      data: {
        status: 'queued',
        leaseUntil: null,
        heartbeatAt: null,
        nextAttemptAt: now,
        log: log as Prisma.InputJsonValue,
      },
    })
    recovered += res.count
  }
  return recovered
}

export async function releaseLiveJob(message: string): Promise<void> {
  const live = liveJob
  if (!live || live.released) return
  live.released = true
  live.abort()
  const lease = live.getLease()
  const row = await prisma.ghlSubaccountJob.findFirst({
    where: { id: live.id, leaseUntil: lease, status: 'running' },
    select: { log: true },
  })
  if (!row) return
  const prev = Array.isArray(row.log) ? row.log : []
  const log = [...prev, jobLogEntry(message)].slice(-60)
  await prisma.ghlSubaccountJob.updateMany({
    where: { id: live.id, leaseUntil: lease, status: 'running' },
    data: {
      status: 'queued',
      leaseUntil: null,
      heartbeatAt: null,
      nextAttemptAt: new Date(),
      log: log as Prisma.InputJsonValue,
    },
  })
}

const retestedThisBoot = new Set<string>()
let retestRunning = false
let retestDone = false
/** When this process loaded the worker. The retiring instance can still claim for a short overlap. */
const workerBootedAt = Date.now()

/** Stop claiming work when Render shuts this process down, and give the in-flight job back. */
export function installWorkerLifecycle(): void {
  if (lifecycleInstalled) return
  lifecycleInstalled = true
  const stop = () => {
    shuttingDown = true
    void releaseLiveJob('Released back to the queue because this instance is shutting down.').catch((err) => {
      console.warn('[ghl-subaccount-worker] could not release the in-flight job:', err)
    })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  void recoverAbandonedJobs().catch((err) => console.warn('[ghl-subaccount-worker] startup recovery:', err))
  void enqueueMissedIntakes().catch((err) => console.warn('[ghl-subaccount-worker] missed intakes:', err))
  const wait = Math.max(0, AUTO_RETEST_DELAY_MS - (Date.now() - workerBootedAt))
  setTimeout(() => {
    void retestNeedsHumanTestJobs().catch((err) => console.warn('[ghl-subaccount-worker] auto-retest:', err))
  }, wait)
}

export async function retestNeedsHumanTestJobs(now = Date.now()): Promise<number> {
  if (shuttingDown || workerPaused() || workerMode() === 'create') return 0
  if (!autoRetestDue(workerBootedAt, now)) return 0
  if (retestDone || retestRunning) return 0
  retestRunning = true
  try {
    const rows = await prisma.ghlSubaccountJob.findMany({
      where: { status: { in: ['needs_human', 'dry_run'] } },
      select: { id: true, status: true, payload: true, log: true },
    })
    let requeued = 0
    const commit = runningCommit()
    for (const row of rows) {
      if (retestedThisBoot.has(row.id)) continue
      const name = readBrowserFields(row.payload)?.name || ''
      if (!shouldAutoRetest(workerMode(), row.status, name)) continue
      retestedThisBoot.add(row.id)
      const prev = Array.isArray(row.log) ? row.log : []
      const log = [...prev, jobLogEntry('Auto-retest after deploy')].slice(-60)
      const payload = {
        ...(row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {}),
        requeuedByCommit: commit,
      }
      const res = await prisma.ghlSubaccountJob.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: 'queued',
          leaseUntil: null,
          heartbeatAt: null,
          nextAttemptAt: new Date(),
          finishedAt: null,
          payload: payload as Prisma.InputJsonValue,
          log: log as Prisma.InputJsonValue,
        },
      })
      requeued += res.count
    }
    retestDone = true
    return requeued
  } finally {
    retestRunning = false
  }
}

async function saveJobShot(id: string, lease: Date, step: string, image: Buffer): Promise<void> {
  const label = step.slice(0, 180)
  try {
    const shot = await prisma.ghlSubaccountJobShot.create({
      data: { jobId: id, step: label, mime: 'image/jpeg', data: Uint8Array.from(image) },
      select: { id: true },
    })
    const older = await prisma.ghlSubaccountJobShot.findMany({
      where: { jobId: id },
      orderBy: { createdAt: 'desc' },
      skip: 8,
      select: { id: true },
    })
    if (older.length) await prisma.ghlSubaccountJobShot.deleteMany({ where: { id: { in: older.map((row) => row.id) } } })
    await appendLog(id, lease, `Screenshot ${shot.id} at step ${label}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await appendLog(id, lease, `Screenshot save failed at step ${label}: ${message.slice(0, 500)}`).catch(() => {})
  }
}

async function touchHeartbeat(id: string, lease: Date): Promise<void> {
  await prisma.ghlSubaccountJob.updateMany({
    where: { id, status: 'running', leaseUntil: lease },
    data: { heartbeatAt: new Date() },
  })
}

async function executeClaimed(id: string, claimedLease: Date): Promise<string> {
  let lease = claimedLease
  const extendLease = async (ms: number) => {
    const next = new Date(Date.now() + ms)
    if (next.getTime() <= lease.getTime()) return
    const res = await prisma.ghlSubaccountJob.updateMany({
      where: { id, leaseUntil: lease },
      data: { leaseUntil: next },
    })
    if (res.count === 0) throw new LeaseLost()
    lease = next
  }
  const job = await prisma.ghlSubaccountJob.findFirst({
    where: { id, leaseUntil: lease },
    include: { client: { select: { id: true, name: true, ghlLocationId: true } } },
  })
  if (!job) return 'lost'
  const fields = readBrowserFields(job.payload)
  const name = fields?.name || job.client.name
  const board = hubLink(`/clients/${job.clientId}/ghl`)

  const failHuman = async (detail: string, locationId?: string | null): Promise<string> => {
    await appendLog(id, lease, detail).catch(() => {})
    await saveJob(id, lease, {
      status: 'needs_human',
      leaseUntil: null,
      detail,
      lastError: detail,
      finishedAt: new Date(),
      ...(locationId ? { locationId } : {}),
    })
    await markClient(job.clientId, 'failed', detail)
    await hubAlert(`:warning: *GHL sub-account needs a person* — *${name}* — ${detail} <${board}|Open the sub-account board>`)
    return 'needs_human'
  }

  if (!fields) return failHuman('The queued job has no form fields on it.')
  let listed: { id: string; name: string }[] = []
  try {
    listed = await listSnapshots(await getAgencyContext())
  } catch (err) {
    await appendLog(id, lease, `Couldn't list agency snapshots (${describe(err)}). The queued snapshot id will be used only if nothing else names Master Template.`).catch(() => {})
  }
  const settings = await getGhlSubaccountSettings().catch(() => null)
  const choice = resolveSnapshotChoice({
    payloadId: fields.snapshotId,
    payloadName: fields.snapshotName,
    envId: process.env.GHL_SUBACCOUNT_SNAPSHOT_ID,
    envName: process.env.GHL_SUBACCOUNT_SNAPSHOT_NAME,
    settingsId: settings?.snapshotId,
    listed,
  })
  const snapshotNote =
    choice.id === fields.snapshotId
      ? `Using snapshot "${choice.name || choice.id}" (${choice.id}) from ${choice.source}.`
      : `Using snapshot "${choice.name || choice.id}" (${choice.id}) from ${choice.source}. It overrides the queued snapshotId ${fields.snapshotId}.`
  await appendLog(id, lease, snapshotNote).catch(() => {})
  const readyFields: BrowserFields = { ...fields, snapshotId: choice.id, snapshotName: choice.name || fields.snapshotName }

  const confirmSnapshot = async (locationId: string): Promise<{ ok: boolean; detail: string }> => {
    let last = `GHL has no snapshot import for "${readyFields.snapshotName || readyFields.snapshotId}" (${readyFields.snapshotId}) on ${locationId}.`
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const status = await getSnapshotPushStatus(await getAgencyContext(), readyFields.snapshotId, locationId)
        const state = snapshotImportState(status)
        const label = status
          ? `${status.status}; completed: ${status.completed.join(', ') || '(none)'}; pending: ${status.pending.join(', ') || '(none)'}`
          : 'no snapshot-status record'
        last = `Snapshot "${readyFields.snapshotName || readyFields.snapshotId}" (${readyFields.snapshotId}) on ${locationId}: ${label}.`
        if (state === 'applied' || state === 'loading') return { ok: true, detail: last }
        if (state === 'failed') return { ok: false, detail: `${last} The snapshot import failed.` }
      } catch (err) {
        last = `Couldn't read snapshot status for ${readyFields.snapshotId} on ${locationId}: ${describe(err)}`
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5000))
    }
    return {
      ok: false,
      detail: `${last} Add manually keeps the snapshot id on the form URL, but that does not load the snapshot. Load "${readyFields.snapshotName || readyFields.snapshotId}" into this sub-account by hand.`,
    }
  }

  const acceptLocation = async (locationId: string, detail: string): Promise<string> => {
    if (workerMode() === 'create') {
      const check = await confirmSnapshot(locationId)
      await appendLog(id, lease, check.detail).catch(() => {})
      if (!check.ok) return failHuman(`${detail} ${check.detail}`, locationId)
      detail = `${detail} ${check.detail}`
    }
    await saveJob(id, lease, { status: 'succeeded', leaseUntil: null, locationId, detail, lastError: null, finishedAt: new Date() })
    return 'succeeded'
  }

  if (job.client.ghlLocationId) {
    return acceptLocation(job.client.ghlLocationId, 'The client was already linked to a sub-account.')
  }

  try {
    const existing = await findExistingByName(fields.name)
    if (existing) {
      const linked = await linkGhlSubAccount(job.clientId, {
        locationId: existing.id,
        actor: ACTOR,
        note: `Browser worker linked existing sub-account ${existing.id} instead of creating another`,
      })
      if (!linked.ok) return failHuman(`A sub-account named "${fields.name}" already exists, and it could not be linked: ${linked.reason}`)
      return acceptLocation(existing.id, `Linked the existing sub-account "${existing.name}".`)
    }
  } catch (err) {
    await appendLog(id, lease, `Couldn't list sub-accounts before creating (${describe(err)}). Continuing in the browser.`)
  }

  const snapshotName = readyFields.snapshotName || (await resolveSnapshotName(readyFields.snapshotId))
  if (!snapshotName) {
    return failHuman(
      "The snapshot's name isn't known, so the form wasn't submitted. Set GHL_SUBACCOUNT_SNAPSHOT_NAME to the name in GHL's snapshot dropdown, or GHL_SUBACCOUNT_SNAPSHOT_ID to its id.",
    )
  }
  const ready: BrowserFields = { ...readyFields, snapshotName }
  await saveJob(id, lease, { payload: ready as unknown as Prisma.InputJsonValue })
  await markClient(job.clientId, 'creating', null)

  const login = await loadLogin()
  const mode = workerMode()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), JOB_TIMEOUT_MS)
  liveJob = { id, getLease: () => lease, abort: () => ac.abort(), released: false }
  await touchHeartbeat(id, lease).catch(() => {})
  const heartbeat = setInterval(() => {
    void touchHeartbeat(id, lease).catch(() => {})
  }, HEARTBEAT_INTERVAL_MS)
  let codeSentAt = 0
  let lastImapAt = 0
  try {
    const result = await runCreateInBrowser({
      fields: ready,
      mode,
      labels: ghlLabels(process.env.GHL_SUBACCOUNT_WORKER_LABELS),
      listUrl: subAccountListUrl(process.env.GHL_AGENCY_DASHBOARD_URL),
      listUrlOverride: listUrlOverride(),
      snapshotTab: process.env.GHL_SUBACCOUNT_SNAPSHOT_TAB?.trim() || '',
      login,
      storageState: await loadSession(),
      headless: workerHeadless(),
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
      signal: ac.signal,
      onNote: async (line) => {
        await appendLog(id, lease, line).catch(() => {})
      },
      capture: async (step, image) => {
        await saveJobShot(id, lease, step, image).catch((err) => {
          console.warn('[ghl-subaccount-worker] screenshot save:', err instanceof Error ? err.message : err)
        })
      },
      pullOtp: async (ms) => {
        await extendLease(14 * 60 * 1000).catch(() => {})
        const pasted = await pollOtp(job.clientId, 0)
        if (pasted) return pasted
        const started = codeSentAt || Date.now()
        if (imapSettings() && Date.now() - started < 3 * 60 * 1000 && Date.now() - lastImapAt >= 8_000) {
          lastImapAt = Date.now()
          const notes: string[] = []
          try {
            const mailed = await fetchLatestSecurityCode(new Date(started), process.env, (line) => notes.push(line))
            if (notes.length) await appendLog(id, lease, notes.join('\n')).catch(() => {})
            if (mailed) return mailed
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            notes.push(`IMAP read failed: ${message.slice(0, 300)}`)
            await appendLog(id, lease, notes.join('\n')).catch(() => {})
            console.warn('[ghl-subaccount-worker] inbox read failed; waiting for a pasted code:', message)
          }
        }
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
        return null
      },
      onOtpPrompt: async (detail) => {
        if (!codeSentAt) codeSentAt = Date.now()
        await extendLease(14 * 60 * 1000).catch(() => {})
        await saveJob(id, lease, { detail }).catch((err) => {
          if (!(err instanceof LeaseLost)) console.warn('[ghl-subaccount-worker] could not record the code wait:', err)
        })
        await markClient(job.clientId, 'creating', detail)
        await hubAlert(`:key: *GHL wants a verification code* — *${name}* — ${detail} <${board}|Open the sub-account board>`)
      },
    })
    if (result.observedSnapshotId) {
      const queued = fields.snapshotId
      const used = ready.snapshotId
      await appendLog(
        id,
        lease,
        `GHL snapshot id from the page URL: ${result.observedSnapshotId}. Verifying snapshot ${used}${used === queued ? '' : ` (queued payload had ${queued})`}.`,
      ).catch(() => {})
    }
    if (result.storageState) {
      await saveSession(result.storageState).catch((err) => console.warn('[ghl-subaccount-worker] session save:', err))
      if (result.reachedAgency) {
        await appendLog(
          id,
          lease,
          'Refreshed the saved GHL browser session in Postgres after the agency dashboard loaded. The cookies live in the database, not on disk.',
        ).catch(() => {})
      }
    }

    if ((result.status === 'created' || result.status === 'already') && result.locationId) {
      const linked = await linkGhlSubAccount(job.clientId, {
        locationId: result.locationId,
        actor: ACTOR,
        note: `Browser worker ${result.status === 'created' ? 'created' : 'found'} sub-account ${result.locationId || fields.name}`,
      })
      if (!linked.ok) {
        return failHuman(`${result.detail || 'GHL accepted it'} The Hub couldn't link it: ${linked.reason}`, result.locationId)
      }
      return acceptLocation(linked.locationId || result.locationId, result.detail || `Created the sub-account ${result.locationId}.`)
    }

    if (result.status === 'dry_run') {
      await saveJob(id, lease, { status: 'dry_run', leaseUntil: null, detail: result.detail, lastError: null, finishedAt: new Date() })
      await markClient(job.clientId, 'dry_run', result.detail)
      await hubAlert(`:information_source: *GHL sub-account dry run* — *${name}* — ${result.detail} <${board}|Open the sub-account board>`)
      return 'dry_run'
    }

    if (result.status === 'needs_human' || result.uncertain) {
      if (result.uncertain) {
        await appendLog(id, lease, `Add Sub-Account did not confirm on the page. Searching the agency list for "${fields.name}".`).catch(() => {})
        let found: { id: string; name: string } | null = null
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            found = await findExistingByName(fields.name)
          } catch (err) {
            await appendLog(id, lease, `Couldn't list sub-accounts after Add Sub-Account (${describe(err)}).`).catch(() => {})
            break
          }
          if (found) break
          await new Promise((resolve) => setTimeout(resolve, 4000))
        }
        if (found) {
          const linked = await linkGhlSubAccount(job.clientId, {
            locationId: found.id,
            actor: ACTOR,
            note: `Browser worker created sub-account ${found.id}; the page did not show a location id, so it was linked from the agency list`,
          })
          if (!linked.ok) return failHuman(`${result.detail || 'GHL may have created it.'} The Hub couldn't link "${found.name}": ${linked.reason}`, found.id)
          return acceptLocation(linked.locationId || found.id, `Created "${found.name}". The page did not show a location id; it was found on the agency list and linked.`)
        }
        return failHuman(`${result.detail || 'GHL needs a person before this can continue.'} Searched the agency list for "${fields.name}" and it was not there.`)
      }
      return failHuman(result.detail || 'GHL needs a person before this can continue.')
    }

    throw new Error(result.detail || 'The browser did not create the sub-account.')
  } catch (err) {
    if (liveJob?.released || shuttingDown) return 'released'
    if (err instanceof LeaseLost) return 'lost'
    const message = describe(err)
    if (ac.signal.aborted) {
      const detail = `Stopped after 20 minutes without finishing. ${message}`.slice(0, 2000)
      await saveJob(id, lease, { status: 'failed', leaseUntil: null, heartbeatAt: null, lastError: detail, detail, finishedAt: new Date() }).catch(() => {})
      await markClient(job.clientId, 'failed', detail)
      await hubAlert(`:warning: *GHL sub-account worker timed out* — *${name}* — ${detail} <${board}|Create it by hand>`)
      return 'failed'
    }
    const attempts = job.attempts
    console.error(`[ghl-subaccount-worker] ${job.clientId} attempt ${attempts}:`, message)
    if (environmentFailure(message) || attempts >= MAX_ATTEMPTS) {
      const detail = environmentFailure(message)
        ? `The browser didn't start: ${message}. The Hub build should run node scripts/install-render-chromium.mjs (Playwright's Chromium plus the Debian libraries it needs). A Docker worker is only the fallback.`
        : `Gave up after ${attempts} tries: ${message}`
      await saveJob(id, lease, { status: 'failed', leaseUntil: null, lastError: detail, detail, finishedAt: new Date() }).catch(() => {})
      await markClient(job.clientId, 'failed', detail)
      await hubAlert(`:warning: *GHL sub-account worker failed* — *${name}* — ${detail} <${board}|Create it by hand>`)
      return 'failed'
    }
    const wait = retryDelayMs(attempts)
    const detail = `Will retry in ${Math.round(wait / 60_000)} min (attempt ${attempts}): ${message}`
    await saveJob(id, lease, {
      status: 'queued',
      leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + wait),
      lastError: message,
      detail,
    }).catch((saveErr) => {
      if (saveErr instanceof LeaseLost) return
      throw saveErr
    })
    await markClient(job.clientId, 'failed', detail)
    await hubAlertThrottled(
      `ghl-subaccount:${job.clientId}`,
      30 * 60_000,
      `:warning: *GHL sub-account worker will retry* — *${name}* — ${detail} <${board}|Open the sub-account board>`,
    )
    return 'retry'
  } finally {
    clearInterval(heartbeat)
    clearTimeout(timer)
    if (liveJob?.id === id) liveJob = null
  }
}

const skippedNewerBuild = new Set<string>()

async function noteSkippedNewerBuild(id: string, sha: string): Promise<void> {
  if (skippedNewerBuild.has(id)) return
  skippedNewerBuild.add(id)
  const message = skipNewerBuildLog(sha)
  console.warn(`[ghl-subaccount-worker] ${message}`)
  const row = await prisma.ghlSubaccountJob.findFirst({
    where: { id, status: 'queued' },
    select: { log: true },
  })
  if (!row) return
  const prev = Array.isArray(row.log) ? row.log : []
  const log = [...prev, jobLogEntry(message)].slice(-60)
  await prisma.ghlSubaccountJob.updateMany({
    where: { id, status: 'queued' },
    data: { log: log as Prisma.InputJsonValue },
  })
}

async function claimOne(): Promise<{ id: string; lease: Date } | null> {
  if (shuttingDown || workerPaused()) return null
  const now = new Date()
  const due: Prisma.GhlSubaccountJobWhereInput = {
    OR: [
      { status: 'queued', nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      { status: 'running', leaseUntil: { lt: now }, attempts: { lt: MAX_ATTEMPTS } },
    ],
  }
  const candidates = await prisma.ghlSubaccountJob.findMany({
    where: due,
    orderBy: { nextAttemptAt: 'asc' },
    take: 5,
    select: { id: true, payload: true },
  })
  const mine = runningCommit()
  for (const c of candidates) {
    if (shuttingDown) return null
    const required = requeueCommitOf(c.payload)
    if (!mayClaimRequeuedJob(required, mine)) {
      await noteSkippedNewerBuild(c.id, required || mine)
      continue
    }
    const lease = newLease(now.getTime())
    const res = await prisma.ghlSubaccountJob.updateMany({
      where: { id: c.id, ...due },
      data: { status: 'running', leaseUntil: lease, heartbeatAt: new Date(), attempts: { increment: 1 } },
    })
    if (res.count !== 1) continue
    if (shuttingDown) {
      await prisma.ghlSubaccountJob.updateMany({
        where: { id: c.id, leaseUntil: lease, status: 'running' },
        data: { status: 'queued', leaseUntil: null, heartbeatAt: null, nextAttemptAt: new Date(), attempts: { decrement: 1 } },
      })
      return null
    }
    return { id: c.id, lease }
  }
  return null
}

let inFlight = false
let pauseLogged = false

export async function runGhlSubaccountWorkerTick(): Promise<TickResult> {
  if (!workerEnabled()) return { enabled: false, ran: false, enqueued: 0, claimed: false }
  if (workerPaused()) {
    if (!pauseLogged) {
      console.warn('[ghl-subaccount-worker] paused by GHL_SUBACCOUNT_WORKER_PAUSED. Not claiming jobs.')
      pauseLogged = true
    }
    return { enabled: true, ran: false, enqueued: 0, claimed: false, paused: true }
  }
  pauseLogged = false
  const recovered = await recoverAbandonedJobs().catch((err) => {
    console.warn('[ghl-subaccount-worker] recovery:', err)
    return 0
  })
  await retestNeedsHumanTestJobs().catch((err) => {
    console.warn('[ghl-subaccount-worker] auto-retest:', err)
    return 0
  })
  if (shuttingDown) return { enabled: true, ran: false, enqueued: 0, claimed: false, recovered }
  if (inFlight) return { enabled: true, ran: false, enqueued: 0, claimed: false, recovered }
  inFlight = true
  try {
    const enqueued = await sweepEligibleClients()
    let promoted = 0
    if (workerMode() === 'create') {
      const res = await prisma.ghlSubaccountJob.updateMany({
        where: { status: 'dry_run' },
        data: { status: 'queued', attempts: 0, nextAttemptAt: new Date(), finishedAt: null, leaseUntil: null, lastError: null },
      })
      promoted = res.count
    }
    if (!workerRunsBrowser()) return { enabled: true, ran: false, enqueued, claimed: false, promoted, recovered }
    const claimed = await claimOne()
    if (!claimed) return { enabled: true, ran: true, enqueued, claimed: false, promoted, recovered }
    const outcome = await executeClaimed(claimed.id, claimed.lease)
    return { enabled: true, ran: true, enqueued, claimed: true, outcome, promoted, recovered }
  } finally {
    inFlight = false
  }
}

export async function recentWorkerJobs(limit = 15) {
  const rows = await prisma.ghlSubaccountJob.findMany({
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      clientId: true,
      status: true,
      attempts: true,
      detail: true,
      lastError: true,
      locationId: true,
      trigger: true,
      nextAttemptAt: true,
      finishedAt: true,
      updatedAt: true,
      heartbeatAt: true,
      client: { select: { name: true } },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.client.name,
    status: r.status,
    attempts: r.attempts,
    detail: r.detail,
    lastError: r.lastError,
    locationId: r.locationId,
    trigger: r.trigger,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    heartbeatAt: r.heartbeatAt?.toISOString() ?? null,
    stale: r.status === 'running' && isHeartbeatStale(r.heartbeatAt, r.updatedAt),
  }))
}

export function workerPublicStatus() {
  return {
    enabled: workerEnabled(),
    runsBrowser: workerRunsBrowser(),
    mode: workerMode(),
    headless: workerHeadless(),
    dashboard: subAccountListUrl(process.env.GHL_AGENCY_DASHBOARD_URL),
  }
}
