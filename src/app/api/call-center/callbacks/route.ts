import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/callbacks
 * Staff view across all agents (middleware blocks role=agent). Filters:
 *   agent   — agent userId, "all" by default
 *   bucket  — pending | overdue | due_today | upcoming | completed | all
 *   q       — search in name / phone / notes
 *   since   — ISO date; callbackAt on/after
 *   until   — ISO date; callbackAt on/before
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const where: Record<string, unknown> = {}

  const agent = sp.get('agent')
  if (agent && agent !== 'all') where.agentUserId = agent

  const since = sp.get('since')
  const until = sp.get('until')
  if (since || until) {
    const range: Record<string, Date> = {}
    if (since) {
      const d = new Date(since)
      if (!isNaN(d.getTime())) range.gte = d
    }
    if (until) {
      const d = new Date(until)
      if (!isNaN(d.getTime())) range.lte = d
    }
    if (Object.keys(range).length > 0) where.callbackAt = range
  }

  const q = sp.get('q')?.trim()
  if (q) {
    where.OR = [
      { customerName: { contains: q, mode: 'insensitive' } },
      { customerPhone: { contains: q } },
      { notes: { contains: q, mode: 'insensitive' } },
    ]
  }

  const callbacks = await prisma.callback.findMany({
    where,
    orderBy: [{ completedAt: 'asc' }, { callbackAt: 'asc' }],
    take: 500,
    include: {
      agent: { select: { id: true, name: true, email: true } },
    },
  })

  // Bucket filter applied in-memory since it depends on "now". Keeps the DB
  // query simple + cacheable; we're capped at 500 rows anyway.
  const bucket = sp.get('bucket') || 'all'
  const now = new Date()
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000)

  const filtered = callbacks.filter((c) => {
    const done = !!c.completedAt
    const when = new Date(c.callbackAt)
    switch (bucket) {
      case 'pending':
        return !done
      case 'overdue':
        return !done && when < now
      case 'due_today':
        return !done && when >= startOfToday && when < endOfToday
      case 'upcoming':
        return !done && when >= endOfToday
      case 'completed':
        return done
      default:
        return true
    }
  })

  return NextResponse.json({ callbacks: filtered })
}
