import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getTodayEvents, getCalendarEventsInRange } from '@/lib/ghl'

/**
 * GET /api/today/calendar
 * GET /api/today/calendar?start=ISO&end=ISO
 *
 * Returns calendar events from the Genisys GHL sub-account.
 *
 * Without query params: today only (in the signed-in user's timezone).
 * With start + end: events whose startTime falls in that range —
 * powers the Today page's calendar pill so picking "Weekly" /
 * "Monthly" / a custom range pulls events for that span instead of
 * the same hard-coded today window.
 *
 * "Today" is computed in the user's timezone (User.timezone), not the
 * server's, so the window doesn't roll over at 8 PM Eastern.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { timezone: true },
    })
    const timeZone = user?.timezone || 'America/New_York'

    const start = req.nextUrl.searchParams.get('start')
    const end = req.nextUrl.searchParams.get('end')

    let data
    if (start && end) {
      const startMs = Date.parse(start)
      const endMs = Date.parse(end)
      if (isNaN(startMs) || isNaN(endMs) || endMs < startMs) {
        return NextResponse.json(
          { error: 'invalid start / end ISO timestamps' },
          { status: 400 },
        )
      }
      data = await getCalendarEventsInRange('GHL Genisys Token', {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      })
    } else {
      // Backward-compat — today only, same behavior as before.
      data = await getTodayEvents('GHL Genisys Token', { timeZone })
    }
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch calendar'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
