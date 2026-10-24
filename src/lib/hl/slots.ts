import { fromZonedTime, formatInTimeZone } from 'date-fns-tz'
import { limitOf, minutesOf, type HlCalendarSettings, type HlHours } from './calendar-shared'

/**
 * Open booking slots, GoHighLevel's way: the calendar's weekly hours (or a
 * date's own hours), cut into slots of `slotDuration` starting every
 * `slotInterval`, between the minimum notice and how far ahead booking is
 * open; a slot is free when some team member (or the calendar itself, with
 * no team) has room in it, counting each appointment's buffers, the
 * per-slot and per-day caps, and the member's appointments on other
 * calendars. "Look busy" then hides a steady share of what's left.
 *
 * Pure (no database): src/lib/hl/booking.ts feeds it.
 */

export type Busy = {
  start: Date
  end: Date
  /** Team member it's with (null: no one in particular). */
  member: string | null
  /** The calendar it's on (only this calendar's count toward the per-day cap). */
  calendarId: string | null
}

/** A member's own hours (their schedule) and the timezone they're in. */
export type MemberHours = { hours: Pick<HlCalendarSettings, 'openHours' | 'availabilities'>; timezone: string }

export type SlotInput = {
  calendarId: string
  settings: HlCalendarSettings
  timezone: string
  now: Date
  from: Date
  to: Date
  /** Team member keys, in the calendar's team order. Empty: the calendar is one resource. */
  members: string[]
  busy: Busy[]
  /** Members whose schedule sets their hours on this calendar; the rest keep the calendar's hours. */
  memberHours?: Map<string, MemberHours>
  /** Collective booking: a slot is open only when every member is free. */
  collective?: boolean
  /** The length the booker picked (minutes), instead of the calendar's own. */
  duration?: number
  /** Staff booking from the calendar: the public page's minimum notice, booking window and "look busy" don't apply. */
  staff?: boolean
}

export type Slot = { start: Date; end: Date; members: string[] }

export type Rules = {
  duration: number
  interval: number
  pre: number
  post: number
  notice: number
  ahead: number | null
  perSlot: number
  perDay: number | null
  lookBusy: number
}

const MIN = 60_000
const DAY = 86_400_000

export function rulesOf(s: HlCalendarSettings, picked?: number): Rules {
  const duration = picked && picked >= 5 ? picked : Math.max(5, minutesOf(s.slotDuration, s.slotDurationUnit, 30))
  const look = s.lookBusyConfig?.enabled ? Math.min(90, Math.max(0, Number(s.lookBusyConfig.lookBusyPercentage) || 0)) : 0
  return {
    duration,
    interval: Math.max(5, minutesOf(s.slotInterval, s.slotIntervalUnit, duration) || duration),
    pre: minutesOf(s.preBuffer, s.preBufferUnit, 0),
    post: minutesOf(s.slotBuffer, s.slotBufferUnit, 0),
    notice: minutesOf(s.allowBookingAfter, s.allowBookingAfterUnit, 0),
    ahead: limitOf(s.allowBookingFor) ? minutesOf(s.allowBookingFor, s.allowBookingForUnit ?? 'days', 0) : null,
    perSlot: limitOf(s.appointmentPerSlot) ?? 1,
    perDay: limitOf(s.appointmentPerDay),
    lookBusy: look,
  }
}

/** YYYY-MM-DD dates from a to b inclusive. */
function datesBetween(a: string, b: string): string[] {
  const out: string[] = []
  const [y, m, d] = a.split('-').map(Number)
  for (let t = Date.UTC(y, m - 1, d), i = 0; i < 800; i++, t += 86_400_000) {
    const s = new Date(t).toISOString().slice(0, 10)
    if (s > b) break
    out.push(s)
  }
  return out
}

const weekday = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The hours a date is open: its own (a date override) or its weekday's. */
export function hoursOn(date: string, s: Pick<HlCalendarSettings, 'openHours' | 'availabilities'>): HlHours[] {
  const own = (s.availabilities ?? []).find((a) => !a.deleted && String(a.date).slice(0, 10) === date)
  if (own) return own.hours ?? []
  const day = weekday(date)
  return (s.openHours ?? []).filter((o) => (o.daysOfTheWeek ?? []).includes(day)).flatMap((o) => o.hours ?? [])
}

/** "2026-10-28" + 9:30 in the zone → the instant. */
const at = (date: string, minutes: number, tz: string) => fromZonedTime(`${date} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`, tz)

