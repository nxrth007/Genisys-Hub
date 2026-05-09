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
  const [clients, dbAppts, sheetRows, clientUsers] = await Promise.all([
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
        dueDate: true,
        contactName: true,
        contactRole: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        notes: true,
        intakeFormUrl: true,
        ghlSubaccountUrl: true,
        servicingZipcodes: true,
        createdAt: true,
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
    // Bulk lookup of every /client login linked to a client. Used to
    // surface "Login active since X" / "Awaiting first sign-in" in
    // the detail dialog's Additional info panel without N+1 fetches
    // per client. Matches any client_* role so we cover pending,
    // onboarding, active and denied states in one pass.
    prisma.user.findMany({
      where: {
        clientId: { not: null },
        role: { startsWith: 'client_' },
      },
      select: {
        id: true,
        email: true,
        role: true,
        clientId: true,
        mustChangePassword: true,
        createdAt: true,
        updatedAt: true,
      },
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
    // Qualified-appointment count: rows where the Sitdown flag (the
    // sheet's "Sent to Client?" column under the hood) is set to
    // "yes" — i.e. the client actually met with the customer. Drives
    // the client card's "X sitdowns" line so admins see fulfilled
    // appointments separately from total bookings.
    sitdowns: number
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
    sitdowns: 0,
    agents: new Set<string>(),
    lastBookingAt: null,
  })
  const byClient = new Map<string, Bucket>()

  // Sheet-presence indexes — built BEFORE the DB pass so we can
  // skip ghost DB rows (sync failed, never synced, sheet row
  // deleted). Without this, /clients showed `total = DB count` even
  // when the sheet had fewer rows, giving Alex the "Brighton 7
  // booked but master tracker shows 5" footgun. With it, /clients
  // mirrors what the master tracker actually shows; ghost DB rows
  // still surface in Settings → Sheet maintenance reconcile so
  // they're not silently lost.
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
  const sheetRowNumbers = new Set<number>()
  const sheetContentKeys = new Set<string>()
  for (const r of sheetRows) {
    sheetRowNumbers.add(r.rowNumber)
    const phoneKey = normalizePhoneForKey(r.customerPhone)
    const dateKey = apptKey(r.apptDateTime)
    if (phoneKey && dateKey) {
      sheetContentKeys.add(`${phoneKey}|${dateKey}`)
    }
  }

  // Track which sheet rowNumbers are already covered by a DB row
  // so the sheet pass below doesn't double-count Hub-booked
  // appointments.
  const coveredRowNumbers = new Set<number>()
  const coveredContent = new Set<string>()

  // ---- Pass 1: DB appointments (only those present in the sheet)
  for (const a of dbAppts) {
    if (!a.clientId) continue
    // Skip ghost DB rows so /clients matches /call-center/master-
    // tracker exactly.
    //
    // We CHECK CONTENT FIRST (phone + apptDateTime) because content
    // is stable across row shifts — phone + time don't change when
    // Mary inserts a row above. masterSheetRowNumber, by contrast,
    // becomes a stale pointer the moment the sheet's row order
    // changes: row 15 might have been the DB row's appointment last
    // week and someone else's appointment now. If we trusted the
    // row number, we'd count those ghost DB rows as "in sheet"
    // (they're not — a DIFFERENT row is at that position) and the
    // /clients total would inflate past the master tracker count.
    // Row-number fallback is only used when the DB row has no
    // content key (no phone or no apptDateTime — extremely rare).
    const phoneKey = normalizePhoneForKey(a.customerPhone)
    const dateKey = apptKey(a.apptDateTime)
    const hasContentKey = !!(phoneKey && dateKey)
    const inSheetByContent =
      hasContentKey &&
      sheetContentKeys.has(`${phoneKey!}|${dateKey!}`)
    const inSheetByRow =
      !hasContentKey &&
      a.masterSheetRowNumber != null &&
      sheetRowNumbers.has(a.masterSheetRowNumber)
    if (!inSheetByContent && !inSheetByRow) continue

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
    if (phoneKey && dateKey) {
      coveredContent.add(`${phoneKey}|${dateKey}`)
    }
  }

  // ---- Pass 2: master sheet rows
  // Sitdown is read from the sheet's "Sent to Client?" / "Sitdown"
  // column, which has no DB equivalent. To count sitdowns for
  // DB-tracked rows too, we route every sheet row first, increment
  // sitdowns unconditionally when the flag is "yes", then skip the
  // rest of the count fields if the row's already covered by the
  // DB pass.
  for (const r of sheetRows) {
    if (!r.customerName?.trim()) continue
    if (!r.apptDateTime) continue

    const route = routeRowToClient(
      { client: r.client, address: normalizeAddress(r.address) },
      routingIndex,
    )
    if (route.source === 'unrouted') continue
    const clientId = route.client.id
    const b = byClient.get(clientId) ?? empty()

    // Sitdown — every sheet row that routes to a client counts here,
    // including ones the DB pass already counted for total/upcoming/
    // etc., because the sentToClient flag lives only on the sheet.
    const sitdownRaw = String(r.sentToClient ?? '').trim().toLowerCase()
    if (
      ['yes', 'y', '1', 'true', 'sent', 'delivered', 'handed off'].includes(
        sitdownRaw,
      )
    ) {
      b.sitdowns++
    }

    // Dedup the rest of the count: DB pass already counted this row
    // for total/upcoming/showed/etc., so skip those increments to
    // avoid double-counting Hub-booked appointments.
    if (coveredRowNumbers.has(r.rowNumber)) {
      byClient.set(clientId, b)
      continue
    }
    const phoneKey = normalizePhoneForKey(r.customerPhone)
    const dateKey = apptKey(r.apptDateTime)
    if (phoneKey && dateKey && coveredContent.has(`${phoneKey}|${dateKey}`)) {
      byClient.set(clientId, b)
      continue
    }

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

  // Index client_* logins by clientId for O(1) lookup in the map
  // below. We don't expect more than one login per client, but if
  // there ever is — pick the most recently updated one as the
  // "current" login surfaced in the dialog (newer mustChangePassword
  // resets bump updatedAt).
  const loginByClientId = new Map<string, (typeof clientUsers)[number]>()
  for (const u of clientUsers) {
    if (!u.clientId) continue
    const existing = loginByClientId.get(u.clientId)
    if (!existing || u.updatedAt > existing.updatedAt) {
      loginByClientId.set(u.clientId, u)
    }
  }

  const result = clients.map((c) => {
    const stats = byClient.get(c.id) ?? empty()
    const login = loginByClientId.get(c.id) ?? null
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
      dueDate: c.dueDate ? c.dueDate.toISOString() : null,
      contactName: c.contactName,
      contactRole: c.contactRole,
      contactEmail: c.contactEmail,
      contactPhone: c.contactPhone,
      address: c.address,
      notes: c.notes,
      intakeFormUrl: c.intakeFormUrl,
      ghlSubaccountUrl: c.ghlSubaccountUrl,
      servicingZipcodes: c.servicingZipcodes,
      createdAt: c.createdAt.toISOString(),
      // null when admin hasn't provisioned a /client login yet (and
      // the client hasn't self-registered). Surfaced in the detail
      // dialog's Additional info panel so admin can spot whether a
      // client has actually signed in.
      linkedLogin: login
        ? {
            id: login.id,
            email: login.email,
            role: login.role,
            mustChangePassword: login.mustChangePassword,
            createdAt: login.createdAt.toISOString(),
            updatedAt: login.updatedAt.toISOString(),
          }
        : null,
      total: stats.total,
      upcoming: stats.upcoming,
      booked: stats.booked,
      showed: stats.showed,
      noShow: stats.noShow,
      cancelled: stats.cancelled,
      sitdowns: stats.sitdowns,
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
