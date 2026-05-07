import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { computeFollowUps } from '@/lib/follow-ups'

/**
 * GET /api/follow-ups
 *
 * Returns the bucketed follow-up landscape for the calling user.
 * Staff-only (admin / member). The dismissal filter is per-user, so
 * Alex marking a thread handled doesn't hide it from Ethan and vice
 * versa.
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

  try {
    const data = await computeFollowUps(session.user.id)
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute follow-ups'
    console.error('[follow-ups] compute failed:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
