import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { fireTrigger } from './automation'
import { BookingError, chooseMember, lockKey, newToken, setStatus, slotsFor, teamOf, type History } from './booking'
import { notifyAppointment } from './calendar-notify'
import { asCalendarSettings, minutesOf } from './calendar-shared'
import { logActivity, upsertContact } from './contacts'
import { HlInputError } from './http'
import { appointmentTimes, renderTemplate } from './merge'
import { staffOf } from './staff'

/**
 * Appointments made and changed by staff in the calendar views (GHL's "New
 * appointment", "Blocked off time" and the appointment editor). The booking
 * page's side is booking.ts. Blocked-off time is an appointment with source
 * "block" and no contact: busy for its team member (or its calendar), and
 * nothing fires for it.
 */

const MIN = 60_000
const asJson = (v: unknown) => v as Prisma.InputJsonValue
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export type StaffAppointmentInput = {
  kind?: 'appointment' | 'block'
  calendarId?: string | null
  contactId?: string | null
  /** A new contact, instead of contactId. */
  contact?: { firstName?: string | null; lastName?: string | null; phone?: string | null; email?: string | null } | null
  start: string
  end?: string | null
  /** Minutes, instead of end. */
  duration?: number | null
  /** A team member (staff key). Empty: round robin (an appointment) or the whole calendar (blocked time). */
  assignedUserId?: string | null
  title?: string | null
  address?: string | null
  notes?: string | null
  status?: string | null
  /** Book outside the calendar's hours or over other bookings (GHL lets staff do this). */
  ignoreAvailability?: boolean
}

export type Made = { appointmentId: string; contactId: string | null; created: boolean; calendarId: string | null; kind: 'appointment' | 'block' }

function times(input: { start: string; end?: string | null; duration?: number | null }, fallbackMinutes: number) {
  const start = new Date(input.start)
  if (Number.isNaN(start.getTime())) throw new HlInputError('Pick a start time.')
  const end = input.end ? new Date(input.end) : new Date(start.getTime() + (Number(input.duration) > 0 ? Number(input.duration) : fallbackMinutes) * MIN)
  if (Number.isNaN(end.getTime()) || end <= start) throw new HlInputError('The end has to be after the start.')
  if (end.getTime() - start.getTime() > 24 * 60 * MIN) throw new HlInputError('Keep it under a day.')
  return { start, end }
}

async function staffName(accountId: string, key: string | null | undefined): Promise<{ key: string; name: string } | null> {
  if (!key) return null
  const s = (await staffOf(accountId)).find((m) => m.id === key || m.ghlId === key)
  if (!s) throw new HlInputError('That team member isn’t on this sub-account.')
  return { key, name: s.name }
}

