import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { maskPhone, maskEmail } from '../_mask'

/** GET /api/external/v1/leads — inbound lead pipeline. Consumer PII masked. */
export const GET = withExternalApi(async (req) => {
  const limit = Math.min(
    100,
    Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? 50)),
  )

  const leads = await prisma.lead.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      company: true,
      serviceType: true,
      zip: true,
      status: true,
      source: true,
      createdAt: true,
    },
  })

  return leads.map((l) => ({
    ...l,
    phone: maskPhone(l.phone),
    email: maskEmail(l.email),
  }))
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
