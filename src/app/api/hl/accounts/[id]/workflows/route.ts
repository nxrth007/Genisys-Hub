import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { workflowTemplates } from '@/lib/hl/templates'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET: workflows (deleted ones flagged) with GHL's list columns: total enrolled,
 * active enrolled, and errors in the last 7 days ("Needs review"); plus the
 * folders, which exist once a workflow is in them or someone made one.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const week = new Date(Date.now() - 7 * 86_400_000)
  const [workflows, total, active, recent, folderRows] = await Promise.all([
    prisma.hlWorkflow.findMany({ where: { accountId: id }, orderBy: [{ folder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.hlWorkflowRun.groupBy({ by: ['workflowId'], where: { accountId: id }, _count: { _all: true } }),
    prisma.hlWorkflowRun.groupBy({ by: ['workflowId'], where: { accountId: id, status: { in: ['waiting', 'running'] } }, _count: { _all: true } }),
    prisma.hlWorkflowRun.findMany({ where: { accountId: id, createdAt: { gte: week } }, select: { workflowId: true, log: true }, take: 3000, orderBy: { createdAt: 'desc' } }),
    prisma.hlRecord.findMany({ where: { accountId: id, kind: 'workflow_folder' }, select: { name: true } }),
  ])
  const errors = new Map<string, number>()
  for (const r of recent) {
    const bad = Array.isArray(r.log) && (r.log as { ok?: boolean }[]).some((l) => l && l.ok === false)
    if (bad) errors.set(r.workflowId, (errors.get(r.workflowId) ?? 0) + 1)
  }
  const folders = [...new Set([...folderRows.map((f) => f.name), ...workflows.filter((w) => !w.deletedAt && w.folder).map((w) => w.folder!)])].sort((a, b) => a.localeCompare(b))
  return NextResponse.json({
    folders,
    workflows: workflows.map((w) => ({
      ...w,
      runs: total.find((r) => r.workflowId === w.id)?._count._all ?? 0,
      waiting: active.find((r) => r.workflowId === w.id)?._count._all ?? 0,
      errors7d: errors.get(w.id) ?? 0,
    })),
  })
}

/** POST { name, folder? } for a blank workflow, { template } for a starter one, or { createFolder } for an empty folder. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const folderName = str(body.createFolder)
    if (folderName) {
      const exists = await prisma.hlRecord.findFirst({ where: { accountId: id, kind: 'workflow_folder', name: folderName } })
      if (!exists) await prisma.hlRecord.create({ data: { accountId: id, kind: 'workflow_folder', name: folderName.slice(0, 120) } })
      return NextResponse.json({ folder: folderName })
    }
    const key = str(body.template)
    if (key) {
      const forms = await prisma.hlForm.findMany({ where: { accountId: id, archivedAt: null }, select: { id: true, kind: true } })
      const t = workflowTemplates({ quote: forms.find((f) => f.kind === 'form')?.id, chat: forms.find((f) => f.kind === 'chat')?.id }).find((x) => x.key === key)
      if (!t) throw new HlInputError('Unknown template.')
      const w = await prisma.hlWorkflow.create({
        data: { accountId: id, name: t.name, folder: str(body.folder) ?? t.folder, template: t.key, status: 'draft', trigger: t.trigger as unknown as Prisma.InputJsonValue, steps: t.steps as unknown as Prisma.InputJsonValue },
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
