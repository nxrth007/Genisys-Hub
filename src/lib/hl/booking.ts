import { randomBytes } from 'crypto'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { fireTrigger } from './automation'
import { getPrefs, scheduleHoursFor } from './calendar-records'
import { asCalendarSettings, durationsOf, type HlCalendarSettings } from './calendar-shared'
import { logActivity, upsertContact } from './contacts'
import { HlInputError } from './http'
import { resolveLegalLinks, type LegalLinks } from './legal-links'
import { appointmentTimes, renderTemplate } from './merge'
import { toE164 } from './phone'
import { computeSlots, pickMember, rulesOf, type Busy, type Slot } from './slots'
import { DEFAULT_CONSENTS } from './templates'
import { publicBase } from './twilio'
import type { HlConsentBox } from './types'

/**
 * Booking calendars (GHL's Calendars): the public booking page books here,
 * and its reschedule/cancel link (/hl/a/<token>) comes back here. Slots come
 * from src/lib/hl/slots.ts; this file feeds it the team and their busy
 * time, and books under a sub-account-wide lock so two people can't take
 * the last place in the same slot.
 */

type Db = typeof prisma | Prisma.TransactionClient

const DAY = 86_400_000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const HEX = /^#[0-9a-f]{6}$/i

export type TeamMember = { key: string; name: string; priority: number; location: string | null }

/** A calendar's team: its selected members, named from the staff records (imported GHL users, or staff added here). */
export async function teamOf(accountId: string, s: HlCalendarSettings, db: Db = prisma): Promise<TeamMember[]> {
  const entries = (s.teamMembers ?? []).filter((m) => m && typeof m.userId === 'string' && m.userId && m.selected !== false)
  if (!entries.length) return []
  const keys = entries.map((m) => m.userId)
  const staff = await db.hlRecord.findMany({ where: { accountId, kind: 'user', OR: [{ id: { in: keys } }, { ghlId: { in: keys } }] }, select: { id: true, ghlId: true, name: true } })
  return entries.map((m) => {
    const r = staff.find((x) => x.id === m.userId || x.ghlId === m.userId)
    return { key: m.userId, name: r?.name ?? 'Team member', priority: typeof m.priority === 'number' ? m.priority : 0.5, location: m.meetingLocation?.trim() || null }
  })
}

/** What's already booked that could clash: on this calendar, or with any of its team members on any calendar. */
async function busyFor(db: Db, accountId: string, calendarId: string, team: TeamMember[], from: Date, to: Date, excludeId?: string): Promise<Busy[]> {
  const keys = team.map((m) => m.key)
  const names = team.map((m) => m.name)
  const rows = await db.hlAppointment.findMany({
    where: {
      accountId,
      status: { notIn: ['cancelled', 'invalid'] },
      startTime: { lt: to },
      endTime: { gt: from },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      // Imported appointments know their member by name only until the import runs again. A collective
      // booking is with every host in meta.members.
      OR: [
        { calendarId },
        ...(keys.length ? [{ assignedUserId: { in: keys } }, { assignedUserId: null, assignedTo: { in: names } }, ...keys.map((k) => ({ meta: { path: ['members'], array_contains: [k] } }))] : []),
      ],
    },
    select: { startTime: true, endTime: true, assignedUserId: true, assignedTo: true, calendarId: true, meta: true },
  })
  return rows.flatMap((r) => {
    const members = (r.meta as { members?: unknown } | null)?.members
    const hosts = Array.isArray(members) ? members.filter((m): m is string => typeof m === 'string') : []
    if (hosts.length) return hosts.map((member) => ({ start: r.startTime, end: r.endTime, member, calendarId: r.calendarId }))
    return [{ start: r.startTime, end: r.endTime, member: r.assignedUserId ?? team.find((m) => m.name === r.assignedTo)?.key ?? null, calendarId: r.calendarId }]
  })
}

async function loadCalendar(calendarId: string, db: Db = prisma) {
  const cal = await db.hlCalendar.findUnique({ where: { id: calendarId }, include: { account: { select: { id: true, name: true, timezone: true, profile: true, archivedAt: true } } } })
  if (!cal || !cal.isActive || cal.account.archivedAt) throw new HlInputError('This calendar isn’t taking bookings right now.')
  return cal
}

/** A length the booker may pick (minutes), or the calendar's own. */
export function pickedDuration(s: HlCalendarSettings, minutes: unknown): number | undefined {
  if (minutes === undefined || minutes === null || minutes === '') return undefined
  const m = Number(minutes)
  if (!durationsOf(s).includes(m)) throw new BookingError('Pick one of the meeting lengths.', 'duration')
  return m
}

