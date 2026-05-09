import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth-helpers'
import { readMasterTableRows } from '@/lib/drive'

/**
 * POST /api/admin/client-alerts/wipe-row
 *
 * Parallel to /api/admin/slack-delivery/wipe-row but for the SMS
 * ledger. Deletes every ClientAlertDelivery record matching a given
 * sheet row's sourceKey or its content key (recipientPhone, customerPhone,
 * apptDateTime). Use case: testing the auto-SMS flow with a phone +
 * appointment time that's been used in earlier tests, where the dedup
 * ledger keeps skipping the row.
 *
 * Body:
 *   { rowNumber: number }
 *
 * Returns:
 *   { ok: true, deleted: number }
 */
function normalizePhoneForKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return null
}

export async function POST(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial

  let body: { rowNumber?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const rowNumber =
    typeof body.rowNumber === 'number' && Number.isFinite(body.rowNumber)
      ? Math.round(body.rowNumber)
      : null
  if (!rowNumber || rowNumber < 1) {
    return NextResponse.json(
      { error: 'rowNumber is required (positive integer)' },
      { status: 400 },
    )
  }

  // Read the sheet to learn the row's customerPhone + apptDateTime so
  // the content-key delete can fire too. Sheet read is best-effort —
  // fall through to sourceKey-only delete if it fails.
  let customerPhoneKey: string | null = null
  let apptDate: Date | null = null
  try {
    const rows = await readMasterTableRows()
    const row = rows.find((r) => r.rowNumber === rowNumber)
    if (row) {
      customerPhoneKey = normalizePhoneForKey(row.customerPhone)
      const d = row.apptDateTime ? new Date(row.apptDateTime) : null
      if (d && !isNaN(d.getTime())) apptDate = d
    }
  } catch (err) {
    console.warn(
      `[client-alerts wipe-row] sheet read failed for row ${rowNumber}; falling back to sourceKey-only delete:`,
      err,
    )
  }

  const sourceKey = `sheet:Master Table:${rowNumber}`
  const matchedContent = !!(customerPhoneKey && apptDate)

  const result = await prisma.clientAlertDelivery.deleteMany({
    where: {
      OR: [
        { sourceKey },
        ...(matchedContent
          ? [
              {
                customerPhone: customerPhoneKey,
                apptDateTime: apptDate,
              },
            ]
          : []),
      ],
    },
  })

  return NextResponse.json({
    ok: true,
    deleted: result.count,
    sourceKey,
    matchedContent,
  })
}
