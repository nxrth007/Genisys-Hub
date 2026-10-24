import { HlInputError } from './http'
import { randomUUID } from 'crypto'
import type { HlCalendarSettings, HlDateOverride, HlDurationOption, HlHours, HlNotification, HlOpenHours, HlTeamMember, TimeUnit } from './calendar-shared'
import type { HlConsentBox } from './types'

/**
 * A calendar's settings from the editor, checked. Only the keys the editor
 * owns are replaced; everything else on the calendar (the rest of an
 * imported GHL calendar's settings) is kept as it was.
 */

const num = (v: unknown, lo: number, hi: number, what: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n) || n < lo || n > hi) throw new HlInputError(`${what} has to be between ${lo} and ${hi}.`)
  return n
}
const unit = <T extends TimeUnit>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined)

function hours(raw: unknown, where: string): HlHours[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 8).map((h) => {
    const x = (h ?? {}) as Record<string, unknown>
    const open = num(x.openHour, 0, 23, `${where}: opening hour`) * 60 + num(x.openMinute ?? 0, 0, 59, `${where}: opening minute`)
    const closeHour = num(x.closeHour, 0, 24, `${where}: closing hour`)
    const closeMinute = closeHour === 24 ? 0 : num(x.closeMinute ?? 0, 0, 59, `${where}: closing minute`)
    const close = closeHour * 60 + closeMinute
    if (close !== 0 && close <= open) throw new HlInputError(`${where}: the closing time has to be after the opening time.`)
    return { openHour: Math.floor(open / 60), openMinute: open % 60, closeHour, closeMinute }
  })
}

