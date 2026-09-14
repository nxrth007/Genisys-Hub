import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'

/**
 * /api/external/v1/clients/intakes — onboarding form submissions.
 *
 * Owner-gated: an intake carries an EIN, a personal phone number and a
 * business address, which is not a staff surface.
 *
 * `raw` is returned alongside the mapped fields so the CRM can show
 * answers to questions the form has grown since this was written,
 * without needing a schema change first.
 */

const STATUSES = new Set(['new', 'reviewed', 'archived'])

export const GET = withOwnerApi(async (req) => {
  const status = (req.nextUrl.searchParams.get('status') ?? '').trim()

  const intakes = await prisma.clientIntake.findMany({
    where: STATUSES.has(status) ? { status } : {},
    orderBy: { receivedAt: 'desc' },
    take: 300,
  })

  return {
    intakes: intakes.map((i) => ({
      ...i,
      receivedAt: i.receivedAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    })),
    counts: {
      new: await prisma.clientIntake.count({ where: { status: 'new' } }),
      total: await prisma.clientIntake.count(),
    },
  }
})

export const PATCH = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const id = String(body.id ?? '').trim()
  if (!id) throw new WriteError('id is required')

  const status = String(body.status ?? '').trim()
  if (!STATUSES.has(status)) {
    throw new WriteError("status must be 'new', 'reviewed' or 'archived'")
  }

  await prisma.clientIntake.update({ where: { id }, data: { status } })
  return { id, status }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