/** Open slots between two instants (of a length the booker picked, when the calendar offers a choice). */
export async function slotsFor(calendarId: string, from: Date, to: Date, o: { excludeAppointmentId?: string; now?: Date; db?: Db; duration?: number; staff?: boolean } = {}) {
  const db = o.db ?? prisma
  const calendar = await loadCalendar(calendarId, db)
  const settings = asCalendarSettings(calendar.settings)
  const team = await teamOf(calendar.accountId, settings, db)
  const members = team.map((m) => m.key)
  const [busy, memberHours] = await Promise.all([
    busyFor(db, calendar.accountId, calendar.id, team, new Date(from.getTime() - DAY), new Date(to.getTime() + DAY), o.excludeAppointmentId),
    scheduleHoursFor(calendar.accountId, calendar.id, members, db),
  ])
  const slots = computeSlots({
    calendarId: calendar.id,
    settings,
    timezone: calendar.account.timezone,
    now: o.now ?? new Date(),
    from,
    to,
    members,
    busy,
    memberHours,
    collective: calendar.kind === 'collective',
    duration: o.duration,
    staff: o.staff,
  })
  return { calendar, settings, team, slots }
}

/** GHL descriptions are HTML; the booking page shows them as text. */
const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export type PublicCalendar = {
  id: string
  name: string
  business: string
  description: string
  timezone: string
  /** Minutes. */
  duration: number
  /** The lengths the booker can pick (minutes, the default first); one means no choice. */
  durations: number[]
  location: string
  color: string
  consents: HlConsentBox[]
  legal: LegalLinks
  askEmail: boolean
  requireEmail: boolean
  askNotes: boolean
  thankYou: string | null
  redirectUrl: string | null
  allowReschedule: boolean
  allowCancellation: boolean
  /** Booking-page preferences (Settings → Calendars → Preferences). */
  hour12: boolean
  weekStartsOn: number
  /** Fill in a returning booker's details. */
  stickyContact: boolean
  /** A Facebook pixel to fire on the booking page. */
  pixelId: string | null
}

/** The booking page's view of a calendar: no team details, no sub-account ids. */
export async function publicCalendar(calendarId: string): Promise<PublicCalendar | null> {
  const cal = await prisma.hlCalendar.findUnique({ where: { id: calendarId }, include: { account: { select: { id: true, name: true, timezone: true, profile: true, archivedAt: true } } } })
  if (!cal || !cal.isActive || cal.account.archivedAt) return null
  const s = asCalendarSettings(cal.settings)
  const profile = readProfile(cal.account.profile)
  const business = profile.businessName || cal.account.name
  const consents = (Array.isArray(s.consents) ? s.consents : DEFAULT_CONSENTS)
    .filter((c) => (c.kind === 'sms' || c.kind === 'marketing') && typeof c.text === 'string' && c.text.trim())
    .map((c) => ({ ...c, text: c.text.replace(/\{\{\s*business\s*\}\}/g, business) }))
  const redirect = s.formSubmitType === 'RedirectURL' && /^https?:\/\//i.test(s.formSubmitRedirectUrl ?? '') ? s.formSubmitRedirectUrl! : null
  const prefs = await getPrefs(cal.accountId)
  return {
    id: cal.id,
    name: cal.name.trim(),
    business,
    description: plain(cal.description || s.description || ''),
    timezone: cal.account.timezone,
    duration: rulesOf(s).duration,
    durations: durationsOf(s),
    location: s.meetingLocation?.trim() || '',
    color: (s.widgetColor && HEX.test(s.widgetColor) ? s.widgetColor : s.eventColor && HEX.test(s.eventColor) ? s.eventColor : '#155EEF'),
    consents,
    legal: resolveLegalLinks(cal.account.id, profile),
    askEmail: s.askEmail !== false,
    requireEmail: s.requireEmail === true,
    askNotes: s.askNotes !== false,
    thankYou: redirect ? null : s.formSubmitThanksMessage?.trim() || 'You’re booked! We’ll text you a confirmation.',
    redirectUrl: redirect,
    allowReschedule: s.allowReschedule !== false,
    allowCancellation: s.allowCancellation !== false,
    hour12: prefs.timeFormat !== '24h',
    weekStartsOn: prefs.weekStartsOn,
    stickyContact: s.stickyContact === true,
    pixelId: s.pixelId && /^\d{6,20}$/.test(s.pixelId) ? s.pixelId : null,
  }
}

