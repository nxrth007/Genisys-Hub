import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/agent/alerts        → the signed-in agent's alerts, newest first
 * PATCH /api/agent/alerts       → { id, status } mark one read|actioned|unread
 *
 * The agent-alert feed: customer declines / reschedules / client
 * no-shows + cancellations on appointments this agent booked. Agent
 * + team_member only; each user sees strictly their own (agentUserId
 * == session user).
 */
const ALLOWED_ROLES = new Set(['agent', 'team_member'])
const ALLOWED_STATUS = new Set(['unread', 'read', 'actioned'])

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const status = sp.get('status')
  const where: Record<string, unknown> = { agentUserId: session.user.id }
  if (status && ALLOWED_STATUS.has(status)) where.status = status

  const [alerts, unreadCount] = await Promise.all([
    prisma.agentAlert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.agentAlert.count({
      where: { agentUserId: session.user.id, status: 'unread' },
    }),
  ])

  return NextResponse.json(
    { alerts, unreadCount },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { id?: unknown; status?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const id = typeof body.id === 'string' ? body.id : ''
  const status = typeof body.status === 'string' ? body.status : ''
  if (!id || !ALLOWED_STATUS.has(status)) {
    return NextResponse.json(
      { error: 'id and a valid status (unread|read|actioned) required' },
      { status: 400 },
    )
  }

  // Scope the update to the caller's own alert — updateMany so a
  // wrong id / other agent's alert just affects 0 rows instead of
  // erroring or leaking.
  const result = await prisma.agentAlert.updateMany({
    where: { id, agentUserId: session.user.id },
    data: { status },
  })
  if (result.count === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
