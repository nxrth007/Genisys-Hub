import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { listGroups, listSchedules } from '@/lib/hl/calendar-records'
import { CALENDAR_TYPES, asCalendarSettings } from '@/lib/hl/calendar-shared'
import { cleanCalendarSettings } from '@/lib/hl/calendar-input'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { staffOf } from '@/lib/hl/staff'

type Ctx = { params: Promise<{ id: string; calendarId: string }> }

async function load(id: string, calendarId: string) {
  const c = await prisma.hlCalendar.findUnique({ where: { id: calendarId } })
  return c && c.accountId === id ? c : null
}

/** GET: the calendar, its staff and group choices, the schedules on it, and how many bookings it has ahead. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, calendarId } = await params
  const calendar = await load(id, calendarId)
  if (!calendar) return NextResponse.json({ error: 'Calendar not found' }, { status: 404 })
  const [staff, upcoming, groups, schedules] = await Promise.all([
    staffOf(id),
    prisma.hlAppointment.count({ where: { calendarId, startTime: { gte: new Date() }, status: { notIn: ['cancelled', 'invalid'] } } }),
    listGroups(id),
    listSchedules(id),
  ])
  return NextResponse.json({ calendar: { ...calendar, name: calendar.name.trim() }, staff, upcoming, groups, schedules: schedules.filter((s) => s.calendarIds.includes(calendarId)) })
}

/** PATCH { name?, description?, isActive?, kind?, settings? }: settings keys the editor owns are replaced, the rest kept. */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, calendarId } = await params
  const calendar = await load(id, calendarId)
  if (!calendar) return NextResponse.json({ error: 'Calendar not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    const data: Prisma.HlCalendarUpdateInput = {}
    if (body.name !== undefined) {
      const name = str(body.name)?.slice(0, 120)
      if (!name) throw new HlInputError('Name the calendar.')
      data.name = name
    }
    if (body.description !== undefined) data.description = typeof body.description === 'string' ? body.description.trim().slice(0, 2000) || null : null
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive
    if (body.kind !== undefined) {
      if (!CALENDAR_TYPES.some((t) => t.key === body.kind)) throw new HlInputError('Unknown calendar type.')
      data.kind = body.kind as string
    }
    if (body.settings !== undefined || data.kind) {
      const [staff, groups] = await Promise.all([staffOf(id), listGroups(id)])
      const keys = new Set(staff.flatMap((s) => [s.id, ...(s.ghlId ? [s.ghlId] : [])]))
      const settings = cleanCalendarSettings(body.settings ?? {}, asCalendarSettings(calendar.settings), keys, new Set(groups.map((g) => g.key)))
      if (data.kind) settings.calendarType = data.kind as string
      data.settings = settings as Prisma.InputJsonValue
    }
    const updated = await prisma.hlCalendar.update({ where: { id: calendarId }, data })
    return NextResponse.json({ calendar: updated })
  } catch (err) {
    return hlError(err, 'update calendar')
  }
}

/** DELETE: the calendar goes; its appointments stay on the contacts, with no calendar. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, calendarId } = await params
  const calendar = await load(id, calendarId)
  if (!calendar) return NextResponse.json({ error: 'Calendar not found' }, { status: 404 })
  try {
    await prisma.hlCalendar.delete({ where: { id: calendarId } })
    console.log(`[hell-level] ${guard.email} deleted calendar ${calendar.name.trim()} (${calendarId})`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'delete calendar')
  }
}