export type BookInput = {
  start: string
  /** The length picked (minutes), when the calendar offers more than one. */
  duration?: number | string | null
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  email?: string | null
  notes?: string | null
  consent?: boolean
  marketingConsent?: boolean
  /** The booker's timezone (shown back to them). */
  timezone?: string | null
  pageUrl?: string | null
}

export type Booked = {
  appointmentId: string
  token: string
  manageUrl: string
  start: Date
  end: Date
  contactId: string
  created: boolean
  accountId: string
  calendarId: string
}

/** The field a booking error is about, so the page can point at it. */
export class BookingError extends HlInputError {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'BookingError'
  }
}

export const newToken = () => randomBytes(18).toString('base64url')
/** The advisory lock every booking on a sub-account takes, so two can't take the last place in a slot. */
export const lockKey = (accountId: string) => `hl-book:${accountId}`

/** Who gets it: a round-robin pick among those free at that time. */
export async function chooseMember(db: Db, calendarId: string, slot: Slot, team: TeamMember[], s: HlCalendarSettings, keep?: string | null): Promise<TeamMember | null> {
  if (!team.length) return null
  if (keep && slot.members.includes(keep)) return team.find((m) => m.key === keep) ?? null
  const recent = await db.hlAppointment.groupBy({
    by: ['assignedUserId'],
    where: { calendarId, assignedUserId: { in: team.map((m) => m.key) }, createdAt: { gte: new Date(Date.now() - 30 * DAY) }, status: { notIn: ['cancelled', 'invalid'] } },
    _count: { _all: true },
  })
  const key = pickMember(slot.members, {
    priority: new Map(team.map((m) => [m.key, m.priority])),
    recent: new Map(recent.map((r) => [r.assignedUserId ?? '', r._count._all])),
    equal: s.eventType === 'RoundRobin_OptimizeForEqualDistribution',
    order: team.map((m) => m.key),
  })
  return team.find((m) => m.key === key) ?? null
}

