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
import { getAgencyContext, getLocation, getSnapshotPushStatus, listAllLocations, listSnapshots } from '@/lib/ghl-agency'
import { buildLocationInput, firstNameOf, getGhlSubaccountSettings, linkGhlSubAccount } from '@/lib/ghl-subaccount-provisioning'
import { hubAlert, hubAlertThrottled, hubLink } from '@/lib/hub-alerts'
import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'
import { countLocationAssets, inspectLocationSnapshot, listAgencySnapshots, pushSnapshotToLocation, runCreateInBrowser } from './browser'
import {
  loginFromEnv,
  MAX_ATTEMPTS,
  ONBOARDING_WEBHOOK_SECRET_NAME,
  parseAgencyLogin,
  retryDelayMs,
  subAccountListUrl,
  listUrlOverride,
  dashboardOrigin,
  snapshotDiagnosticEnabled,
  snapshotRecheckLocationIds,
  VAULT_LOGIN_NAME,
  VAULT_WEBHOOK_SECRET_NAME,
  WORKER_SINCE_GRACE_MS,
  workerEnabled,
  workerHeadless,
  workerMode,
  workerPaused,
  backfillIntakeIds,
  workerRunsBrowser,
} from './config'
import { autoEnqueueAllowed, intakeTimeKnown } from './eligibility'
import { browserFieldsFromLocation, describeSnapshotPush, readBrowserFields, resolveSnapshotChoice, type BrowserFields } from './fields'
import { ABANDONED_JOB_LOG, AUTO_RETEST_DELAY_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, autoRetestDue, isHeartbeatStale, JOB_WALL_MS, jobLogEntry, mayClaimRequeuedJob, requeueCommitOf, runningCommit, shouldAutoRetest, skipNewerBuildLog } from './heartbeat'
import { ghlLabels } from './labels'
import {
  MASTER_TEMPLATE_ID,
  MASTER_TEMPLATE_NAME,
  SNAPSHOT_LOAD_LOG_JOB_ID,
  describeAssetCounts,
  emptyAssetCounts,
  locationContentLanded,
  pendingSnapshotLoads,
  snapshotLoadLocationIds,
  verifyCheckTimes,
  type AssetCounts,
} from './snapshot-load'
import { configuredSnapshotHint, mergeSnapshotRows, snapshotCatalogLines, sourceCountsFor, type SnapshotRow } from './snapshot-catalog'
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

