import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { fetchVicidialLists } from '@/lib/vicidial-lists'

/**
 * GET /api/admin/vicidial/lists
 *
 * Parsed Vicidial Lists listing (admin.php?ADD=100 + the leads-
 * counts variant). Backs the /leads overview page. Admin + member,
 * same gate as the Vicidial users mirror. Lib caches 5 minutes.
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

  const result = await fetchVicidialLists()
  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
