import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { readMasterTableRows } from '@/lib/drive'
import { buildRoutingIndex, routeRowToClient } from '@/lib/client-routing'
import { normalizeAddress } from '@/lib/address'

/**
 * GET /api/clients/with-counts
 *
 * Returns each registered client with appointment statistics. Powers
 * the /clients listing page. Counts pull from BOTH the DB Appointment
 * table (Hub-form bookings) AND the master sheet (manual entries),
 * deduped via the existing masterSheetRowNumber + content key, with
 * sheet rows routed to clients via the same routing brain that
 * powers the Slack-channel delivery sync (explicit Client column
 * first, address-state inference second, ambiguous left unrouted).
 *
 * Originally read only the Appointment table — but the call center
 * mostly types straight into the sheet, so the DB-only counts
 * showed near-zero appointments per client even though the sheet
 * had dozens. Hence /clients's Show Rate was always "—" and the
 * metric felt broken.
 *
 * Staff-only.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Fetch clients, DB appointments, and master sheet rows in
  // parallel. Sheet read is best-effort — a transient Drive API
  // failure shouldn't break the page; we'd rather show DB-only
  // counts than no counts at all.
  const [clients, dbAppts, sheetRows] = await Promise.all([
    prisma.client.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        state: true,
        color: true,
        lifecycle: true,
        package: true,
        apptCap: true,
        contactName: true,
        contactRole: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        notes: true,
        intakeFormUrl: true,
        ghlSubaccountUrl: true,
      },
    }),
    prisma.appointment.findMany({
      select: {
        clientId: true,
        apptDateTime: true,
        createdAt: true,
        status: true,
        agentUserId: true,
        masterSheetRowNumber: true,
        customerPhone: true,
      },
    }),
    readMasterTableRows().catch((err) => {
      console.error('[clients/with-counts] sheet read failed:', err)
      return [] as Awaited<ReturnType<typeof readMasterTableRows>>
    }),
  ])

  // Build the routing index once so sheet rows can be attributed
  // to a client via the same logic the Slack-delivery sync uses.
  const routingIndex = buildRoutingIndex(clients)

  type Bucket = {
    total: number
    upcoming: number
    showed: number
    noShow: number
    cancelled: number
    booked: number // status='booked' (still on the books, not yet resolved)
    agents: Set<string>
    lastBookingAt: Date | null
  }
  const empty = (): Bucket => ({
    total: 0,
    upcoming: 0,
    showed: 0,
    noShow: 0,
    cancelled: 0,
    booked: 0,
    agents: new Set<string>(),
    lastBookingAt: null,
  })
  const byClient = new Map<string, Bucket>()

  // Track which sheet rowNumbers are already covered by a DB row
  // so the sheet pass doesn't double-count Hub-booked appointments.
  // Also a content key (phone + apptDateTime to the minute) so the
  // in-flight sync window doesn't briefly inflate counts.
  const coveredRowNumbers = new Set<number>()
  const coveredContent = new Set<string>()
  function normalizePhoneForKey(raw: string | null | undefined): string | null {
    if (!raw) return null
    const digits = String(raw).replace(/\D/g, '')
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    if (digits.length >= 10) return `+${digits}`
    return null
  }
  function apptKey(d: Date | string | null): string | null {
    if (!d) return null
    const date = typeof d === 'string' ? new Date(d) : d
    if (isNaN(date.getTime())) return null
    return new Date(
      Math.floor(date.getTime() / 60_000) * 60_000,
    ).toISOString()
  }

  // ---- Pass 1: DB appointments
  for (const a of dbAppts) {
    if (!a.clientId) continue
    const b = byClient.get(a.clientId) ?? empty()
    b.total++
    if (a.apptDateTime > now && a.status === 'booked') b.upcoming++
    if (a.status === 'showed') b.showed++
    if (a.status === 'no_show') b.noShow++
    if (a.status === 'cancelled') b.cancelled++
    if (a.status === 'booked') b.booked++
    if (a.agentUserId) b.agents.add(a.agentUserId)
    if (!b.lastBookingAt || a.createdAt > b.lastBookingAt) {
      b.lastBookingAt = a.createdAt
    }
    byClient.set(a.clientId, b)

    if (a.masterSheetRowNumber) coveredRowNumbers.add(a.masterSheetRowNumber)
    const phoneKey = normalizePhoneForKey(a.customerPhone)
    const dateKey = apptKey(a.apptDateTime)
    if (phoneKey && dateKey) {
      coveredContent.add(`${phoneKey}|${dateKey}`)
    }
  }

  // ---- Pass 2: master sheet rows
  for (const r of sheetRows) {
    if (!r.customerName?.trim()) continue
    if (!r.apptDateTime) continue
    if (coveredRowNumbers.has(r.rowNumber)) continue
    const phoneKey = normalizePhoneForKey(r.customerPhone)
    const dateKey = apptKey(r.apptDateTime)
    if (phoneKey && dateKey && coveredContent.has(`${phoneKey}|${dateKey}`)) {
      continue
    }

    const route = routeRowToClient(
      { client: r.client, address: normalizeAddress(r.address) },
      routingIndex,
    )
    if (route.source === 'unrouted') continue
    const clientId = route.client.id

    const b = byClient.get(clientId) ?? empty()
    b.total++
    const apptDate = new Date(r.apptDateTime)
    const status = (r.status ?? '').toLowerCase().trim()
    const isBookedStatus =
      !status || status === 'booked' || status === 'rescheduled'
    if (apptDate > now && isBookedStatus) b.upcoming++
    if (status === 'showed' || status === 'show' || status === 'shown')
      b.showed++
    if (
      status === 'no show' ||
      status === 'no-show' ||
      status === 'noshow' ||
      status === 'no_show'
    )
      b.noShow++
    if (
      status === 'cancelled' ||
      status === 'canceled' ||
      status === 'cancel'
    )
      b.cancelled++
    if (!status || status === 'booked') b.booked++
    // Sheet rows don't reliably carry the originating Hub user, so
    // skip the agent count contribution. The DB pass already counts
    // distinct Hub agents; sheet entries just bump the appointment
    // totals.
    const loggedAt = r.loggedAt ? new Date(r.loggedAt) : null
    const ts = loggedAt && !isNaN(loggedAt.getTime()) ? loggedAt : apptDate
    if (!b.lastBookingAt || ts > b.lastBookingAt) {
      b.lastBookingAt = ts
    }
    byClient.set(clientId, b)
  }

  const result = clients.map((c) => {
    const stats = byClient.get(c.id) ?? empty()
    // Appointment-progress metric: completed share of all booked
    // appointments. Higher = more appointments have been resolved
    // (showed or no-show), which signals the client is actively
    // moving through their pipeline. 0% means everything's still
    // pending; 100% means everything's resolved.
    const resolved = stats.showed + stats.noShow + stats.cancelled
    const progressPct =
      stats.total > 0 ? Math.round((resolved / stats.total) * 100) : null
    // Show rate: of resolved (showed + no-show, not cancelled),
    // what fraction actually showed up. Useful but secondary to
    // the progress count, so we still surface it for admins who
    // care about it.
    const completed = stats.showed + stats.noShow
    const showRate =
      completed > 0 ? Math.round((stats.showed / completed) * 100) : null
    return {
      id: c.id,
      name: c.name,
      state: c.state,
      color: c.color,
      lifecycle: c.lifecycle,
      package: c.package,
      apptCap: c.apptCap,
      contactName: c.contactName,
      contactRole: c.contactRole,
      contactEmail: c.contactEmail,
      contactPhone: c.contactPhone,
      address: c.address,
      notes: c.notes,
      intakeFormUrl: c.intakeFormUrl,
      ghlSubaccountUrl: c.ghlSubaccountUrl,
      total: stats.total,
      upcoming: stats.upcoming,
      booked: stats.booked,
      showed: stats.showed,
      noShow: stats.noShow,
      cancelled: stats.cancelled,
      progressPct,
      showRate,
      agents: stats.agents.size,
      lastBookingAt: stats.lastBookingAt
        ? stats.lastBookingAt.toISOString()
        : null,
    }
  })

  return NextResponse.json({ clients: result })
}
