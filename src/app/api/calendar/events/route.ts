import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getEventsAcrossSubAccounts } from '@/lib/ghl'
import { fetchICalEvents } from '@/lib/ical'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/calendar/events?startTime=...&endTime=...
 * Merges:
 *   1. GHL events from all sub-accounts
 *   2. iCal feed events from CalendarConnection rows
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
      { error: 'startTime and endTime are required' },
      { status: 400 }
    )
  }

  const startDate = new Date(Number(startTime) || startTime)
  const endDate = new Date(Number(endTime) || endTime)

  try {
    // 1. GHL events (existing)
    const ghlData = await getEventsAcrossSubAccounts(
      startDate.toISOString(),
      endDate.toISOString()
    )

    // 2. iCal feed events
    const icalConnections = await prisma.calendarConnection.findMany({
      where: { provider: 'ical', icalUrl: { not: null } },
    })

    const icalEvents: Array<Record<string, unknown>> = []
    await Promise.all(
      icalConnections.map(async (conn) => {
        if (!conn.icalUrl) return
        try {
          const events = await fetchICalEvents({
            url: conn.icalUrl,
            calendarName: conn.label,
            label: conn.label,
            startTime: startDate,
            endTime: endDate,
          })
          for (const ev of events) {
            icalEvents.push({
              ...ev,
              vaultName: `ical-${conn.id}`, // unique key for filtering
            })
          }
        } catch (err) {
          console.warn(`[calendar] iCal fetch failed for "${conn.label}":`, err)
        }
      })
    )

    // Merge and sort
    const allEvents = [...ghlData.events, ...icalEvents]
    allEvents.sort((a, b) => {
      const da = new Date(String(a.startTime || '1970-01-01')).getTime()
      const db = new Date(String(b.startTime || '1970-01-01')).getTime()
      return da - db
    })

    // Build combined sub-account list for filter chips
    const subAccounts = [
      ...ghlData.subAccounts,
      ...icalConnections.map((c) => ({
        vaultName: `ical-${c.id}`,
        locationId: c.id,
        locationName: c.label,
      })),
    ]

    return NextResponse.json({ events: allEvents, subAccounts })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch events'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
