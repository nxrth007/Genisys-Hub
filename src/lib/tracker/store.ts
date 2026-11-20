/**
 * The client tracker: rows derived from what the Hub knows (src/lib/tracker/
 * derive.ts over src/lib/tracker/facts.ts), plus the ClientTracker row that
 * holds a client's hand marks and status-link nonce. A hand mark is audited
 * in ClientJourneyEvent as stage "tracker.<step>"; the final check (QA) is the
 * journey's own "qa" stage, audited the same way. A Stripe sign-up with no
 * client yet is a row too, keyed by its Stripe customer id. Provider-neutral.
 */
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { setJourneyStage } from '@/lib/client-journey'
import {
  MANUAL_FIELDS,
  deriveSteps,
  filterRows,
  inStripe,
  isHandStep,
  isManualStep,
  lastChangeAt,
  publicStatusView,
  readStep,
  sortRows,
  summarizeTracker,
  trackerRow,
  type HandStep,
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
  /** Newest sign-up first. */
  rows: TrackerRow[]
  /** Over every client listed, roster only: after the Stripe toggle, before the other filters. */
  summary: TrackerSummary
  billing: BillingRead
  asOf: string
}

export async function listTracker(opts: RowFilter & { includeArchived?: boolean; refresh?: boolean } = {}): Promise<TrackerList> {
  const { facts, rows: meta, billing } = await trackerFacts({ includeArchived: opts.includeArchived, refresh: opts.refresh })
  const now = Date.now()
  const all = sortRows(facts.map((f) => trackerRow(f, meta.get(f.id) ?? { hasRow: false, sheetRow: null }, now)))
  // "In Stripe only" narrows the population, so the view counts follow it.
  const pop = opts.stripe ? all.filter(inStripe) : all
  return { rows: filterRows(pop, opts), summary: summarizeTracker(pop), billing, asOf: new Date(now).toISOString() }
}

// ---- one client's page ---------------------------------------------------------------------

/** Contact and business details for the client page, from the onboarding form, the client record and Stripe. */
export type TrackerProfile = {
  person: string | null
  email: string | null
  phone: string | null
  /** The Hub's name for the business; null for a Stripe sign-up with no client yet. */
  business: string | null
  services: string | null
  address: string | null
  /** The site we built (the Clients site link, else Forge's published build). */
  website: string | null
}

/** A hand mark or a final check, for the client page's history. */
export type TrackerEvent = { id: string; stage: string; fromStatus: string | null; toStatus: string; note: string | null; actor: string | null; createdAt: string }

export type TrackerDetail = {
  row: TrackerRow
  profile: TrackerProfile
  billing: BillingRead
  events: TrackerEvent[]
  asOf: string
}

/** Long onboarding answers on one line, cut to fit. */
function oneLine(s: string | null | undefined, max = 220): string | null {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** The first value that holds a phone number: a US one as "(555) 123-4567", anything else as typed. */
function phoneOf(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) {
    const t = (v ?? '').trim()
    const d = t.replace(/\D/g, '')
    if (d.length < 10) continue
    const us = d.replace(/^1(?=\d{10}$)/, '')
    return us.length === 10 ? `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}` : t
  }
  return null
}

/**
 * One client's tracker page: the derived row, the contact and business
 * details, the Stripe read and the history of hand marks. `id` is a client id,
 * or a Stripe customer id (cus_…) for a sign-up with no client yet. Null when
 * neither exists.
 */
export async function trackerClient(id: string, o: { refresh?: boolean } = {}): Promise<TrackerDetail | null> {
  const { facts, rows: meta, billing } = await trackerFacts({ clientId: id, includeArchived: true, refresh: o.refresh })
  const f = facts[0]
  if (!f) return null
  const now = Date.now()
  const row = trackerRow(f, meta.get(f.id) ?? { hasRow: false, sheetRow: null }, now)
  const asOf = new Date(now).toISOString()
  if (f.stripeOnly) {
    return {
      row,
      profile: { person: f.person, email: f.email, phone: phoneOf(f.stripeOnly.phone), business: null, services: null, address: null, website: null },
      billing,
      events: [],
      asOf,
    }
  }
  const [c, events] = await Promise.all([
    prisma.client.findUnique({
      where: { id },
      select: {
        contactPhone: true,
        address: true,
        intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { businessContact: true, customerPhone: true, mainServices: true, businessAddress: true } },
      },
    }),
    trackerEvents(id, 30),
  ])
  const i = c?.intakes[0]
  return {
    row,
    profile: {
      person: f.person,
      email: f.email,
      phone: phoneOf(c?.contactPhone, i?.businessContact, i?.customerPhone, f.billing?.subscription?.phone),
      business: f.name,
      services: oneLine(i?.mainServices),
      address: oneLine(i?.businessAddress || c?.address, 160),
      website: f.siteUrl?.trim() || f.siteBuild?.liveUrl || null,
    },
    billing,
    events: events.map((e) => ({ id: e.id, stage: e.stage, fromStatus: e.fromStatus, toStatus: e.toStatus, note: e.note, actor: e.actor, createdAt: e.createdAt.toISOString() })),
    asOf,
  }
}

// ---- hand marks ----------------------------------------------------------------------------

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

/** The step a request names, when it is one of the five sheet-era steps; null otherwise. */
export function manualStepFor(step: unknown): ManualStep | null {
  const s = readStep(step)
  return s && isManualStep(s) ? s : null
}

/** The step a request names, when a person can mark it on the client's page (the five, or qa); null otherwise. */
export function handStepFor(step: unknown): HandStep | null {
  const s = readStep(step)
  return s && isHandStep(s) ? s : null
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

/**
 * A person's mark from the client page: the five sheet-era steps go to the
 * tracker row (setTrackerStep), the final check to the journey's "qa" stage,
 * whose note says what was tested. Both audited; no-op when unchanged.
 */
export async function markStep(clientId: string, step: HandStep, status: 'done' | 'pending', opts: { actor?: string | null; note?: string | null } = {}): Promise<{ changed: boolean; status: string }> {
  if (step !== 'qa') return setTrackerStep(clientId, step, status, opts)
  const before = await prisma.clientJourneyStage.findUnique({ where: { clientId_stage: { clientId, stage: 'qa' } }, select: { status: true } })
  const note = status === 'done' ? opts.note?.trim() || null : null
  const after = await setJourneyStage(clientId, 'qa', status, { note, actor: opts.actor ?? null })
  return { changed: (before?.status ?? 'pending') !== after, status: after }
}

/** Hand marks and final checks for one client, newest first. */
export async function trackerEvents(clientId: string, limit = 50) {
  return prisma.clientJourneyEvent.findMany({
    where: { clientId, OR: [{ stage: { startsWith: 'tracker.' } }, { stage: 'qa' }] },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

// ---- the client's status link --------------------------------------------------------------

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
