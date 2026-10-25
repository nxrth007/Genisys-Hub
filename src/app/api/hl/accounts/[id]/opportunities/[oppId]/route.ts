import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { fireTrigger } from '@/lib/hl/automation'
import { hlError, hlGuard, HlInputError, jsonBody, str, hlAccountGuard } from '@/lib/hl/http'
import { OPPORTUNITY_STATUSES, type HlStage } from '@/lib/hl/types'

type Ctx = { params: Promise<{ id: string; oppId: string }> }

/** PATCH { stageId?, position?, status?, value?, name? }. Moving into a stage fires "Pipeline stage changed". */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id, oppId } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const opp = await prisma.hlOpportunity.findUnique({ where: { id: oppId }, include: { pipeline: true } })
  if (!opp || opp.accountId !== id) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    const data: Prisma.HlOpportunityUpdateInput = {}
    let movedTo: string | null = null
    if (typeof body.stageId === 'string' && body.stageId !== opp.stageId) {
      const stage = ((opp.pipeline.stages as HlStage[]) ?? []).find((s) => s.id === body.stageId)
      if (!stage) throw new HlInputError('That stage isn’t in this pipeline.')
      data.stageId = stage.id
      movedTo = stage.id
    }
    if (typeof body.position === 'number' && Number.isFinite(body.position)) data.position = body.position
    if (typeof body.status === 'string') {
      if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(body.status)) throw new HlInputError('Unknown status.')
      data.status = body.status
      data.closedAt = body.status === 'open' ? null : new Date()
    }
    if (body.value !== undefined) data.value = Math.max(0, Math.round(Number(body.value) || 0))
    const name = str(body.name)
    if (name) data.name = name
    const updated = await prisma.hlOpportunity.update({ where: { id: oppId }, data })
    if (movedTo) await fireTrigger(id, opp.contactId, { type: 'opportunity_stage', stageId: movedTo, pipelineId: opp.pipelineId })
    return NextResponse.json({ opportunity: updated })
  } catch (err) {
    return hlError(err, 'update opportunity')
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, oppId } = await params
  const opp = await prisma.hlOpportunity.findUnique({ where: { id: oppId }, select: { accountId: true } })
  if (!opp || opp.accountId !== id) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })
  await prisma.hlOpportunity.delete({ where: { id: oppId } })
  return NextResponse.json({ ok: true })
}
