import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getTodayEvents } from '@/lib/ghl'

/**
 * GET /api/today/calendar
 * Returns today's calendar events from the Genisys GHL sub-account.
 * Later: merge with Trustware Google Calendar events.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const data = await getTodayEvents('GHL Genisys Token')
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch calendar'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
