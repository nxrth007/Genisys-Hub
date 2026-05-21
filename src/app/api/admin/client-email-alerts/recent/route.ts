import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'

/**
 * GET /api/admin/client-email-alerts/recent?limit=20
 *
 * Recent activity feed for the Email Client Alerts settings panel —
 * last N rows from ClientEmailDelivery with the client name joined
 * so the UI can render "Spring Solar · david@spring.com · delivered"
 * style entries without a second round-trip per row.
 *
 * Staff-only.
 */
export async function GET(req: NextRequest) {
  const denial = await requireStaff()
  if (denial) return denial

  const sp = req.nextUrl.searchParams
  const limit = Math.min(100, Math.max(1, Number(sp.get('limit') || '20')))

  const rows = await prisma.clientEmailDelivery.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      client: { select: { id: true, name: true, color: true } },
    },
  })

  return NextResponse.json({
    deliveries: rows.map((r) => ({
      id: r.id,
      sourceKey: r.sourceKey,
      recipientEmail: r.recipientEmail,
      status: r.status,
      messageId: r.messageId,
      errorMessage: r.errorMessage,
      scheduledFor: r.scheduledFor ? r.scheduledFor.toISOString() : null,
      deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      apptDateTime: r.apptDateTime ? r.apptDateTime.toISOString() : null,
      client: r.client,
    })),
  })
}
