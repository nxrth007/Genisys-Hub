import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { signRecordingUrl } from '@/lib/recording-proxy'
import { getPublicOrigin } from '@/lib/gmail'
import { readAllSheetRows } from '@/lib/secondary-sheets'
import { buildRoutingIndex, routeRowToClient } from '@/lib/client-routing'
import { normalizeAddress } from '@/lib/address'

/**
 * GET /api/call-center/status-updates
 *
 * Powers the /call-center/status-updates triage page. Returns every
 * active client's full appointment slate (DB + sheet) grouped by
 * client, with the appointments-the-client-has-updated bucket at
 * the top of each group and still-pending appointments at the
 * bottom.
 *
 * Two data sources, unified into one stream:
 *   1. DB Appointments       — created when Mary books via the Hub
 *      form. These are the ones the client can update from their
 *      dashboard; they carry clientStatusUpdatedAt + clientNotes +
 *      reviewed state.
 *   2. Google Sheet rows     — primary Master Table + secondary
 *      partner sheets. Sheet-only rows can't be client-updated
 *      (no DB row → no client login path), but admins still need
 *      to see them so the per-client section reflects the FULL
 *      pipeline, not just "the 11 that have DB rows".
 *
 * Matching: sheet rows with a corresponding DB Appointment (matched
 * by masterSheetRowNumber, or by phone + ISO datetime as a content
 * fallback) inherit the DB's status fields. Unmatched sheet rows
 * appear in the pending bucket using sheet data only.
 *
 * Query params (all optional):
 *   - reviewStatus: 'all' | 'unreviewed' | 'reviewed' — applies to
 *                   the updated bucket only
 *   - outcome:      comma-separated showed,no_show,won,lost
 *   - q:            fuzzy across name, phone, address, notes
 *   - clientId:     scope to a single client
 *   - perClient:    cap per section (default 250)
 *
 * Sections with zero rows are omitted so the page doesn't render
 * dead headers.
 */

