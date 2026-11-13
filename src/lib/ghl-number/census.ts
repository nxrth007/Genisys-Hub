/**
 * The daily read of each linked client's GHL numbers, on the browser worker
 * when it has nothing else to do (after sub-account creates, toll-free numbers
 * and workflow copy). Read-only: it opens Phone System → Manage Numbers and
 * records what's there (GhlNumberCensus). Sites and Echo's number question
 * use it: a sub-account with a number is set up already; one without needs
 * one (./census-plan.ts).
 */
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { workerEnabled, workerHeadless, workerPaused } from '@/lib/ghl-subaccount-worker/config'
import { ghlLabels } from '@/lib/ghl-subaccount-worker/labels'
import { loadLogin, loadSession, makeOtpPuller, saveSession } from '@/lib/ghl-subaccount-worker/session-store'
import { runGhlCensus, type CensusLocation, type CensusRead } from './browser'
import { CENSUS_VERSION, dueForCensus } from './census-plan'

const LEASE_KEY = 'ghlCensus.lease'
const LEASE_MS = 20 * 60_000
const WALL_MS = 15 * 60_000
/** After a run that couldn't start or sign in, wait this long instead of trying every tick. */
const PAUSE_AFTER_FAILURE_MS = 60 * 60_000

/**
 * Paused (2026-11-13): reading eight GHL Phone System pages in a row ran the
 * Render instance out of memory (over 2 GB) every run, at 2:35, 2:56, 3:17 and
 * 3:41 AM ET, and each crash took the Hub down. Reads already saved stay; no
 * new ones until the read is rebuilt to use far less memory.
 */
export const CENSUS_ON = false

let pausedUntil = 0
let running = false
let stopping = false
let abortLive: (() => void) | null = null

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Render is shutting this instance down: stop reading (what was read is saved already). */
export function stopGhlCensus(): void {
  stopping = true
  abortLive?.()
}

/** One instance at a time (a deploy overlaps two for a while). */
async function takeLease(now: number): Promise<boolean> {
  await prisma.appSetting.upsert({ where: { key: LEASE_KEY }, create: { key: LEASE_KEY, value: new Date(0).toISOString() }, update: {} }).catch(() => {})
  const res = await prisma.appSetting.updateMany({ where: { key: LEASE_KEY, value: { lt: new Date(now).toISOString() } }, data: { value: new Date(now + LEASE_MS).toISOString() } })
  return res.count === 1
}

async function dropLease(): Promise<void> {
  await prisma.appSetting.updateMany({ where: { key: LEASE_KEY }, data: { value: new Date(0).toISOString() } }).catch(() => {})
}

/** Save one sub-account's read. A failed read keeps the last good one and only says what went wrong. */
async function save(loc: CensusLocation, read: CensusRead): Promise<void> {
  const now = new Date()
  const prior = await prisma.ghlNumberCensus.findUnique({ where: { clientId: loc.clientId }, select: { locationId: true, version: true } })
  const detail = read.detail.slice(0, 2000)
  if (read.state === 'error' && prior?.locationId === loc.locationId && prior.version >= CENSUS_VERSION) {
    await prisma.ghlNumberCensus.update({ where: { clientId: loc.clientId }, data: { triedAt: now, detail } })
    return
  }
  const data = {
    locationId: loc.locationId,
    state: read.state,
    numbers: read.numbers as unknown as Prisma.InputJsonValue,
    detail,
    checkedAt: read.state === 'error' ? null : now,
    triedAt: now,
    version: CENSUS_VERSION,
  }
  await prisma.ghlNumberCensus.upsert({ where: { clientId: loc.clientId }, create: { clientId: loc.clientId, ...data }, update: data })
}

/** One tick from the sub-account worker, when the browser is free and nothing else is waiting: read the next few sub-accounts. */
export async function ghlCensusTick(opts: { runBrowser: boolean }): Promise<{ claimed: boolean; outcome?: string }> {
  if (!CENSUS_ON || !workerEnabled() || !opts.runBrowser || workerPaused() || stopping || running) return { claimed: false }
  const now = Date.now()
  if (now < pausedUntil) return { claimed: false }
  const clients = await prisma.client.findMany({
    where: { archivedAt: null, ghlLocationId: { not: null } },
    select: { id: true, name: true, ghlLocationId: true, ghlNumberCensus: { select: { locationId: true, state: true, checkedAt: true, triedAt: true, version: true } } },
  })
  const due = dueForCensus(
    clients.map((c) => ({ id: c.id, locationId: c.ghlLocationId!, census: c.ghlNumberCensus })),
    now,
  )
  if (!due.length) return { claimed: false }
  if (!(await takeLease(now))) return { claimed: false }
  running = true
  const byId = new Map(clients.map((c) => [c.id, c]))
  const locations: CensusLocation[] = due.map((id) => {
    const c = byId.get(id)!
    return { clientId: c.id, clientName: c.name, locationId: c.ghlLocationId! }
  })
  const ac = new AbortController()
  abortLive = () => ac.abort()
  const timer = setTimeout(() => ac.abort(), WALL_MS)
  const note = async (line: string) => {
    console.log(`[ghl-census] ${line}`)
  }
  let read = 0
  try {
    const otp = makeOtpPuller(locations[0].clientId, note)
    const res = await runGhlCensus({
      locations,
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
      // A read takes no pictures.
      capture: async () => {},
      onRead: async (loc, r) => {
        read += 1
        await save(loc, r).catch((err) => console.warn('[ghl-census] save failed:', describe(err)))
      },
    })
    if (res.storageState) await saveSession(res.storageState).catch(() => {})
    return { claimed: true, outcome: `census:${read}/${locations.length}` }
  } catch (err) {
    // The browser didn't start or GHL wouldn't sign in: back off instead of retrying every tick.
    pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS
    console.warn(`[ghl-census] stopped after ${read} of ${locations.length}:`, describe(err))
    return { claimed: true, outcome: `census-stopped:${read}/${locations.length}` }
  } finally {
    clearTimeout(timer)
    abortLive = null
    running = false
    await dropLease()
  }
}
