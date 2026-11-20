/**
 * The client tracker: rows derived from what the Hub knows (src/lib/tracker/
 * derive.ts over src/lib/tracker/facts.ts), plus the ClientTracker row that
 * holds a client's hand marks and status-link nonce. A hand mark is audited
 * in ClientJourneyEvent as stage "tracker.<step>". Provider-neutral.
 */
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import {
  MANUAL_FIELDS,
  deriveSteps,
  filterRows,
  inStripe,
  isManualStep,
  lastChangeAt,
  publicStatusView,
  readStep,
  summarizeTracker,
  trackerRow,
  type ManualStep,
  type PublicStatus,
  type RowFilter,
  type TrackerRow,
  type TrackerSummary,
} from './derive'
import { trackerFacts, type BillingRead } from './facts'
import { linkSecret, newNonce, signStatusToken, tokenClientId, verifyStatusToken } from './token'

export type { TrackerRow, TrackerSummary }

export type TrackerList = {
  rows: TrackerRow[]
  /** Over every client listed, roster only: after the Stripe toggle, before the other filters. */
  summary: TrackerSummary
  billing: BillingRead
  asOf: string
}

export async function listTracker(opts: RowFilter & { includeArchived?: boolean; refresh?: boolean } = {}): Promise<TrackerList> {
  const { facts, rows: meta, billing } = await trackerFacts({ includeArchived: opts.includeArchived, refresh: opts.refresh })
  const now = Date.now()
  const all = facts.map((f) => trackerRow(f, meta.get(f.id) ?? { hasRow: false, sheetRow: null }, now))
  // "In Stripe only" narrows the population, so the view counts follow it.
  const pop = opts.stripe ? all.filter(inStripe) : all
  return { rows: filterRows(pop, opts), summary: summarizeTracker(pop), billing, asOf: new Date(now).toISOString() }
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

/** The step a request names, when it is one that can be marked by hand; null otherwise. */
export function manualStepFor(step: unknown): ManualStep | null {
  const s = readStep(step)
  return s && isManualStep(s) ? s : null
}

/**
 * Mark one step done (or clear the mark) by hand, auditing the change. Only the
 * five hand-markable steps; the rest are read from the Hub and refused by the
 * callers. No-op (no event) when unchanged.
 */
export async function setTrackerStep(clientId: string, step: ManualStep, status: 'done' | 'pending', opts: { actor?: string | null; note?: string | null } = {}) {
  const row = await ensureTrackerRow(clientId)
  const field = MANUAL_FIELDS[step]
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

/** Public: the client's derived status for a token, or null for any bad/revoked token. */
export async function publicStatus(token: string): Promise<PublicStatus | null> {
  const clientId = tokenClientId(token)
  if (!clientId) return null
  const row = await prisma.clientTracker.findUnique({ where: { clientId }, include: { client: { select: { name: true } } } })
  if (!row || !verifyStatusToken(token, row.publicTokenNonce, linkSecret())) return null
  const { facts } = await trackerFacts({ clientId, includeArchived: true })
  const f = facts[0]
  if (!f) return null
  const steps = deriveSteps(f)
  // The Hub's own client name: the sheet's and the form's business fields have held addresses.
  return publicStatusView(steps, { business: row.client.name, updatedAt: lastChangeAt(steps, f.createdAt) })
}
