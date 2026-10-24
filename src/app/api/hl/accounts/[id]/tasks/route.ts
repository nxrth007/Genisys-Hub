import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/** GET ?status=open|done|all: tasks with their contact, due soonest first. */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const status = new URL(req.url).searchParams.get('status') ?? 'open'
  const where: Prisma.HlTaskWhereInput = { accountId: id, ...(status === 'all' ? {} : { completed: status === 'done' }) }
  const tasks = await prisma.hlTask.findMany({
    where,
    orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: 500,
    include: { contact: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } },
  })
  return NextResponse.json({ tasks })
}

/** POST { title, body?, dueDate?, contactId? } — PATCH-like toggles go through { id, completed }. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    if (typeof body.id === 'string') {
      const task = await prisma.hlTask.findUnique({ where: { id: body.id } })
      if (!task || task.accountId !== id) throw new HlInputError('Task not found.')
      return NextResponse.json({ task: await prisma.hlTask.update({ where: { id: task.id }, data: { completed: body.completed === true } }) })
    }
    const title = str(body.title)
    if (!title) throw new HlInputError('Give the task a title.')
    const due = str(body.dueDate) ? new Date(String(body.dueDate)) : null
    const contactId = str(body.contactId)
    if (contactId) {
      const c = await prisma.hlContact.findUnique({ where: { id: contactId }, select: { accountId: true } })
      if (!c || c.accountId !== id) throw new HlInputError('That contact isn’t in this sub-account.')
    }
    const task = await prisma.hlTask.create({
      data: { accountId: id, title, body: str(body.body), dueDate: due && !Number.isNaN(due.getTime()) ? due : null, contactId, assignedTo: guard.email },
    })
    return NextResponse.json({ task })
  } catch (err) {
    return hlError(err, 'task')
  }
}
