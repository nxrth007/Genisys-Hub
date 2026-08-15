import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { maskPhone, maskEmail } from '../_mask'

/**
 * GET /api/external/v1/appointments?limit=50
 * Recent appointments, newest first. End-customer PII is masked.
 */
export const GET = withOwnerApi(async (req) => {
  const limit = Math.min(
    100,
    Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? 50)),
  )

  const appts = await prisma.appointment.findMany({
    orderBy: { apptDateTime: 'desc' },
    take: limit,
    select: {
      id: true,
      apptDateTime: true,
      customerName: true,
      customerPhone: true,
      email: true,
      address: true,
      county: true,
      status: true,
      dispatchStatus: true,
      monthlyBill: true,
      utilityProvider: true,
      createdAt: true,
      client: { select: { name: true, color: true } },
      agent: { select: { name: true } },
    },
  })

  return appts.map((a) => ({
    id: a.id,
    apptDateTime: a.apptDateTime,
    customerName: a.customerName,
    customerPhone: maskPhone(a.customerPhone),
    email: maskEmail(a.email),
    address: a.address,
    county: a.county,
    status: a.status,
    dispatchStatus: a.dispatchStatus,
    monthlyBill: a.monthlyBill,
    utilityProvider: a.utilityProvider,
    clientName: a.client?.name ?? null,
    clientColor: a.client?.color ?? null,
    agentName: a.agent?.name ?? null,
    createdAt: a.createdAt,
  }))
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
