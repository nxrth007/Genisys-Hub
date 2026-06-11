import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { fetchVicidialListStats } from '@/lib/vicidial-lists'

/**
 * GET /api/admin/vicidial/lists/[id]
 *
 * Per-list called-count stats ("CALLED COUNTS WITHIN THIS LIST"):
 * status breakdown + grand total. Backs the /leads/[id] detail
 * header. Admin + member. Lib caches 5 minutes per list.
 */
export async function GET(
  _req: NextRequest,
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

  const result = await fetchVicidialListStats(id)
  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
