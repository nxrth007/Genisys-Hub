import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import {
  deleteMasterTableRow,
  migrateAddSentToClientColumn,
  readMasterTableRows,
  updateMasterTableCell,
  updateMasterTableCells,
  type CanonicalKey,
} from '@/lib/drive'
import {
  syncRemindersFromSheet,
  upsertRemindersForAppointment,
  sendRescheduleConfirmation,
} from '@/lib/reminders'
import { requireAdmin } from '@/lib/auth-helpers'
import { qualifyingTimestampFor } from '@/lib/appointment-qualification'
import { recordAppointmentEdit } from '@/lib/appointment-edit-log'
import { createAgentAlert } from '@/lib/agent-alerts'
import { postRescheduleToClientChannel } from '@/lib/client-delivery'

/** Diff helper for sheet-edit audit logging. Read before-snapshot
 *  values + body intent here, write an AppointmentEditLog row after
 *  the cell write succeeds. Fire-and-forget — never block the response
 *  on the audit pipeline. */
type EditAuditContext = {
  rowNumber: number
  userId: string
  /** Editor's role — captured so cross-writes to the DB
   *  (qualifyingStatusUpdatedAt for PPA invoicing) can apply the
   *  same admin/member/client_active rule everywhere else does. */
  role: string | null
  beforeRow: Awaited<ReturnType<typeof readMasterTableRows>>[number] | null
}

async function logSheetEdit(
  ctx: EditAuditContext,
  changes: Record<string, { from: unknown; to: unknown }>,
) {
  if (Object.keys(changes).length === 0) return
  const before = ctx.beforeRow
  // Try to link the sheet edit to its DB Appointment counterpart if
  // there is one — admins can then jump from the audit row to the
  // appointment record without a separate lookup.
  const matching = await prisma.appointment
    .findFirst({
      where: { masterSheetRowNumber: ctx.rowNumber },
      select: {
        id: true,
        clientId: true,
        client: { select: { name: true } },
      },
    })
    .catch(() => null)
  const editor = await prisma.user
    .findUnique({
      where: { id: ctx.userId },
      select: { name: true, email: true },
    })
    .catch(() => null)
  void recordAppointmentEdit({
    appointmentId: matching?.id ?? null,
    sheetTabTitle: 'Master Table',
    sheetRowNumber: ctx.rowNumber,
    clientId: matching?.clientId ?? null,
    clientName: matching?.client?.name ?? before?.client ?? null,
    editorUserId: ctx.userId,
    editorEmail: editor?.email ?? null,
    editorName: editor?.name ?? null,
    customerName: before?.customerName ?? null,
    customerPhone: before?.customerPhone ?? null,
    apptDateTime: before?.apptDateTime ?? null,
    source: 'master-tracker',
    changes,
  })
}

/**
 * /api/call-center/master-tracker/:rowNumber
 *
 * PATCH:
 *   - Inline-editable cells (status / sentToClient): any signed-in
 *     staff can flip these. Mary on /agent inherits this since
 *     her route reads the same data and is treated like staff for
 *     these specific writes.
 *   - Full row edit (customerName, phone, address, notes, etc.):
 *     admin-only. Distinguished by `mode: 'full'` in the body OR
 *     by the presence of fields outside the inline-edit set.
 *
 * DELETE: admin-only. Removes the row from the master sheet AND
 * cleans up downstream ledger records so the freed-up rowNumber
 * doesn't accidentally claim another row's history.
 */

const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  showed: 'Showed',
  // Won/Lost are deal-outcome statuses captured after the appt.
  // They imply the customer sat down (so they roll up into "showed"
  // for show-rate calcs) but record whether the deal closed.
  won: 'Won',
  lost: 'Lost',
  no_show: 'No Show',
  cancelled: 'Cancelled',
}

const SENT_TO_CLIENT_LABEL: Record<string, string> = {
  yes: 'Yes',
  no: 'No',
  unassigned: '',
}

/**
 * Split a wall-clock datetime string into separate date + time
 * pieces formatted the way the master sheet expects ("M/D/YYYY"
 * and "h:mm AM/PM"). Tolerant of multiple input shapes — anything
 * the modal's `<input type="datetime-local">` ("YYYY-MM-DDTHH:mm")
 * or the legacy `toLocaleString` output ("M/D/YYYY, h:mm AM/PM")
 * could produce. Returns null when the input doesn't look like a
 * wall-clock at all so the caller can fall through.
 *
 * Critical: does NOT route through `new Date()`. That would
 * interpret the wall-clock in the SERVER's tz (UTC on Render) and
 * shift the components — exactly the bug we just spent two days
 * eliminating elsewhere. Instead we parse + reformat the components
 * directly so the wall-clock stays untouched, and the sheet re-read
 * pins it to the customer's tz on the next pass.
 */