const MAX_PER_CLIENT = 1000
const DEFAULT_PER_CLIENT = 250

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
  const search = (url.searchParams.get('q') || '').trim().toLowerCase()
  const clientFilter = url.searchParams.get('clientId') || undefined
  const perClient = clampInt(
    url.searchParams.get('perClient'),
    DEFAULT_PER_CLIENT,
    1,
    MAX_PER_CLIENT,
  )

  // Active clients — used both for filtering DB appointments AND
  // for routing sheet rows to a client via the same logic the
  // master tracker uses.
  const clients = await prisma.client.findMany({
    where: {
      active: true,
      ...(clientFilter ? { id: clientFilter } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, color: true, state: true },
  })
  const clientIdSet = new Set(clients.map((c) => c.id))
  const routingIndex = buildRoutingIndex(clients)

  // ─── DB pass ────────────────────────────────────────────────────
  // Every DB Appointment for these clients. Each one is the
  // authoritative source for its status fields (clientNotes,
  // clientStatusUpdatedAt, reviewed state, recording).
  const dbAppts = await prisma.appointment.findMany({
    where: { clientId: { in: clients.map((c) => c.id) } },
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
      masterSheetRowNumber: true,
      createdAt: true,
    },
  })

  // Build matching indexes so we can dedup sheet rows that already
  // have a DB row. Two keys, mirroring the master-tracker's
  // dedup-by-content approach:
  //   1. masterSheetRowNumber (fast path; the sync writes it back
  //      to the DB after first save)
  //   2. (phone + ISO apptDateTime) (content fallback for the
  //      pre-rownumber-write window, or for sheet edits that
  //      reordered rows)
  const dbByRowNumber = new Map<number, (typeof dbAppts)[number]>()
  const dbByContent = new Map<string, (typeof dbAppts)[number]>()
  for (const a of dbAppts) {
    if (a.masterSheetRowNumber) {
      dbByRowNumber.set(a.masterSheetRowNumber, a)
    }
    const phoneKey = normalizePhoneKey(a.customerPhone)
    const apptIso = a.apptDateTime ? a.apptDateTime.toISOString() : null
    if (phoneKey && apptIso) {
      dbByContent.set(`${phoneKey}|${apptIso}`, a)
    }
  }

  // ─── Sheet pass ─────────────────────────────────────────────────
  // Read every sheet row across the primary Master Table + secondary
  // partner sheets. A sheet failure here shouldn't take down the
  // whole page — we degrade gracefully by returning DB-only data
  // and surfacing a `sheetReadError` field the UI can render as a
  // banner.
  //
  // TEMPORARY: per Alex 2026-06-01, sheets are read here because
  // most existing client appointments still live on sheets and
  // haven't been migrated into the Appointment table. Once
  // everything onboards through the Hub form (and the legacy
  // sheet rows are either backfilled or written off), DELETE this
  // entire block + the sheet-walk merge below, and drop the
  // hasDbRow / sourceKind / sheetReadError fields from the
  // response shape. The DB-only fast path is the long-term plan.
  let sheetRows: Awaited<ReturnType<typeof readAllSheetRows>> = []
  let sheetReadError: string | null = null
  try {
    sheetRows = await readAllSheetRows()
  } catch (err) {
    sheetReadError = err instanceof Error ? err.message : 'Sheet read failed'
    console.error('[status-updates] readAllSheetRows failed:', err)
  }

  // Edit-log lookup for "was: booked → now: no_show". Bounded to
  // rows we'll actually return so the join scales with output, not
  // the entire history.
  const updatedDbIds = dbAppts
    .filter((a) => a.clientStatusUpdatedAt)
    .map((a) => a.id)
  const editLogs =
    updatedDbIds.length === 0
      ? []
      : await prisma.appointmentEditLog.findMany({
          where: { appointmentId: { in: updatedDbIds } },
          orderBy: { createdAt: 'desc' },
          select: {
            appointmentId: true,
            createdAt: true,
            changes: true,
          },
        })
  const previousStatusByAppt = new Map<string, string | null>()
  for (const log of editLogs) {
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

  // ─── Merge ──────────────────────────────────────────────────────
  // Walk every sheet row and produce a unified appointment shape.
  // Primary sheet rows that match a DB row inherit DB-side state
  // (and we mark the DB row as consumed). Sheet-only rows surface
  // with sheet data. After the sheet walk, any remaining DB rows
  // (Hub-booked but not yet visible on the sheet, e.g. a sync
  // hasn't run) get appended so we don't drop anything.
  type Serialized = SerializedAppointment
  type Bucket = { updated: Serialized[]; pending: Serialized[] }
  const byClient = new Map<string, Bucket>()
  for (const c of clients) {
    byClient.set(c.id, { updated: [], pending: [] })
  }
  const consumedDbIds = new Set<string>()

  for (const row of sheetRows) {
    const cleanedAddress = normalizeAddress(row.address)
    const route = routeRowToClient(
      { client: row.client, address: cleanedAddress },
      routingIndex,
    )
    const matchedClient =
      route.source === 'explicit' || route.source === 'inferred-state'
        ? route.client
        : null
    if (!matchedClient) continue
    if (!clientIdSet.has(matchedClient.id)) continue
    const bucket = byClient.get(matchedClient.id)
    if (!bucket) continue

    // Try to match to a DB row. Primary-sheet rows have a row
    // number we can key on; secondary partner-sheet rows generally
    // won't (they have a separate sourceKey shape and aren't synced
    // into the Appointment table).
    let db: (typeof dbAppts)[number] | undefined
    if (row.source.kind === 'primary' && row.rowNumber) {
      db = dbByRowNumber.get(row.rowNumber)
    }
    if (!db) {
      const phoneKey = normalizePhoneKey(row.customerPhone)
      const apptIso = row.apptDateTime
        ? new Date(row.apptDateTime).toISOString()
        : null
      if (phoneKey && apptIso) {
        db = dbByContent.get(`${phoneKey}|${apptIso}`)
      }
    }
    if (db) consumedDbIds.add(db.id)

    const serialized = serializeRow({
      sheetRow: row,
      db,
      previousStatusByAppt,
      hubOrigin,
    })
    if (!matchesSearch(serialized, search)) continue

    if (serialized.clientStatusUpdatedAt) {
      if (
        outcomeFilter.size > 0 &&
        !outcomeFilter.has(serialized.status.toLowerCase())
      ) {
        continue
      }
      const reviewed = !!serialized.clientStatusReviewedAt
      if (reviewStatus === 'unreviewed' && reviewed) continue
      if (reviewStatus === 'reviewed' && !reviewed) continue
      bucket.updated.push(serialized)
    } else {
      // Pending bucket — skip when admin filtered to either
      // reviewed-only or unreviewed-only since neither concept
      // applies here.
      if (reviewStatus === 'unreviewed' || reviewStatus === 'reviewed') continue
      bucket.pending.push(serialized)
    }
  }

  // Append any DB appointments that weren't consumed by a sheet
  // row. This is the in-flight case: Mary booked through the Hub,
  // the DB row exists, the sheet sync hasn't run yet so there's no
  // sheet row to find it under. Without this, those rows would
  // disappear from the page entirely.
  for (const a of dbAppts) {
    if (consumedDbIds.has(a.id)) continue
    const bucket = byClient.get(a.clientId ?? '')
    if (!bucket) continue
    const serialized = serializeRow({
      sheetRow: null,
      db: a,
      previousStatusByAppt,
      hubOrigin,
    })
    if (!matchesSearch(serialized, search)) continue
    if (serialized.clientStatusUpdatedAt) {
      if (
        outcomeFilter.size > 0 &&
        !outcomeFilter.has(serialized.status.toLowerCase())
      ) {
        continue
      }
      const reviewed = !!serialized.clientStatusReviewedAt
      if (reviewStatus === 'unreviewed' && reviewed) continue
      if (reviewStatus === 'reviewed' && !reviewed) continue
      bucket.updated.push(serialized)
    } else {
      if (reviewStatus === 'unreviewed' || reviewStatus === 'reviewed') continue
      bucket.pending.push(serialized)
    }
  }

  // ─── Summary + final sort + cap ─────────────────────────────────
  let totalUpdated = 0
  let totalUnreviewed = 0
  const countsByOutcome: Record<string, number> = {}
  for (const bucket of byClient.values()) {
    // Updated rows: most recent client update first.
    bucket.updated.sort((a, b) => {
      const aTs = a.clientStatusUpdatedAt
        ? Date.parse(a.clientStatusUpdatedAt)
        : 0
      const bTs = b.clientStatusUpdatedAt
        ? Date.parse(b.clientStatusUpdatedAt)
        : 0
      return bTs - aTs
    })
    // Pending rows: most recent appointment first so admin sees
    // upcoming bookings before old cancelled ones.
    bucket.pending.sort((a, b) => {
      return Date.parse(b.apptDateTime) - Date.parse(a.apptDateTime)
    })
    // Tally before truncation so the summary reflects the full
    // result set rather than just what fits on the page.
    for (const u of bucket.updated) {
      totalUpdated++
      if (!u.clientStatusReviewedAt) totalUnreviewed++
      const key = u.status.toLowerCase()
      countsByOutcome[key] = (countsByOutcome[key] ?? 0) + 1
    }
    if (bucket.updated.length > perClient) {
      bucket.updated = bucket.updated.slice(0, perClient)
    }
    if (bucket.pending.length > perClient) {
      bucket.pending = bucket.pending.slice(0, perClient)
    }
  }

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
    sheetReadError,
  })
}

