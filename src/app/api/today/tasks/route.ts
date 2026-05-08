import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/today/tasks
 *
 * Returns tasks for the Today view. Defaults to the logged-in
 * user's own tasks; staff (admin / member) can override via
 * ?userId=<otherUserId> to inspect a teammate's queue (the
 * Assignee dropdown on /today uses this). Non-staff get a 403
 * if they try to look at anyone else's tasks.
 *
 * Other params:
 *   ?date=2026-04-15  → tasks due on that ISO date (also includes
 *                       incomplete-no-due-date so they don't get
 *                       hidden when filtering by day)
 *   no date           → all incomplete tasks + today's completed
 *                       tasks (the latter is for the post-check
 *                       in-flight window; the UI hides completed
 *                       tasks from the list anyway)
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const dateParam = req.nextUrl.searchParams.get('date')
  const userIdParam = req.nextUrl.searchParams.get('userId')?.trim() || null

  // Resolve which user's tasks we're returning. Default = caller.
  // Override allowed only for staff so they can filter the
  // Assignee dropdown to a teammate; non-staff get a 403 to
  // prevent leaking tasks across roles.
  let targetUserId = session.user.id
  if (userIdParam && userIdParam !== session.user.id) {
    const role = (session.user as { role?: string } | undefined)?.role
    if (role !== 'admin' && role !== 'member') {
      return NextResponse.json(
        { error: 'forbidden — staff only can view other users tasks' },
        { status: 403 },
      )
    }
    targetUserId = userIdParam
  }

  let where: Record<string, unknown> = { userId: targetUserId }

  if (dateParam) {
    const day = new Date(dateParam)
    const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000)
    where = {
      userId: targetUserId,
      OR: [
        { dueAt: { gte: day, lt: nextDay } },
        { dueAt: null, completedAt: null },
      ],
    }
  } else {
    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    where = {
      userId: targetUserId,
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
