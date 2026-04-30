import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/clients/with-counts
 *
 * Returns each registered client with appointment statistics.
 * Powers the /clients listing page. Splits "show rate" + total +
 * upcoming counts so the page can render without doing math itself.
 *
 * Staff-only — no agent access. Middleware enforces /api/clients/* is
 * fine for any signed-in user, but the agent allow-list explicitly
 * scopes to the simpler /api/clients endpoint, not this one.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Pull clients + per-client appointment counts. We compute a few
  // groups in JS rather than firing 4× findMany — single query, then
  // bucket by clientId. Scales fine until we have 100k+ rows.
  const [clients, appts] = await Promise.all([
    prisma.client.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        state: true,
        color: true,
      },
    }),
    prisma.appointment.findMany({
      select: {
        clientId: true,
        apptDateTime: true,
        createdAt: true,
        status: true,
        // Track the booking agent so we can count distinct agents
        // who have booked for each client (mirrors the mockup's
        // "Agents" column).
        agentUserId: true,
      },
    }),
  ])

  type Bucket = {
    total: number
    upcoming: number
    showed: number
    noShow: number
    cancelled: number
    agents: Set<string>
    lastBookingAt: Date | null
  }
  const empty = (): Bucket => ({
    total: 0,
    upcoming: 0,
    showed: 0,
    noShow: 0,
    cancelled: 0,
    agents: new Set<string>(),
    lastBookingAt: null,
  })
  const byClient = new Map<string, Bucket>()
  for (const a of appts) {
    if (!a.clientId) continue
    const b = byClient.get(a.clientId) ?? empty()
    b.total++
    if (a.apptDateTime > now) b.upcoming++
    if (a.status === 'showed') b.showed++
    if (a.status === 'no_show') b.noShow++
    if (a.status === 'cancelled') b.cancelled++
    if (a.agentUserId) b.agents.add(a.agentUserId)
    // Track most recent booking by createdAt — that's "when the row
    // landed in the system", which is more meaningful than
    // apptDateTime for an "is this client active?" signal.
    if (!b.lastBookingAt || a.createdAt > b.lastBookingAt) {
      b.lastBookingAt = a.createdAt
    }
    byClient.set(a.clientId, b)
  }

  const result = clients.map((c) => {
    const stats = byClient.get(c.id) ?? empty()
    const completed = stats.showed + stats.noShow
    const showRate = completed > 0 ? Math.round((stats.showed / completed) * 100) : null
    return {
      id: c.id,
      name: c.name,
      state: c.state,
      color: c.color,
      total: stats.total,
      upcoming: stats.upcoming,
      showed: stats.showed,
      noShow: stats.noShow,
      cancelled: stats.cancelled,
      showRate,
      agents: stats.agents.size,
      lastBookingAt: stats.lastBookingAt
        ? stats.lastBookingAt.toISOString()
        : null,
    }
  })

  return NextResponse.json({ clients: result })
}
