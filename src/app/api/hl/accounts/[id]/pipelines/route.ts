import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str, hlAccountGuard } from '@/lib/hl/http'
import { cleanStages } from '@/lib/hl/pipelines'

type Ctx = { params: Promise<{ id: string }> }

/** GET: pipelines with their opportunities (and each opportunity's contact). */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const pipelines = await prisma.hlPipeline.findMany({
    where: { accountId: id },
    orderBy: { createdAt: 'asc' },
    include: {
      opportunities: {
        orderBy: [{ createdAt: 'desc' }],
        include: { contact: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, tags: true } } },
      },
    },
  })
  return NextResponse.json({ pipelines })
}

/** POST { name, stages: [{ id?, name }] } */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const name = str(body.name)
    if (!name) throw new HlInputError('Name the pipeline.')
    const stages = cleanStages(body.stages)
    const pipeline = await prisma.hlPipeline.create({ data: { accountId: id, name, stages: stages as unknown as Prisma.InputJsonValue } })
    return NextResponse.json({ pipeline })
  } catch (err) {
    return hlError(err, 'create pipeline')
  }
}
