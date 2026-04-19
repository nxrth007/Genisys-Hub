import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { findConflicts } from '@/lib/appointment-conflicts'

/**
 * GET /api/agent/appointments/conflicts?at=<iso>&exclude=<id?>&duration=<min?>
 *
 * Returns every appointment that overlaps with the proposed time across
 * all agents (the customer-facing calendar is shared). Used by the agent
 * form to warn before a booking is submitted. Accessible to agents and
 * staff — middleware has already authenticated the session.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const at = sp.get('at')
  const exclude = sp.get('exclude') || undefined
  const duration = sp.get('duration')

  if (!at) {
    return NextResponse.json({ error: 'at (ISO datetime) required' }, { status: 400 })
  }
  const apptDateTime = new Date(at)
  if (isNaN(apptDateTime.getTime())) {
    return NextResponse.json({ error: 'invalid at' }, { status: 400 })
  }

  const conflicts = await findConflicts({
    apptDateTime,
    excludeId: exclude,
    durationMinutes: duration ? Number(duration) : undefined,
  })

  return NextResponse.json({ conflicts })
}