/* -------------------------------------------------------------------------- */
/*  Serialization helpers                                                     */
/* -------------------------------------------------------------------------- */

type SerializedAppointment = {
  /** Stable id for React keys + the review-toggle endpoint.
   *  - DB appointment id when present
   *  - 'sheet:<rowNumber>' for unmatched primary-sheet rows
   *  - 'sheet:<spreadsheetId>:<rowNumber>' for unmatched secondary
   *    sheet rows
   */
  id: string
  /** True when this row is backed by a DB Appointment (and therefore
   *  can be toggled reviewed / has a client-facing update path).
   *  False for sheet-only rows — UI hides the View-Update + Mark-
   *  Reviewed actions for these. */
  hasDbRow: boolean
  apptDateTime: string
  customerName: string
  customerPhone: string
  address: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  status: string
  notes: string | null
  bookedByName: string | null
  clientNotes: string | null
  clientStatusUpdatedAt: string | null
  clientStatusReviewedAt: string | null
  clientStatusReviewedBy: { id: string; name: string } | null
  previousStatus: string | null
  createdAt: string
  recordingUrl: string | null
  /** Discrimination tag so the UI can render a small "partner"
   *  badge on secondary-sheet rows the same way master tracker
   *  does. */
  sourceKind: 'primary' | 'secondary' | 'db-only'
}

