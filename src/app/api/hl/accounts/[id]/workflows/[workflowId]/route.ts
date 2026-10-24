import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { startWorkflow } from '@/lib/hl/automation'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { cleanSteps, cleanTrigger } from '@/lib/hl/workflow-input'

type Ctx = { params: Promise<{ id: string; workflowId: string }> }

async function load(id: string, workflowId: string) {
  const w = await prisma.hlWorkflow.findUnique({ where: { id: workflowId } })
  return w && w.accountId === id ? w : null
}

/** GET: the workflow and its latest runs (the execution log). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, workflowId } = await params
  const workflow = await load(id, workflowId)
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
  const runs = await prisma.hlWorkflowRun.findMany({
    where: { workflowId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { contact: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } },
  })
  return NextResponse.json({ workflow, runs })
}

/** PATCH { name?, folder?, trigger?, steps?, status?: 'draft'|'published', allowReentry?, testContactId? } */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, workflowId } = await params
  const workflow = await load(id, workflowId)
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    if (typeof body.testContactId === 'string') {
      const runId = await startWorkflow(workflowId, body.testContactId)
      const run = await prisma.hlWorkflowRun.findUnique({ where: { id: runId } })
      return NextResponse.json({ run })
    }
    if (body.restore === true) {
      return NextResponse.json({ workflow: await prisma.hlWorkflow.update({ where: { id: workflowId }, data: { deletedAt: null } }) })
    }
    const data: Prisma.HlWorkflowUpdateInput = {}
    const name = str(body.name)
    if (name) data.name = name
    if ('folder' in body) data.folder = str(body.folder)
    if (body.trigger !== undefined) data.trigger = cleanTrigger(body.trigger) as unknown as Prisma.InputJsonValue
    if (body.steps !== undefined) data.steps = cleanSteps(body.steps) as unknown as Prisma.InputJsonValue
    if (typeof body.allowReentry === 'boolean') data.allowReentry = body.allowReentry
    if (body.status === 'published' || body.status === 'draft') {
      const steps = body.steps !== undefined ? cleanSteps(body.steps) : (workflow.steps as unknown[])
      if (body.status === 'published' && !steps.length) throw new HlInputError('Add at least one action before publishing.')
      data.status = body.status
      if (body.status === 'published' && workflow.status !== 'published') data.publishedAt = new Date()
    }
    return NextResponse.json({ workflow: await prisma.hlWorkflow.update({ where: { id: workflowId }, data }) })
  } catch (err) {
    return hlError(err, 'update workflow')
  }
}

/**
 * DELETE: into "Deleted" (switched off, restorable), like GHL. ?permanent=1 on a
 * deleted one removes it and its run history for good.
 */
export async function DELETE(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, workflowId } = await params
  const workflow = await load(id, workflowId)
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
  if (new URL(req.url).searchParams.get('permanent') && workflow.deletedAt) {
    await prisma.hlWorkflow.delete({ where: { id: workflowId } })
  } else {
    await prisma.hlWorkflow.update({ where: { id: workflowId }, data: { deletedAt: new Date(), status: 'draft' } })
    await prisma.hlWorkflowRun.updateMany({ where: { workflowId, status: { in: ['running', 'waiting'] } }, data: { status: 'cancelled', lockedAt: null, nextRunAt: null } })
  }
  return NextResponse.json({ ok: true })
}