/** Weekly hours, as GHL keeps them (day groups). */
export function cleanOpenHours(raw: unknown): HlOpenHours[] {
  if (!Array.isArray(raw)) throw new HlInputError('Weekly hours must be a list.')
  return raw.slice(0, 14).flatMap((o): HlOpenHours[] => {
    const x = (o ?? {}) as Record<string, unknown>
    const days = (Array.isArray(x.daysOfTheWeek) ? x.daysOfTheWeek : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    const h = hours(x.hours, 'Weekly hours')
    return days.length && h.length ? [{ daysOfTheWeek: [...new Set(days)], hours: h }] : []
  })
}

/** Date-specific hours (no hours: closed that day). */
export function cleanOverrides(raw: unknown): HlDateOverride[] {
  if (!Array.isArray(raw)) throw new HlInputError('Date-specific hours must be a list.')
  const seen = new Set<string>()
  return raw.slice(0, 200).flatMap((a): HlDateOverride[] => {
    const x = (a ?? {}) as Record<string, unknown>
    const date = str(x.date, 30).slice(0, 10)
    if (!/^\d{4}-\d\d-\d\d$/.test(date) || seen.has(date) || x.deleted === true) return []
    seen.add(date)
    return [{ date, hours: hours(x.hours, `Hours on ${date}`) }]
  })
}

export function cleanCalendarSettings(raw: unknown, existing: HlCalendarSettings, staffKeys: Set<string>, groupKeys?: Set<string>): HlCalendarSettings {
  const s = (raw ?? {}) as Record<string, unknown>
  const out: HlCalendarSettings = { ...existing }

  if (s.eventType !== undefined) out.eventType = s.eventType === 'RoundRobin_OptimizeForEqualDistribution' ? 'RoundRobin_OptimizeForEqualDistribution' : 'RoundRobin_OptimizeForAvailability'
  if (s.teamMembers !== undefined) {
    if (!Array.isArray(s.teamMembers)) throw new HlInputError('Team members must be a list.')
    const before = new Map((existing.teamMembers ?? []).map((m) => [m.userId, m]))
    const seen = new Set<string>()
    out.teamMembers = s.teamMembers.slice(0, 50).flatMap((m): HlTeamMember[] => {
      const x = (m ?? {}) as Record<string, unknown>
      const userId = str(x.userId, 80)
      if (!userId || seen.has(userId) || !staffKeys.has(userId)) return []
      seen.add(userId)
      const p = Number(x.priority)
      return [{ ...(before.get(userId) ?? {}), userId, priority: p === 1 || p === 0 ? p : 0.5, selected: true, meetingLocation: str(x.meetingLocation, 300) || undefined }]
    })
  }
  if (s.openHours !== undefined) out.openHours = cleanOpenHours(s.openHours)
  if (s.availabilities !== undefined) out.availabilities = cleanOverrides(s.availabilities)
  const minutes = ['mins', 'hours'] as const
  if (s.slotDuration !== undefined) {
    out.slotDurationUnit = unit(s.slotDurationUnit, minutes, 'mins')
    out.slotDuration = num(s.slotDuration, out.slotDurationUnit === 'hours' ? 1 : 5, out.slotDurationUnit === 'hours' ? 12 : 720, 'Meeting length')
  }
  if (s.slotInterval !== undefined) {
    out.slotIntervalUnit = unit(s.slotIntervalUnit, minutes, 'mins')
    out.slotInterval = num(s.slotInterval, 0, out.slotIntervalUnit === 'hours' ? 12 : 720, 'Slot interval')
  }
  if (s.slotBuffer !== undefined) {
    out.slotBufferUnit = unit(s.slotBufferUnit, minutes, 'mins')
    out.slotBuffer = num(s.slotBuffer, 0, out.slotBufferUnit === 'hours' ? 12 : 720, 'Buffer after')
  }
  if (s.preBuffer !== undefined) {
    out.preBufferUnit = unit(s.preBufferUnit, minutes, 'mins')
    out.preBuffer = num(s.preBuffer, 0, out.preBufferUnit === 'hours' ? 12 : 720, 'Buffer before')
  }
  if (s.allowBookingAfter !== undefined) {
    out.allowBookingAfterUnit = unit(s.allowBookingAfterUnit, ['mins', 'hours', 'days'] as const, 'hours')
    out.allowBookingAfter = num(s.allowBookingAfter, 0, 1000, 'Minimum notice')
  }
  if (s.allowBookingFor !== undefined) {
    out.allowBookingForUnit = unit(s.allowBookingForUnit, ['days', 'weeks', 'months'] as const, 'days')
    out.allowBookingFor = num(s.allowBookingFor, 0, 1000, 'Booking window')
  }
  if (s.appointmentPerSlot !== undefined) out.appointmentPerSlot = num(s.appointmentPerSlot || 1, 1, 1000, 'Appointments per slot')
  if (s.appointmentPerDay !== undefined) out.appointmentPerDay = s.appointmentPerDay === '' || s.appointmentPerDay === null || Number(s.appointmentPerDay) === 0 ? '' : num(s.appointmentPerDay, 1, 1000, 'Appointments per day')
  if (s.lookBusyConfig !== undefined) {
    const l = (s.lookBusyConfig ?? {}) as Record<string, unknown>
    out.lookBusyConfig = { enabled: l.enabled === true, lookBusyPercentage: l.enabled === true ? num(l.lookBusyPercentage ?? 0, 0, 90, 'Look busy') : Number(existing.lookBusyConfig?.lookBusyPercentage) || 0 }
  }
  for (const k of ['autoConfirm', 'allowReschedule', 'allowCancellation', 'askEmail', 'requireEmail', 'askNotes'] as const) {
    if (s[k] !== undefined) out[k] = s[k] === true
  }
  if (s.eventTitle !== undefined) out.eventTitle = str(s.eventTitle, 200) || '{{contact.name}}'
  if (s.eventColor !== undefined) out.eventColor = hex(s.eventColor) ?? existing.eventColor
  if (s.widgetColor !== undefined) out.widgetColor = hex(s.widgetColor) ?? existing.widgetColor
  if (s.meetingLocation !== undefined) out.meetingLocation = str(s.meetingLocation, 300)
  if (s.meetingType !== undefined) out.meetingType = s.meetingType === 'google_meet' ? 'google_meet' : 'location'
  if (s.formSubmitType !== undefined) out.formSubmitType = s.formSubmitType === 'RedirectURL' ? 'RedirectURL' : 'ThankYouMessage'
  if (s.formSubmitThanksMessage !== undefined) out.formSubmitThanksMessage = str(s.formSubmitThanksMessage, 500)
  if (s.formSubmitRedirectUrl !== undefined) {
    const u = str(s.formSubmitRedirectUrl, 500)
    if (u && !/^https?:\/\/\S+$/i.test(u)) throw new HlInputError('The page to send people to after booking has to be a full address starting with https://.')
    out.formSubmitRedirectUrl = u
  }
  if (out.formSubmitType === 'RedirectURL' && !out.formSubmitRedirectUrl) throw new HlInputError('Add the page to send people to after booking, or show a thank-you message instead.')
  if (s.groupId !== undefined) {
    const g = str(s.groupId, 80)
    if (g && groupKeys && !groupKeys.has(g)) throw new HlInputError('That group isn’t in this sub-account.')
    out.groupId = g || undefined
  }
  if (s.durationOptions !== undefined) {
    if (!Array.isArray(s.durationOptions)) throw new HlInputError('Meeting lengths must be a list.')
    const seen = new Set<number>()
    out.durationOptions = s.durationOptions.slice(0, 8).flatMap((d, i): HlDurationOption[] => {
      const x = (d ?? {}) as Record<string, unknown>
      const durationUnit = unit(x.durationUnit, ['mins', 'hours'] as const, 'mins')
      const duration = num(x.duration, durationUnit === 'hours' ? 1 : 5, durationUnit === 'hours' ? 12 : 720, 'A meeting length')
      const minutes = durationUnit === 'hours' ? duration * 60 : duration
      if (seen.has(minutes)) return []
      seen.add(minutes)
      return [{ duration, durationUnit, isDefault: x.isDefault === true, order: i + 1 }]
    })
    // The default length is the calendar's slot length.
    const def = out.durationOptions.find((d) => d.isDefault) ?? out.durationOptions[0]
    if (def) {
      out.durationOptions = out.durationOptions.map((d) => ({ ...d, isDefault: d === def }))
      out.slotDuration = def.duration
      out.slotDurationUnit = def.durationUnit
    }
  }
  if (s.notes !== undefined) out.notes = str(s.notes, 2000)
  if (s.hlNotifications !== undefined) {
    if (!Array.isArray(s.hlNotifications)) throw new HlInputError('Notifications must be a list.')
    const ons = ['booked', 'rescheduled', 'cancelled', 'reminder', 'followup'] as const
    out.hlNotifications = s.hlNotifications.slice(0, 20).map((n, i): HlNotification => {
      const x = (n ?? {}) as Record<string, unknown>
      const on = ons.find((o) => o === x.on)
      if (!on) throw new HlInputError(`Notification ${i + 1}: pick when it goes.`)
      const to = x.to === 'member' ? 'member' : 'contact'
      const channel = x.channel === 'email' && to === 'member' ? 'email' : 'sms'
      const body = str(x.body, 1600)
      if (!body) throw new HlInputError(`Notification ${i + 1} has no message.`)
      const timed = on === 'reminder' || on === 'followup'
      return {
        id: typeof x.id === 'string' && /^[\w-]{6,64}$/.test(x.id) ? x.id : randomUUID(),
        on,
        to,
        channel,
        ...(timed ? { minutes: num(x.minutes ?? 60, 0, 60 * 24 * 30, `Notification ${i + 1}: the time`) } : {}),
        ...(channel === 'email' ? { subject: str(x.subject, 200) } : {}),
        body,
        enabled: x.enabled !== false,
      }
    })
  }
  if (s.stickyContact !== undefined) out.stickyContact = s.stickyContact === true
  if (s.pixelId !== undefined) {
    const px = str(s.pixelId, 40)
    if (px && !/^\d{6,20}$/.test(px)) throw new HlInputError('A Facebook pixel ID is just digits.')
    out.pixelId = px
  }
  if (s.consents !== undefined) {
    const boxes: HlConsentBox[] = []
    for (const c of Array.isArray(s.consents) ? s.consents.slice(0, 4) : []) {
      const x = (c ?? {}) as Record<string, unknown>
      const text = str(x.text, 1000)
      if (!text || (x.kind !== 'sms' && x.kind !== 'marketing') || boxes.some((b) => b.kind === x.kind)) continue
      boxes.push({ kind: x.kind, text, required: x.required === true })
    }
    out.consents = boxes
  }
  return out
}