function serializeRow(opts: {
  sheetRow: Awaited<ReturnType<typeof readAllSheetRows>>[number] | null
  db:
    | {
        id: string
        clientId: string | null
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
        clientStatusReviewedBy: {
          id: string
          name: string | null
          email: string
        } | null
        createdAt: Date
      }
    | undefined
  previousStatusByAppt: Map<string, string | null>
  hubOrigin: string
}): SerializedAppointment {
  const { sheetRow, db, previousStatusByAppt, hubOrigin } = opts
  const hasDbRow = !!db

  if (db) {
    return {
      id: db.id,
      hasDbRow: true,
      apptDateTime: db.apptDateTime.toISOString(),
      customerName: db.customerName,
      customerPhone: db.customerPhone,
      address: db.address,
      monthlyBill: db.monthlyBill,
      utilityProvider: db.utilityProvider,
      status: db.status,
      notes: db.notes,
      bookedByName: db.bookedByName,
      clientNotes: db.clientNotes,
      clientStatusUpdatedAt: db.clientStatusUpdatedAt?.toISOString() ?? null,
      clientStatusReviewedAt: db.clientStatusReviewedAt?.toISOString() ?? null,
      clientStatusReviewedBy: db.clientStatusReviewedBy
        ? {
            id: db.clientStatusReviewedBy.id,
            name: db.clientStatusReviewedBy.name ?? db.clientStatusReviewedBy.email,
          }
        : null,
      previousStatus: previousStatusByAppt.get(db.id) ?? null,
      createdAt: db.createdAt.toISOString(),
      recordingUrl: db.callRecordingLink?.trim()
        ? signRecordingUrl(db.callRecordingLink.trim(), hubOrigin)
        : null,
      sourceKind:
        sheetRow?.source.kind === 'secondary' ? 'secondary' : 'primary',
    }
  }

  // Sheet-only: synthesize from the sheet row.
  if (!sheetRow) {
    // Defensive — shouldn't happen with current call sites.
    throw new Error('serializeRow called without sheetRow or db')
  }
  const idPrefix =
    sheetRow.source.kind === 'secondary'
      ? `sheet:${sheetRow.source.spreadsheetId}`
      : 'sheet'
  const apptIso = sheetRow.apptDateTime
    ? new Date(sheetRow.apptDateTime).toISOString()
    : new Date(0).toISOString()
  return {
    id: `${idPrefix}:${sheetRow.rowNumber}`,
    hasDbRow: false,
    apptDateTime: apptIso,
    customerName: sheetRow.customerName,
    customerPhone: sheetRow.customerPhone,
    address: sheetRow.address,
    monthlyBill: sheetRow.monthlyBill,
    utilityProvider: sheetRow.utilityProvider,
    status: normalizeSheetStatus(sheetRow.status),
    notes: sheetRow.notes,
    bookedByName: sheetRow.agentName,
    clientNotes: null,
    clientStatusUpdatedAt: null,
    clientStatusReviewedAt: null,
    clientStatusReviewedBy: null,
    previousStatus: null,
    createdAt: sheetRow.loggedAt
      ? new Date(sheetRow.loggedAt).toISOString()
      : apptIso,
    recordingUrl: sheetRow.callRecordingLink?.trim()
      ? signRecordingUrl(sheetRow.callRecordingLink.trim(), hubOrigin)
      : null,
    sourceKind: sheetRow.source.kind,
  }
}

/** Normalize free-form sheet status cells into the canonical
 *  underscore-cased tokens the UI keys on. Mirrors the master
 *  tracker's normalizeStatus inline helper. */
function normalizeSheetStatus(raw: string | null): string {
  if (!raw) return 'booked'
  const s = raw.toLowerCase().trim()
  if (s === 'no show' || s === 'no-show' || s === 'noshow') return 'no_show'
  if (s === 'rescheduled' || s === 'reschedule') return 'rescheduled'
  if (s === 'showed' || s === 'show' || s === 'shown') return 'showed'
  if (s === 'cancelled' || s === 'canceled' || s === 'cancel') return 'cancelled'
  if (s === 'won' || s === 'closed' || s === 'sold' || s === 'win') return 'won'
  if (s === 'lost' || s === 'no sale' || s === 'no-sale' || s === 'loss') {
    return 'lost'
  }
  return 'booked'
}

function normalizePhoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return null
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
