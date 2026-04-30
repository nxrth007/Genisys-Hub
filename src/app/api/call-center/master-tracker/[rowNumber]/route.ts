import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { updateMasterTableCell } from '@/lib/drive'
import { syncRemindersFromSheet } from '@/lib/reminders'

/**
 * PATCH /api/call-center/master-tracker/:rowNumber
 *
 * Updates a single field on a Master Table sheet row. Currently
 * accepts the Status column or the Sent-to-Client flag. Both are
 * mutually exclusive per request — caller sends `{ status }` or
 * `{ sentToClient }`, the handler routes to the right canonical
 * column. Adding more fields later is just a new entry in the
 * dispatch table below.
 *
 * Staff-only — middleware already blocks role=agent. Sheet-side, the
 * write hits the master spreadsheet via the writer service account.
 */

// Status tokens the UI uses internally → human-readable label
// written to the sheet. Keeps the sheet copy consistent with how the
// call center already writes them ("No Show", "Showed", etc.) so the
// canonical reader still recognizes them on the next refresh.
const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  showed: 'Showed',
  no_show: 'No Show',
  cancelled: 'Cancelled',
}

// Sent-to-Client tokens. "unassigned" clears the cell so it's empty
// in the sheet — Ethan asked for Yes / No / Unassigned, and an empty
// cell reads as Unassigned both visually + via the normalizer.
const SENT_TO_CLIENT_LABEL: Record<string, string> = {
  yes: 'Yes',
  no: 'No',
  unassigned: '',
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ rowNumber: string }> }
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

  let body: { status?: string; sentToClient?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  // Dispatch on which field was sent. Status takes precedence if both
  // arrive in the same body — happens rarely but the spec is "one
  // edit per call" and we'd rather pick one than write both partially.
  if (typeof body.status === 'string') {
    if (!STATUS_LABEL[body.status]) {
      return NextResponse.json(
        { error: 'status must be one of: booked, rescheduled, showed, no_show, cancelled' },
        { status: 400 }
      )
    }
    return await writeOne(rowNumber, 'status', STATUS_LABEL[body.status], {
      status: body.status,
    })
  }

  if (typeof body.sentToClient === 'string') {
    if (!(body.sentToClient in SENT_TO_CLIENT_LABEL)) {
      return NextResponse.json(
        { error: 'sentToClient must be one of: yes, no, unassigned' },
        { status: 400 }
      )
    }
    return await writeOne(
      rowNumber,
      'sentToClient',
      SENT_TO_CLIENT_LABEL[body.sentToClient],
      { sentToClient: body.sentToClient }
    )
  }

  return NextResponse.json(
    { error: 'no editable field on this request (expected status or sentToClient)' },
    { status: 400 }
  )
}

async function writeOne(
  rowNumber: number,
  canonical: 'status' | 'sentToClient',
  value: string,
  echo: Record<string, string>
) {
  try {
    await updateMasterTableCell({ rowNumber, canonical, value })

    // Status changes (especially → cancelled) should propagate to the
    // SMS reminder queue immediately. Fire-and-forget — the sync read
    // can take a few seconds against the Drive API and we don't want
    // to block the user's status-pill click on it. Errors are logged
    // but never surfaced; the next 5-minute cron tick is the safety
    // net. Skipped for sentToClient changes (they don't affect
    // reminder scheduling).
    if (canonical === 'status') {
      void syncRemindersFromSheet().catch((err) =>
        console.error(
          '[master-tracker PATCH] background reminder sync failed:',
          err
        )
      )
    }

    return NextResponse.json({ ok: true, ...echo })
  } catch (err) {
    console.error('[master-tracker PATCH] failed:', err)
    const message = err instanceof Error ? err.message : 'Update failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
