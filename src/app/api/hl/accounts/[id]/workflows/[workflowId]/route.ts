import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { asTriggers, startWorkflow } from '@/lib/hl/automation'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import type { HlTrigger } from '@/lib/hl/types'
import { ensureHookIds, forgetHooks } from '@/lib/hl/webhooks'
import { cleanSteps, cleanTrigger, cleanTriggers } from '@/lib/hl/workflow-input'

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

/** PATCH { name?, folder?, trigger?, triggers?, steps?, status?: 'draft'|'published', allowReentry?, stopOnResponse?, testContactId? } */
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
    let triggers: HlTrigger[] | null = null
    const name = str(body.name)
    if (name) data.name = name
    if ('folder' in body) data.folder = str(body.folder)
    if (body.triggers !== undefined || body.trigger !== undefined) {
      // Several triggers (GHL's way): the first is also kept as `trigger` for what reads one.
      // Webhook triggers each keep (or get) a URL of their own.
      triggers = await ensureHookIds(workflowId, body.triggers !== undefined ? cleanTriggers(body.triggers) : [cleanTrigger(body.trigger)])
      data.triggers = (body.triggers !== undefined ? triggers : []) as unknown as Prisma.InputJsonValue
      data.trigger = triggers[0] as unknown as Prisma.InputJsonValue
    }
    if (body.steps !== undefined) data.steps = cleanSteps(body.steps) as unknown as Prisma.InputJsonValue
    if (typeof body.allowReentry === 'boolean') data.allowReentry = body.allowReentry
    if (typeof body.stopOnResponse === 'boolean') data.meta = { ...((workflow.meta as Record<string, unknown> | null) ?? {}), stopOnResponse: body.stopOnResponse } as Prisma.InputJsonValue
    if (body.status === 'published' || body.status === 'draft') {
      const steps = body.steps !== undefined ? cleanSteps(body.steps) : (workflow.steps as unknown[])
      if (body.status === 'published' && !steps.length) throw new HlInputError('Add at least one action before publishing.')
      data.status = body.status
      if (body.status === 'published' && workflow.status !== 'published') data.publishedAt = new Date()
    }
    const updated = await prisma.hlWorkflow.update({ where: { id: workflowId }, data })
    // A webhook trigger that was removed takes its test requests with it, as in GHL.
    if (triggers) await forgetHooks(id, asTriggers(workflow), triggers)
    return NextResponse.json({ workflow: updated })
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
