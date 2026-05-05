import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { syncAppointmentCreate } from '@/lib/appointment-sync'
import { deliverAppointmentToSlack } from '@/lib/client-delivery'
import { deliverAppointmentAsSms } from '@/lib/client-alert'
import { upsertRemindersForAppointment } from '@/lib/reminders'
import { findConflicts } from '@/lib/appointment-conflicts'
import { normalizeRoofAge } from '@/lib/normalize'
import { snapshotSolarFromCache } from '@/lib/solar'
import { readMasterTableRows } from '@/lib/drive'

/**
 * GET  /api/agent/appointments  → own appointments, most recent first
 * POST /api/agent/appointments  → create a new booking for the signed-in agent
 *
 * Middleware has already checked that role === 'agent' (or staff). We
 * still double-check server-side so a staff user calling this endpoint
 * can only see their own appointments (they won't have any unless they
 * booked as an agent for testing).
 */

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Pull DB-backed appointments AND a fresh copy of the master sheet
  // in parallel. The agent dashboard's "My Appointments" view used to
  // be DB-only, which silently hid rows Mary typed straight into the
  // sheet — Hub-booked appointments showed up but manual sheet
  // entries never did, so her counts were off vs. what the call
  // center actually had on the books. Unifying them here means the
  // dashboard reflects the sheet's source-of-truth count regardless
  // of which path the row took to get there.
  const userEmail = (session.user.email ?? '').toLowerCase()
  const userName = (session.user.name ?? '').toLowerCase()

  const [dbAppointments, clients, sheetRows] = await Promise.all([
    prisma.appointment.findMany({
      where: { agentUserId: session.user.id },
      // Sort by createdAt so the most-recently-booked appointment
      // floats to the top of Mary's dashboard. The final merge
      // re-sorts the same way after sheet rows are folded in, but
      // matching the DB order keeps the result stable across the
      // sheet-read race window (DB row appears before its loggedAt
      // is set on the sheet, etc.).
      orderBy: { createdAt: 'desc' },
      include: {
        client: { select: { id: true, name: true, state: true, color: true } },
      },
    }),
    prisma.client.findMany({
      select: { id: true, name: true, state: true, color: true },
    }),
    readMasterTableRows().catch((err) => {
      // Non-fatal — if the sheet read fails the dashboard still shows
      // the DB-backed appointments. Logging surfaces it to me without
      // blocking Mary.
      console.error('[agent appointments GET] sheet read failed:', err)
      return [] as Awaited<ReturnType<typeof readMasterTableRows>>
    }),
  ])

  // Tag DB rows with source='hub' so the UI can decide what
  // affordances to render (full edit/delete only for hub rows).
  const dbTagged = dbAppointments.map((a) => ({ ...a, source: 'hub' as const }))

  // Build a lookup of sheet rows already covered by DB rows so the
  // sheet pass doesn't double-count Hub-booked appointments. Two
  // dedup signals:
  //   1. masterSheetRowNumber on the DB row — set after sheet sync
  //      completes (~1-3s after the form submit). Fast path.
  //   2. (normalizedPhone + apptDateTime) — content-stable key that
  //      catches the in-flight window where the DB row exists but
  //      the sheet sync hasn't written back its rowNumber yet.
  //      Without this, Mary briefly sees the appointment twice on
  //      /agent right after saving — once from the DB, once from
  //      the sheet — until the sync catches up. Same fix pattern as
  //      the Slack-delivery content dedup.
  function normalizePhoneForKey(raw: string | null | undefined): string | null {
    if (!raw) return null
    const digits = String(raw).replace(/\D/g, '')
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    if (digits.length >= 10) return `+${digits}`
    return null
  }
  function apptDateKey(d: Date | string | null): string | null {
    if (!d) return null
    const date = typeof d === 'string' ? new Date(d) : d
    if (isNaN(date.getTime())) return null
    // Round to the minute — sheet "FORMATTED_VALUE" reads can lose
    // sub-minute precision, and an exact-ms compare would miss the
    // match on those rows. Same Hub-booked appt in DB vs. sheet
    // should always agree to the minute.
    return new Date(
      Math.floor(date.getTime() / 60_000) * 60_000,
    ).toISOString()
  }

  const coveredRowNumbers = new Set<number>()
  const coveredContent = new Set<string>()
  for (const a of dbTagged) {
    if (a.masterSheetRowNumber) coveredRowNumbers.add(a.masterSheetRowNumber)
    const phoneKey = normalizePhoneForKey(a.customerPhone)
    const dateKey = apptDateKey(a.apptDateTime)
    if (phoneKey && dateKey) {
      coveredContent.add(`${phoneKey}|${dateKey}`)
    }
  }

  // Match sheet "Client" cell to a registered client so the
  // synthesized rows render with the same color/state/badge as DB
  // rows. Lower-case map for case-insensitive matching.
  const clientByLower = new Map(
    clients.map((c) => [c.name.toLowerCase(), c]),
  )

  // Sheet-row attribution filter. Originally tried to scope rows to
  // "this user's bookings" via agentEmail / agentName matching, but
  // in the single-agent setup that produced confusing count
  // mismatches: rows typed with a manual agent name like "Mary
  // Faith" or "Daisy" don't match the logged-in Hub user record
  // exactly, so they got filtered out. With only Mary actively
  // booking right now, the right behavior is "show everything that
  // exists in the master sheet" — same data the staff-side Master
  // Tracker shows, just under the agent shell.
  //
  // Future: when a second agent is onboarded, switch this back to
  // strict per-user filtering. For now, the filter is intentionally
  // permissive — silenced via the suppression below.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function _rowAttributedToUser(_r: {
    agentEmail: string | null
    agentName: string | null
  }): boolean {
    // Reserved for the multi-agent future; see comment above.
    return true
  }
  void userEmail
  void userName

  // Status from the sheet comes back as "Booked" / "No Show" / etc.
  // The agent dashboard's stat counters key on lowercase tokens
  // ('booked', 'showed', 'no_show'). Normalize here so the counts
  // line up with the actual rows on the page. Same shape the
  // Master Tracker route uses.
  function normalizeStatus(raw: string | null): string {
    if (!raw) return 'booked'
    const s = raw.toLowerCase().trim()
    if (s === 'no show' || s === 'no-show' || s === 'noshow') return 'no_show'
    if (s === 'rescheduled' || s === 'reschedule') return 'rescheduled'
    if (s === 'showed' || s === 'show' || s === 'shown') return 'showed'
    if (s === 'cancelled' || s === 'canceled' || s === 'cancel')
      return 'cancelled'
    return 'booked'
  }

  const sheetOnly = sheetRows
    .filter((r) => {
      // Skip if this sheet row is already represented by a DB row.
      // Either the sync wrote the rowNumber back (covered by row
      // number) OR the (phone, apptTime) content key matches a DB
      // row whose sync is still in flight.
      if (coveredRowNumbers.has(r.rowNumber)) return false
      const phoneKey = normalizePhoneForKey(r.customerPhone)
      const dateKey = apptDateKey(r.apptDateTime)
      if (phoneKey && dateKey) {
        if (coveredContent.has(`${phoneKey}|${dateKey}`)) return false
      }
      return true
    })
    .filter((r) => r.customerName?.trim() && r.apptDateTime)
    .map((r) => {
      const matchedClient = r.client
        ? clientByLower.get(r.client.toLowerCase())
        : null
      // Synthesize a row that matches the DB Appointment shape closely
      // enough that the UI can render it without branching at every
      // field. id is `sheet:rowNumber` so the UI can detect this
      // path and route edits to the Master Tracker instead of
      // /agent/appointments/[id] (which only knows DB ids).
      return {
        id: `sheet:${r.rowNumber}`,
        source: 'sheet' as const,
        agentUserId: session.user.id,
        clientId: matchedClient?.id ?? null,
        client: matchedClient ?? null,
        apptDateTime: r.apptDateTime,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        address: r.address,
        email: r.email,
        monthlyBill: r.monthlyBill,
        utilityProvider: r.utilityProvider,
        roofType: r.roofType,
        roofAge: r.roofAge,
        status: normalizeStatus(r.status),
        estimatedDealValue: r.estimatedDealValue,
        notes: r.notes,
        callRecordingLink: r.callRecordingLink,
        bookedByName: null,
        solarSummary: null,
        agentSheetRowNumber: null,
        masterSheetRowNumber: r.rowNumber,
        lastSyncedAt: null,
        syncError: null,
        // createdAt: prefer the sheet's loggedAt if available so the
        // dashboard's "today" filtering and ordering land on a
        // sensible date for sheet-only rows.
        createdAt: r.loggedAt
          ? new Date(r.loggedAt).toISOString()
          : r.apptDateTime,
        updatedAt: r.loggedAt
          ? new Date(r.loggedAt).toISOString()
          : r.apptDateTime,
      }
    })

  // Merge + sort by createdAt DESC — most-recently-booked at the top
  // is what Mary actually wants to see when she pops the dashboard
  // (the appointment she just saved, plus whatever else got logged
  // in the last hour). Sheet-only rows synthesize createdAt from
  // their loggedAt cell above, so the two sources sort coherently.
  const appointments = [...dbTagged, ...sheetOnly].sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return bt - at
  })

  return NextResponse.json({ appointments })
}

