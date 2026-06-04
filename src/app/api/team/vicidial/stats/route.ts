import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { fetchVicidialStats } from '@/lib/vicidial-stats'

/**
 * GET /api/team/vicidial/stats
 *
 * Backs /team/live-report. Returns a stable JSON shape (see
 * VicidialStatsResult in lib/vicidial-stats.ts) the page polls every
 * 60s. The helper caches for 55s server-side so even with multiple
 * concurrent viewers we hit Vicidial at most once per minute.
 *
 * Role gate: team_member (their dashboard), admin + member
 * (supervisors). Mary (role=agent) is deliberately excluded — she
 * has her own surfaces. Path under /api/team/* so middleware permits
 * team_member access.
 */

const ALLOWED_ROLES = new Set(['team_member', 'admin', 'member'])

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const result = await fetchVicidialStats()
  // Always return 200 with the shape — failures get { ok: false }
  // so the UI can render a "Live data unavailable" banner without
  // any try/catch on its side. Status 503 would be the strict
  // alternative but it complicates React Query error handling for
  // no real benefit.
  return NextResponse.json(result, {
    headers: {
      // Tell the browser not to cache — server-side cache is what
      // shields Vicidial; browser cache would just stale the UI.
      'Cache-Control': 'no-store',
    },
  })
}
