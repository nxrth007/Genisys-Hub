import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { fetchVicidialUsers } from '@/lib/vicidial-users'

/**
 * GET /api/admin/vicidial/users
 *
 * Returns the parsed Vicidial Users listing. Backs the
 * /agents/vicidial-users page. Admin + member only — this is
 * cross-system visibility, not something Team #1 members need.
 * The lib's 5-minute cache shields Vicidial from concurrent
 * viewers.
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

  const result = await fetchVicidialUsers()
  return NextResponse.json(result, {
    headers: {
      // Server-side cache is what shields Vicidial; the browser
      // doesn't need its own cache layer on top.
      'Cache-Control': 'no-store',
    },
  })
}