type AppointmentInput = {
  apptDateTime?: string
  clientId?: string
  customerName?: string
  customerPhone?: string
  address?: string | null
  email?: string | null
  monthlyBill?: string | null
  utilityProvider?: string | null
  roofType?: string | null
  roofAge?: string | null
  status?: string
  estimatedDealValue?: string | null
  notes?: string | null
  callRecordingLink?: string | null
  /** Free-text agent name override. Mary uses this to record which
   *  call-center agent took the call (vs. agentUserId, which points
   *  at her Hub user account). Falls through to user.name on display
   *  when null. */
  bookedByName?: string | null
  /**
   * IDs of conflicts the agent has already acknowledged (ticked "Book anyway"
   * for) on the client. If a server-side re-check finds conflicts that
   * aren't in this list, a new booking slipped in during the form-fill
   * and we bounce back a 409 so the UI can re-prompt.
   */
  acknowledgedConflictIds?: string[]
}

const ALLOWED_STATUS = new Set([
  'booked',
  'rescheduled',
  'showed',
  'no_show',
  'cancelled',
])

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: AppointmentInput
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.apptDateTime) {
    return NextResponse.json({ error: 'Appointment date/time is required.' }, { status: 400 })
  }
  if (!body.clientId || !body.clientId.trim()) {
    return NextResponse.json(
      { error: 'Please select which client this appointment is for.' },
      { status: 400 }
    )
  }
  if (!body.customerName || !body.customerName.trim()) {
    return NextResponse.json({ error: "Customer's name is required." }, { status: 400 })
  }
  if (!body.customerPhone || !body.customerPhone.trim()) {
    return NextResponse.json({ error: "Customer's phone number is required." }, { status: 400 })
  }

  const parsedDate = new Date(body.apptDateTime)
  if (isNaN(parsedDate.getTime())) {
    return NextResponse.json({ error: 'Invalid date/time format.' }, { status: 400 })
  }

  // Verify the client exists + is active before we commit the FK.
  const client = await prisma.client.findFirst({
    where: { id: body.clientId, active: true },
    select: { id: true },
  })
  if (!client) {
    return NextResponse.json(
      { error: 'That client is not available. Refresh and try again.' },
      { status: 400 }
    )
  }

  const status = body.status && ALLOWED_STATUS.has(body.status) ? body.status : 'booked'

  // Server-side conflict re-check to close the race where two agents both
  // submit after each saw "no conflicts" in their form. Running inside a
  // transaction shrinks (but doesn't eliminate) the race window; the
  // acknowledged-ids comparison handles the "you accepted conflict A, but
  // someone just booked conflict B" case by returning 409 with the new set.
  const acknowledgedSet = new Set(body.acknowledgedConflictIds || [])

  let appt
  try {
    appt = await prisma.$transaction(async (tx) => {
      const currentConflicts = await findConflicts({
        apptDateTime: parsedDate,
        excludeId: undefined,
        tx,
      })
      const unacknowledged = currentConflicts.filter(
        (c) => !acknowledgedSet.has(c.id)
      )
      if (unacknowledged.length > 0) {
        // Throw a sentinel error with the conflict payload — caught below
        // and returned as 409. Any other throw is a real server error.
        const err = new Error('conflict') as Error & {
          __conflict?: true
          conflicts?: typeof currentConflicts
        }
        err.__conflict = true
        err.conflicts = currentConflicts
        throw err
      }

      return tx.appointment.create({
        data: {
          agentUserId: session.user.id,
          clientId: client.id,
          apptDateTime: parsedDate,
          customerName: body.customerName!.trim(),
          customerPhone: body.customerPhone!.trim(),
          address: body.address?.trim() || null,
          email: body.email?.trim() || null,
          monthlyBill: body.monthlyBill?.trim() || null,
          utilityProvider: body.utilityProvider?.trim() || null,
          roofType: body.roofType?.trim() || null,
          roofAge: normalizeRoofAge(body.roofAge),
          status,
          estimatedDealValue: body.estimatedDealValue?.trim() || null,
          notes: body.notes?.trim() || null,
          callRecordingLink: body.callRecordingLink?.trim() || null,
          bookedByName: body.bookedByName?.trim() || null,
        },
      })
    })
  } catch (err) {
    if ((err as { __conflict?: boolean }).__conflict) {
      return NextResponse.json(
        {
          error:
            'Another booking just landed in this time slot. Review the updated conflicts and confirm if you still want to proceed.',
          conflicts:
            (err as { conflicts?: unknown }).conflicts || [],
          code: 'CONFLICT_RACE',
        },
        { status: 409 }
      )
    }
    throw err
  }

  // If Mary clicked "Check solar potential" on the form before
  // saving, the SolarInsightsCache already has a row for this
  // address. Snapshot the summary onto the appointment so we keep
  // an audit-trail of what Sunroof said at booking time. Cache-only
  // — never triggers a fresh billable API call from this path.
  if (appt.address) {
    try {
      const summary = await snapshotSolarFromCache(appt.address)
      if (summary) {
        await prisma.appointment.update({
          where: { id: appt.id },
          data: { solarSummary: summary },
        })
      }
    } catch (err) {
      // Non-fatal — appointment is saved either way; we just lose
      // the audit trail for this row.
      console.error('[appointments POST] solar snapshot failed:', err)
    }
  }

  // Fire Slack + SMS notifications IMMEDIATELY off the DB row —
  // fully decoupled from the sheet sync below. Mary's booking pings
  // the channel within seconds even if Google Sheets is slow / down,
  // and even if the cron isn't ticking.
  //
  // Each delivery records a SheetSlackDelivery / ClientAlertDelivery
  // row with sourceKey="db:appointment:{id}" so re-saves and the
  // later cron scan dedup-skip cleanly. Once the sheet sync writes
  // a rowNumber, appointment-sync re-keys the delivery sourceKey to
  // the sheet form so the cron's permanent sourceKey lookup also
  // matches (covers the >48h-out future-appointment case where the
  // content-key window has expired).
  void deliverAppointmentToSlack(appt.id).then((result) => {
    console.log(
      `[appointments POST] direct slack: ${result.status}${result.reason ? ` (${result.reason})` : ''} for ${appt.id}`,
    )
  }).catch((err) => {
    console.error('[appointments POST] direct slack threw:', err)
  })
  void deliverAppointmentAsSms(appt.id).then((result) => {
    if (result.status !== 'disabled') {
      console.log(
        `[appointments POST] direct sms: ${result.status}${result.reason ? ` (${result.reason})` : ''} for ${appt.id}`,
      )
    }
  }).catch((err) => {
    console.error('[appointments POST] direct sms threw:', err)
  })

  // Customer-facing SMS reminders (1-day-out, 2-hr, 30-min, start,
  // confirmation). Same DB-driven story — queue rows in
  // AppointmentReminder against the DB id immediately so the
  // dispatcher can pick them up on its next minute-tick. No sheet
  // round-trip required. Honors RemindersConfig.enabled +
  // confirmationEnabled internally; if either is off, the rows
  // simply aren't created and the sheet-driven sync remains the
  // backstop for sheet-typed entries.
  //
  // Confirmation reminders fire 15 min after queueing (set in
  // lib/reminders) so Mary has time to fix typos via /agent/
  // appointments/[id] edit before the customer's phone buzzes.
  // The edit flow re-runs upsertRemindersForAppointment and
  // updates the snapshot in place.
  void upsertRemindersForAppointment(appt.id).then((result) => {
    if (result.skippedDisabled) {
      // Quiet log — master toggle is off, this is expected.
      return
    }
    console.log(
      `[appointments POST] reminders queued: ${result.upserted} new, ${result.skippedPast} past for ${appt.id}`,
    )
  }).catch((err) => {
    console.error('[appointments POST] reminders queue threw:', err)
  })

  // Fire-and-forget sheets sync — audit / backup path now, no longer
  // the trigger for client notifications. Errors surface on
  // appointment.syncError for the UI.
  syncAppointmentCreate(appt.id).catch((err) =>
    console.error('[appointments POST] sync scheduling failed:', err)
  )

  return NextResponse.json({ ok: true, appointment: appt })
}
