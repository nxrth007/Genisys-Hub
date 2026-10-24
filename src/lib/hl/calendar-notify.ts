import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { toZonedTime } from 'date-fns-tz'
import { readProfile } from './accounts'
import { asCalendarSettings, type HlNotification } from './calendar-shared'
import { renderTemplate, type MergeData } from './merge'
import { sendInternalEmail, sendInternalSms, sendSmsToContact } from './messages'
import { toE164 } from './phone'
import { staffOf } from './staff'
import { publicBase } from './twilio'

/**
 * A calendar's own notifications (GHL's calendar Notifications): a text to
 * the contact, or a text or email to the team member, when an appointment is
 * booked, rescheduled or cancelled; reminders before it and a follow-up
 * after. Texts to the contact go through sendSmsToContact, so they need the
 * contact's texting consent and stop at STOP; reminders and follow-ups wait
 * out the night (9 PM to 8 AM in the sub-account's timezone).
 */

const MIN = 60_000
const HOUR = 60 * MIN
/** A reminder that's this late isn't sent at all. */
const GRACE = 12 * HOUR
const QUIET_START = 21
const QUIET_END = 8

type Notice = { id: string; on: string; at: string; ok: boolean; detail: string }
type Meta = { members?: string[]; sent?: Record<string, string>; notices?: Notice[] } & Record<string, unknown>

export function notificationsOf(settings: unknown): HlNotification[] {
  const list = asCalendarSettings(settings).hlNotifications
  return Array.isArray(list) ? list.filter((n) => n && typeof n.id === 'string' && typeof n.body === 'string') : []
}

const quiet = (tz: string, at: Date) => {
  const h = toZonedTime(at, tz).getHours()
  return h >= QUIET_START || h < QUIET_END
}

const split = (v: string | null | undefined) => (v ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)

async function load(appointmentId: string) {
  return prisma.hlAppointment.findUnique({
    where: { id: appointmentId },
    include: { calendar: true, contact: true, account: { select: { id: true, name: true, timezone: true, profile: true } } },
  })
}
type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>

function mergeFor(a: Loaded): MergeData {
  const base = publicBase()
  const manage = a.token ? `${base}/hl/a/${a.token}` : null
  return {
    contact: a.contact,
    account: readProfile(a.account.profile),
    appointment: {
      title: a.title,
      startTime: a.startTime,
      endTime: a.endTime,
      timezone: a.account.timezone,
      calendarName: a.calendar?.name.trim() ?? null,
      location: a.address,
      status: a.status,
      rescheduleUrl: manage,
      cancelUrl: manage,
      bookingUrl: a.calendarId ? `${base}/hl/b/${a.calendarId}` : null,
    },
  }
}

/** Who "the team member" is: the appointment's (every host of a collective one), else the sub-account's notification phone and email. */
async function memberContacts(a: Loaded): Promise<{ phones: string[]; emails: string[] }> {
  const meta = (a.meta ?? {}) as Meta
  const keys = Array.isArray(meta.members) && meta.members.length ? meta.members : a.assignedUserId ? [a.assignedUserId] : []
  const staff = keys.length ? (await staffOf(a.accountId)).filter((s) => keys.includes(s.id) || (s.ghlId !== null && keys.includes(s.ghlId))) : []
  const phones = staff.map((s) => toE164(s.phone)).filter((p): p is string => !!p)
  const emails = staff.map((s) => s.email).filter((e): e is string => !!e && e.includes('@'))
  const p = readProfile(a.account.profile)
  return {
    phones: phones.length ? phones : split(p.notifyPhone).map((x) => toE164(x)).filter((x): x is string => !!x),
    emails: emails.length ? emails : split(p.notifyEmail).filter((e) => e.includes('@')),
  }
}

