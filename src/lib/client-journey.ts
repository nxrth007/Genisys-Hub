/**
 * Genesis fulfillment journey, per client, stored in the DB
 * (ClientJourneyStage + ClientJourneyEvent audit rows).
 *
 *   signup -> intake -> subaccount -> website -> a2p -> qa
 *
 * Each stage is pending | in_progress | done | blocked. Every change writes
 * an audit event. The Google Sheet tracker (onboarding-tracker.ts) keeps
 * working as before; callers that tick it still do so themselves.
 *
 * Helpers here are best-effort by design for the pipeline: use
 * `recordJourney` from fire-and-forget paths so a journey write never
 * breaks intake, provisioning or a webhook.
 */
import { prisma } from './prisma'

export const JOURNEY_STAGES = ['signup', 'intake', 'subaccount', 'website', 'a2p', 'qa'] as const
export type JourneyStage = (typeof JOURNEY_STAGES)[number]
export const JOURNEY_STATUSES = ['pending', 'in_progress', 'done', 'blocked'] as const
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number]

export function isJourneyStage(v: unknown): v is JourneyStage {
  return typeof v === 'string' && (JOURNEY_STAGES as readonly string[]).includes(v)
}
export function isJourneyStatus(v: unknown): v is JourneyStatus {
  return typeof v === 'string' && (JOURNEY_STATUSES as readonly string[]).includes(v)
}

export type JourneyStageRow = {
  stage: JourneyStage
  status: JourneyStatus
  note: string | null
  startedAt: Date | null
  completedAt: Date | null
  blockedAt: Date | null
  updatedAt: Date | null
}

export type ClientJourney = {
  clientId: string
  stages: JourneyStageRow[]
  /** First stage that isn't done (null when every stage is done). */
  current: JourneyStage | null
}

/** Timestamp columns a move into `to` should set (pure; exported for tests). */
export function transitionData(
  to: JourneyStatus,
  prev: { startedAt?: Date | null } | null,
  now: Date,
): { startedAt?: Date; completedAt?: Date | null; blockedAt?: Date | null } {
  const started = prev?.startedAt ? {} : to === 'pending' ? {} : { startedAt: now }
  if (to === 'done') return { ...started, completedAt: now, blockedAt: null }
  if (to === 'blocked') return { ...started, blockedAt: now, completedAt: null }
  return { ...started, completedAt: null, blockedAt: null }
}

/** All six stages for a client, filling in "pending" for stages with no row yet. */
export async function getJourney(clientId: string): Promise<ClientJourney> {
  const rows = await prisma.clientJourneyStage.findMany({ where: { clientId } })
  const stages = JOURNEY_STAGES.map((stage): JourneyStageRow => {
    const r = rows.find((x) => x.stage === stage)
    return {
      stage,
      status: r && isJourneyStatus(r.status) ? r.status : 'pending',
      note: r?.note ?? null,
      startedAt: r?.startedAt ?? null,
      completedAt: r?.completedAt ?? null,
      blockedAt: r?.blockedAt ?? null,
      updatedAt: r?.updatedAt ?? null,
    }
  })
  return { clientId, stages, current: stages.find((s) => s.status !== 'done')?.stage ?? null }
}

export async function getJourneyEvents(clientId: string, limit = 50) {
  return prisma.clientJourneyEvent.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, take: limit })
}

/**
 * Set a stage's status and write an audit event. No-op (no event) when the
 * status and note are unchanged. Returns the new status.
 */
export async function setJourneyStage(
  clientId: string,
  stage: JourneyStage,
  status: JourneyStatus,
  opts: { note?: string | null; actor?: string | null } = {},
): Promise<JourneyStatus> {
  const now = new Date()
  const note = opts.note === undefined ? undefined : opts.note?.slice(0, 2000) ?? null
  const prev = await prisma.clientJourneyStage.findUnique({ where: { clientId_stage: { clientId, stage } } })
  if (prev && prev.status === status && (note === undefined || note === prev.note)) return status
  const fromStatus = prev?.status ?? null
  const data = { status, ...transitionData(status, prev, now), ...(note !== undefined ? { note } : {}) }
  await prisma.$transaction([
    prisma.clientJourneyStage.upsert({
      where: { clientId_stage: { clientId, stage } },
      create: { clientId, stage, ...data },
      update: data,
    }),
    prisma.clientJourneyEvent.create({
      data: { clientId, stage, fromStatus, toStatus: status, note: note ?? null, actor: opts.actor ?? null },
    }),
  ])
  return status
}

/**
 * Mark `stage` done and, if the next stage hasn't started, move it to
 * in_progress. Returns the next stage (null after qa).
 */
export async function advanceJourneyStage(
  clientId: string,
  stage: JourneyStage,
  opts: { note?: string | null; actor?: string | null } = {},
): Promise<JourneyStage | null> {
  await setJourneyStage(clientId, stage, 'done', opts)
  const next = JOURNEY_STAGES[JOURNEY_STAGES.indexOf(stage) + 1] ?? null
  if (next) {
    const row = await prisma.clientJourneyStage.findUnique({ where: { clientId_stage: { clientId, stage: next } } })
    if (!row || row.status === 'pending') await setJourneyStage(clientId, next, 'in_progress', { actor: opts.actor })
  }
  return next
}

export async function blockJourneyStage(
  clientId: string,
  stage: JourneyStage,
  reason: string,
  opts: { actor?: string | null } = {},
): Promise<void> {
  await setJourneyStage(clientId, stage, 'blocked', { note: reason, actor: opts.actor })
}

/** Fire-and-forget wrapper: logs instead of throwing. */
export async function recordJourney(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.warn(`[client-journey] ${label}:`, err)
  }
}
