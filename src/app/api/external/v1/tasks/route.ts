import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { externalWrite, WriteError } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * POST /api/external/v1/tasks — create a task.
 *
 * Owned by whoever is signed in, so tasks made here show up as theirs in
 * the Hub rather than appearing from nowhere.
 */
export const POST = externalWrite(async ({ auth, body }) => {
  const title = String(body.title ?? '').trim()
  if (!title) throw new WriteError('Give the task a title.')
  if (title.length > 500) throw new WriteError('Title is too long.')

  const priorityRaw = String(body.priority ?? 'medium').toLowerCase()
  const priority = ['low', 'medium', 'high'].includes(priorityRaw)
    ? priorityRaw
    : 'medium'

  let dueAt: Date | null = null
  if (body.dueAt) {
    const d = new Date(String(body.dueAt))
    if (isNaN(d.getTime())) throw new WriteError('Due date is not a valid date.')
    dueAt = d
  }

  const task = await prisma.task.create({
    data: {
      userId: auth.user.id,
      title,
      notes: String(body.notes ?? '').trim() || null,
      priority,
      dueAt,
    },
    select: { id: true, title: true, priority: true, dueAt: true },
  })

  return task
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
