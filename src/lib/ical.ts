/**
 * iCal feed parser — fetches a Google Calendar secret iCal URL and
 * extracts events into the same shape the Calendar page expects.
 *
 * Minimal VEVENT parser (no external dependency). Handles:
 * - SUMMARY (title), DTSTART/DTEND (times), LOCATION, DESCRIPTION
 * - All-day events (DATE vs DATE-TIME)
 * - Recurring events are NOT expanded — only single/modified instances.
 *   Google's iCal feed pre-expands most recurring events, so this covers
 *   the majority of real-world cases.
 */

type ICalEvent = {
  id: string
  title: string
  startTime: string
  endTime: string
  location?: string
  description?: string
  calendarName: string
  subAccountName: string
}

function parseICalDate(value: string): Date {
  // Format: 20260416T140000Z or 20260416 (all-day)
  const cleaned = value.replace(/[^0-9T]/g, '')
  if (cleaned.length === 8) {
    // All-day: YYYYMMDD
    return new Date(
      `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}T00:00:00`
    )
  }
  // DateTime: YYYYMMDDTHHMMSS
  const iso = `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}T${cleaned.slice(9, 11)}:${cleaned.slice(11, 13)}:${cleaned.slice(13, 15)}Z`
  return new Date(iso)
}

function unfoldLines(raw: string): string[] {
  // iCal spec: lines starting with space/tab are continuations of the previous line
  return raw
    .replace(/\r\n[ \t]/g, '')
    .replace(/\r/g, '')
    .split('\n')
}

export function parseICalFeed(raw: string, calendarName: string, label: string): ICalEvent[] {
  const lines = unfoldLines(raw)
  const events: ICalEvent[] = []
  let inEvent = false
  let current: Partial<ICalEvent> = {}

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true
      current = {}
      continue
    }
    if (line === 'END:VEVENT') {
      inEvent = false
      if (current.startTime) {
        events.push({
          id: current.id || crypto.randomUUID(),
          title: current.title || 'Untitled',
          startTime: current.startTime,
          endTime: current.endTime || current.startTime,
          location: current.location,
          description: current.description,
          calendarName,
          subAccountName: label,
        })
      }
      continue
    }
    if (!inEvent) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).split(';')[0] // strip params like DTSTART;TZID=...
    const value = line.slice(colonIdx + 1).trim()

    switch (key) {
      case 'UID':
        current.id = value
        break
      case 'SUMMARY':
        current.title = value.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\\\/g, '\\')
        break
      case 'DTSTART':
        current.startTime = parseICalDate(value).toISOString()
        break
      case 'DTEND':
        current.endTime = parseICalDate(value).toISOString()
        break
      case 'LOCATION':
        current.location = value.replace(/\\n/g, '\n').replace(/\\,/g, ',')
        break
      case 'DESCRIPTION':
        current.description = value.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\\\/g, '\\')
        break
    }
  }

  return events
}

/**
 * Fetch + parse an iCal URL. Filters to events within a date range.
 */
export async function fetchICalEvents(params: {
  url: string
  calendarName: string
  label: string
  startTime: Date
  endTime: Date
}): Promise<ICalEvent[]> {
  const res = await fetch(params.url, { next: { revalidate: 300 } }) // cache 5min
  if (!res.ok) {
    throw new Error(`Failed to fetch iCal feed (${res.status})`)
  }
  const raw = await res.text()
  const all = parseICalFeed(raw, params.calendarName, params.label)

  // Filter to date range
  const startMs = params.startTime.getTime()
  const endMs = params.endTime.getTime()
  return all.filter((ev) => {
    const evStart = new Date(ev.startTime).getTime()
    return evStart >= startMs && evStart <= endMs
  })
}
