import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/clients
 * The client roster, shaped for display. Active first, then by sortOrder.
 */
export const GET = withExternalApi(async () => {
  const clients = await prisma.client.findMany({
    orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      state: true,
      color: true,
      active: true,
      contactName: true,
      contactRole: true,
      contactEmail: true,
      contactPhone: true,
      createdAt: true,
      _count: { select: { appointments: true } },
    },
  })

  return clients.map((c) => ({
    id: c.id,
    name: c.name,
    state: c.state,
    color: c.color,
    active: c.active,
    contactName: c.contactName,
    contactRole: c.contactRole,
    contactEmail: c.contactEmail,
    contactPhone: c.contactPhone,
    appointmentCount: c._count.appointments,
    createdAt: c.createdAt,
  }))
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
