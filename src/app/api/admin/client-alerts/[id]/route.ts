import { NextRequest, NextResponse } from 'next/server'
import { requireStaff, requireAdmin } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { retryFailedClientAlert } from '@/lib/client-alert'

/**
 * PATCH /api/admin/client-alerts/[id]
 *
 * Action endpoint for clearing or re-firing client-alert ledger rows.
 * Supported actions:
 *
 *   { action: 'cancel' } — staff-gated. Flips a `pending` row to
 *     `cancelled` so the dispatcher stops trying to fire it. Refuses
 *     to touch already-delivered / failed / backfilled rows (409).
 *
 *   { action: 'retry' } — admin-gated. Re-fires a `failed` row by
 *     re-fetching fresh source data (latest appointment state for
 *     db:* rows, latest sheet row for sheet:* rows), rebuilding the
 *     SMS body, and sending inline through GHL. Updates the row to
 *     `delivered` on success or keeps it `failed` with a new
 *     errorMessage on another error. Admin-only because retry spends
 *     money and contacts a real client phone.
 *
 * Use cases:
 *   - cancel: master toggle gets flipped off after a row was queued,
 *     or the appointment becomes irrelevant; admin wants the row to
 *     stop sitting in the queue.
 *   - retry: GHL had a transient outage / bad token; admin fixes the
 *     underlying issue and wants to push the SMS without re-creating
 *     the appointment.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  const action = typeof body?.action === 'string' ? body.action : ''

  if (action === 'cancel') {
    const denial = await requireStaff()
    if (denial) return denial

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

  if (action === 'retry') {
    const denial = await requireAdmin()
    if (denial) return denial

    const result = await retryFailedClientAlert(id)
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, status: result.status },
        { status: 400 },
      )
    }
    return NextResponse.json({ ok: true, messageId: result.messageId })
  }

  return NextResponse.json(
    { error: 'unsupported action; allowed: "cancel", "retry"' },
    { status: 400 },
  )
}
