import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'
import { readMasterTableRows } from '@/lib/drive'

/**
 * POST /api/admin/slack-delivery/wipe-row
 *
 * Delete every SheetSlackDelivery record matching a given master-
 * sheet row. Use case: testing the auto-delivery flow with a phone
 * number / appointment time that's been used in earlier tests, where
 * the dedup ledger keeps skipping the row before it can re-post.
 *
 * Wipes BOTH dedup paths:
 *   1. sourceKey  ("sheet:Master Table:N") — the row position
 *   2. content    (channelId, customerPhone, apptDateTime) — across
 *      ALL channels, since the master tracker's display matches
 *      cross-channel and we want a clean slate
 *
 * After this runs, the next 5-min cron tick treats the row as fresh
 * and either auto-delivers or fails-with-reason loudly.
 *
 * Body:
 *   { rowNumber: number }
 *
 * Returns:
 *   { ok: true, deleted: number, sourceKey, matchedContent: boolean }
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
  const denial = await requireStaff()
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

  // Pull the row off the sheet so we know its phone + apptDateTime
  // for the content-key delete. If the sheet read fails, we can
  // still wipe by sourceKey alone — better than refusing the
  // request entirely.
  let phoneKey: string | null = null
  let apptDate: Date | null = null
  try {
    const rows = await readMasterTableRows()
    const row = rows.find((r) => r.rowNumber === rowNumber)
    if (row) {
      phoneKey = normalizePhoneForKey(row.customerPhone)
      const d = row.apptDateTime ? new Date(row.apptDateTime) : null
      if (d && !isNaN(d.getTime())) apptDate = d
    }
  } catch (err) {
    console.warn(
      `[wipe-row] sheet read failed for row ${rowNumber}; falling back to sourceKey-only delete:`,
      err,
    )
  }

  const sourceKey = `sheet:Master Table:${rowNumber}`
  const matchedContent = !!(phoneKey && apptDate)

  // Delete every record matching either path. Scoped by sourceKey
  // first (always safe), then by content key across ALL channels
  // (matches the master tracker's display logic so the UI flips
  // back to "Unassigned" on next reload).
  const result = await prisma.sheetSlackDelivery.deleteMany({
    where: {
      OR: [
        { sourceKey },
        ...(matchedContent
          ? [
              {
                customerPhone: phoneKey,
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
