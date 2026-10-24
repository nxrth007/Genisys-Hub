import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { defaultCalendarSettings } from '@/lib/hl/calendar-shared'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { staffOf } from '@/lib/hl/staff'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the sub-account's calendars (with upcoming bookings) and its staff (for calendar teams). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const [calendars, upcoming, staff] = await Promise.all([
    prisma.hlCalendar.findMany({ where: { accountId: id }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
    prisma.hlAppointment.groupBy({ by: ['calendarId'], where: { accountId: id, startTime: { gte: new Date() }, status: { notIn: ['cancelled', 'invalid'] } }, _count: { _all: true } }),
    staffOf(id),
  ])
  return NextResponse.json({
    calendars: calendars.map((c) => ({ ...c, name: c.name.trim(), upcoming: upcoming.find((u) => u.calendarId === c.id)?._count._all ?? 0 })),
    staff,
  })
}

/** POST { name }: a new booking calendar, Monday to Friday 9-5, 30-minute slots. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const name = str(body.name)?.slice(0, 120)
    if (!name) throw new HlInputError('Name the calendar.')
    const settings = defaultCalendarSettings()
    // One person on staff: they take the bookings.
    const staff = await staffOf(id)
    if (staff.length === 1) settings.teamMembers = [{ userId: staff[0].ghlId ?? staff[0].id, priority: 1, selected: true }]
    const calendar = await prisma.hlCalendar.create({ data: { accountId: id, name, kind: 'round_robin', isActive: true, settings: settings as Prisma.InputJsonValue } })
    return NextResponse.json({ calendar })
  } catch (err) {
    return hlError(err, 'create calendar')
  }
}