function parseWallClockParts(
  input: string,
): { dateStr: string; timeStr: string } | null {
  // ISO-local first: "2026-05-08T18:00" or "2026-05-08 18:00"
  const iso = input.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/,
  )
  if (iso) {
    const Y = parseInt(iso[1], 10)
    const M = parseInt(iso[2], 10)
    const D = parseInt(iso[3], 10)
    let h = parseInt(iso[4], 10)
    const min = parseInt(iso[5], 10)
    const ampm = h >= 12 ? 'PM' : 'AM'
    h = h % 12
    if (h === 0) h = 12
    return {
      dateStr: `${M}/${D}/${Y}`,
      timeStr: `${h}:${String(min).padStart(2, '0')} ${ampm}`,
    }
  }
  // US-style: "5/8/2026, 6:00 PM" or "5/8/2026 6:00 PM" with optional
  // comma + optional seconds. Already in the shape the sheet wants —
  // just split on the first space-after-the-date.
  const us = input.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)/i,
  )
  if (us) {
    return {
      dateStr: `${parseInt(us[1], 10)}/${parseInt(us[2], 10)}/${us[3]}`,
      timeStr: `${parseInt(us[4], 10)}:${us[5]} ${us[6].toUpperCase()}`,
    }
  }
  return null
}

// Field allowlist for the admin full-row edit. Each entry maps the
// JSON body key to the sheet's canonical column key. Centralized here
// so adding a new editable field is a one-line change.
const FULL_EDIT_FIELDS: Record<string, CanonicalKey> = {
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  address: 'address',
  email: 'email',
  monthlyBill: 'monthlyBill',
  utilityProvider: 'utilityProvider',
  roofType: 'roofType',
  roofAge: 'roofAge',
  estimatedDealValue: 'estimatedDealValue',
  notes: 'notes',
  callRecordingLink: 'callRecordingLink',
  agentName: 'agentName',
  agentEmail: 'agentEmail',
  client: 'client',
  // Date + time are split fields on the wire (the client splits
  // apptDateTime in buildDiff before sending). Both map to their
  // own sheet columns directly. apptDateTime kept as a fallback
  // for callers that still send the combined form — writeFullEdit
  // splits it server-side too, but discrete fields are the
  // preferred path because they bypass any parsing ambiguity.
  apptDate: 'apptDate',
  apptTime: 'apptTime',
  apptDateTime: 'apptDateTime',
  // Explicit timezone override Mary can type into the sheet's
  // Timezone column. Editing it here writes back to the same cell
  // and the next sheet-read parses the row in the new tz.
  timezone: 'timezone',
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ rowNumber: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { rowNumber: rowNumberStr } = await params
  const rowNumber = parseInt(rowNumberStr, 10)
  if (!Number.isFinite(rowNumber) || rowNumber <= 0) {
    return NextResponse.json({ error: 'invalid row number' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  // Inline-edit fields (status / sentToClient) stay open to staff —
  // these are surfaced as quick selects in the UI and admin-gating
  // them would block Ethan's normal triage workflow. Anything else
  // is a real row mutation that needs admin role.
  const inlineKeys = ['status', 'sentToClient']
  const requestedKeys = Object.keys(body).filter((k) => k !== 'mode')
  const hasFullEditField = requestedKeys.some(
    (k) => !inlineKeys.includes(k) && k in FULL_EDIT_FIELDS,
  )

  // Pre-edit snapshot for the audit log. Read once at the top so all
  // dispatch paths share it; one Drive call per edit is fine. If the
  // read fails for any reason we proceed with a null snapshot — the
  // audit log entry will still get written but with sparser before-
  // value detail.
  const beforeRow = await readMasterTableRows()
    .then((rows) => rows.find((r) => r.rowNumber === rowNumber) ?? null)
    .catch((err) => {
      console.warn(
        '[master-tracker PATCH] pre-edit snapshot read failed (audit log will be sparse):',
        err,
      )
      return null
    })
  const auditCtx: EditAuditContext = {
    rowNumber,
    userId: session.user.id,
    role: (session.user as { role?: string | null }).role ?? null,
    beforeRow,
  }

  if (hasFullEditField) {
    const denial = await requireAdmin()
    if (denial) return denial
    return await writeFullEdit(rowNumber, body, auditCtx)
  }

  // Inline edits — same dispatch as before. Status takes precedence
  // when both arrive, but the UI sends one at a time.
  if (typeof body.status === 'string') {
    if (!STATUS_LABEL[body.status as string]) {
      return NextResponse.json(
        {
          error:
            'status must be one of: booked, rescheduled, showed, won, lost, no_show, cancelled',
        },
        { status: 400 },
      )
    }
    return await writeOne(
      rowNumber,
      'status',
      STATUS_LABEL[body.status as string],
      { status: body.status as string },
      auditCtx,
      'status',
      body.status as string,
    )
  }

  if (typeof body.sentToClient === 'string') {
    if (!(body.sentToClient in SENT_TO_CLIENT_LABEL)) {
      return NextResponse.json(
        { error: 'sentToClient must be one of: yes, no, unassigned' },
        { status: 400 },
      )
    }
    return await writeOne(
      rowNumber,
      'sentToClient',
      SENT_TO_CLIENT_LABEL[body.sentToClient as string],
      { sentToClient: body.sentToClient as string },
      auditCtx,
      'sentToClient',
      body.sentToClient as string,
    )
  }

  return NextResponse.json(
    { error: 'no editable field on this request' },
    { status: 400 },
  )
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ rowNumber: string }> },
) {
  const denial = await requireAdmin()
  if (denial) return denial

  const { rowNumber: rowNumberStr } = await params
  const rowNumber = parseInt(rowNumberStr, 10)
  if (!Number.isFinite(rowNumber) || rowNumber <= 0) {
    return NextResponse.json({ error: 'invalid row number' }, { status: 400 })
  }

  const sourceKey = `sheet:Master Table:${rowNumber}`

  try {
    // Order matters here:
    //   1. Delete the actual sheet row first. If this fails the DB
    //      stays consistent — the source row is still there and the
    //      ledger records still point at valid data.
    //   2. Then wipe the SheetSlackDelivery records keyed on this
    //      sourceKey. Necessary because deleting a sheet row shifts
    //      everything below it up by one — without this cleanup, the
    //      next cron tick would see "row N" with new content but
    //      match against the OLD row N's delivery record via
    //      sourceKey, then skip delivery for a legit new row.
    //   3. Cancel pending AppointmentReminders for the same key. Sent
    //      ones stay (already fired, no point un-firing). Pending
    //      ones get cancelled so they don't fire for an appointment
    //      that no longer exists.
    await deleteMasterTableRow(rowNumber)

    const [deletedDeliveries, cancelledReminders] = await Promise.all([
      prisma.sheetSlackDelivery.deleteMany({
        where: { sourceKey },
      }),
      prisma.appointmentReminder.updateMany({
        where: { sourceKey, status: 'pending' },
        data: { status: 'cancelled' },
      }),
    ])

    return NextResponse.json({
      ok: true,
      rowNumber,
      cleanup: {
        deliveryRecordsDeleted: deletedDeliveries.count,
        pendingRemindersCancelled: cancelledReminders.count,
      },
    })
  } catch (err) {
    console.error('[master-tracker DELETE] failed:', err)
    const message = err instanceof Error ? err.message : 'Delete failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function writeFullEdit(
  rowNumber: number,
  body: Record<string, unknown>,
  auditCtx?: EditAuditContext,
) {
  // Build the field updates from the allowlist. String values pass
  // through (with trim); empty string / null clears the cell.
  const updates: Partial<Record<CanonicalKey, string>> = {}
  for (const [bodyKey, canonical] of Object.entries(FULL_EDIT_FIELDS)) {
    if (!(bodyKey in body)) continue
    const raw = body[bodyKey]
    if (raw === null || raw === undefined) {
      updates[canonical] = ''
      continue
    }
    if (typeof raw === 'string') {
      updates[canonical] = raw.trim()
      continue
    }
    // Anything other than string/null gets coerced rather than
    // crashed — admin's UI sends strings but defensive handling
    // catches stray Date objects from the picker, etc.
    updates[canonical] = String(raw)
  }

  // Split apptDateTime into apptDate + apptTime as a fallback. Most
  // master sheets use SEPARATE Date and Time columns rather than a
  // combined one, in which case writing only to `apptDateTime`
  // silently goes nowhere (updateMasterTableCells skips canonicals
  // that don't exist in the schema). Symptom Alex hit: opens the
  // edit modal, changes the time, saves, sees no change in the
  // tracker because the write landed on a non-existent column.
  // Split-and-also-write covers both schemas — the combined column
  // still gets the value if it exists, AND the date/time columns
  // get the same wall-clock so split sheets actually update too.
  const dt = updates.apptDateTime
  if (dt && (!updates.apptDate || !updates.apptTime)) {
    const parts = parseWallClockParts(dt)
    if (parts) {
      if (!updates.apptDate) updates.apptDate = parts.dateStr
      if (!updates.apptTime) updates.apptTime = parts.timeStr
    }
  }

  // Optional status update — accept the same token form the inline
  // path uses ('booked' / 'showed' / etc.) and translate to the
  // sheet's display label.
  if (typeof body.status === 'string' && STATUS_LABEL[body.status]) {
    updates.status = STATUS_LABEL[body.status]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'no editable fields supplied' },
      { status: 400 },
    )
  }

  // Server-side telemetry — Alex hit a "saved 6 PM, sheet shows
  // 1 AM May 9" bug that was hard to diagnose without seeing the
  // actual write payload. Logging the resolved updates makes the
  // next instance debuggable from Render logs alone.
  console.log(
    `[master-tracker PATCH:full] row=${rowNumber} updates=`,
    JSON.stringify(updates),
  )

  try {
    const result = await updateMasterTableCells({ rowNumber, updates })

    // Verification snapshot — re-read the row we just wrote and
    // return the parsed apptDateTime + tz. Lets the UI confirm
    // the round-trip without a second roundtrip via the master-
    // tracker GET, and gives Alex a clear "what actually got
    // stored" string to compare against what he intended.
    let verify: {
      apptDateIso: string | null
      apptDateCell: string | null
      apptTimeCell: string | null
      timezoneCell: string | null
      resolvedTimezone: string | null
      /** Verbatim cell contents — what the SHEET literally has,
       *  not our combined/parsed view. Lets admins spot when a
       *  stale cell is winning over the others. */
      rawDateCell: string | null
      rawTimeCell: string | null
      rawDateTimeCell: string | null
      /** Names of canonicals the write skipped (column not in
       *  schema). If apptDate is in here, the sheet has no Date
       *  column and our split-write didn't update anything for
       *  the date piece — the combined cell was the only target. */
      writeSkipped: string[]
    } | null = null
    try {
      const fresh = await readMasterTableRows()
      const row = fresh.find((r) => r.rowNumber === rowNumber)
      if (row) {
        verify = {
          apptDateIso: row.apptDateTime,
          apptDateCell: row.apptDateTime
            ? new Intl.DateTimeFormat('en-US', {
                timeZone: row.resolvedTimezone,
                month: 'numeric',
                day: 'numeric',
                year: 'numeric',
              }).format(new Date(row.apptDateTime))
            : null,
          apptTimeCell: row.apptDateTime
            ? new Intl.DateTimeFormat('en-US', {
                timeZone: row.resolvedTimezone,
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZoneName: 'short',
              }).format(new Date(row.apptDateTime))
            : null,
          timezoneCell: row.timezone,
          resolvedTimezone: row.resolvedTimezone,
          rawDateCell: row.apptDateRaw,
          rawTimeCell: row.apptTimeRaw,
          rawDateTimeCell: row.apptDateTimeRaw,
          writeSkipped: result.skipped,
        }
        console.log(
          `[master-tracker PATCH:full] verify row=${rowNumber} → parsed=${verify.apptDateCell} ${verify.apptTimeCell} (${verify.resolvedTimezone}); rawDate=${JSON.stringify(verify.rawDateCell)} rawTime=${JSON.stringify(verify.rawTimeCell)} rawCombined=${JSON.stringify(verify.rawDateTimeCell)} skipped=${JSON.stringify(verify.writeSkipped)}`,
        )
      }
    } catch (verifyErr) {
      console.error(
        '[master-tracker PATCH:full] verify re-read failed:',
        verifyErr,
      )
    }

    // Trigger reminder re-sync since edits could move the
    // appointment time, change the customer phone, or flip the
    // client. Same fire-and-forget pattern the inline status path
    // uses.
    void syncRemindersFromSheet().catch((err) =>
      console.error(
        '[master-tracker PATCH:full] background reminder sync failed:',
        err,
      ),
    )

    // Keep the DB Appointment in lockstep with this sheet edit, then
    // run the reschedule flow. Without the cross-write, a time change
    // lands on the sheet but the DB row (and its db:appointment
    // reminders) keep the OLD time — the same DB/sheet drift that
    // forked Fayaz's reminders. With it: we update the DB appt's
    // apptDateTime + status from the freshly-parsed sheet value, then
    // upsertRemindersForAppointment re-arms the full reminder set for
    // the new time (its re-arm-on-shift logic), and when the row was
    // marked "rescheduled" we text the customer their new time.
    // Fire-and-forget — the sheet write already succeeded.
    void (async () => {
      try {
        const dbAppt = await prisma.appointment.findFirst({
          where: { masterSheetRowNumber: rowNumber },
          select: {
            id: true,
            apptDateTime: true,
            customerName: true,
            customerPhone: true,
            address: true,
            status: true,
            dispatchStatus: true,
            client: { select: { name: true } },
          },
        })
        if (!dbAppt) return
        const newIso = verify?.apptDateIso ?? null
        const newDate = newIso ? new Date(newIso) : null
        const newStatus =
          typeof body.status === 'string' && STATUS_LABEL[body.status]
            ? body.status
            : null
        const timeChanged =
          !!newDate &&
          !isNaN(newDate.getTime()) &&
          (!dbAppt.apptDateTime ||
            newDate.getTime() !== dbAppt.apptDateTime.getTime())

        if (timeChanged || newStatus) {
          await prisma.appointment.update({
            where: { id: dbAppt.id },
            data: {
              ...(timeChanged && newDate ? { apptDateTime: newDate } : {}),
              ...(newStatus ? { status: newStatus } : {}),
            },
          })
        }

        // Re-arm reminders for the new time (covers no-shows /
        // "N"-decliners whose old reminders are spent/cancelled).
        if (timeChanged) {
          await upsertRemindersForAppointment(dbAppt.id)
          // Notify the client's Slack channel of the new time — the
          // original appointment post is one-time/deduped, so without
          // this the client never sees the reschedule.
          await postRescheduleToClientChannel(dbAppt.id)
        }

        // Customer reschedule-confirmation text — only on an explicit
        // reschedule, only when the time actually moved, and only when
        // the appt is Confirmed (same gate as every customer-facing
        // message), so a stray status re-save / unconfirmed row doesn't
        // spam them.
        if (
          newStatus === 'rescheduled' &&
          timeChanged &&
          newDate &&
          dbAppt.dispatchStatus === 'confirmed'
        ) {
          await sendRescheduleConfirmation({
            customerName: dbAppt.customerName,
            customerPhone: dbAppt.customerPhone,
            clientName: dbAppt.client?.name ?? null,
            apptDateTime: newDate,
            address: dbAppt.address,
          })
        }
      } catch (err) {
        console.error(
          '[master-tracker PATCH:full] reschedule flow failed:',
          err,
        )
      }
    })()

    // Past-appointment safeguard: if admin just assigned a client
    // to a row whose appointment is already in the past, pre-mark
    // SheetSlackDelivery + ClientAlertDelivery as 'backfilled' for
    // (this row, that client's channel/phone). Without this, the
    // next cron tick would see a freshly-routable past row with no
    // delivery record and blast the channel/SMS for an already-
    // completed meeting. For FUTURE appointments we let the cron
    // fire normally — that's the intended notification.
    void backfillPastAppointmentOnClientAssign({
      rowNumber,
      newClientName: typeof body.client === 'string' ? body.client.trim() : '',
      verify,
    }).catch((err) =>
      console.error(
        '[master-tracker PATCH:full] past-appt client-assign backfill failed:',
        err,
      ),
    )

    // Audit log — compute the diff from the before-snapshot against
    // the body's intent (we know what fields admin meant to change,
    // and the request succeeded above). Fire-and-forget; nothing
    // here should block the response.
    if (auditCtx) {
      const before = auditCtx.beforeRow
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      // Iterate the same allowlist writeFullEdit used to build updates.
      for (const [bodyKey] of Object.entries(FULL_EDIT_FIELDS)) {
        if (!(bodyKey in body)) continue
        const newVal = body[bodyKey]
        const newNormalized =
          newVal === null || newVal === undefined
            ? null
            : String(newVal).trim() || null
        const oldNormalized = before
          ? readBeforeField(before, bodyKey)
          : null
        if (oldNormalized !== newNormalized) {
          changes[bodyKey] = { from: oldNormalized, to: newNormalized }
        }
      }
      // Status comes through as a body-level field too (token form).
      if (typeof body.status === 'string' && STATUS_LABEL[body.status]) {
        const oldStatus = before ? normalizeBeforeStatus(before.status) : null
        if (oldStatus !== body.status) {
          changes.status = { from: oldStatus, to: body.status }
        }
      }
      void logSheetEdit(auditCtx, changes)
    }

    return NextResponse.json({ ok: true, ...result, verify })
  } catch (err) {
    console.error('[master-tracker PATCH:full] failed:', err)
    const message = err instanceof Error ? err.message : 'Edit failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function writeOne(
  rowNumber: number,
  canonical: 'status' | 'sentToClient',
  value: string,
  echo: Record<string, string>,
  auditCtx?: EditAuditContext,
  /** The audit-facing field name (matches the body key, not the
   *  sheet's display label). Status uses lowercase tokens; the sheet
   *  cell value is the display form ("Booked"). We want the token in
   *  the audit log so consumers don't have to translate. */
  auditField?: 'status' | 'sentToClient',
  auditNewValue?: string,
) {
  try {
    await updateMasterTableCell({ rowNumber, canonical, value })

    if (canonical === 'status') {
      void syncRemindersFromSheet().catch((err) =>
        console.error(
          '[master-tracker PATCH] background reminder sync failed:',
          err,
        ),
      )

      // Cross-write to the DB Appointment row when one exists for
      // this sheet row. Master-tracker inline status edits
      // historically only wrote to the sheet, which left the DB's
      // status stale for any Hub-booked appointment. Critically,
      // this is also the only path that can stamp
      // qualifyingStatusUpdatedAt — without it, an Alex/Ethan
      // inline "showed" mark wouldn't trigger the PPA invoice.
      //
      // Fire-and-forget so a DB blip doesn't fail the sheet write
      // (the sheet is the canonical surface admin sees in this
      // flow).
      void (async () => {
        try {
          const dbAppt = await prisma.appointment.findFirst({
            where: { masterSheetRowNumber: rowNumber },
            select: {
              id: true,
              agentUserId: true,
              customerName: true,
              customerPhone: true,
              apptDateTime: true,
              status: true,
              client: { select: { name: true } },
            },
          })
          if (!dbAppt) return
          const newStatus = auditNewValue ?? null
          if (!newStatus) return
          const qa = qualifyingTimestampFor(auditCtx?.role ?? null, newStatus)
          await prisma.appointment.update({
            where: { id: dbAppt.id },
            data: {
              status: newStatus,
              ...(qa ? { qualifyingStatusUpdatedAt: qa } : {}),
            },
          })
          // Agent-alert feed: a call-center cancel / no-show mark on a
          // Hub-booked appointment routes back to the booking agent.
          // The actor here is admin (requireAdmin), never the agent
          // themselves, so this is always "someone else changed
          // Mary's appointment" — exactly what she needs to see.
          if (
            (newStatus === 'cancelled' || newStatus === 'no_show') &&
            dbAppt.agentUserId
          ) {
            await createAgentAlert({
              agentUserId: dbAppt.agentUserId,
              type: newStatus,
              dedupKey: `appt:${dbAppt.id}:${newStatus}`,
              appointmentId: dbAppt.id,
              customerName: dbAppt.customerName,
              customerPhone: dbAppt.customerPhone,
              clientName: dbAppt.client?.name ?? null,
              apptDateTime: dbAppt.apptDateTime,
              detail:
                newStatus === 'cancelled'
                  ? 'Appointment cancelled (call center / master tracker)'
                  : 'Marked no-show (call center / master tracker)',
            })
          }
        } catch (err) {
          console.error(
            '[master-tracker PATCH] DB cross-write failed:',
            err,
          )
        }
      })()
    }

    // Audit log — only when we have a snapshot context AND the new
    // value differs from what was already there. Saves a phantom log
    // row when admin re-saves a row without changing the value.
    if (auditCtx && auditField && auditNewValue !== undefined) {
      const before = auditCtx.beforeRow
      const oldValue = before
        ? canonical === 'status'
          ? normalizeBeforeStatus(before.status)
          : normalizeBeforeSentToClient(before.sentToClient)
        : null
      if (oldValue !== auditNewValue) {
        void logSheetEdit(auditCtx, {
          [auditField]: { from: oldValue, to: auditNewValue },
        })
      }
    }

    return NextResponse.json({ ok: true, ...echo })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed'
    // Self-heal the "no Sitdown column on the sheet" case. The
    // updateMasterTableCell helper throws a recognizable message
    // when the canonical column is missing from the schema. For
    // sentToClient we know the migration that adds it (idempotent,
    // safe to re-run), so run it here and retry once instead of
    // forcing admin to navigate to /settings just to make a
    // dropdown work.
    const isMissingColumn =
      canonical === 'sentToClient' &&
      /Column .* not found/i.test(message)
    if (isMissingColumn) {
      try {
        console.log(
          '[master-tracker PATCH] sentToClient column missing — auto-running migrateAddSentToClientColumn before retry',
        )
        await migrateAddSentToClientColumn()
        await updateMasterTableCell({ rowNumber, canonical, value })
        return NextResponse.json({ ok: true, ...echo, autoMigrated: true })
      } catch (retryErr) {
        console.error(
          '[master-tracker PATCH] auto-migrate + retry failed:',
          retryErr,
        )
        const retryMessage =
          retryErr instanceof Error ? retryErr.message : 'Retry failed'
        return NextResponse.json(
          {
            error: `Auto-added the Sitdown column but the retry write failed: ${retryMessage}`,
          },
          { status: 500 },
        )
      }
    }
    console.error('[master-tracker PATCH] failed:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/* -------------------------------------------------------------------------- */
/*  Past-appointment safeguard                                                 */
/* -------------------------------------------------------------------------- */

/**
 * When admin assigns a client to a row whose appointment date is
 * ALREADY in the past, write 'backfilled' SheetSlackDelivery +
 * ClientAlertDelivery records so the cron's next sync doesn't fire
 * a Slack post / SMS for a completed meeting.
 *
 * Why: most rows that lost their explicit Client value did so when
 * the routing brain switched away from state inference (multiple
 * clients in the same state made inference ambiguous). When admin
 * cleans those up by picking a client in the edit modal, ~80% of
 * those rows are historical bookings — completed meetings that
 * shouldn't trigger a fresh notification. The remaining 20%
 * (future appointments) DO fire normally because the safeguard
 * exits early when apptDateTime > now.
 *
 * Idempotent — uses the same sourceKey shape the cron uses
 * ("sheet:Master Table:N"), and the unique-index on
 * (sourceKey, channelId / recipientPhone) means re-running is a
 * no-op when records already exist.
 */
async function backfillPastAppointmentOnClientAssign(params: {
  rowNumber: number
  newClientName: string
  verify: { apptDateIso: string | null } | null
}) {
  const { rowNumber, newClientName, verify } = params
  if (!newClientName) return // client wasn't part of this edit
  const apptIso = verify?.apptDateIso
  if (!apptIso) return
  const apptDate = new Date(apptIso)
  if (isNaN(apptDate.getTime())) return
  if (apptDate.getTime() > Date.now()) return // future — let cron fire normally

  // Look up the client by name (case-insensitive). If admin typed a
  // name we don't have a record for (rare — dropdown only shows
  // registered clients), there's nothing to backfill against.
  const matched = await prisma.client.findFirst({
    where: {
      name: { equals: newClientName, mode: 'insensitive' },
      active: true,
    },
    select: {
      id: true,
      name: true,
      slackChannelId: true,
      contactPhone: true,
    },
  })
  if (!matched) return

  const sourceKey = `sheet:Master Table:${rowNumber}`

  // Slack-channel side: only backfill when the client has a channel
  // configured (otherwise there's nothing the cron would post).
  if (matched.slackChannelId) {
    try {
      await prisma.sheetSlackDelivery.create({
        data: {
          sourceKey,
          clientId: matched.id,
          channelId: matched.slackChannelId,
          status: 'backfilled',
          errorMessage:
            'Past-appointment safeguard — client assigned via Master Tracker edit after appt date had passed.',
        },
      })
      console.log(
        `[master-tracker PATCH:full] past-appt slack backfill: row ${rowNumber} → ${matched.name} (${matched.slackChannelId})`,
      )
    } catch (err) {
      // Unique constraint hit means a record already exists for
      // this (sourceKey, channelId) — fine, idempotent no-op.
      const code =
        err instanceof Error && 'code' in err
          ? (err as { code?: string }).code
          : undefined
      if (code !== 'P2002') {
        console.error(
          '[master-tracker PATCH:full] slack backfill insert failed:',
          err,
        )
      }
    }
  }

  // Client Alerts SMS side: only backfill when the client has a
  // contactPhone configured AND ClientAlertsConfig is enabled. If
  // the master toggle is off the cron is a no-op anyway, so the
  // record would be wasted insert.
  const phoneDigits = String(matched.contactPhone ?? '').replace(/\D/g, '')
  let recipientPhone: string | null = null
  if (phoneDigits.length === 10) recipientPhone = `+1${phoneDigits}`
  else if (phoneDigits.length === 11 && phoneDigits.startsWith('1'))
    recipientPhone = `+${phoneDigits}`
  else if (phoneDigits.length >= 10) recipientPhone = `+${phoneDigits}`

  if (recipientPhone) {
    const alertConfig = await prisma.clientAlertsConfig
      .findUnique({ where: { id: 'singleton' } })
      .catch(() => null)
    if (alertConfig?.enabled) {
      try {
        await prisma.clientAlertDelivery.create({
          data: {
            sourceKey,
            clientId: matched.id,
            recipientPhone,
            status: 'backfilled',
            errorMessage:
              'Past-appointment safeguard — client assigned via Master Tracker edit after appt date had passed.',
          },
        })
        console.log(
          `[master-tracker PATCH:full] past-appt sms backfill: row ${rowNumber} → ${matched.name} (${recipientPhone})`,
        )
      } catch (err) {
        const code =
          err instanceof Error && 'code' in err
            ? (err as { code?: string }).code
            : undefined
        if (code !== 'P2002') {
          console.error(
            '[master-tracker PATCH:full] sms backfill insert failed:',
            err,
          )
        }
      }
    }
  }

}

/* -------------------------------------------------------------------------- */
/*  Audit-log normalization helpers                                            */
/* -------------------------------------------------------------------------- */

/** Convert the sheet's display-form status ("Booked", "No Show") to
 *  the lowercase token form admin sees in the UI ("booked", "no_show").
 *  Returns null for empty / unrecognized values so the audit log
 *  records the absence rather than a phantom token. */
function normalizeBeforeStatus(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw).trim().toLowerCase()
  if (!s) return null
  if (s === 'no show' || s === 'no-show' || s === 'noshow') return 'no_show'
  if (s === 'rescheduled' || s === 'reschedule') return 'rescheduled'
  if (s === 'showed' || s === 'show' || s === 'shown') return 'showed'
  if (s === 'cancelled' || s === 'canceled' || s === 'cancel') return 'cancelled'
  if (s === 'won' || s === 'closed' || s === 'sold' || s === 'win') return 'won'
  if (s === 'lost' || s === 'no sale' || s === 'no-sale') return 'lost'
  if (s === 'booked' || s === 'book') return 'booked'
  return s
}

/** Same idea for the Sent to Client column — sheet has "Yes" / "No"
 *  / blank; admin's UI uses 'yes' / 'no' / 'unassigned' tokens. */
function normalizeBeforeSentToClient(
  raw: string | null | undefined,
): 'yes' | 'no' | 'unassigned' {
  if (!raw) return 'unassigned'
  const s = String(raw).trim().toLowerCase()
  if (!s) return 'unassigned'
  if (['yes', 'y', '1', 'true', 'sent', 'delivered', 'handed off'].includes(s))
    return 'yes'
  if (['no', 'n', '0', 'false', 'not sent'].includes(s)) return 'no'
  return 'unassigned'
}

/** Pull a normalized "before" value off the sheet-row snapshot by
 *  body-key name. The body keys map to MasterTableRow fields one-to-
 *  one for most fields; status / sentToClient need their own
 *  normalizers above. */
function readBeforeField(
  row: Awaited<ReturnType<typeof readMasterTableRows>>[number],
  bodyKey: string,
): string | null {
  switch (bodyKey) {
    case 'customerName':
      return row.customerName?.trim() || null
    case 'customerPhone':
      return row.customerPhone?.trim() || null
    case 'address':
      return row.address?.trim() || null
    case 'email':
      return row.email?.trim() || null
    case 'monthlyBill':
      return row.monthlyBill?.trim() || null
    case 'utilityProvider':
      return row.utilityProvider?.trim() || null
    case 'roofType':
      return row.roofType?.trim() || null
    case 'roofAge':
      return row.roofAge?.trim() || null
    case 'estimatedDealValue':
      return row.estimatedDealValue?.trim() || null
    case 'notes':
      return row.notes?.trim() || null
    case 'callRecordingLink':
      return row.callRecordingLink?.trim() || null
    case 'agentName':
      return row.agentName?.trim() || null
    case 'agentEmail':
      return row.agentEmail?.trim() || null
    case 'client':
      return row.client?.trim() || null
    case 'timezone':
      return row.timezone?.trim() || null
    case 'apptDate':
      return row.apptDateRaw?.trim() || null
    case 'apptTime':
      return row.apptTimeRaw?.trim() || null
    case 'apptDateTime':
      return row.apptDateTime ?? null
    default:
      return null
  }
}
