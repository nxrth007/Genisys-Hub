import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { maskPhone } from '../_mask'

/** GET /api/external/v1/today — open tasks plus the day's appointments. */
export const GET = withExternalApi(async () => {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start.getTime() + 24 * 3600 * 1000)

  const [tasks, appts, openCount] = await Promise.all([
    prisma.task.findMany({
      orderBy: [{ completedAt: 'asc' }, { dueAt: 'asc' }],
      take: 40,
      select: {
        id: true,
        title: true,
        notes: true,
        dueAt: true,
        priority: true,
        completedAt: true,
        user: { select: { name: true } },
      },
    }),
    prisma.appointment.findMany({
      where: { apptDateTime: { gte: start, lt: end } },
      orderBy: { apptDateTime: 'asc' },
      select: {
        id: true,
        apptDateTime: true,
        customerName: true,
        customerPhone: true,
        status: true,
        dispatchStatus: true,
        client: { select: { name: true, color: true } },
      },
    }),
    prisma.task.count({ where: { completedAt: null } }),
  ])

  return {
    counts: { openTasks: openCount, appointmentsToday: appts.length },
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes,
      dueAt: t.dueAt,
      priority: t.priority,
      done: t.completedAt !== null,
      owner: t.user?.name ?? null,
    })),
    appointments: appts.map((a) => ({
      id: a.id,
      apptDateTime: a.apptDateTime,
      customerName: a.customerName,
      customerPhone: maskPhone(a.customerPhone),
      status: a.status,
      dispatchStatus: a.dispatchStatus,
      clientName: a.client?.name ?? null,
      clientColor: a.client?.color ?? null,
    })),
  }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
