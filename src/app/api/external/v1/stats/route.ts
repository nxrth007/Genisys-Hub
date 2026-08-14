import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/stats
 * Headline numbers for a dashboard screen.
 */
export const GET = withExternalApi(async () => {
  const now = new Date()
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const weekAgo = new Date(startOfDay.getTime() - 7 * 24 * 3600 * 1000)

  const [activeClients, totalAppts, weekAppts, upcoming, byStatus] =
    await Promise.all([
      prisma.client.count({ where: { active: true } }),
      prisma.appointment.count(),
      prisma.appointment.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.appointment.count({
        where: { apptDateTime: { gte: now }, status: { not: 'cancelled' } },
      }),
      prisma.appointment.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ])

  return {
    activeClients,
    totalAppointments: totalAppts,
    appointmentsThisWeek: weekAppts,
    upcomingAppointments: upcoming,
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
  }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
