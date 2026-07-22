import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { canAccessPayments } from '@/lib/payments-access'

/**
 * GET /api/payments/nct/payload-log
 *
 * The last 100 authenticated hits on the NCT lead webhook, verbatim —
 * exactly what NCT sent, plus what we did with it. Gated to the
 * Payments email allowlist like everything else in this section.
 */
export async function GET() {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const events = await prisma.nctWebhookEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return NextResponse.json({
    ok: true,
    events: events.map((e) => ({
      id: e.id,
      rawBody: e.rawBody,
      contentType: e.contentType,
      userAgent: e.userAgent,
      outcome: e.outcome,
      leadId: e.leadId,
      note: e.note,
      createdAt: e.createdAt,
    })),
  })
}