/** One notification, sent: any failure (no number, no consent, Gmail down) is recorded, never thrown, so the others still go. */
async function deliver(a: Loaded, n: HlNotification): Promise<Notice> {
  try {
    return await attempt(a, n)
  } catch (err) {
    return { id: n.id, on: n.on, at: new Date().toISOString(), ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

async function attempt(a: Loaded, n: HlNotification): Promise<Notice> {
  const data = mergeFor(a)
  const body = renderTemplate(n.body, data).trim()
  const done = (ok: boolean, detail: string): Notice => ({ id: n.id, on: n.on, at: new Date().toISOString(), ok, detail })
  if (!body) return done(false, 'Empty message')
  if (n.to === 'contact') {
    if (n.channel !== 'sms') return done(false, 'Email to contacts isn’t set up in Hell-level yet')
    if (!a.contactId) return done(false, 'No contact on the appointment')
    const r = await sendSmsToContact({ accountId: a.accountId, contactId: a.contactId, body, by: 'calendar' })
    return done(r.ok, r.detail)
  }
  const { phones, emails } = await memberContacts(a)
  const r = n.channel === 'sms' ? await sendInternalSms(a.accountId, phones, body) : await sendInternalEmail(a.accountId, emails, renderTemplate(n.subject?.trim() || 'Appointment: {{contact.name}}', data), body)
  return done(r.ok, r.detail)
}

async function record(id: string, notices: Notice[], sent?: Record<string, string>): Promise<void> {
  const row = await prisma.hlAppointment.findUnique({ where: { id }, select: { meta: true } })
  const meta = (row?.meta ?? {}) as Meta
  const next: Meta = { ...meta, notices: [...(meta.notices ?? []), ...notices].slice(-30), ...(sent ? { sent: { ...(meta.sent ?? {}), ...sent } } : {}) }
  await prisma.hlAppointment.update({ where: { id }, data: { meta: next as Prisma.InputJsonValue } })
}

/** Send the calendar's notifications for something that just happened to an appointment. A reschedule re-arms its reminders. */
export async function notifyAppointment(appointmentId: string, on: 'booked' | 'rescheduled' | 'cancelled'): Promise<number> {
  const a = await load(appointmentId)
  if (!a || a.source === 'block' || !a.calendar) return 0
  if (on === 'rescheduled') {
    const meta = (a.meta ?? {}) as Meta
    if (meta.sent && Object.keys(meta.sent).length) await prisma.hlAppointment.update({ where: { id: a.id }, data: { meta: { ...meta, sent: {} } as Prisma.InputJsonValue } })
  }
  const due = notificationsOf(a.calendar.settings).filter((n) => n.enabled && n.on === on)
  if (!due.length) return 0
  const notices: Notice[] = []
  for (const n of due) notices.push(await deliver(a, n))
  await record(a.id, notices)
  return notices.filter((x) => x.ok).length
}

/**
 * Reminders and follow-ups that are due: a reminder goes `minutes` before the
 * start (only for appointments booked before then), a follow-up `minutes`
 * after the end (only when it was kept or confirmed). Each goes once.
 */
export async function sendDueReminders(now = new Date()): Promise<number> {
  const calendars = await prisma.hlCalendar.findMany({ select: { id: true, settings: true } })
  let sent = 0
  for (const cal of calendars) {
    const timed = notificationsOf(cal.settings).filter((n) => n.enabled && (n.on === 'reminder' || n.on === 'followup') && Number(n.minutes) >= 0)
    if (!timed.length) continue
    const before = Math.max(0, ...timed.filter((n) => n.on === 'reminder').map((n) => Number(n.minutes) || 0))
    const after = Math.max(0, ...timed.filter((n) => n.on === 'followup').map((n) => Number(n.minutes) || 0))
    const appts = await prisma.hlAppointment.findMany({
      where: {
        calendarId: cal.id,
        source: { not: 'block' },
        status: { in: ['new', 'confirmed', 'showed'] },
        startTime: { gte: new Date(now.getTime() - after * MIN - GRACE - 24 * HOUR), lte: new Date(now.getTime() + before * MIN + MIN) },
      },
      select: { id: true },
    })
    for (const { id } of appts) {
      const a = await load(id)
      if (!a) continue
      const meta = (a.meta ?? {}) as Meta
      const due = timed.filter((n) => {
        if (meta.sent?.[n.id]) return false
        const minutes = Number(n.minutes) || 0
        const dueAt = n.on === 'reminder' ? a.startTime.getTime() - minutes * MIN : a.endTime.getTime() + minutes * MIN
        if (dueAt > now.getTime() || now.getTime() - dueAt > GRACE) return false
        if (n.on === 'reminder' && (a.startTime <= now || a.createdAt.getTime() > dueAt)) return false
        if (n.on === 'followup' && a.status === 'new') return false
        // Texts to the contact wait for the morning (a reminder that would land after the start is dropped).
        return !(n.to === 'contact' && quiet(a.account.timezone, now))
      })
      if (!due.length) continue
      // Claimed before sending, so a restart mid-send can't send it twice.
      await record(a.id, [], Object.fromEntries(due.map((n) => [n.id, now.toISOString()])))
      const notices: Notice[] = []
      for (const n of due) notices.push(await deliver(a, n))
      await record(a.id, notices)
      sent += notices.filter((x) => x.ok).length
    }
  }
  return sent
}

let lastSweep = 0
let inFlight = false
/** Every minute from the scheduler. */
export async function maybeSendCalendarReminders(): Promise<number> {
  if (inFlight || Date.now() - lastSweep < 55_000) return 0
  lastSweep = Date.now()
  inFlight = true
  try {
    return await sendDueReminders()
  } finally {
    inFlight = false
  }
}
