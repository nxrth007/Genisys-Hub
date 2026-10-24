import { DEFAULT_CONSENTS } from './templates'
import type { HlConsentBox } from './types'

/**
 * A booking calendar's settings, in GoHighLevel's own field names (what GHL's
 * API returns and the import keeps), so imported calendars book as they did
 * in GHL. A few Hell-level additions sit at the end. Client-safe: the
 * settings editor and the engine (src/lib/hl/slots.ts) read the same shape.
 */

export type HlHours = { openHour: number; openMinute: number; closeHour: number; closeMinute: number }
/** daysOfTheWeek: 0 = Sunday … 6 = Saturday. */
export type HlOpenHours = { daysOfTheWeek: number[]; hours: HlHours[] }
/** A date with its own hours (none = closed that day). `date` is YYYY-MM-DD or GHL's ISO midnight. */
export type HlDateOverride = { date: string; hours: HlHours[]; deleted?: boolean }
export type HlTeamMember = {
  /** GHL user id (imported calendars) or the staff record's id. */
  userId: string
  /** GHL's round-robin priority: 1 high, 0.5 medium, 0 low. */
  priority?: number
  selected?: boolean
  isPrimary?: boolean
  meetingLocation?: string
}
export type TimeUnit = 'mins' | 'hours' | 'days' | 'weeks' | 'months'

export type HlCalendarSettings = {
  calendarType?: string
  eventType?: 'RoundRobin_OptimizeForAvailability' | 'RoundRobin_OptimizeForEqualDistribution'
  teamMembers?: HlTeamMember[]
  openHours?: HlOpenHours[]
  availabilities?: HlDateOverride[]
  slotDuration?: number
  slotDurationUnit?: TimeUnit
  /** How often a slot starts (default: the slot length). */
  slotInterval?: number
  slotIntervalUnit?: TimeUnit
  /** Blocked after each appointment. */
  slotBuffer?: number
  slotBufferUnit?: TimeUnit
  /** Blocked before each appointment. */
  preBuffer?: number
  preBufferUnit?: TimeUnit
  /** Minimum notice. */
  allowBookingAfter?: number
  allowBookingAfterUnit?: TimeUnit
  /** How far ahead people can book. */
  allowBookingFor?: number
  allowBookingForUnit?: TimeUnit
  appointmentPerSlot?: number | string
  appointmentPerDay?: number | string
  /** Hides this share of open slots so the calendar looks busy. */
  lookBusyConfig?: { enabled?: boolean; lookBusyPercentage?: number }
  autoConfirm?: boolean
  allowReschedule?: boolean
  allowCancellation?: boolean
  /** The appointment's title; {{contact.name}} works. */
  eventTitle?: string
  eventColor?: string
  description?: string
  formSubmitType?: 'ThankYouMessage' | 'RedirectURL'
  formSubmitThanksMessage?: string
  formSubmitRedirectUrl?: string
  /** The calendar group it's in (a group's key: its GHL id or its own). */
  groupId?: string
  /** Lengths the booker can choose from; the one marked default is slotDuration. */
  durationOptions?: HlDurationOption[]
  /** What the appointment's notes say (calendar invites); {{reschedule_link}} and {{cancellation_link}} work. */
  notes?: string
  /** Keep the details of someone who booked before filled in on the booking page. */
  stickyContact?: boolean
  /** A Facebook pixel fired on the booking page. */
  pixelId?: string
  // --- Hell-level's own ---
  /** The calendar's own notifications (GHL's Notifications tab). GHL's imported `notifications` are its older email switches, kept as they were. */
  hlNotifications?: HlNotification[]
  /** Where it happens when no team member has their own: an address, a phone number, a meeting link. */
  meetingLocation?: string
  /** The booking form's consent boxes (default: the two every form gets). */
  consents?: HlConsentBox[]
  askEmail?: boolean
  requireEmail?: boolean
  askNotes?: boolean
  /** Booking page accent colour. */
  widgetColor?: string
}

const MINUTES: Record<TimeUnit, number> = { mins: 1, hours: 60, days: 1440, weeks: 10080, months: 43200 }

