import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { maskPhone } from '../_mask'

/**
 * GET /api/external/v1/calendar?from=ISO&to=ISO
 *
 * Appointments in a date range, for the schedule view. Defaults to a
 * 4-week window around today.
 */
export const GET = withExternalApi(async (req) => {
  const params = req.nextUrl.searchParams
  const now = new Date()

  const parse = (v: string | null, fallback: Date) => {
    if (!v) return fallback
    const d = new Date(v)
    return isNaN(d.getTime()) ? fallback : d
  }

  const from = parse(
    params.get('from'),
    new Date(now.getTime() - 7 * 24 * 3600 * 1000),
  )
  const to = parse(
    params.get('to'),
    new Date(now.getTime() + 21 * 24 * 3600 * 1000),
  )

  const appts = await prisma.appointment.findMany({
    where: { apptDateTime: { gte: from, lte: to } },
    orderBy: { apptDateTime: 'asc' },
    take: 500,
    select: {
      id: true,
      apptDateTime: true,
      customerName: true,
      customerPhone: true,
      address: true,
      status: true,
      dispatchStatus: true,
      client: { select: { name: true, color: true } },
      agent: { select: { name: true } },
    },
  })

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    appointments: appts.map((a) => ({
      id: a.id,
      apptDateTime: a.apptDateTime,
      customerName: a.customerName,
      customerPhone: maskPhone(a.customerPhone),
      address: a.address,
      status: a.status,
      dispatchStatus: a.dispatchStatus,
      clientName: a.client?.name ?? null,
      clientColor: a.client?.color ?? null,
      agentName: a.agent?.name ?? null,
    })),
  }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