/** A new appointment or blocked-off time, by staff. Appointments get a reschedule/cancel link; the caller fires the booking triggers. */
export async function createAppointment(accountId: string, input: StaffAppointmentInput, by: string): Promise<Made> {
  const kind = input.kind === 'block' ? 'block' : 'appointment'
  const calendar = input.calendarId ? await prisma.hlCalendar.findFirst({ where: { id: input.calendarId, accountId } }) : null
  if (input.calendarId && !calendar) throw new HlInputError('That calendar isn’t on this sub-account.')
  if (kind === 'appointment' && !calendar) throw new HlInputError('Pick a calendar.')
  const settings = asCalendarSettings(calendar?.settings)
  const { start, end } = times(input, minutesOf(settings.slotDuration, settings.slotDurationUnit, 30))
  const member = await staffName(accountId, input.assignedUserId)
  if (kind === 'block' && !member && !calendar) throw new HlInputError('Block off time for a team member or a calendar.')
  const notes = text(input.notes, 2000) || null

  if (kind === 'block') {
    const row = await prisma.hlAppointment.create({
      data: {
        accountId,
        calendarId: calendar?.id ?? null,
        title: text(input.title, 300) || 'Blocked off',
        startTime: start,
        endTime: end,
        status: 'confirmed',
        assignedUserId: member?.key ?? null,
        assignedTo: member?.name ?? null,
        notes,
        source: 'block',
        meta: asJson({ history: [{ at: new Date().toISOString(), what: `blocked off by ${by}` }] }),
      },
    })
    return { appointmentId: row.id, contactId: null, created: false, calendarId: row.calendarId, kind }
  }

  // The contact: one picked, or a new one (found again by phone or email if they're already here).
  let contactId: string
  let created = false
  if (input.contactId) {
    const c = await prisma.hlContact.findFirst({ where: { id: input.contactId, accountId }, select: { id: true } })
    if (!c) throw new HlInputError('That contact isn’t on this sub-account.')
    contactId = c.id
  } else {
    const n = input.contact ?? {}
    if (!text(n.firstName, 80) && !text(n.phone, 40) && !text(n.email, 200)) throw new HlInputError('Pick a contact, or add a name and a phone number or email.')
    const r = await upsertContact(accountId, { firstName: n.firstName, lastName: n.lastName, phone: n.phone, email: n.email, source: 'manual' })
    contactId = r.contact.id
    created = r.created
  }
  const contact = await prisma.hlContact.findUniqueOrThrow({ where: { id: contactId } })
  const status = input.status === 'new' ? 'new' : 'confirmed'
  const duration = Math.round((end.getTime() - start.getTime()) / MIN)

  const row = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(accountId)}))`
      let assigned = member
      if (!input.ignoreAvailability) {
        const { slots, team } = await slotsFor(calendar!.id, new Date(start.getTime() - MIN), new Date(start.getTime() + MIN), { db: tx, duration, staff: true }).catch((err) => {
          // A calendar that's off can't be checked: say so, and let staff book anyway.
          if (err instanceof HlInputError && !(err instanceof BookingError)) throw new BookingError(`${err.message} Tick “Book anyway” to book it.`, 'start')
          throw err
        })
        const slot = slots.find((x) => x.start.getTime() === start.getTime())
        if (!slot || (member && team.length && !slot.members.includes(member.key)))
          throw new BookingError(`${member ? `${member.name} isn’t` : 'No one is'} free then on ${calendar!.name.trim()}. Pick another time, or tick “Book anyway” to book outside its hours.`, 'start')
        if (!assigned && team.length) {
          const picked = await chooseMember(tx, calendar!.id, slot, team, settings)
          assigned = picked ? { key: picked.key, name: picked.name } : null
        }
      }
      const hosts = calendar!.kind === 'collective' ? await teamOf(accountId, settings, tx) : []
      const title = text(input.title, 300) || renderTemplate(settings.eventTitle?.trim() || '{{contact.name}}', { contact }).trim() || calendar!.name.trim()
      return tx.hlAppointment.create({
        data: {
          accountId,
          calendarId: calendar!.id,
          contactId,
          title,
          startTime: start,
          endTime: end,
          status,
          assignedUserId: hosts[0]?.key ?? assigned?.key ?? null,
          assignedTo: hosts.length ? hosts.map((m) => m.name).join(', ') : (assigned?.name ?? null),
          address: text(input.address, 300) || settings.meetingLocation?.trim() || null,
          notes,
          source: 'manual',
          token: newToken(),
          meta: asJson({ ...(hosts.length ? { members: hosts.map((m) => m.key) } : {}), history: [{ at: new Date().toISOString(), what: `booked by ${by}` }] }),
        },
      })
    },
    { timeout: 20_000 },
  )
  const tz = (await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { timezone: true } })).timezone
  await logActivity(accountId, contactId, `Booked ${calendar!.name.trim()} (by ${by})\n${appointmentTimes({ startTime: row.startTime, timezone: tz }).full}${row.assignedTo ? ` with ${row.assignedTo}` : ''}${notes ? `\nNotes: ${notes}` : ''}`, { appointmentId: row.id })
  return { appointmentId: row.id, contactId, created, calendarId: calendar!.id, kind }
}

export type StaffAppointmentChange = Partial<Omit<StaffAppointmentInput, 'kind' | 'contact' | 'contactId'>>

/** Change an appointment (or blocked-off time) from the calendar: its time, who it's with, its details, its status. */
export async function updateAppointment(accountId: string, id: string, input: StaffAppointmentChange, by: string): Promise<{ statusChanged: string | null; moved: boolean }> {
  const a = await prisma.hlAppointment.findFirst({ where: { id, accountId }, include: { calendar: true } })
  if (!a) throw new HlInputError('Appointment not found.')
  const block = a.source === 'block'
  const data: Prisma.HlAppointmentUpdateInput = {}
  const meta = (a.meta && typeof a.meta === 'object' ? a.meta : {}) as { history?: History[] }
  const history = [...(meta.history ?? [])]
  if (input.title !== undefined) data.title = text(input.title, 300) || a.title
  if (input.notes !== undefined) data.notes = text(input.notes, 2000) || null
  if (input.address !== undefined) data.address = text(input.address, 300) || null
  let member: { key: string; name: string } | null | undefined
  if (input.assignedUserId !== undefined) {
    member = await staffName(accountId, input.assignedUserId)
    data.assignedUserId = member?.key ?? null
    data.assignedTo = member?.name ?? null
  }

  const moving = input.start !== undefined || input.end !== undefined || input.duration !== undefined
  if (moving) {
    const length = Math.round((a.endTime.getTime() - a.startTime.getTime()) / MIN)
    const { start, end } = times({ start: input.start ?? a.startTime.toISOString(), end: input.end, duration: input.duration ?? (input.end ? null : length) }, length)
    if (!block && a.calendarId && !input.ignoreAvailability) {
      const key = member === undefined ? a.assignedUserId : (member?.key ?? null)
      const { slots, team } = await slotsFor(a.calendarId, new Date(start.getTime() - MIN), new Date(start.getTime() + MIN), { excludeAppointmentId: a.id, duration: Math.round((end.getTime() - start.getTime()) / MIN), staff: true }).catch((err) => {
        // A calendar that's been turned off can't be checked: say so, and let staff book anyway.
        if (err instanceof HlInputError && !(err instanceof BookingError)) throw new BookingError(`${err.message} Tick “Book anyway” to move it.`, 'start')
        throw err
      })
      const slot = slots.find((x) => x.start.getTime() === start.getTime())
      if (!slot || (key && team.length && a.calendar?.kind !== 'collective' && !slot.members.includes(key)))
        throw new BookingError('That time isn’t free on this calendar. Pick another time, or tick “Book anyway”.', 'start')
    }
    data.startTime = start
    data.endTime = end
    if (start.getTime() !== a.startTime.getTime()) history.push({ at: new Date().toISOString(), what: `moved by ${by}`, from: a.startTime.toISOString(), to: start.toISOString() })
  }
  if (Object.keys(data).length) {
    data.meta = asJson({ ...meta, history: history.slice(-20) })
    await prisma.hlAppointment.update({ where: { id }, data })
  }
  const moved = !block && !!data.startTime && (data.startTime as Date).getTime() !== a.startTime.getTime()
  if (moved && a.contactId) {
    const tz = (await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { timezone: true } })).timezone
    await logActivity(accountId, a.contactId, `Rescheduled ${a.calendar?.name.trim() ?? 'appointment'} (by ${by})\nfrom ${appointmentTimes({ startTime: a.startTime, timezone: tz }).full}\nto ${appointmentTimes({ startTime: data.startTime as Date, timezone: tz }).full}`, { appointmentId: id })
  }
  // Status last: it logs and fires its own automations.
  let statusChanged: string | null = null
  if (!block && input.status && input.status !== a.status) {
    await setStatus(id, input.status, by)
    statusChanged = input.status
  }
  return { statusChanged, moved }
}

/** Remove blocked-off time. Appointments are cancelled instead, so their automations stop properly. */
export async function deleteBlock(accountId: string, id: string): Promise<void> {
  const a = await prisma.hlAppointment.findFirst({ where: { id, accountId }, select: { source: true } })
  if (!a) return
  if (a.source !== 'block') throw new HlInputError('Appointments are cancelled, not deleted, so their reminders stop.')
  await prisma.hlAppointment.delete({ where: { id } })
}

/** After a staff booking: "contact created" for someone new, then "appointment booked" (blocked-off time fires nothing). */
export async function fireMadeTriggers(accountId: string, m: Made): Promise<void> {
  if (m.kind !== 'appointment' || !m.contactId) return
  if (m.created) await fireTrigger(accountId, m.contactId, { type: 'contact_created', context: { appointmentId: m.appointmentId } })
  await fireTrigger(accountId, m.contactId, { type: 'appointment_booked', calendarId: m.calendarId ?? undefined, context: { appointmentId: m.appointmentId } })
  await notifyAppointment(m.appointmentId, 'booked')
}