export function minutesOf(n: unknown, unit: unknown, fallback: number): number {
  const v = typeof n === 'number' ? n : typeof n === 'string' && n.trim() ? Number(n) : NaN
  if (!Number.isFinite(v) || v < 0) return fallback
  return v * (MINUTES[unit as TimeUnit] ?? 1)
}

/** A count setting ("" or 0 = no limit). */
export function limitOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

export const asCalendarSettings = (v: unknown): HlCalendarSettings => (v && typeof v === 'object' && !Array.isArray(v) ? (v as HlCalendarSettings) : {})

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export type HlDurationOption = { duration: number; durationUnit: TimeUnit; isDefault?: boolean; order?: number }

/**
 * A calendar notification: a text to the contact, or a text or email to the
 * team member, when an appointment is booked, rescheduled or cancelled, a
 * reminder `minutes` before it starts, or a follow-up `minutes` after it ends.
 */
export type HlNotification = {
  id: string
  on: 'booked' | 'rescheduled' | 'cancelled' | 'reminder' | 'followup'
  to: 'contact' | 'member'
  channel: 'sms' | 'email'
  minutes?: number
  subject?: string
  body: string
  enabled: boolean
}

export const NOTIFICATION_EVENTS: { key: HlNotification['on']; label: string }[] = [
  { key: 'booked', label: 'Booked' },
  { key: 'rescheduled', label: 'Rescheduled' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'reminder', label: 'Reminder' },
  { key: 'followup', label: 'Follow-up' },
]

/** GHL's usual set, in Hell-level's words: confirmations, two reminders, the team's heads-up. */
export const NOTIFICATION_PRESETS: (Omit<HlNotification, 'id' | 'enabled'> & { label: string })[] = [
  { label: 'Confirmation text to the contact', on: 'booked', to: 'contact', channel: 'sms', body: 'Hi {{contact.first_name}}, you’re booked with {{account.business_name}} for {{appointment.start_time}}. Need to change it? {{appointment.reschedule_link}}' },
  { label: 'Reminder text a day before', on: 'reminder', to: 'contact', channel: 'sms', minutes: 1440, body: 'Reminder: {{account.business_name}} tomorrow, {{appointment.start_time}}. Need a different time? {{appointment.reschedule_link}}' },
  { label: 'Reminder text an hour before', on: 'reminder', to: 'contact', channel: 'sms', minutes: 60, body: 'See you soon, {{contact.first_name}}! {{account.business_name}} at {{appointment.time}}.' },
  { label: 'Rescheduled text to the contact', on: 'rescheduled', to: 'contact', channel: 'sms', body: 'Your appointment with {{account.business_name}} is now {{appointment.start_time}}.' },
  { label: 'Cancelled text to the contact', on: 'cancelled', to: 'contact', channel: 'sms', body: 'Your appointment with {{account.business_name}} on {{appointment.start_time}} is cancelled. Book another time: {{appointment.booking_link}}' },
  { label: 'Follow-up text after', on: 'followup', to: 'contact', channel: 'sms', minutes: 60, body: 'Thanks for your time today, {{contact.first_name}}! Any questions, just reply here. – {{account.business_name}}' },
  { label: 'New booking text to the team member', on: 'booked', to: 'member', channel: 'sms', body: 'New booking: {{contact.name}} {{contact.phone}}, {{appointment.calendar_name}}, {{appointment.start_time}}.' },
  { label: 'New booking email to the team member', on: 'booked', to: 'member', channel: 'email', subject: 'New booking: {{contact.name}}', body: '{{contact.name}} ({{contact.phone}}, {{contact.email}}) booked {{appointment.calendar_name}} for {{appointment.start_time}}.' },
  { label: 'Cancellation text to the team member', on: 'cancelled', to: 'member', channel: 'sms', body: 'Cancelled: {{contact.name}}, {{appointment.calendar_name}}, {{appointment.start_time}}.' },
]

/** The lengths a booker can pick, in minutes, default first (just the slot length when there's no choice). */
export function durationsOf(s: HlCalendarSettings): number[] {
  const base = minutesOf(s.slotDuration, s.slotDurationUnit, 30)
  const opts = (Array.isArray(s.durationOptions) ? s.durationOptions : [])
    .map((o) => ({ m: minutesOf(o.duration, o.durationUnit, 0), d: o.isDefault === true }))
    .filter((o) => o.m >= 5 && o.m <= 720)
  const list = [...new Set([base, ...opts.filter((o) => o.d).map((o) => o.m), ...opts.map((o) => o.m)])]
  return list.length ? list : [base]
}

