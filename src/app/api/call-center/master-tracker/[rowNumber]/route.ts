import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { updateMasterTableCell } from '@/lib/drive'

/**
 * PATCH /api/call-center/master-tracker/:rowNumber
 *
 * Updates a single field on a Master Table sheet row. Today only the
 * Status column is editable from the UI, but the endpoint is shaped to
 * accept a small allow-list of fields so we can extend it later
 * (notes, deal value, etc.) without adding new routes.
 *
 * Staff-only — middleware already blocks role=agent. Sheet-side, the
 * write hits the master spreadsheet via the writer service account.
 */

// Status tokens the UI uses internally → human-readable label written
// to the sheet. Keeping the sheet copy consistent with how the call
// center already writes them ("No Show", "Showed", etc.) means the
// canonical reader still recognizes them on the next refresh.
const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  showed: 'Showed',
  no_show: 'No Show',
  cancelled: 'Cancelled',
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

  let body: { status?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  if (typeof body.status !== 'string' || !STATUS_LABEL[body.status]) {
    return NextResponse.json(
      { error: 'status must be one of: booked, rescheduled, showed, no_show, cancelled' },
      { status: 400 }
    )
  }

  try {
    await updateMasterTableCell({
      rowNumber,
      canonical: 'status',
      value: STATUS_LABEL[body.status],
    })
    return NextResponse.json({ ok: true, status: body.status })
  } catch (err) {
    console.error('[master-tracker PATCH] failed:', err)
    const message = err instanceof Error ? err.message : 'Update failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