/** Book a slot from the booking page (or by hand). Re-checks the slot under the lock; fires nothing (see fireBookingTriggers). */
export async function book(calendarId: string, input: BookInput, o: { source?: 'booking' | 'manual'; now?: Date } = {}): Promise<Booked> {
  const start = new Date(input.start)
  if (Number.isNaN(start.getTime())) throw new BookingError('Pick a time.')
  const pub = await publicCalendar(calendarId)
  if (!pub) throw new BookingError('This calendar isn’t taking bookings right now.')
  const firstName = input.firstName?.trim().slice(0, 80)
  if (!firstName) throw new BookingError('Please add your first name.', 'firstName')
  const phone = toE164(input.phone)
  if (!phone) throw new BookingError('Please enter a valid US mobile number.', 'phone')
  const email = input.email?.trim().toLowerCase().slice(0, 200) || null
  if (email && !EMAIL.test(email)) throw new BookingError('Please enter a valid email address.', 'email')
  if (pub.askEmail && pub.requireEmail && !email) throw new BookingError('Please add your email.', 'email')
  const missing = pub.consents.find((c) => c.required && !(c.kind === 'marketing' ? input.marketingConsent : input.consent))
  if (missing) throw new BookingError('Please check the box to agree before booking.', missing.kind === 'marketing' ? 'marketing_consent' : 'sms_consent')
  const consent = pub.consents.some((c) => c.kind === 'sms') && input.consent === true
  const marketingConsent = pub.consents.some((c) => c.kind === 'marketing') && input.marketingConsent === true
  const notes = input.notes?.trim().slice(0, 2000) || null
  const lastName = input.lastName?.trim().slice(0, 80) || null

  const calendar = await loadCalendar(calendarId)
  const accountId = calendar.accountId
  const duration = pickedDuration(asCalendarSettings(calendar.settings), input.duration)
  const { contact, created } = await upsertContact(accountId, { firstName, lastName, phone, email, source: 'booking', consent, marketingConsent })

  const appointment = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(accountId)}))`
      const { settings, team, slots } = await slotsFor(calendarId, new Date(start.getTime() - 60_000), new Date(start.getTime() + 60_000), { now: o.now, db: tx, duration })
      const slot = slots.find((x) => x.start.getTime() === start.getTime())
      if (!slot) throw new BookingError('That time was just taken. Please pick another.', 'start')
      // A collective booking is with the whole team; otherwise one member, in turn.
      const hosts = calendar.kind === 'collective' ? team : []
      const member = hosts[0] ?? (await chooseMember(tx, calendarId, slot, team, settings))
      const title = renderTemplate(settings.eventTitle?.trim() || '{{contact.name}}', { contact }).trim() || calendar.name
      return tx.hlAppointment.create({
        data: {
          accountId,
          calendarId,
          contactId: contact.id,
          title: title.slice(0, 300),
          startTime: slot.start,
          endTime: slot.end,
          status: settings.autoConfirm === false ? 'new' : 'confirmed',
          assignedUserId: member?.key ?? null,
          assignedTo: hosts.length ? hosts.map((h) => h.name).join(', ') : (member?.name ?? null),
          address: member?.location || settings.meetingLocation?.trim() || null,
          notes,
          source: o.source ?? 'booking',
          token: newToken(),
          timezone: input.timezone?.slice(0, 60) || null,
          meta: {
            consent,
            marketingConsent,
            pageUrl: input.pageUrl?.slice(0, 500) ?? null,
            ...(hosts.length ? { members: hosts.map((h) => h.key) } : {}),
            history: [{ at: new Date().toISOString(), what: 'booked' }],
          } as Prisma.InputJsonValue,
        },
      })
    },
    { timeout: 20_000 },
  )
  const when = appointmentTimes({ startTime: appointment.startTime, timezone: calendar.account.timezone }).full
  await logActivity(accountId, contact.id, `Booked ${calendar.name.trim()}\n${when}${appointment.assignedTo ? ` with ${appointment.assignedTo}` : ''}${notes ? `\nNotes: ${notes}` : ''}`, { appointmentId: appointment.id, consent, marketingConsent })
  return {
    appointmentId: appointment.id,
    token: appointment.token!,
    manageUrl: `${publicBase()}/hl/a/${appointment.token}`,
    start: appointment.startTime,
    end: appointment.endTime,
    contactId: contact.id,
    created,
    accountId,
    calendarId,
  }
}

/** After a booking: "contact created" for someone new, then "customer booked appointment". */
export async function fireBookingTriggers(b: Booked): Promise<void> {
  if (b.created) await fireTrigger(b.accountId, b.contactId, { type: 'contact_created', context: { appointmentId: b.appointmentId } })
  await fireTrigger(b.accountId, b.contactId, { type: 'appointment_booked', calendarId: b.calendarId, context: { appointmentId: b.appointmentId } })
}

export async function fireStatusTrigger(appointmentId: string, status: string): Promise<void> {
  const a = await prisma.hlAppointment.findUnique({ where: { id: appointmentId }, select: { accountId: true, contactId: true, calendarId: true } })
  if (!a?.contactId) return
  await fireTrigger(a.accountId, a.contactId, { type: 'appointment_status', status, calendarId: a.calendarId ?? undefined, context: { appointmentId } })
}

// ---------------------------------------------------------------------------
// The reschedule / cancel link (/hl/a/<token>)
// ---------------------------------------------------------------------------

export type ManagedAppointment = {
  start: string
  end: string
  status: string
  title: string
  business: string
  calendarName: string
  calendarId: string | null
  timezone: string
  bookerTimezone: string | null
  location: string | null
  with: string | null
  firstName: string | null
  canReschedule: boolean
  canCancel: boolean
  calendar: PublicCalendar | null
}

async function byToken(t: string) {
  if (!/^[\w-]{16,64}$/.test(t)) return null
  return prisma.hlAppointment.findUnique({
    where: { token: t },
    include: { calendar: true, account: { select: { id: true, name: true, timezone: true, profile: true } }, contact: { select: { firstName: true } } },
  })
}

export async function appointmentByToken(t: string): Promise<ManagedAppointment | null> {
  const a = await byToken(t)
  if (!a) return null
  const s = asCalendarSettings(a.calendar?.settings)
  const live = a.status !== 'cancelled' && a.status !== 'invalid' && a.startTime.getTime() > Date.now()
  const calendar = a.calendarId ? await publicCalendar(a.calendarId) : null
  return {
    start: a.startTime.toISOString(),
    end: a.endTime.toISOString(),
    status: a.status,
    title: a.title,
    business: readProfile(a.account.profile).businessName || a.account.name,
    calendarName: a.calendar?.name.trim() ?? 'Appointment',
    calendarId: a.calendarId,
    timezone: a.account.timezone,
    bookerTimezone: a.timezone,
    location: a.address,
    with: a.assignedTo,
    firstName: a.contact?.firstName ?? null,
    canReschedule: live && !!calendar && s.allowReschedule !== false,
    canCancel: live && s.allowCancellation !== false,
    calendar,
  }
}

export type History = { at: string; what: string; from?: string; to?: string }

export async function rescheduleByToken(t: string, newStart: string, o: { now?: Date } = {}): Promise<{ appointmentId: string; start: Date; end: Date }> {
  const a = await byToken(t)
  if (!a || !a.calendarId) throw new BookingError('This appointment can’t be found.')
  const info = await appointmentByToken(t)
  if (!info?.canReschedule) throw new BookingError(a.status === 'cancelled' ? 'This appointment was cancelled.' : 'This appointment can’t be rescheduled online. Please call us.')
  const start = new Date(newStart)
  if (Number.isNaN(start.getTime())) throw new BookingError('Pick a new time.', 'start')
  const calendarId = a.calendarId
  const updated = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(a.accountId)}))`
      const length = Math.round((a.endTime.getTime() - a.startTime.getTime()) / 60_000)
      const duration = durationsOf(asCalendarSettings(a.calendar?.settings)).includes(length) ? length : undefined
      const { settings, team, slots } = await slotsFor(calendarId, new Date(start.getTime() - 60_000), new Date(start.getTime() + 60_000), { excludeAppointmentId: a.id, now: o.now, db: tx, duration })
      const slot = slots.find((x) => x.start.getTime() === start.getTime())
      if (!slot) throw new BookingError('That time was just taken. Please pick another.', 'start')
      const collective = a.calendar?.kind === 'collective'
      const member = collective ? (team[0] ?? null) : await chooseMember(tx, calendarId, slot, team, settings, a.assignedUserId)
      const meta = (a.meta && typeof a.meta === 'object' ? a.meta : {}) as { history?: History[] }
      const history = [...(meta.history ?? []), { at: new Date().toISOString(), what: 'rescheduled', from: a.startTime.toISOString(), to: slot.start.toISOString() }].slice(-20)
      return tx.hlAppointment.update({
        where: { id: a.id },
        data: {
          startTime: slot.start,
          endTime: slot.end,
          ...(team.length && !collective ? { assignedUserId: member?.key ?? null, assignedTo: member?.name ?? null } : {}),
          meta: { ...meta, history } as Prisma.InputJsonValue,
        },
      })
    },
    { timeout: 20_000 },
  )
  if (a.contactId) {
    const tz = a.account.timezone
    await logActivity(a.accountId, a.contactId, `Rescheduled ${a.calendar?.name.trim() ?? 'appointment'}\nfrom ${appointmentTimes({ startTime: a.startTime, timezone: tz }).full}\nto ${appointmentTimes({ startTime: updated.startTime, timezone: tz }).full}`, { appointmentId: a.id })
  }
  return { appointmentId: a.id, start: updated.startTime, end: updated.endTime }
}

