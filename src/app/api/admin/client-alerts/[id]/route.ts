import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/**
 * PATCH /api/admin/client-alerts/[id]
 *
 * Single-action endpoint for clearing stuck client-alert rows.
 * Today the only supported action is { action: 'cancel' }, which
 * flips a `pending` row to `cancelled` so the dispatcher stops
 * trying to fire it.
 *
 * Use case: the master toggle gets flipped off after a row was
 * queued (or the appointment becomes irrelevant), and admin wants
 * the row to stop sitting in the queue. Without this endpoint,
 * stuck rows pile up indefinitely or require a DB shell.
 *
 * Only `pending` rows can be cancelled. Already-delivered /
 * already-failed / already-backfilled rows return 409 to prevent
 * surprise edits.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const denial = await requireStaff()
  if (denial) return denial

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  const action = typeof body?.action === 'string' ? body.action : ''

  if (action !== 'cancel') {
    return NextResponse.json(
      { error: 'unsupported action; only "cancel" is allowed' },
      { status: 400 },
    )
  }

  const existing = await prisma.clientAlertDelivery.findUnique({
    where: { id },
    select: { status: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (existing.status !== 'pending') {
    return NextResponse.json(
      {
        error: `cannot cancel a row with status "${existing.status}" — only pending rows can be cancelled`,
      },
      { status: 409 },
    )
  }

  await prisma.clientAlertDelivery.update({
    where: { id },
    data: {
      status: 'cancelled',
      errorMessage: 'cancelled by admin from Settings',
    },
  })

  return NextResponse.json({ ok: true })
}
