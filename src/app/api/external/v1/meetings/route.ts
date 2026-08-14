import { NextRequest } from 'next/server'
import { getCalendarEventsInRange, getTodayEvents } from '@/lib/ghl'
import { findMeetingLink } from '@/lib/meeting-link'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/meetings?start=ISO&end=ISO
 *
 * Booked calendar meetings from the Genisys GHL sub-account, each with a
 * join link where one can be found. This is what backs "Next up" — a
 * different thing from /calendar, which lists Appointment rows.
 *
 * Worth keeping straight, because the two look similar and aren't:
 *   Appointment = a homeowner sitdown an agent booked into the tracker
 *   calendar event = a meeting on the GHL calendar, which may have a
 *                    Zoom/Meet/Teams link attached
 */

type RawEvent = Record<string, unknown>

export const GET = withExternalApi(async (req, auth) => {
  if (!auth.user) {
    throw new Error('Meetings require a signed-in account.')
  }

  const params = req.nextUrl.searchParams
  const start = params.get('start')
  const end = params.get('end')

  let payload: unknown
  if (start && end) {
    const s = Date.parse(start)
    const e = Date.parse(end)
    if (isNaN(s) || isNaN(e) || e < s) {
      throw new Error('Invalid start / end timestamps.')
    }
    payload = await getCalendarEventsInRange('GHL Genisys Token', {
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
    })
  } else {
    payload = await getTodayEvents('GHL Genisys Token', {
      timeZone: params.get('tz') || 'America/New_York',
    })
  }

  // GHL returns events under a few different keys depending on endpoint.
  const p = payload as Record<string, unknown>
  const raw: RawEvent[] = Array.isArray(p?.events)
    ? (p.events as RawEvent[])
    : Array.isArray(p)
      ? (p as RawEvent[])
      : Array.isArray(p?.appointments)
        ? (p.appointments as RawEvent[])
        : []

  const pick = (e: RawEvent, keys: string[]): string | null => {
    for (const k of keys) {
      const v = e[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return null
  }

  const meetings = raw
    .map((e) => {
      const link = findMeetingLink(e)
      return {
        id: String(e.id ?? ''),
        title:
          pick(e, ['title', 'name', 'appointmentTitle']) ?? 'Untitled meeting',
        startTime: pick(e, ['startTime', 'start', 'startDate']),
        endTime: pick(e, ['endTime', 'end', 'endDate']),
        contactName: pick(e, ['contactName', 'fullName', 'contact']),
        calendarName: pick(e, ['calendarName', 'calendar']),
        status: pick(e, ['appointmentStatus', 'status']),
        joinUrl: link?.url ?? null,
        joinKind: link?.kind ?? null,
        joinLabel: link?.label ?? null,
      }
    })
    .filter((m) => m.startTime)
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))

  return { meetings }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