/** GHL's calendar types, in its picker's order. */
export const CALENDAR_TYPES = [
  { key: 'personal', label: 'Personal booking', what: 'One-on-one meetings with one team member.', example: 'Client meetings, private consultations' },
  { key: 'round_robin', label: 'Round robin', what: 'Shares bookings among the team in turn.', example: 'Sales calls, onboarding sessions' },
  { key: 'class_booking', label: 'Class booking', what: 'One host, many people in the same slot.', example: 'Webinars, group training, classes' },
  { key: 'collective', label: 'Collective booking', what: 'Several hosts meet one person: a slot is open only when they’re all free.', example: 'Panel interviews, reviews' },
  { key: 'event', label: 'Event calendar', what: 'Seats at a time with no host.', example: 'Seminars, open houses, expos' },
  { key: 'service_booking', label: 'Service booking', what: 'Booking by service, for service businesses.', example: 'Repairs, appointments, consultations' },
] as const
export type CalendarType = (typeof CALENDAR_TYPES)[number]['key']
export const calendarTypeLabel = (k: string | null | undefined) => CALENDAR_TYPES.find((t) => t.key === k)?.label ?? 'Round robin'

/** A calendar group (GHL's Groups): a shared booking page listing its calendars. */
export type HlCalendarGroup = { id: string; key: string; name: string; description: string; slug: string; isActive: boolean; ghlId: string | null }

/**
 * A team member's schedule (GHL's Availability → Schedules): weekly hours and
 * date-specific hours, in its own timezone, that set the member's hours on
 * the calendars it's active on (instead of the calendar's own hours).
 */
export type HlSchedule = {
  id: string
  /** The staff member: a calendar's teamMembers[].userId (GHL user id or staff record id). */
  userId: string
  name: string
  timezone: string
  isDefault: boolean
  openHours: HlOpenHours[]
  availabilities: HlDateOverride[]
  calendarIds: string[]
}

/** GHL's calendar Preferences: the sub-account's (Account preference) and each user's (My preference). */
export type HlCalendarPrefs = {
  weekStartsOn: number
  timeFormat: '12h' | '24h'
  widgetLanguage: string
  services: { serviceMenu: boolean; rooms: boolean; equipment: boolean }
  /** By the Hub user's email. */
  users: Record<string, { meetingLocation?: string; timezone?: string }>
}

export const defaultCalendarPrefs = (): HlCalendarPrefs => ({ weekStartsOn: 0, timeFormat: '12h', widgetLanguage: 'en', services: { serviceMenu: false, rooms: false, equipment: false }, users: {} })

const nineToFive: HlHours[] = [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]

export function defaultCalendarSettings(): HlCalendarSettings {
  return {
    calendarType: 'round_robin',
    eventType: 'RoundRobin_OptimizeForAvailability',
    teamMembers: [],
    openHours: [1, 2, 3, 4, 5].map((d) => ({ daysOfTheWeek: [d], hours: nineToFive })),
    availabilities: [],
    slotDuration: 30,
    slotDurationUnit: 'mins',
    slotInterval: 30,
    slotIntervalUnit: 'mins',
    slotBuffer: 0,
    slotBufferUnit: 'mins',
    preBuffer: 0,
    preBufferUnit: 'mins',
    allowBookingAfter: 2,
    allowBookingAfterUnit: 'hours',
    allowBookingFor: 30,
    allowBookingForUnit: 'days',
    appointmentPerSlot: 1,
    appointmentPerDay: '',
    lookBusyConfig: { enabled: false, lookBusyPercentage: 0 },
    autoConfirm: true,
    allowReschedule: true,
    allowCancellation: true,
    eventTitle: '{{contact.name}}',
    eventColor: '#155EEF',
    formSubmitType: 'ThankYouMessage',
    formSubmitThanksMessage: "You're booked! We'll text you a confirmation.",
    consents: DEFAULT_CONSENTS,
    askEmail: true,
    askNotes: true,
    widgetColor: '#155EEF',
  }
}

/** "9:00 AM" from minutes after midnight. */
export function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
