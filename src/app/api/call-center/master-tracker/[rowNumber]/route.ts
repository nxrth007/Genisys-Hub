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
import { syncRemindersFromSheet } from '@/lib/reminders'
import { requireAdmin } from '@/lib/auth-helpers'

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

  if (hasFullEditField) {
    const denial = await requireAdmin()
    if (denial) return denial
    return await writeFullEdit(rowNumber, body)
  }

  // Inline edits — same dispatch as before. Status takes precedence
  // when both arrive, but the UI sends one at a time.
  if (typeof body.status === 'string') {
    if (!STATUS_LABEL[body.status as string]) {
      return NextResponse.json(
        {
          error:
            'status must be one of: booked, rescheduled, showed, no_show, cancelled',
        },
        { status: 400 },
      )
    }
    return await writeOne(
      rowNumber,
      'status',
      STATUS_LABEL[body.status as string],
      { status: body.status as string },
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
