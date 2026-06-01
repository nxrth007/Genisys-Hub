import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/status-updates/summary
 *
 * Lightweight count endpoint used by the Call Center tabs nav to
 * render the red-dot "you have N unreviewed updates" badge. Kept
 * deliberately separate from the full /status-updates list so the
 * badge poll doesn't pull a multi-KB response every 60 seconds.
 *
 * Returns the count of appointments where the client posted an
 * update AND no admin has marked it reviewed. Scoped to active
 * clients only — archived/inactive clients shouldn't keep dripping
 * red dots forever.
 *
 * Cache-Control: 30 seconds. The tabs nav polls on a 60s interval;
 * a 30s server hint lets browser tabs / proxies dedup without
 * making the badge feel stale.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const unreviewed = await prisma.appointment.count({
    where: {
      clientStatusUpdatedAt: { not: null },
      clientStatusReviewedAt: null,
      client: { active: true },
    },
  })

  return NextResponse.json(
    { unreviewed },
    {
      headers: {
        // Short-cache the badge — 30s on the browser side, no
        // shared cache (every admin should get their own count).
        'Cache-Control': 'private, max-age=30',
      },
    },
  )
}
