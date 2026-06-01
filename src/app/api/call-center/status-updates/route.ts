import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { signRecordingUrl } from '@/lib/recording-proxy'
import { getPublicOrigin } from '@/lib/gmail'

/**
 * GET /api/call-center/status-updates
 *
 * Powers the /call-center/status-updates triage page. Returns
 * every active client's full appointment slate, grouped by client,
 * with the appointments-they've-updated bucket at the top of each
 * group and the still-pending appointments at the bottom.
 *
 * Why one big payload instead of per-client paginated lookups?
 *   - The numbers are small: ~20 active clients × ~50 recent appts
 *     each = ~1000 rows. Postgres + Prisma handle that in <100ms.
 *   - The UI wants to render every client section at once for the
 *     "any updates anywhere" scan. Per-client pagination would
 *     either lazy-load on scroll (ugly) or eagerly fetch all of
 *     them anyway (worse than one round-trip).
 *   - We cap at `appointmentsPerClient` (default 100) so a single
 *     massive client doesn't pull the response into multi-MB
 *     territory.
 *
 * Query params (all optional):
 *   - reviewStatus: 'all' | 'unreviewed' | 'reviewed' — defaults
 *                   to 'all'. Filter applies only to the updated
 *                   bucket; non-updated rows aren't review-able.
 *   - outcome:      comma-separated subset of showed,no_show,won,lost
 *   - since / until: ms timestamps; filter applies to apptDateTime
 *   - q:            fuzzy search across customer name, phone, address,
 *                   and clientNotes
 *   - clientId:     restrict to a single client's section
 *   - perClient:    cap appointments per client section (default 100)
 *
 * Returns a stable shape so the UI doesn't have to feature-detect.
 * Sections for clients with zero appointments overall are omitted.
 */

