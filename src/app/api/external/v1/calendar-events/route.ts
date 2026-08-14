import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getEventsAcrossSubAccounts } from '@/lib/ghl'
import { fetchICalEvents } from '@/lib/ical'
import { findMeetingLink } from '@/lib/meeting-link'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/calendar-events?startTime=ISO&endTime=ISO
 *
 * Mirrors the Hub's /api/calendar/events: every GHL sub-account's
 * calendar merged with any iCal feeds, so the CRM's month view shows the
 * same set the Hub does rather than a subset.
 *
 * Normalized here — GHL and iCal disagree on field names, and the Hub's
 * page papers over that in the component. Doing it server-side keeps the
 * frontend from re-deriving the same guesses.
 */

type RawEvent = Record<string, unknown>

export const GET = withExternalApi(async (req, auth) => {
  if (!auth.user) {
    throw new Error('The calendar requires a signed-in account.')
  }

  const params = req.nextUrl.searchParams
  const startTime = params.get('startTime')
  const endTime = params.get('endTime')
  if (!startTime || !endTime) {
    throw new Error('startTime and endTime are required.')
  }

  const startDate = new Date(Number(startTime) || startTime)
  const endDate = new Date(Number(endTime) || endTime)
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new Error('startTime / endTime are not valid dates.')
  }

  const ghlData = await getEventsAcrossSubAccounts(
    startDate.toISOString(),
    endDate.toISOString(),
  )

  // iCal feeds, best-effort: one unreachable feed must not blank the month.
  const icalConnections = await prisma.calendarConnection.findMany({
    where: { provider: 'ical', icalUrl: { not: null } },
  })
  const icalEvents: RawEvent[] = []
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
        for (const e of events as RawEvent[]) {
          icalEvents.push({ ...e, __source: conn.label, __sub: `ical-${conn.id}` })
        }
      } catch (err) {
        console.warn(`[external-calendar] iCal "${conn.label}" failed:`, err)
      }
    }),
  )

  const pick = (e: RawEvent, keys: string[]): string | null => {
    for (const k of keys) {
      const v = e[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return null
  }

  const normalize = (e: RawEvent) => {
    const link = findMeetingLink(e)
    return {
      id: String(e.id ?? e.uid ?? `${pick(e, ['startTime', 'start'])}-${pick(e, ['title', 'summary'])}`),
      title:
        pick(e, ['title', 'summary', 'name', 'appointmentTitle']) ??
        'Untitled',
      startTime: pick(e, ['startTime', 'start', 'startDate']),
      endTime: pick(e, ['endTime', 'end', 'endDate']),
      contactName: pick(e, ['contactName', 'fullName']),
      status: pick(e, ['appointmentStatus', 'status']),
      subAccount:
        pick(e, ['__sub', 'vaultName', 'subAccount']) ?? null,
      subAccountName:
        pick(e, ['__source', 'locationName', 'calendarName']) ?? null,
      joinUrl: link?.url ?? null,
      joinKind: link?.kind ?? null,
      joinLabel: link?.label ?? null,
    }
  }

  const events = [...(ghlData.events as RawEvent[]), ...icalEvents]
    .map(normalize)
    .filter((e) => e.startTime)
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))

  const subAccounts = [
    ...ghlData.subAccounts.map((s) => ({
      id: s.vaultName,
      name: s.locationName,
    })),
    ...icalConnections.map((c) => ({ id: `ical-${c.id}`, name: c.label })),
  ]

  return { events, subAccounts }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
