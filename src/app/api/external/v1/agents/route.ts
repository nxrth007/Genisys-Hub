import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/** GET /api/external/v1/agents — staff roster with booking volume. */
export const GET = withExternalApi(async () => {
  const [users, byAgent] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ['agent', 'member', 'admin'] } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, role: true, image: true },
    }),
    prisma.appointment.groupBy({
      by: ['agentUserId'],
      _count: { _all: true },
      _max: { apptDateTime: true },
    }),
  ])

  const stats = new Map(
    byAgent.map((r) => [
      r.agentUserId,
      { count: r._count._all, last: r._max.apptDateTime },
    ]),
  )

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    image: u.image,
    appointmentCount: stats.get(u.id)?.count ?? 0,
    lastBookingAt: stats.get(u.id)?.last ?? null,
  }))
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
