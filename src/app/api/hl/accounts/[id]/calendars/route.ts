import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { listGroups } from '@/lib/hl/calendar-records'
import { CALENDAR_TYPES, asCalendarSettings, defaultCalendarSettings, type HlCalendarSettings } from '@/lib/hl/calendar-shared'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { staffOf } from '@/lib/hl/staff'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the sub-account's calendars (with upcoming bookings), its calendar groups, and its staff (for calendar teams). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const [calendars, upcoming, staff, groups] = await Promise.all([
    prisma.hlCalendar.findMany({ where: { accountId: id }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
    prisma.hlAppointment.groupBy({ by: ['calendarId'], where: { accountId: id, startTime: { gte: new Date() }, status: { notIn: ['cancelled', 'invalid'] } }, _count: { _all: true } }),
    staffOf(id),
    listGroups(id),
  ])
  return NextResponse.json({
    calendars: calendars.map((c) => ({ ...c, name: c.name.trim(), upcoming: upcoming.find((u) => u.calendarId === c.id)?._count._all ?? 0 })),
    staff,
    groups,
  })
}

/** What a new calendar of each type starts with (GHL's defaults for it). */
function forType(kind: string, s: HlCalendarSettings, staffKeys: string[]): HlCalendarSettings {
  const members = (keys: string[]) => keys.map((userId, i) => ({ userId, priority: 1, selected: true, isPrimary: i === 0 }))
  switch (kind) {
    case 'personal':
      return { ...s, calendarType: kind, teamMembers: members(staffKeys.slice(0, 1)) }
    case 'class_booking':
      return { ...s, calendarType: kind, teamMembers: members(staffKeys.slice(0, 1)), appointmentPerSlot: 10, slotDuration: 60, slotInterval: 60 }
    case 'collective':
      return { ...s, calendarType: kind, teamMembers: members(staffKeys.slice(0, 2)) }
    case 'event':
      return { ...s, calendarType: kind, teamMembers: [], appointmentPerSlot: 25, slotDuration: 60, slotInterval: 60 }
    default:
      return { ...s, calendarType: kind, teamMembers: members(staffKeys.length === 1 ? staffKeys : []) }
  }
}

/**
 * POST { name, kind?, groupId? }: a new booking calendar (Monday to Friday 9-5),
 * set up for its type. POST { cloneOf, name? }: a copy of a calendar, off until
 * it's turned on.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const cloneOf = str(body.cloneOf)
    if (cloneOf) {
      const src = await prisma.hlCalendar.findUnique({ where: { id: cloneOf } })
      if (!src || src.accountId !== id) throw new HlInputError('Calendar not found.')
      const name = (str(body.name) ?? `${src.name.trim()} (copy)`).slice(0, 120)
      const settings = asCalendarSettings(src.settings)
      // A copy is Hell-level's own: no GHL ids or slugs carried over.
      for (const k of ['id', 'locationId', 'slug', 'widgetSlug'] as const) delete (settings as Record<string, unknown>)[k]
      const calendar = await prisma.hlCalendar.create({ data: { accountId: id, name, description: src.description, kind: src.kind, isActive: false, settings: settings as Prisma.InputJsonValue } })
      return NextResponse.json({ calendar })
    }
    const name = str(body.name)?.slice(0, 120)
    if (!name) throw new HlInputError('Name the calendar.')
    const kind = CALENDAR_TYPES.some((t) => t.key === body.kind) ? (body.kind as string) : 'round_robin'
    const staff = await staffOf(id)
    const settings = forType(kind, defaultCalendarSettings(), staff.map((s) => s.ghlId ?? s.id))
    const groupId = str(body.groupId)
    if (groupId) {
      if (!(await listGroups(id)).some((g) => g.key === groupId)) throw new HlInputError('That group isn’t in this sub-account.')
      settings.groupId = groupId
    }
    const calendar = await prisma.hlCalendar.create({ data: { accountId: id, name, kind, isActive: true, settings: settings as Prisma.InputJsonValue } })
    return NextResponse.json({ calendar })
  } catch (err) {
    return hlError(err, 'create calendar')
  }
}