/** Split only the intakes named by GHL_BACKFILL_INTAKE_IDS (default: Snapshot Check LLC). Idempotent. */
export async function enqueueMissedIntakes(): Promise<number> {
  if (!workerEnabled()) return 0
  const ids = backfillIntakeIds()
  if (!ids.length) return 0
  const rows = await prisma.clientIntake.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      businessName: true,
      receivedAt: true,
      client: { select: { name: true } },
    },
  })
  const found = new Set(rows.map((row) => row.id))
  for (const id of ids) {
    if (!found.has(id)) console.log(`[client-onboarding] GHL browser job skipped for intake ${id}: not found`)
  }
  let queued = 0
  for (const row of rows) {
    if (!row.businessName || !row.client || !distinctBusinessNames(row.businessName, row.client.name)) {
      console.log(`[client-onboarding] GHL browser job skipped for intake ${row.id}: business name already matches ${row.client?.name ?? 'no client'}`)
      continue
    }
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

/** Read one location's last snapshot push and screenshot its snapshot page. Does not create or load anything. */
export async function recheckSnapshotLocation(locationId: string): Promise<string> {
  const settings = await getGhlSubaccountSettings().catch(() => null)
  const snapshotId = process.env.GHL_SUBACCOUNT_SNAPSHOT_ID?.trim() || settings?.snapshotId || ''
  let line = snapshotId
    ? ''
    : `Snapshot recheck for ${locationId} skipped: no snapshot id is configured.`
  if (snapshotId) {
    try {
      const status = await getSnapshotPushStatus(await getAgencyContext(), snapshotId, locationId)
      line = describeSnapshotPush(status, locationId, snapshotId)
    } catch (err) {
      line = `Couldn't read snapshot status for ${snapshotId} on ${locationId}: ${describe(err)}`
    }
  }
  let image: Buffer | null = null
  if (!workerRunsBrowser()) {
    line = `${line} Screenshot skipped: this process is not running the browser.`
  } else {
    try {
      const seen = await inspectLocationSnapshot({
        locationId,
        origin: dashboardOrigin(process.env.GHL_AGENCY_DASHBOARD_URL),
        push: false,
        labels: ghlLabels(process.env.GHL_SUBACCOUNT_WORKER_LABELS),
        storageState: await loadSession(),
        headless: workerHeadless(),
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
      })
      line = `${line} ${seen.note}`
      image = seen.image
    } catch (err) {
      line = `${line} Screenshot skipped: ${describe(err)}`
    }
  }
  console.log(`[ghl-subaccount-worker] ${line}`)
  const job = await prisma.ghlSubaccountJob.findFirst({
    where: { locationId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, log: true },
  })
  if (job) {
    const prev = Array.isArray(job.log) ? job.log : []
    let log = [...prev, jobLogEntry(line)].slice(-60)
    if (image) {
      try {
        const shot = await prisma.ghlSubaccountJobShot.create({
          data: { jobId: job.id, step: 'snapshot recheck', mime: 'image/jpeg', data: Uint8Array.from(image) },
          select: { id: true },
        })
        log = [...log, jobLogEntry(`Screenshot ${shot.id} at step snapshot recheck`)].slice(-60)
      } catch (err) {
        log = [...log, jobLogEntry(`Screenshot save failed at step snapshot recheck: ${describe(err).slice(0, 300)}`)].slice(-60)
      }
    }
    await prisma.ghlSubaccountJob.update({
      where: { id: job.id },
      data: { log: log as Prisma.InputJsonValue, detail: line.slice(0, 2000) },
    })
  }
  return line
}

const LOAD_DONE_KEY = 'ghlSubaccountWorker.snapshotLoad.done'
let lastSnapshotCatalog: SnapshotRow[] = []
let snapshotBootRunning = false

async function snapshotLoadsDone(): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: LOAD_DONE_KEY } })
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value) as unknown
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

async function markSnapshotLoadDone(locationId: string): Promise<void> {
  const done = await snapshotLoadsDone()
  if (done.includes(locationId)) return
  const value = JSON.stringify([...done, locationId])
  await prisma.appSetting.upsert({ where: { key: LOAD_DONE_KEY }, create: { key: LOAD_DONE_KEY, value }, update: { value } })
}

async function rememberCatalog(rows: SnapshotRow[]): Promise<void> {
  if (!rows.length) return
  lastSnapshotCatalog = mergeSnapshotRows([...lastSnapshotCatalog, ...rows])
}

async function logOnLocationJob(
  locationId: string | null,
  lines: string[],
  shots: { step: string; image: Buffer }[] = [],
  outcome?: 'needs_human',
): Promise<void> {
  for (const line of lines) console.log(`[ghl-subaccount-worker] ${line}`)
  const job = locationId
    ? await prisma.ghlSubaccountJob.findFirst({
        where: { locationId },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, log: true, status: true },
      })
    : await prisma.ghlSubaccountJob.findUnique({
        where: { id: SNAPSHOT_LOAD_LOG_JOB_ID },
        select: { id: true, log: true, status: true },
      })
  const target =
    job ||
    (await prisma.ghlSubaccountJob.findUnique({
      where: { id: SNAPSHOT_LOAD_LOG_JOB_ID },
      select: { id: true, log: true, status: true },
    }))
  if (!target) return
  const prev = Array.isArray(target.log) ? target.log : []
  let log = [...prev, ...lines.map((line) => jobLogEntry(line))].slice(-120)
  for (const shot of shots) {
    if (!shot.image) continue
    try {
      const saved = await prisma.ghlSubaccountJobShot.create({
        data: { jobId: target.id, step: shot.step.slice(0, 180), mime: 'image/jpeg', data: Uint8Array.from(shot.image) },
        select: { id: true },
      })
      log = [...log, jobLogEntry(`Screenshot ${saved.id} at step ${shot.step}`)].slice(-120)
    } catch (err) {
      log = [...log, jobLogEntry(`Screenshot save failed at step ${shot.step}: ${describe(err).slice(0, 300)}`)].slice(-120)
    }
  }
  const detail = lines[lines.length - 1]?.slice(0, 2000)
  if (outcome === 'needs_human' && target.status !== 'running') {
    await prisma.ghlSubaccountJob.update({
      where: { id: target.id },
      data: { status: 'needs_human', log: log as Prisma.InputJsonValue, detail, finishedAt: new Date(), leaseUntil: null },
    })
    return
  }
  await prisma.ghlSubaccountJob.update({
    where: { id: target.id },
    data: { log: log as Prisma.InputJsonValue, detail },
  })
}

