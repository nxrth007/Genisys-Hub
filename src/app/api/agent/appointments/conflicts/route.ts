import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { findConflicts } from '@/lib/appointment-conflicts'

/**
 * GET /api/agent/appointments/conflicts?at=<iso>&clientId=<id>&exclude=<id?>&duration=<min?>
 *
 * Returns appointments that overlap with the proposed time for the given
 * client. Conflicts are scoped per-client because each client has its
 * own closer / pipeline. Used by the agent form to warn before a booking
 * is submitted. Accessible to agents and staff — middleware has already
 * authenticated the session.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const at = sp.get('at')
  const clientId = sp.get('clientId')
  const exclude = sp.get('exclude') || undefined
  const duration = sp.get('duration')

  if (!at) {
    return NextResponse.json({ error: 'at (ISO datetime) required' }, { status: 400 })
  }
  if (!clientId) {
    return NextResponse.json({ error: 'clientId required' }, { status: 400 })
  }
  const apptDateTime = new Date(at)
  if (isNaN(apptDateTime.getTime())) {
    return NextResponse.json({ error: 'invalid at' }, { status: 400 })
  }

  const conflicts = await findConflicts({
    apptDateTime,
    clientId,
    excludeId: exclude,
    durationMinutes: duration ? Number(duration) : undefined,
  })

  return NextResponse.json({ conflicts })
}
