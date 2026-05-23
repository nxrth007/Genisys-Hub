import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/client-alerts/recent?limit=20
 *
 * Returns the last N ClientAlertDelivery rows so the Settings UI
 * can render a "Recent activity" panel showing exactly what
 * fired, what's pending in the 30-min buffer, what failed, and
 * what got backfilled. Answers the common Slack-fired-but-no-SMS
 * question without making admin shell into the DB.
 *
 * Each row carries:
 *   - status (delivered / pending / failed / backfilled)
 *   - clientName + recipientPhone (who got texted)
 *   - customerName + apptDateTime (which booking triggered it)
 *   - scheduledFor (when the buffer expires, for pending rows)
 *   - deliveredAt (when GHL acknowledged the send)
 *   - errorMessage (failed rows only)
 *   - createdAt (so the UI can show "5 minutes ago")
 *
 * Default limit 20, max 100.
 */
export async function GET(req: NextRequest) {
  const denial = await requireStaff()
  if (denial) return denial

  const limitParam = req.nextUrl.searchParams.get('limit')
  const limit = Math.min(
    Math.max(1, Number.parseInt(limitParam ?? '20', 10) || 20),
    100,
  )

  const rows = await prisma.clientAlertDelivery.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      status: true,
      recipientPhone: true,
      customerPhone: true,
      apptDateTime: true,
      scheduledFor: true,
      deliveredAt: true,
      errorMessage: true,
      createdAt: true,
      sourceKey: true,
      client: {
        select: { id: true, name: true },
      },
    },
  })

  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id,
      status: r.status,
      clientId: r.client?.id ?? null,
      clientName: r.client?.name ?? null,
      recipientPhone: r.recipientPhone,
      customerPhone: r.customerPhone,
      apptDateTime: r.apptDateTime ? r.apptDateTime.toISOString() : null,
      scheduledFor: r.scheduledFor ? r.scheduledFor.toISOString() : null,
      deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
      errorMessage: r.errorMessage,
      sourceKey: r.sourceKey,
      createdAt: r.createdAt.toISOString(),
    })),
  })
}