async function countLocationRecords(locationId: string): Promise<{ counts: AssetCounts; line: string }> {
  try {
    const counted = await countLocationAssets({
      locationId,
      origin: dashboardOrigin(process.env.GHL_AGENCY_DASHBOARD_URL),
      labels: ghlLabels(process.env.GHL_SUBACCOUNT_WORKER_LABELS),
      storageState: await loadSession(),
      headless: workerHeadless(),
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
    })
    return { counts: counted.counts, line: `Location records: ${describeAssetCounts(counted.counts)}. ${counted.notes.join(' ')}`.trim() }
  } catch (err) {
    return {
      counts: emptyAssetCounts(),
      line: `Location records could not be counted: ${describe(err)}`,
    }
  }
}

async function waitForSnapshotCopy(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (shuttingDown) return false
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  return !shuttingDown
}

function browserLaunch() {
  return {
    origin: dashboardOrigin(process.env.GHL_AGENCY_DASHBOARD_URL),
    labels: ghlLabels(process.env.GHL_SUBACCOUNT_WORKER_LABELS),
    storageState: null as string | null,
    headless: workerHeadless(),
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
  }
}

/** Read-only. Lists every snapshot the agency pages return, including asset counts. */
export async function runSnapshotDiagnostic(): Promise<void> {
  if (!snapshotDiagnosticEnabled()) return
  if (!workerRunsBrowser()) {
    console.log('[ghl-subaccount-worker] Snapshot diagnostic skipped: this process is not running the browser.')
    return
  }
  const launch = browserLaunch()
  launch.storageState = await loadSession()
  let listed: Awaited<ReturnType<typeof listAgencySnapshots>>
  try {
    listed = await listAgencySnapshots(launch)
  } catch (err) {
    await logOnLocationJob(null, [`Snapshot diagnostic failed: ${describe(err)}`])
    return
  }
  await rememberCatalog(listed.rows)
  const lines = [...listed.notes, ...snapshotCatalogLines(listed.rows)]
  const hint = configuredSnapshotHint(
    listed.rows,
    process.env.GHL_SUBACCOUNT_SNAPSHOT_ID?.trim() || MASTER_TEMPLATE_ID,
    process.env.GHL_SUBACCOUNT_SNAPSHOT_NAME?.trim() || MASTER_TEMPLATE_NAME,
  )
  if (hint) lines.push(hint)
  await logOnLocationJob(null, lines, listed.shots)
  for (const locationId of snapshotLoadLocationIds()) {
    const job = await prisma.ghlSubaccountJob.findFirst({
      where: { locationId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })
    if (job && job.id !== SNAPSHOT_LOAD_LOG_JOB_ID) await logOnLocationJob(locationId, lines)
  }
}

async function pollLocationRecords(
  locationId: string,
  snapshotId: string,
  onLine: (line: string) => Promise<void>,
): Promise<{ ok: boolean; detail: string }> {
  const source = sourceCountsFor(lastSnapshotCatalog, snapshotId)
  const started = Date.now()
  let last = ''
  for (const at of verifyCheckTimes()) {
    if (shuttingDown) return { ok: false, detail: `${last} Stopped while waiting for snapshot records because this process is shutting down.`.trim() }
    const wait = started + at - Date.now()
    if (wait > 0 && !(await waitForSnapshotCopy(wait))) {
      return { ok: false, detail: `${last} Stopped while waiting for snapshot records because this process is shutting down.`.trim() }
    }
    const counted = await countLocationRecords(locationId)
    let statusLine = ''
    try {
      statusLine = describeSnapshotPush(await getSnapshotPushStatus(await getAgencyContext(), snapshotId, locationId), locationId, snapshotId)
    } catch (err) {
      statusLine = `Couldn't read snapshot status for ${snapshotId} on ${locationId}: ${describe(err)}`
    }
    const verdict = locationContentLanded(counted.counts, source)
    const sourceBit = source ? `Snapshot source: ${describeAssetCounts(source)}. ` : 'Snapshot source counts were not in the catalog. '
    last = `${sourceBit}${statusLine} ${counted.line} ${verdict.reason}`
    await onLine(last)
    if (verdict.ok) return { ok: true, detail: last }
  }
  return { ok: false, detail: last || `No record check finished for ${locationId}.` }
}

/**
 * Push the configured snapshot into the locations named by GHL_SNAPSHOT_LOAD_LOCATION_IDS.
 * Empty means do nothing. This does not create a location. Allowed while the worker is in dry_run.
 */
export async function loadListedSnapshots(): Promise<void> {
  const ids = snapshotLoadLocationIds()
  if (!ids.length) return
  if (!workerRunsBrowser()) {
    console.log('[ghl-subaccount-worker] Snapshot load skipped: this process is not running the browser.')
    return
  }
  const done = await snapshotLoadsDone()
  const pending = pendingSnapshotLoads(ids, done)
  for (const locationId of ids) {
    if (!pending.includes(locationId)) {
      await logOnLocationJob(locationId, [`Snapshot load skipped for ${locationId}: it already succeeded.`])
    }
  }
  const snapshotId = process.env.GHL_SUBACCOUNT_SNAPSHOT_ID?.trim() || MASTER_TEMPLATE_ID
  const snapshotName = process.env.GHL_SUBACCOUNT_SNAPSHOT_NAME?.trim() || MASTER_TEMPLATE_NAME
  for (const locationId of pending) {
    if (shuttingDown) return
    let locationName = ''
    try {
      locationName = (await getLocation(await getAgencyContext(), locationId))?.name || ''
    } catch (err) {
      await logOnLocationJob(locationId, [`Couldn't read the name of location ${locationId} (${describe(err)}). The push will match on the id.`])
    }
    const hint = configuredSnapshotHint(lastSnapshotCatalog, snapshotId, snapshotName)
    const lines = [
      `Snapshot load starting for location ${locationId}${locationName ? ` "${locationName}"` : ''} only. Snapshot ${snapshotName} (${snapshotId}). No location will be created.${hint ? ` ${hint}` : ''}`,
    ]
    const launch = browserLaunch()
    launch.storageState = await loadSession()
    let pushed: Awaited<ReturnType<typeof pushSnapshotToLocation>>
    try {
      pushed = await pushSnapshotToLocation({
        ...launch,
        locationId,
        locationName,
        snapshotId,
        snapshotName,
      })
    } catch (err) {
      await logOnLocationJob(locationId, [...lines, `Snapshot push failed before it could confirm: ${describe(err)}`], [], 'needs_human')
      continue
    }
    await rememberCatalog(pushed.rows)
    await logOnLocationJob(locationId, [...lines, ...pushed.notes], pushed.shots)
    if (!pushed.confirmed) {
      await logOnLocationJob(
        locationId,
        [`Snapshot push was not confirmed for ${locationId}. ${pushed.notes[pushed.notes.length - 1] || 'No confirm button was pressed.'}`],
        [],
        'needs_human',
      )
      continue
    }
    const polled = await pollLocationRecords(locationId, snapshotId, async (line) => {
      await logOnLocationJob(locationId, [line])
    })
    if (shuttingDown) return
    if (polled.ok) {
      await markSnapshotLoadDone(locationId)
      await logOnLocationJob(locationId, [`${polled.detail} Snapshot load succeeded for ${locationId}. It will not run again for this location.`])
    } else {
      await logOnLocationJob(
        locationId,
        [`${polled.detail} Snapshot load did not find the template records in ${locationId}. It was not marked done.`],
        [],
        'needs_human',
      )
    }
  }
}

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
  void (async () => {
    snapshotBootRunning = true
    try {
      if (snapshotDiagnosticEnabled()) await runSnapshotDiagnostic()
      await loadListedSnapshots()
      for (const locationId of snapshotRecheckLocationIds()) await recheckSnapshotLocation(locationId)
      const wait = Math.max(0, AUTO_RETEST_DELAY_MS - (Date.now() - workerBootedAt))
      await new Promise((resolve) => setTimeout(resolve, wait))
    } finally {
      snapshotBootRunning = false
    }
    await retestNeedsHumanTestJobs()
  })().catch((err) => console.warn('[ghl-subaccount-worker] snapshot boot:', err))
}

