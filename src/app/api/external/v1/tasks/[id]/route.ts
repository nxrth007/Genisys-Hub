import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { externalWrite, WriteError } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * PATCH /api/external/v1/tasks/:id — complete, reopen, or edit a task.
 * DELETE                          — remove it.
 */
export const PATCH = externalWrite(async ({ body }, req) => {
  const id = req.nextUrl.pathname.split('/').pop() ?? ''
  const existing = await prisma.task.findUnique({ where: { id } })
  if (!existing) throw new WriteError('Task not found.', 404)

  const data: Record<string, unknown> = {}

  if (typeof body.done === 'boolean') {
    data.completedAt = body.done ? new Date() : null
  }
  if (typeof body.title === 'string' && body.title.trim()) {
    data.title = body.title.trim()
  }
  if (typeof body.notes === 'string') {
    data.notes = body.notes.trim() || null
  }
  if (typeof body.priority === 'string') {
    const p = body.priority.toLowerCase()
    if (['low', 'medium', 'high'].includes(p)) data.priority = p
  }
  if (body.dueAt === null) {
    data.dueAt = null
  } else if (typeof body.dueAt === 'string' && body.dueAt) {
    const d = new Date(body.dueAt)
    if (isNaN(d.getTime())) throw new WriteError('Due date is not valid.')
    data.dueAt = d
  }

  if (Object.keys(data).length === 0) {
    throw new WriteError('Nothing to update.')
  }

  await prisma.task.update({ where: { id }, data })
  return { id }
})

export const DELETE = externalWrite(async (_ctx, req) => {
  const id = req.nextUrl.pathname.split('/').pop() ?? ''
  const existing = await prisma.task.findUnique({ where: { id } })
  if (!existing) throw new WriteError('Task not found.', 404)
  await prisma.task.delete({ where: { id } })
  return { id }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
