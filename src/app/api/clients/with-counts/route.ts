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
        status: true,
      },
    }),
  ])

  type Bucket = {
    total: number
    upcoming: number
    showed: number
    noShow: number
    cancelled: number
  }
  const empty = (): Bucket => ({
    total: 0,
    upcoming: 0,
    showed: 0,
    noShow: 0,
    cancelled: 0,
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
    byClient.set(a.clientId, b)
  }

  const result = clients.map((c) => {
    const stats = byClient.get(c.id) ?? empty()
    // Show-rate % over completed (showed + no_show); null when nobody
    // has reached that bucket yet so the UI can render "—" instead
    // of a misleading 0%.
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
    }
  })

  return NextResponse.json({ clients: result })
}
