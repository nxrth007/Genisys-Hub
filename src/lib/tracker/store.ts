/**
 * DB client tracker: read/write ClientTracker rows (one per client) with
 * every step change audited in ClientJourneyEvent as stage "tracker.<step>".
 * Provider-neutral: nothing here talks to GHL / Hell-level.
 */
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { STEP_FIELDS, TRACKER_STEPS, safeStatusView, type SafeStatus, type TrackerStatus, type TrackerStep } from './columns'
import { linkSecret, newNonce, signStatusToken, tokenClientId, verifyStatusToken } from './token'

export type TrackerListRow = {
  clientId: string
  clientName: string
  business: string | null
  contactName: string | null
  contactEmail: string | null
  startDate: string | null
  steps: Record<TrackerStep, TrackerStatus>
  /** First step not done (null = all done). */
  current: TrackerStep | null
  hasRow: boolean
  source: string | null
  sheetRow: number | null
  sheetSyncedAt: string | null
  updatedAt: string | null
  archived: boolean
  extra: Record<string, string> | null
}

const asStatus = (v: string | null | undefined): TrackerStatus => (v === 'done' ? 'done' : 'pending')

export async function listTracker(opts: { q?: string; step?: TrackerStep; status?: TrackerStatus; includeArchived?: boolean } = {}): Promise<TrackerListRow[]> {
  const clients = await prisma.client.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, contactName: true, contactEmail: true, archivedAt: true, tracker: true },
  })
  const q = (opts.q ?? '').trim().toLowerCase()
  const rows = clients.map((c): TrackerListRow => {
    const t = c.tracker
    const steps = Object.fromEntries(TRACKER_STEPS.map((s) => [s, asStatus(t?.[STEP_FIELDS[s]])])) as Record<TrackerStep, TrackerStatus>
    return {
      clientId: c.id,
      clientName: c.name,
      business: t?.business ?? null,
      contactName: t?.clientName ?? c.contactName,
      contactEmail: t?.contactEmail ?? c.contactEmail,
      startDate: t?.startDate ?? null,
      steps,
      current: TRACKER_STEPS.find((s) => steps[s] !== 'done') ?? null,
      hasRow: !!t,
      source: t?.source ?? null,
      sheetRow: t?.sheetRow ?? null,
      sheetSyncedAt: t?.sheetSyncedAt?.toISOString() ?? null,
      updatedAt: t?.updatedAt.toISOString() ?? null,
      archived: !!c.archivedAt,
      extra: (t?.extra as Record<string, string> | null) ?? null,
    }
  })
  return rows.filter((r) => {
    if (opts.step && opts.status && r.steps[opts.step] !== opts.status) return false
    if (!q) return true
    return [r.clientName, r.business, r.contactName, r.contactEmail].some((v) => (v ?? '').toLowerCase().includes(q))
  })
}

/** Create the client's tracker row from Hub data if it has none. Never creates a client. */
export async function ensureTrackerRow(clientId: string) {
  const existing = await prisma.clientTracker.findUnique({ where: { clientId } })
  if (existing) return existing
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, contactName: true, contactEmail: true, intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { businessName: true, fullName: true, leadEmail: true } } },
  })
  if (!c) throw new Error('client not found')
  const i = c.intakes[0]
  return prisma.clientTracker.upsert({
    where: { clientId },
    create: {
      clientId,
      clientName: i?.fullName || c.contactName,
      business: i?.businessName || c.name,
      contactEmail: (i?.leadEmail || c.contactEmail)?.toLowerCase() ?? null,
      source: 'hub',
    },
    update: {},
  })
}

/** Set one step's status, auditing the change. No-op (no event) when unchanged. */
export async function setTrackerStep(clientId: string, step: TrackerStep, status: TrackerStatus, opts: { actor?: string | null; note?: string | null } = {}) {
  const row = await ensureTrackerRow(clientId)
  const field = STEP_FIELDS[step]
  const from = row[field]
  if (from === status) return { changed: false, status }
  await prisma.$transaction([
    prisma.clientTracker.update({ where: { clientId }, data: { [field]: status } as Prisma.ClientTrackerUpdateInput }),
    prisma.clientJourneyEvent.create({
      data: { clientId, stage: `tracker.${step}`, fromStatus: from, toStatus: status, note: opts.note?.slice(0, 2000) ?? null, actor: opts.actor ?? null },
    }),
  ])
  return { changed: true, status }
}

export async function trackerEvents(clientId: string, limit = 50) {
  return prisma.clientJourneyEvent.findMany({
    where: { clientId, stage: { startsWith: 'tracker.' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

/**
 * Staff-only: the client's read-only status link path (`/status/<token>`).
 * `rotate` mints a new nonce, revoking any link sent before. Sends nothing.
 */
export async function statusLinkPath(clientId: string, opts: { rotate?: boolean } = {}): Promise<string> {
  const secret = linkSecret()
  if (!secret) throw new Error('Status links need TRACKER_LINK_SECRET (or AUTH_SECRET) set to at least 16 characters.')
  const row = await ensureTrackerRow(clientId)
  let nonce = row.publicTokenNonce
  if (!nonce || opts.rotate) {
    nonce = newNonce()
    await prisma.clientTracker.update({ where: { clientId }, data: { publicTokenNonce: nonce } })
  }
  return `/status/${signStatusToken(clientId, nonce, secret)}`
}

export async function revokeStatusLinks(clientId: string): Promise<void> {
  await prisma.clientTracker.updateMany({ where: { clientId }, data: { publicTokenNonce: null } })
}

/** Public: the safe status view for a token, or null for any bad/revoked token. */
export async function publicStatus(token: string): Promise<SafeStatus | null> {
  const clientId = tokenClientId(token)
  if (!clientId) return null
  const row = await prisma.clientTracker.findUnique({ where: { clientId }, include: { client: { select: { name: true, archivedAt: true } } } })
  if (!row || !verifyStatusToken(token, row.publicTokenNonce, linkSecret())) return null
  return safeStatusView({ ...row, business: row.business || row.client.name })
}
