import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/invoices
 *
 * Lists every PPA invoice the automation has generated, most recent
 * first. Powers /clients/invoices history page.
 *
 * Query params (all optional):
 *   - clientId: scope to a single client
 *   - limit:    cap rows (default 100, max 500)
 *
 * Admin/member only — invoice history is sensitive (amounts, client
 * payment status). agents/team can't reach this.
 */

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const clientId = url.searchParams.get('clientId') || undefined
  const limitRaw = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
    : DEFAULT_LIMIT

  const invoices = await prisma.invoice.findMany({
    where: clientId ? { clientId } : undefined,
    orderBy: [{ cycleEndAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      id: true,
      clientId: true,
      cycleStartAt: true,
      cycleEndAt: true,
      appointmentCount: true,
      appointmentIds: true,
      amountCents: true,
      paymentLink: true,
      emailSentAt: true,
      smsSentAt: true,
      deliveryError: true,
      createdAt: true,
      client: {
        select: { id: true, name: true, color: true },
      },
    },
  })

  return NextResponse.json({
    invoices: invoices.map((inv) => ({
      id: inv.id,
      client: inv.client,
      cycleStartAt: inv.cycleStartAt.toISOString(),
      cycleEndAt: inv.cycleEndAt.toISOString(),
      appointmentCount: inv.appointmentCount,
      appointmentIds: Array.isArray(inv.appointmentIds)
        ? (inv.appointmentIds as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : [],
      amountCents: inv.amountCents,
      paymentLink: inv.paymentLink,
      emailSentAt: inv.emailSentAt?.toISOString() ?? null,
      smsSentAt: inv.smsSentAt?.toISOString() ?? null,
      deliveryError: inv.deliveryError,
      createdAt: inv.createdAt.toISOString(),
    })),
  })
}
