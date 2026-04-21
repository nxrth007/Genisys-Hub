import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getTodayEvents } from '@/lib/ghl'

/**
 * GET /api/today/calendar
 * Returns today's calendar events from the Genisys GHL sub-account.
 * Later: merge with Trustware Google Calendar events.
 *
 * "Today" is computed in the signed-in user's timezone (User.timezone),
 * not the server's — Render is UTC, so without this the window rolls over
 * at 8 PM Eastern and you'd start seeing tomorrow's meetings mixed in.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { timezone: true },
    })
    const data = await getTodayEvents('GHL Genisys Token', {
      timeZone: user?.timezone || 'America/New_York',
    })
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch calendar'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