export async function retestNeedsHumanTestJobs(now = Date.now()): Promise<number> {
  if (snapshotBootRunning || shuttingDown || workerPaused() || workerMode() === 'create') return 0
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
  let extendWall = (_ms: number) => {}

  const confirmRecords = async (locationId: string) => {
    extendWall(40 * 60 * 1000)
    return pollLocationRecords(locationId, readyFields.snapshotId, async (line) => {
      await extendLease(20 * 60 * 1000).catch(() => {})
      await touchHeartbeat(id, lease).catch(() => {})
      await appendLog(id, lease, line).catch(() => {})
    })
  }

  const acceptLocation = async (locationId: string, detail: string): Promise<string> => {
    if (workerMode() === 'create') {
      await appendLog(
        id,
        lease,
        `Checking real records on ${locationId} every 2 minutes for up to 15 minutes. A completed snapshot-status document is not enough.`,
      ).catch(() => {})
      const first = await confirmRecords(locationId)
      if (shuttingDown) return 'released'
      if (!first.ok) {
        let locationName = fields.name
        try {
          const official = await getLocation(await getAgencyContext(), locationId)
          if (official?.name) locationName = official.name
        } catch (err) {
          await appendLog(id, lease, `Couldn't read the location name (${describe(err)}). The push will match "${locationName}" or ${locationId}.`).catch(() => {})
        }
        await appendLog(
          id,
          lease,
          `Records are still empty. Pushing snapshot "${readyFields.snapshotName || readyFields.snapshotId}" (${readyFields.snapshotId}) from Account Snapshots into ${locationId} "${locationName}" only.`,
        ).catch(() => {})
        let pushed: Awaited<ReturnType<typeof pushSnapshotToLocation>>
        try {
          const launch = browserLaunch()
          launch.storageState = await loadSession()
          pushed = await pushSnapshotToLocation({
            ...launch,
            locationId,
            locationName,
            snapshotId: readyFields.snapshotId,
            snapshotName: readyFields.snapshotName || readyFields.snapshotId,
          })
        } catch (err) {
          return failHuman(`${detail} Snapshot push failed: ${describe(err)} ${first.detail}`, locationId)
        }
        await rememberCatalog(pushed.rows)
        for (const line of pushed.notes) await appendLog(id, lease, line).catch(() => {})
        for (const shot of pushed.shots) await saveJobShot(id, lease, shot.step, shot.image).catch(() => {})
        if (!pushed.confirmed) {
          return failHuman(`${detail} ${first.detail} ${pushed.notes[pushed.notes.length - 1] || 'The agency snapshot push was not confirmed.'}`, locationId)
        }
        const second = await confirmRecords(locationId)
        if (shuttingDown) return 'released'
        if (!second.ok) return failHuman(`${detail} ${second.detail}`, locationId)
        detail = `${detail} ${second.detail}`
      } else {
        detail = `${detail} ${first.detail}`
      }
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
  let timer = setTimeout(() => ac.abort(), JOB_TIMEOUT_MS)
  extendWall = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => ac.abort(), ms)
  }
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