/** FNV-1a: the same slot is always hidden (or not) by "look busy". */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Where slots can start in some hours: each open range cut every `interval`, with the slot fitting inside. */
function startsIn(hours: Pick<HlCalendarSettings, 'openHours' | 'availabilities'>, tz: string, from: Date, to: Date, r: Rules): number[] {
  const out: number[] = []
  // A day either side: a member in another timezone can be open on a neighbouring date.
  const first = formatInTimeZone(new Date(from.getTime() - DAY), tz, 'yyyy-MM-dd')
  const last = formatInTimeZone(new Date(to.getTime() + DAY), tz, 'yyyy-MM-dd')
  for (const date of datesBetween(first, last)) {
    for (const h of hoursOn(date, hours)) {
      const open = (h.openHour ?? 0) * 60 + (h.openMinute ?? 0)
      let close = (h.closeHour ?? 0) * 60 + (h.closeMinute ?? 0)
      if (close <= open) close = 24 * 60 // "until midnight"
      for (let m = open; m + r.duration <= close; m += r.interval) out.push(at(date, m, tz).getTime())
    }
  }
  return out
}

export function computeSlots(o: SlotInput): Slot[] {
  const r = rulesOf(o.settings, o.duration)
  const earliest = o.staff ? -Infinity : o.now.getTime() + r.notice * MIN
  const latest = !o.staff && r.ahead !== null ? o.now.getTime() + r.ahead * MIN : Infinity
  const resources = o.members.length ? o.members : ['']

  // Who has hours when: a member's own schedule, or the calendar's hours.
  const open = new Map<number, string[]>()
  for (const k of resources) {
    const own = k ? o.memberHours?.get(k) : undefined
    for (const t of startsIn(own?.hours ?? o.settings, own?.timezone ?? o.timezone, o.from, o.to, r)) {
      if (t < earliest || t > latest || t < o.from.getTime() || t >= o.to.getTime()) continue
      const list = open.get(t)
      if (!list) open.set(t, [k])
      else if (!list.includes(k)) list.push(k)
    }
  }

  // Each resource's appointments on this calendar per day, in the calendar's timezone (the per-day cap).
  const dayCount = new Map<string, number>()
  if (r.perDay !== null) {
    for (const b of o.busy) {
      if (b.calendarId !== o.calendarId) continue
      const k = `${o.members.length ? (b.member ?? '') : ''}|${formatInTimeZone(b.start, o.timezone, 'yyyy-MM-dd')}`
      dayCount.set(k, (dayCount.get(k) ?? 0) + 1)
    }
  }

  const slots: Slot[] = []
  for (const t of [...open.keys()].sort((a, b) => a - b)) {
    const start = new Date(t)
    const end = new Date(t + r.duration * MIN)
    // Who's free: room left in the slot (buffers around every appointment), under the day's cap.
    const lo = t - r.post * MIN
    const hi = end.getTime() + r.pre * MIN
    const overlapping = o.busy.filter((b) => b.start.getTime() < hi && b.end.getTime() > lo)
    // With a team: a member's own appointments (any calendar). Without: everything on this calendar.
    const usedBy = (k: string) => (k === '' ? overlapping.filter((b) => b.calendarId === o.calendarId).length : overlapping.filter((b) => b.member === k).length)
    const unassigned = o.members.length ? overlapping.filter((b) => b.calendarId === o.calendarId && (b.member === null || !o.members.includes(b.member))).length : 0
    const date = formatInTimeZone(start, o.timezone, 'yyyy-MM-dd')
    const free = open.get(t)!.filter((k) => usedBy(k) < r.perSlot && (r.perDay === null || (dayCount.get(`${k}|${date}`) ?? 0) < r.perDay))
    if (o.collective && o.members.length && free.length < o.members.length) continue
    // Appointments on this calendar with no one in particular take a place from someone.
    const places = o.members.length ? free.length - unassigned : free.length
    if (places <= 0) continue
    if (!o.staff && r.lookBusy && hash(`${o.calendarId}|${t}`) % 100 < r.lookBusy) continue
    slots.push({ start, end, members: free.filter((k) => k !== '') })
  }
  return slots
}

/**
 * Who gets a round-robin booking: GHL's "optimize for availability" goes by
 * priority then by who has fewer bookings lately; "equal distribution" by
 * fewer bookings first.
 */
export function pickMember(
  free: string[],
  o: { priority: Map<string, number>; recent: Map<string, number>; equal: boolean; order: string[] },
): string | null {
  if (!free.length) return null
  return [...free].sort((a, b) => {
    const pa = o.priority.get(a) ?? 0.5
    const pb = o.priority.get(b) ?? 0.5
    const ra = o.recent.get(a) ?? 0
    const rb = o.recent.get(b) ?? 0
    const byPriority = pb - pa
    const byLoad = ra - rb
    const first = o.equal ? byLoad || byPriority : byPriority || byLoad
    return first || o.order.indexOf(a) - o.order.indexOf(b)
  })[0]
}
