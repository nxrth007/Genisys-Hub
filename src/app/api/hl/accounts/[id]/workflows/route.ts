import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { workflowTemplates } from '@/lib/hl/templates'

type Ctx = { params: Promise<{ id: string }> }

/** GET: workflows with how many contacts went through each (last 30 days) and how many are waiting. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const since = new Date(Date.now() - 30 * 86_400_000)
  const [workflows, recent, waiting] = await Promise.all([
    prisma.hlWorkflow.findMany({ where: { accountId: id }, orderBy: [{ folder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.hlWorkflowRun.groupBy({ by: ['workflowId'], where: { accountId: id, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.hlWorkflowRun.groupBy({ by: ['workflowId'], where: { accountId: id, status: 'waiting' }, _count: { _all: true } }),
  ])
  return NextResponse.json({
    workflows: workflows.map((w) => ({
      ...w,
      runs30: recent.find((r) => r.workflowId === w.id)?._count._all ?? 0,
      waiting: waiting.find((r) => r.workflowId === w.id)?._count._all ?? 0,
    })),
  })
}

/** POST { name, folder? } for a blank workflow, or { template } for a starter one. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const key = str(body.template)
    if (key) {
      const forms = await prisma.hlForm.findMany({ where: { accountId: id, archivedAt: null }, select: { id: true, kind: true } })
      const t = workflowTemplates({ quote: forms.find((f) => f.kind === 'form')?.id, chat: forms.find((f) => f.kind === 'chat')?.id }).find((x) => x.key === key)
      if (!t) throw new HlInputError('Unknown template.')
      const w = await prisma.hlWorkflow.create({
        data: { accountId: id, name: t.name, folder: t.folder, template: t.key, status: 'draft', trigger: t.trigger as unknown as Prisma.InputJsonValue, steps: t.steps as unknown as Prisma.InputJsonValue },
      })
      return NextResponse.json({ workflow: w })
    }
    const name = str(body.name)
    if (!name) throw new HlInputError('Name the workflow.')
    const w = await prisma.hlWorkflow.create({
      data: { accountId: id, name, folder: str(body.folder), status: 'draft', trigger: { type: 'form_submitted' }, steps: [] },
    })
    return NextResponse.json({ workflow: w })
  } catch (err) {
    return hlError(err, 'create workflow')
  }
}
