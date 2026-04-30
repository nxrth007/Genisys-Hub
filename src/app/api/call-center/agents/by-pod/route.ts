import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/agents/by-pod
 *
 * Returns approved agents grouped into "pods" by their primary
 * client — the registered Client they've booked the most appointments
 * for. Mirrors the mockup's Agents-tab pod accordion view, but driven
 * by real data (Brighton agents land in the Brighton pod, etc).
 *
 * Agents with zero bookings land in an "Unassigned" bucket so they
 * still show up on the page until they have data to anchor them.
 *
 * Staff-only — middleware blocks role=agent on /api/call-center/*.
 *
 * Sibling of /api/call-center/agents (which keeps a flat list shape
 * for the existing legacy callers); this route exists separately so
 * adding pod metadata didn't risk breaking the flat consumer.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const [agents, clients, appts] = await Promise.all([
    prisma.user.findMany({
      where: { role: 'agent' },
      select: { id: true, name: true, email: true, approvedAt: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    }),
    prisma.client.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, state: true, color: true },
    }),
    prisma.appointment.findMany({
      select: {
        agentUserId: true,
        clientId: true,
        status: true,
        apptDateTime: true,
        createdAt: true,
      },
    }),
  ])

  type AgentStats = {
    total: number
    showed: number
    noShow: number
    cancelled: number
    upcoming: number
    lastBookingAt: Date | null
    perClient: Map<string, number>
  }
  const empty = (): AgentStats => ({
    total: 0,
    showed: 0,
    noShow: 0,
    cancelled: 0,
    upcoming: 0,
    lastBookingAt: null,
    perClient: new Map(),
  })
  const byAgent = new Map<string, AgentStats>()
  const now = new Date()
  for (const a of appts) {
    if (!a.agentUserId) continue
    const s = byAgent.get(a.agentUserId) ?? empty()
    s.total++
    if (a.status === 'showed') s.showed++
    if (a.status === 'no_show') s.noShow++
    if (a.status === 'cancelled') s.cancelled++
    if (a.apptDateTime > now) s.upcoming++
    if (!s.lastBookingAt || a.createdAt > s.lastBookingAt) {
      s.lastBookingAt = a.createdAt
    }
    if (a.clientId) {
      s.perClient.set(a.clientId, (s.perClient.get(a.clientId) || 0) + 1)
    }
    byAgent.set(a.agentUserId, s)
  }

  type AgentRow = {
    id: string
    name: string | null
    email: string
    primaryClientId: string | null
    total: number
    showed: number
    noShow: number
    cancelled: number
    upcoming: number
    showRate: number | null
    lastBookingAt: string | null
  }
  const decorated: AgentRow[] = agents.map((a) => {
    const s = byAgent.get(a.id) ?? empty()
    let primary: string | null = null
    let primaryCount = 0
    for (const [cid, count] of s.perClient.entries()) {
      if (count > primaryCount) {
        primary = cid
        primaryCount = count
      }
    }
    const completed = s.showed + s.noShow
    return {
      id: a.id,
      name: a.name,
      email: a.email,
      primaryClientId: primary,
      total: s.total,
      showed: s.showed,
      noShow: s.noShow,
      cancelled: s.cancelled,
      upcoming: s.upcoming,
      showRate:
        completed > 0 ? Math.round((s.showed / completed) * 100) : null,
      lastBookingAt: s.lastBookingAt ? s.lastBookingAt.toISOString() : null,
    }
  })

  type Pod = {
    id: string
    name: string
    state: string | null
    color: string
    agents: AgentRow[]
    totalAppts: number
  }
  const pods: Pod[] = clients.map((c) => ({
    id: c.id,
    name: c.name,
    state: c.state,
    color: c.color,
    agents: [],
    totalAppts: 0,
  }))
  const unassigned: AgentRow[] = []
  for (const row of decorated) {
    const pod = row.primaryClientId
      ? pods.find((p) => p.id === row.primaryClientId)
      : null
    if (pod) pod.agents.push(row)
    else unassigned.push(row)
  }
  for (const p of pods) {
    p.totalAppts = p.agents.reduce((s, a) => s + a.total, 0)
  }

  return NextResponse.json({
    pods,
    unassigned,
    totals: {
      agents: decorated.length,
      pods: pods.length,
      totalAppts: decorated.reduce((s, a) => s + a.total, 0),
    },
  })
}