export async function cancelByToken(t: string): Promise<{ appointmentId: string }> {
  const a = await byToken(t)
  if (!a) throw new BookingError('This appointment can’t be found.')
  if (a.status === 'cancelled') return { appointmentId: a.id }
  const info = await appointmentByToken(t)
  if (!info?.canCancel) throw new BookingError('This appointment can’t be cancelled online. Please call us.')
  await setStatus(a.id, 'cancelled', 'the customer, from the booking link')
  return { appointmentId: a.id }
}

export const STATUSES = ['new', 'confirmed', 'showed', 'noshow', 'cancelled', 'invalid'] as const

/** Change an appointment's status (staff in the calendar, or the customer cancelling). Fire the trigger after. */
export async function setStatus(appointmentId: string, status: string, by: string) {
  if (!(STATUSES as readonly string[]).includes(status)) throw new HlInputError('Unknown status.')
  const a = await prisma.hlAppointment.findUniqueOrThrow({ where: { id: appointmentId }, include: { calendar: { select: { name: true } }, account: { select: { timezone: true } } } })
  if (a.status === status) return a
  const meta = (a.meta && typeof a.meta === 'object' ? a.meta : {}) as { history?: History[] }
  const history = [...(meta.history ?? []), { at: new Date().toISOString(), what: `${status} (${by})` }].slice(-20)
  const updated = await prisma.hlAppointment.update({ where: { id: appointmentId }, data: { status, meta: { ...meta, history } as Prisma.InputJsonValue } })
  if (a.contactId) {
    const label = { cancelled: 'Cancelled', showed: 'Showed up to', noshow: 'No-show for', confirmed: 'Confirmed', new: 'Unconfirmed', invalid: 'Marked invalid' }[status] ?? status
    await logActivity(a.accountId, a.contactId, `${label} ${a.calendar?.name.trim() ?? 'appointment'}: ${appointmentTimes({ startTime: a.startTime, timezone: a.account.timezone }).full}`, { appointmentId }, status === 'cancelled')
  }
  return updated
}
