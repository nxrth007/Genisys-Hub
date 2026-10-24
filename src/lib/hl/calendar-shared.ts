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
  // --- Hell-level's own ---
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
