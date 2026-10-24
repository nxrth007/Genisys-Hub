import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { asCalendarSettings } from '@/lib/hl/calendar-shared'
import { cleanCalendarSettings } from '@/lib/hl/calendar-input'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { staffOf } from '@/lib/hl/staff'

type Ctx = { params: Promise<{ id: string; calendarId: string }> }

async function load(id: string, calendarId: string) {
  const c = await prisma.hlCalendar.findUnique({ where: { id: calendarId } })
  return c && c.accountId === id ? c : null
}

/** GET: the calendar, its staff choices and how many bookings it has ahead. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, calendarId } = await params
  const calendar = await load(id, calendarId)
  if (!calendar) return NextResponse.json({ error: 'Calendar not found' }, { status: 404 })
  const [staff, upcoming] = await Promise.all([
    staffOf(id),
    prisma.hlAppointment.count({ where: { calendarId, startTime: { gte: new Date() }, status: { notIn: ['cancelled', 'invalid'] } } }),
  ])
  return NextResponse.json({ calendar: { ...calendar, name: calendar.name.trim() }, staff, upcoming })
}

/** PATCH { name?, description?, isActive?, settings? }: settings keys the editor owns are replaced, the rest kept. */
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
    if (body.settings !== undefined) {
      const staff = await staffOf(id)
      const keys = new Set(staff.flatMap((s) => [s.id, ...(s.ghlId ? [s.ghlId] : [])]))
      data.settings = cleanCalendarSettings(body.settings, asCalendarSettings(calendar.settings), keys) as Prisma.InputJsonValue
    }
    const updated = await prisma.hlCalendar.update({ where: { id: calendarId }, data })
    return NextResponse.json({ calendar: updated })
  } catch (err) {
    return hlError(err, 'update calendar')
  }
}
