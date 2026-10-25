import type { HlProfile } from './types'
import { pathValue, webhookText } from './webhook-shared'

/**
 * {{merge.fields}} in automation and message text, GHL style. Client-safe:
 * the builder previews with the same code the engine sends with.
 */

export type MergeContact = {
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  email?: string | null
  /** Form answers kept on the contact (JSON from the database). */
  fields?: unknown
}

/** The appointment a run is about (booked / status triggers). */
export type MergeAppointment = {
  title?: string | null
  startTime: string | Date
  endTime?: string | Date | null
  /** Shown in this zone (the sub-account's). */
  timezone: string
  calendarName?: string | null
  location?: string | null
  status?: string | null
  rescheduleUrl?: string | null
  cancelUrl?: string | null
  /** The calendar's booking page, to book another time. */
  bookingUrl?: string | null
}

export type MergeData = {
  contact?: MergeContact | null
  account?: HlProfile | null
  /** Answers of the form that fired the workflow, by field key. */
  form?: Record<string, unknown> | null
  /** The call that fired it: { from, to }. */
  call?: Record<string, unknown> | null
  appointment?: MergeAppointment | null
  /** The contact's tracked links ({{trigger_link.review}}). */
  links?: Record<string, string> | null
  /** The request that started the run (inbound webhook): {{inboundWebhookRequest.*}}, as GHL names it. */
  webhook?: unknown
}

/** GHL's scope for an inbound webhook's request, and a shorter one. */
const WEBHOOK_SCOPES = ['inboundwebhookrequest', 'webhook']

