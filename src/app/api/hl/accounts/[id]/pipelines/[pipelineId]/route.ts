import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { cleanStages } from '@/lib/hl/pipelines'

type Ctx = { params: Promise<{ id: string; pipelineId: string }> }

async function load(id: string, pipelineId: string) {
  const p = await prisma.hlPipeline.findUnique({ where: { id: pipelineId } })
  return p && p.accountId === id ? p : null
}

/** PATCH { name?, stages? }. A stage that still has opportunities can't be removed. */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, pipelineId } = await params
  const pipeline = await load(id, pipelineId)
  if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    const data: Prisma.HlPipelineUpdateInput = {}
    const name = str(body.name)
    if (name) data.name = name
    if (body.stages !== undefined) {
      const stages = cleanStages(body.stages)
      const kept = new Set(stages.map((s) => s.id))
      const orphaned = await prisma.hlOpportunity.count({ where: { pipelineId, stageId: { notIn: [...kept] } } })
      if (orphaned) throw new HlInputError(`${orphaned} opportunit${orphaned === 1 ? 'y is' : 'ies are'} in a stage you removed. Move them first.`)
      data.stages = stages as unknown as Prisma.InputJsonValue
    }
    return NextResponse.json({ pipeline: await prisma.hlPipeline.update({ where: { id: pipelineId }, data }) })
  } catch (err) {
    return hlError(err, 'update pipeline')
  }
}

/** DELETE: only an empty pipeline, and never the last one. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, pipelineId } = await params
  const pipeline = await load(id, pipelineId)
  if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
  const [opps, count] = await Promise.all([prisma.hlOpportunity.count({ where: { pipelineId } }), prisma.hlPipeline.count({ where: { accountId: id } })])
  if (opps) return NextResponse.json({ error: 'Move or delete its opportunities first.' }, { status: 400 })
  if (count <= 1) return NextResponse.json({ error: 'A sub-account keeps at least one pipeline.' }, { status: 400 })
  await prisma.hlPipeline.delete({ where: { id: pipelineId } })
  return NextResponse.json({ ok: true })
}
