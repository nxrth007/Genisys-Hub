import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import {
  deleteMasterTableRow,
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
  apptDateTime: 'apptDateTime',
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

  try {
    const result = await updateMasterTableCells({ rowNumber, updates })

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

    return NextResponse.json({ ok: true, ...result })
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
    console.error('[master-tracker PATCH] failed:', err)
    const message = err instanceof Error ? err.message : 'Update failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
