import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/today/tasks
 * Returns the logged-in user's tasks. Optionally filter by date.
 * ?date=2026-04-15 (ISO date) → tasks due on that date
 * No date param → all incomplete tasks + today's completed tasks
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const dateParam = req.nextUrl.searchParams.get('date')

  let where: Record<string, unknown> = { userId: session.user.id }

  if (dateParam) {
    const day = new Date(dateParam)
    const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000)
    where = {
      userId: session.user.id,
      OR: [
        // Tasks due on this date (completed or not)
        { dueAt: { gte: day, lt: nextDay } },
        // Incomplete tasks with no due date (always show)
        { dueAt: null, completedAt: null },
      ],
    }
  } else {
    // Default: incomplete tasks + tasks completed today
    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    where = {
      userId: session.user.id,
      OR: [
        { completedAt: null },
        { completedAt: { gte: startOfDay } },
      ],
    }
  }

  const tasks = await prisma.task.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
  })

  return NextResponse.json({ tasks })
}

const CreateSchema = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(5000).optional().nullable(),
  dueAt: z.string().datetime().optional().nullable(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
})

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const task = await prisma.task.create({
    data: {
      userId: session.user.id,
      title: parsed.data.title,
      notes: parsed.data.notes ?? null,
      dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
      priority: parsed.data.priority ?? 'normal',
    },
  })

  return NextResponse.json({ task }, { status: 201 })
}
