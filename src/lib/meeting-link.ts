/**
 * Find the "join" link for a calendar event.
 *
 * Lifted out of the Today page so the Hub and the external CRM API share
 * one implementation. Two copies of this would drift, and the failure
 * mode is silent: a meeting shows a Join button in one app and not the
 * other, with no error anywhere.
 *
 * GHL stores meeting URLs inconsistently — sometimes `meetingUrl`,
 * sometimes buried in `description` or `address` — so this checks the
 * known fields in priority order, then falls back to scanning every
 * string on the event.
 */

export type MeetingLink = {
  url: string
  kind: 'zoom' | 'meet' | 'teams' | 'url' | 'phone'
  label: string
}

type CalEventLike = Record<string, unknown>

export function findMeetingLink(ev: CalEventLike): MeetingLink | null {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null

  // Fields GHL is known to stash URLs in, in rough priority order.
  const fields = [
    str(ev.meetingUrl),
    str(ev.meetingLocation),
    str(ev.appointmentMeetingLocation),
    str(ev.address),
    str(ev.location),
    str(ev.description),
    str(ev.notes),
  ].filter((v): v is string => v !== null)

  // Then any other string on the event, in case it landed somewhere odd.
  for (const v of Object.values(ev)) {
    if (typeof v === 'string' && v.length > 0 && !fields.includes(v)) {
      fields.push(v)
    }
  }

  const urlRe = /https?:\/\/[^\s<>"']+/i
  for (const text of fields) {
    const m = text.match(urlRe)
    if (!m) continue
    // Trailing punctuation is usually prose, not part of the URL.
    const url = m[0].replace(/[.,;)]+$/, '')
    if (/zoom\.us\//i.test(url)) return { url, kind: 'zoom', label: 'Join Zoom' }
    if (/meet\.google\.com\//i.test(url)) {
      return { url, kind: 'meet', label: 'Join Meet' }
    }
    if (/teams\.(microsoft|live)\.com\//i.test(url)) {
      return { url, kind: 'teams', label: 'Join Teams' }
    }
    return { url, kind: 'url', label: 'Join meeting' }
  }

  // No URL — GHL sometimes stores phone appointments with the number in
  // `address` or `meetingLocation`, which is still worth surfacing.
  for (const text of fields) {
    const phone = text.match(/\+?\d[\d\s().-]{8,}\d/)
    if (phone) {
      const digits = phone[0].replace(/[^\d+]/g, '')
      return { url: `tel:${digits}`, kind: 'phone', label: digits }
    }
  }

  return null
}
