import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/reminders
 *
 * Staff-accessible (admin or member; agents blocked by middleware)
 * paginated list of AppointmentReminder rows. Powers the Call Center
 * → Reminders tab. Mirrors /api/admin/reminders but lives under the
 * call-center namespace so member staff (Ethan) can browse without
 * needing admin role.
 *
 * Filters: status, clientId, reminderType, search query (matches
 * customerName / customerPhone). Latest-first by scheduledFor so
 * the page leads with what's about to fire.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const status = sp.get('status')
  const clientId = sp.get('clientId')
  const reminderType = sp.get('reminderType')
  const q = sp.get('q')?.trim()
  const limit = Math.min(500, Math.max(1, parseInt(sp.get('limit') || '100', 10)))

  const where: Record<string, unknown> = {}
  if (status && status !== 'all') where.status = status
  if (clientId && clientId !== 'all') where.clientId = clientId
  if (reminderType && reminderType !== 'all') where.reminderType = reminderType
  if (q) {
    where.OR = [
      { customerName: { contains: q, mode: 'insensitive' } },
      { customerPhone: { contains: q } },
    ]
  }

  const reminders = await prisma.appointmentReminder.findMany({
    where,
    orderBy: { scheduledFor: 'desc' },
    take: limit,
    include: {
      client: { select: { id: true, name: true, color: true } },
    },
  })

  // Counts per status for the filter chips, computed off the *full*
  // unfiltered set so the chip badges show real totals.
  const allCounts = await prisma.appointmentReminder.groupBy({
    by: ['status'],
    _count: { _all: true },
  })
  const counts: Record<string, number> = {}
  for (const c of allCounts) counts[c.status] = c._count._all

  // Stats cards — pending in the next 24h, sent in past 7 days,
  // failed in past 7 days. Computed independently of the active
  // status / type filters so the operational health stays visible
  // even when the user is drilled into a specific slice.
  const now = new Date()
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const past7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const [pendingNext24h, sentPast7d, failedPast7d] = await Promise.all([
    prisma.appointmentReminder.count({
      where: {
        status: 'pending',
        scheduledFor: { gte: now, lte: in24h },
      },
    }),
    prisma.appointmentReminder.count({
      where: { status: 'sent', sentAt: { gte: past7Days } },
    }),
    prisma.appointmentReminder.count({
      where: { status: 'failed', updatedAt: { gte: past7Days } },
    }),
  ])
  const completedPast7d = sentPast7d + failedPast7d
  const successRate =
    completedPast7d > 0 ? Math.round((sentPast7d / completedPast7d) * 100) : null

  return NextResponse.json({
    reminders,
    counts,
    stats: {
      pendingNext24h,
      sentPast7d,
      failedPast7d,
      successRate, // 0–100 or null when nothing has fired yet
    },
  })
}
