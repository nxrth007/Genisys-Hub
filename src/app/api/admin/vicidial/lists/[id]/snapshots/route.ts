import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { ensureTodaySnapshot } from '@/lib/vicidial-snapshots'

/**
 * GET /api/admin/vicidial/lists/[id]/snapshots?days=60
 *
 * Burn-down history for one list — daily (snapshotDay, total,
 * newCount) rows, oldest first, ready for charting. Lazily writes
 * today's snapshot if the daily scheduler tick hasn't fired yet
 * (fresh deploys / restarts), so the first view of a list always
 * has at least one data point.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'invalid list id' }, { status: 400 })
  }
  const days = Math.min(
    365,
    Math.max(1, parseInt(req.nextUrl.searchParams.get('days') || '60', 10) || 60),
  )

  // Best-effort: make sure today exists before reading. Failure is
  // non-fatal (dialer hiccup) — history still returns.
  try {
    await ensureTodaySnapshot(id)
  } catch (err) {
    console.error(`[snapshots] ensureToday failed for list ${id}:`, err)
  }

  const rows = await prisma.vicidialListSnapshot.findMany({
    where: { listId: id },
    orderBy: { snapshotDay: 'desc' },
    take: days,
    select: {
      snapshotDay: true,
      total: true,
      newCount: true,
      createdAt: true,
    },
  })

  return NextResponse.json(
    { ok: true, listId: id, snapshots: rows.reverse() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