/** "Tuesday, October 28, 2026 at 2:00 PM EDT" and its parts, in the appointment's zone. */
export function appointmentTimes(a: Pick<MergeAppointment, 'startTime' | 'timezone'>) {
  const d = new Date(a.startTime)
  const f = (o: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: a.timezone, ...o }).format(d)
    } catch {
      return new Intl.DateTimeFormat('en-US', o).format(d)
    }
  }
  const date = f({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const time = f({ hour: 'numeric', minute: '2-digit' })
  const zone = f({ timeZoneName: 'short' }).split(' ').pop() ?? ''
  return { full: `${date} at ${time} ${zone}`.trim(), date: f({ month: 'short', day: 'numeric', year: 'numeric' }), time, weekday: f({ weekday: 'long' }), zone }
}

function appointmentValue(key: string, a: MergeAppointment | null | undefined): string {
  if (!a) return ''
  const t = appointmentTimes(a)
  switch (key) {
    case 'title':
      return a.title ?? ''
    case 'start_time':
    case 'start_date_time':
      return t.full
    case 'only_start_date':
    case 'date':
      return t.date
    case 'only_start_time':
    case 'time':
      return t.time
    case 'day_of_week':
      return t.weekday
    case 'timezone':
      return t.zone
    case 'calendar':
    case 'calendar_name':
      return a.calendarName ?? ''
    case 'meeting_location':
    case 'location':
      return a.location ?? ''
    case 'status':
      return a.status ?? ''
    case 'reschedule_link':
      return a.rescheduleUrl ?? ''
    case 'cancellation_link':
    case 'cancel_link':
      return a.cancelUrl ?? ''
    case 'booking_link':
      return a.bookingUrl ?? ''
    default:
      return ''
  }
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** "+16035551234" → "(603) 555-1234"; anything else unchanged. */
export function prettyPhone(p: string | null | undefined): string {
  const d = (p ?? '').replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : (p ?? '')
}

function value(path: string, d: MergeData): string | null {
  // GHL's unscoped {{reschedule_link}} / {{cancellation_link}}.
  const bare = path.trim().toLowerCase()
  if (bare === 'reschedule_link' || bare === 'cancellation_link') return appointmentValue(bare, d.appointment)
  // A webhook's own field names keep their case and spacing.
  const raw = path.trim()
  const dot = raw.indexOf('.')
  if (WEBHOOK_SCOPES.includes((dot < 0 ? raw : raw.slice(0, dot)).toLowerCase())) {
    return webhookText(dot < 0 ? d.webhook : pathValue(d.webhook, raw.slice(dot + 1)))
  }
  const [scope, ...rest] = path.trim().toLowerCase().split('.')
  const key = rest.join('.').replace(/\s+/g, '_')
  const str = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v))
  if (scope === 'contact') {
    const c = d.contact ?? {}
    const full = [c.firstName, c.lastName].filter(Boolean).join(' ')
    switch (key) {
      case 'first_name':
        return c.firstName ?? ''
      case 'last_name':
        return c.lastName ?? ''
      case 'name':
      case 'full_name':
        return full
      case 'phone':
        return prettyPhone(c.phone)
      case 'email':
        return c.email ?? ''
      // GHL's name for the contact's company.
      case 'business_name':
      case 'company_name':
        return str(c.fields && typeof c.fields === 'object' ? (c.fields as Record<string, unknown>).company_name : null)
      default:
        return str(c.fields && typeof c.fields === 'object' ? (c.fields as Record<string, unknown>)[key] : null)
    }
  }
  // GHL's {{user.*}} (the sub-account's user: here, its owner) and {{location.*}} (the business).
  if (scope === 'user' || scope === 'location') {
    const a = d.account ?? {}
    const first = (s: string | undefined) => (s ?? '').split(/[,;]/)[0].trim()
    const values: Record<string, string> =
      scope === 'user'
        ? {
            name: a.ownerName || a.ownerFirstName || '',
            first_name: a.ownerFirstName || (a.ownerName ?? '').split(' ')[0] || '',
            last_name: (a.ownerName ?? '').split(' ').slice(1).join(' '),
            phone: prettyPhone(first(a.notifyPhone) || a.businessPhone),
            email: first(a.notifyEmail),
          }
        : {
            name: a.businessName ?? '',
            phone: prettyPhone(a.businessPhone),
            email: first(a.notifyEmail),
            address: a.address ?? '',
            full_address: a.address ?? '',
            website: a.website ?? '',
          }
    return values[key] ?? ''
  }
  if (scope === 'account' || scope === 'custom_values') {
    const a = (d.account ?? {}) as Record<string, unknown>
    const hit = Object.keys(a).find((k) => snake(k) === key)
    const v = hit ? str(a[hit]) : ''
    return key.endsWith('phone') ? prettyPhone(v) : v
  }
  if (scope === 'form') return str((d.form ?? {})[key])
  // GHL names trigger links by id; a sub-account has one, the review link.
  if (scope === 'trigger_link') return (d.links ?? {})[key] ?? (d.links ?? {}).review ?? ''
  if (scope === 'appointment') return appointmentValue(key, d.appointment)
  if (scope === 'call') return key.endsWith('from') || key.endsWith('to') ? prettyPhone(str((d.call ?? {})[key])) : str((d.call ?? {})[key])
  return null
}

/**
 * Fill every {{scope.field}} in the text. Unknown scopes stay as written so a
 * typo shows up in the message preview; known scopes with no value go blank.
 */
export function renderTemplate(text: string, d: MergeData): string {
  return text
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, path: string) => {
      const v = value(path, d)
      return v === null ? m : v
    })
    // "Hey ! Just got…" when there's no first name reads badly.
    .replace(/\b(Hey|Hi|Hello),?\s+([!,.])/g, '$1$2')
}

/** Merge tokens in the text that wouldn't fill (unknown scope). */
export function unknownTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const bare = m[1].trim().toLowerCase()
    if (bare === 'reschedule_link' || bare === 'cancellation_link') continue
    const scope = bare.split('.')[0]
    if (!['contact', 'account', 'custom_values', 'form', 'call', 'appointment', 'user', 'location', 'trigger_link', ...WEBHOOK_SCOPES].includes(scope)) out.push(m[0])
  }
  return out
}
