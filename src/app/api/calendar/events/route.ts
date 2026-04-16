import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getEventsAcrossSubAccounts } from '@/lib/ghl'

/**
 * GET /api/calendar/events?startTime=ISO&endTime=ISO
 * Fetches events in a date range across all GHL sub-accounts.
 * Results are tagged with the sub-account name so the UI can color-code.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const startTime = req.nextUrl.searchParams.get('startTime')
  const endTime = req.nextUrl.searchParams.get('endTime')

  if (!startTime || !endTime) {
    return NextResponse.json(
      { error: 'startTime and endTime are required (ISO format)' },
      { status: 400 }
    )
  }

  try {
    const data = await getEventsAcrossSubAccounts(startTime, endTime)
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch events'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
