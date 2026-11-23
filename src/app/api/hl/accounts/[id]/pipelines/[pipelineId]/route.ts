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

/**
 * The live workflows (not deleted) whose triggers or steps name one of these ids: the client kit puts
 * leads in stages by id (missed_call_lead, new_lead, job_completed) and the review request listens for
 * Job Completed. Removing one quietly broke them (a lead landed in the first stage, no review asked), and
 * a re-added stage gets a different id, so it never came back.
 */
async function workflowsUsing(accountId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  const rows = await prisma.hlWorkflow.findMany({ where: { accountId, deletedAt: null }, select: { name: true, trigger: true, triggers: true, steps: true } })
  return rows.filter((w) => ids.some((x) => JSON.stringify([w.trigger, w.triggers, w.steps]).includes(`"${x}"`))).map((w) => w.name)
}

const listOf = (names: string[]) => (names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and '))

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
      const before = ((pipeline.stages ?? []) as { id: string; name: string }[]).filter((st) => !kept.has(st.id))
      const users = await workflowsUsing(id, before.map((st) => st.id))
      if (users.length)
        throw new HlInputError(`${listOf(before.map((st) => st.name))} can’t be removed: ${listOf(users)} put${users.length === 1 ? 's' : ''} leads there or listen${users.length === 1 ? 's' : ''} for it. Rename it instead.`)
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
  const users = await workflowsUsing(id, [pipelineId])
  if (users.length) return NextResponse.json({ error: `${listOf(users)} use${users.length === 1 ? 's' : ''} this pipeline, so it stays.` }, { status: 400 })
  await prisma.hlPipeline.delete({ where: { id: pipelineId } })
  return NextResponse.json({ ok: true })
}