const MAX_PER_CLIENT = 250
const DEFAULT_PER_CLIENT = 100

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const reviewStatus = (url.searchParams.get('reviewStatus') || 'all').toLowerCase()
  const outcomeRaw = url.searchParams.get('outcome') || ''
  const outcomeFilter = new Set(
    outcomeRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  const sinceMs = parseMs(url.searchParams.get('since'))
  const untilMs = parseMs(url.searchParams.get('until'))
  const search = (url.searchParams.get('q') || '').trim().toLowerCase()
  const clientFilter = url.searchParams.get('clientId') || undefined
  const perClient = clampInt(
    url.searchParams.get('perClient'),
    DEFAULT_PER_CLIENT,
    1,
    MAX_PER_CLIENT,
  )

  // Pull every active client first so we can render sections for
  // clients with zero appointments-updated, too — admin sometimes
  // wants to scan "which clients haven't engaged at all". Filter
  // out clients with no appointments in the response shaping step
  // below.
  const clients = await prisma.client.findMany({
    where: {
      active: true,
      ...(clientFilter ? { id: clientFilter } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, color: true, state: true },
  })

  // One big appointment query, scoped to those clients. Composite
  // WHERE for the date / outcome filters; we shape into per-client
  // buckets in memory after. The partial index added in
  // 20260601200000_status_update_review keeps the unreviewed query
  // cheap.
  const apptWhere: Record<string, unknown> = {
    clientId: { in: clients.map((c) => c.id) },
  }
  const dateClause: Record<string, Date> = {}
  if (sinceMs !== null) dateClause.gte = new Date(sinceMs)
  if (untilMs !== null) dateClause.lte = new Date(untilMs)
  if (Object.keys(dateClause).length > 0) apptWhere.apptDateTime = dateClause

  // For the outcome filter, only restrict on UPDATED rows — the
  // non-updated bucket would always be empty if we filtered the
  // whole query by an outcome. We apply outcome filtering in the
  // bucketing step instead.

  const allAppts = await prisma.appointment.findMany({
    where: apptWhere,
    orderBy: [{ apptDateTime: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      clientId: true,
      apptDateTime: true,
      customerName: true,
      customerPhone: true,
      address: true,
      monthlyBill: true,
      utilityProvider: true,
      status: true,
      notes: true,
      bookedByName: true,
      callRecordingLink: true,
      clientNotes: true,
      clientStatusUpdatedAt: true,
      clientStatusReviewedAt: true,
      clientStatusReviewedById: true,
      clientStatusReviewedBy: {
        select: { id: true, name: true, email: true },
      },
      createdAt: true,
    },
  })

  // Latest status-change history from AppointmentEditLog —
  // surfaces "was: booked → now: no_show" on each updated card
  // without re-deriving from individual edits. Limit to the rows
  // we're about to return so this scales with response size, not
  // total log volume.
  const editIds = allAppts
    .filter((a) => a.clientStatusUpdatedAt)
    .map((a) => a.id)
  const editLogs =
    editIds.length === 0
      ? []
      : await prisma.appointmentEditLog.findMany({
          where: { appointmentId: { in: editIds } },
          orderBy: { createdAt: 'desc' },
          select: {
            appointmentId: true,
            createdAt: true,
            changes: true,
            editorEmail: true,
            editorName: true,
          },
        })
  // Map appointmentId → most-recent status change from a client
  // edit. Only count edits that actually moved `status`; an edit
  // that just changed notes shouldn't count as a "was X → now Y"
  // story.
  const previousStatusByAppt = new Map<string, string | null>()
  for (const log of editLogs) {
    // appointmentId is nullable on AppointmentEditLog (sheet-only
    // edits don't have one), but the .findMany above filtered to
    // ids in editIds, so we should never hit null here. Defensive
    // skip anyway so TS narrows the type for the .has/.set below.
    if (!log.appointmentId) continue
    if (previousStatusByAppt.has(log.appointmentId)) continue
    const changes = log.changes as Record<string, { before?: unknown }> | null
    const statusChange = changes?.status
    if (statusChange && 'before' in statusChange) {
      previousStatusByAppt.set(
        log.appointmentId,
        typeof statusChange.before === 'string' ? statusChange.before : null,
      )
    }
  }

  const hubOrigin = getPublicOrigin(req)

  // Bucket appts per client. Updated bucket → only rows where the
  // client has touched the status. Each bucket is then filtered by
  // reviewStatus + outcome + search. Non-updated bucket gets the
  // search filter but never the reviewStatus filter (nothing to
  // review).
  type SerializedAppt = ReturnType<typeof serializeAppt>
  const byClient = new Map<
    string,
    { updated: SerializedAppt[]; pending: SerializedAppt[] }
  >()
  for (const c of clients) {
    byClient.set(c.id, { updated: [], pending: [] })
  }

  let totalUpdated = 0
  let totalUnreviewed = 0
  let countsByOutcome: Record<string, number> = {}

  for (const a of allAppts) {
    const bucket = byClient.get(a.clientId ?? '')
    if (!bucket) continue
    const hit = matchesSearch(a, search)
    if (!hit) continue

    if (a.clientStatusUpdatedAt) {
      // Outcome filter — applies only to updated rows.
      if (
        outcomeFilter.size > 0 &&
        !outcomeFilter.has(a.status.toLowerCase())
      ) {
        continue
      }
      const reviewed = !!a.clientStatusReviewedAt
      if (reviewStatus === 'unreviewed' && reviewed) continue
      if (reviewStatus === 'reviewed' && !reviewed) continue

      const serialized = serializeAppt(a, {
        previousStatus: previousStatusByAppt.get(a.id) ?? null,
        hubOrigin,
      })
      bucket.updated.push(serialized)
      totalUpdated++
      if (!reviewed) totalUnreviewed++
      countsByOutcome[a.status.toLowerCase()] =
        (countsByOutcome[a.status.toLowerCase()] ?? 0) + 1
    } else {
      // Pending bucket — only when reviewStatus allows showing
      // non-updates at all. Hide entirely when admin filters to
      // "reviewed" because there's nothing to review here, and
      // they'd clutter the view.
      if (reviewStatus === 'reviewed') continue
      if (reviewStatus === 'unreviewed') continue
      const serialized = serializeAppt(a, {
        previousStatus: null,
        hubOrigin,
      })
      bucket.pending.push(serialized)
    }
  }

  // Trim each bucket to perClient — applied per-section so a
  // mega-client doesn't starve everyone else of API time, but
  // sections all keep their top-N most-recent rows. Updated bucket
  // keeps its sort (most recent client update first); pending
  // bucket keeps the appt-date sort from the SQL ORDER BY.
  for (const bucket of byClient.values()) {
    bucket.updated.sort((a, b) => {
      const aTs = a.clientStatusUpdatedAt
        ? Date.parse(a.clientStatusUpdatedAt)
        : 0
      const bTs = b.clientStatusUpdatedAt
        ? Date.parse(b.clientStatusUpdatedAt)
        : 0
      return bTs - aTs
    })
    if (bucket.updated.length > perClient) {
      bucket.updated = bucket.updated.slice(0, perClient)
    }
    if (bucket.pending.length > perClient) {
      bucket.pending = bucket.pending.slice(0, perClient)
    }
  }

  // Compose final response. Hide clients with zero appts overall
  // so the page doesn't render dead sections.
  const sections = clients
    .map((c) => {
      const b = byClient.get(c.id) ?? { updated: [], pending: [] }
      return {
        client: { id: c.id, name: c.name, color: c.color, state: c.state },
        updated: b.updated,
        pending: b.pending,
        counts: {
          updated: b.updated.length,
          pending: b.pending.length,
        },
      }
    })
    .filter((s) => s.updated.length + s.pending.length > 0)

  return NextResponse.json({
    sections,
    summary: {
      totalUpdated,
      totalUnreviewed,
      countsByOutcome,
    },
  })
}

/** Lazily produce the per-appointment payload shape with extras
 *  the bucket needs (resolved previous-status, signed recording
 *  URL). Kept inside the route file so the shape is colocated with
 *  the only consumer. */
function serializeAppt(
  a: {
    id: string
    apptDateTime: Date
    customerName: string
    customerPhone: string
    address: string | null
    monthlyBill: string | null
    utilityProvider: string | null
    status: string
    notes: string | null
    bookedByName: string | null
    callRecordingLink: string | null
    clientNotes: string | null
    clientStatusUpdatedAt: Date | null
    clientStatusReviewedAt: Date | null
    clientStatusReviewedById: string | null
    clientStatusReviewedBy: {
      id: string
      name: string | null
      email: string
    } | null
    createdAt: Date
  },
  extras: { previousStatus: string | null; hubOrigin: string },
) {
  return {
    id: a.id,
    apptDateTime: a.apptDateTime.toISOString(),
    customerName: a.customerName,
    customerPhone: a.customerPhone,
    address: a.address,
    monthlyBill: a.monthlyBill,
    utilityProvider: a.utilityProvider,
    status: a.status,
    notes: a.notes,
    bookedByName: a.bookedByName,
    clientNotes: a.clientNotes,
    clientStatusUpdatedAt: a.clientStatusUpdatedAt?.toISOString() ?? null,
    clientStatusReviewedAt: a.clientStatusReviewedAt?.toISOString() ?? null,
    clientStatusReviewedBy: a.clientStatusReviewedBy
      ? {
          id: a.clientStatusReviewedBy.id,
          name: a.clientStatusReviewedBy.name ?? a.clientStatusReviewedBy.email,
        }
      : null,
    previousStatus: extras.previousStatus,
    createdAt: a.createdAt.toISOString(),
    recordingUrl: a.callRecordingLink?.trim()
      ? signRecordingUrl(a.callRecordingLink.trim(), extras.hubOrigin)
      : null,
  }
}

function matchesSearch(
  a: {
    customerName: string
    customerPhone: string
    address: string | null
    clientNotes: string | null
    notes: string | null
  },
  q: string,
): boolean {
  if (!q) return true
  const haystacks = [
    a.customerName,
    a.customerPhone,
    a.address ?? '',
    a.clientNotes ?? '',
    a.notes ?? '',
  ].map((s) => s.toLowerCase())
  return haystacks.some((h) => h.includes(q))
}

function parseMs(raw: string | null): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}
