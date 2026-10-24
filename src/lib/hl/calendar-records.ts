import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { cleanOpenHours, cleanOverrides } from './calendar-input'
import { asCalendarSettings, defaultCalendarPrefs, type HlCalendarGroup, type HlCalendarPrefs, type HlSchedule } from './calendar-shared'
import { HlInputError } from './http'
import type { MemberHours } from './slots'
import { staffOf } from './staff'

/**
 * GHL's calendar settings that aren't a calendar: calendar groups, the team's
 * schedules (Availability) and the Preferences. Kept as HlRecord rows of kind
 * calendar_group, schedule and calendar_prefs.
 */

type Db = typeof prisma | Prisma.TransactionClient

const asJson = (v: unknown) => v as Prisma.InputJsonValue
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** "Free Estimates!" → "free-estimates". */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'group'

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function toGroup(r: { id: string; ghlId: string | null; name: string; data: unknown }): HlCalendarGroup {
  const d = obj(r.data)
  return { id: r.id, key: r.ghlId ?? r.id, name: r.name, description: text(d.description, 500), slug: text(d.slug, 60) || slugify(r.name), isActive: d.isActive !== false, ghlId: r.ghlId }
}

export async function listGroups(accountId: string, db: Db = prisma): Promise<HlCalendarGroup[]> {
  const rows = await db.hlRecord.findMany({ where: { accountId, kind: 'calendar_group' }, orderBy: { name: 'asc' } })
  return rows.map(toGroup)
}

async function uniqueSlug(accountId: string, want: string, exceptId?: string): Promise<string> {
  const taken = new Set((await listGroups(accountId)).filter((g) => g.id !== exceptId).map((g) => g.slug))
  let slug = slugify(want)
  for (let i = 2; taken.has(slug); i++) slug = `${slugify(want)}-${i}`
  return slug
}

export async function createGroup(accountId: string, raw: Record<string, unknown>): Promise<HlCalendarGroup> {
  const name = text(raw.name, 120)
  if (!name) throw new HlInputError('Name the group.')
  const slug = await uniqueSlug(accountId, text(raw.slug, 60) || name)
  const row = await prisma.hlRecord.create({ data: { accountId, kind: 'calendar_group', name, data: asJson({ description: text(raw.description, 500), slug, isActive: true }) } })
  return toGroup(row)
}

export async function updateGroup(accountId: string, id: string, raw: Record<string, unknown>): Promise<HlCalendarGroup> {
  const row = await prisma.hlRecord.findFirst({ where: { id, accountId, kind: 'calendar_group' } })
  if (!row) throw new HlInputError('Group not found.')
  const d = obj(row.data)
  const name = raw.name !== undefined ? text(raw.name, 120) : row.name
  if (!name) throw new HlInputError('Name the group.')
  const data = {
    ...d,
    ...(raw.description !== undefined ? { description: text(raw.description, 500) } : {}),
    ...(raw.slug !== undefined ? { slug: await uniqueSlug(accountId, text(raw.slug, 60) || name, id) } : {}),
    ...(typeof raw.isActive === 'boolean' ? { isActive: raw.isActive } : {}),
  }
  return toGroup(await prisma.hlRecord.update({ where: { id }, data: { name, data: asJson(data) } }))
}

/** Delete a group; its calendars stay, ungrouped. */
export async function deleteGroup(accountId: string, id: string): Promise<void> {
  const row = await prisma.hlRecord.findFirst({ where: { id, accountId, kind: 'calendar_group' } })
  if (!row) return
  const key = row.ghlId ?? row.id
  const calendars = await prisma.hlCalendar.findMany({ where: { accountId }, select: { id: true, settings: true } })
  for (const c of calendars) {
    const s = asCalendarSettings(c.settings)
    if (s.groupId !== key) continue
    delete s.groupId
    await prisma.hlCalendar.update({ where: { id: c.id }, data: { settings: asJson(s) } })
  }
  await prisma.hlRecord.delete({ where: { id } })
}

// ---------------------------------------------------------------------------
// Schedules (Availability)
// ---------------------------------------------------------------------------

function toSchedule(r: { id: string; name: string; data: unknown }): HlSchedule {
  const d = obj(r.data)
  return {
    id: r.id,
    userId: text(d.userId, 80),
    name: r.name,
    timezone: text(d.timezone, 60) || 'America/New_York',
    isDefault: d.isDefault === true,
    openHours: Array.isArray(d.openHours) ? (d.openHours as HlSchedule['openHours']) : [],
    availabilities: Array.isArray(d.availabilities) ? (d.availabilities as HlSchedule['availabilities']) : [],
    calendarIds: Array.isArray(d.calendarIds) ? (d.calendarIds as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  }
}

export async function listSchedules(accountId: string, db: Db = prisma): Promise<HlSchedule[]> {
  const rows = await db.hlRecord.findMany({ where: { accountId, kind: 'schedule' }, orderBy: { createdAt: 'asc' } })
  return rows.map(toSchedule)
}

const NINE_TO_FIVE = [1, 2, 3, 4, 5].map((d) => ({ daysOfTheWeek: [d], hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }] }))

/** Save a schedule (new without an id). A calendar takes one schedule per member, so it leaves the member's others. */
export async function saveSchedule(accountId: string, raw: Record<string, unknown>, id?: string): Promise<HlSchedule> {
  const all = await listSchedules(accountId)
  const before = id ? all.find((s) => s.id === id) : undefined
  if (id && !before) throw new HlInputError('Schedule not found.')
  const staff = await staffOf(accountId)
  const userId = before?.userId ?? text(raw.userId, 80)
  if (!staff.some((m) => m.id === userId || m.ghlId === userId)) throw new HlInputError('Pick a team member for the schedule.')
  const name = raw.name !== undefined ? text(raw.name, 80) : (before?.name ?? 'Working hours')
  if (!name) throw new HlInputError('Name the schedule.')
  const timezone = raw.timezone !== undefined ? text(raw.timezone, 60) : (before?.timezone ?? 'America/New_York')
  if (!isTimeZone(timezone)) throw new HlInputError('Pick a timezone.')
  const calendarIds =
    raw.calendarIds !== undefined
      ? await (async () => {
          const ids = (Array.isArray(raw.calendarIds) ? raw.calendarIds : []).filter((x): x is string => typeof x === 'string')
          const real = await prisma.hlCalendar.findMany({ where: { accountId, id: { in: ids } }, select: { id: true } })
          return real.map((c) => c.id)
        })()
      : (before?.calendarIds ?? [])
  const mine = all.filter((s) => s.userId === userId && s.id !== id)
  const data = {
    userId,
    timezone,
    isDefault: before?.isDefault ?? !mine.length,
    openHours: raw.openHours !== undefined ? cleanOpenHours(raw.openHours) : (before?.openHours ?? NINE_TO_FIVE),
    availabilities: raw.availabilities !== undefined ? cleanOverrides(raw.availabilities) : (before?.availabilities ?? []),
    calendarIds,
  }
  const saved = await prisma.$transaction(async (tx) => {
    for (const other of mine) {
      if (!other.calendarIds.some((c) => calendarIds.includes(c))) continue
      const left = other.calendarIds.filter((c) => !calendarIds.includes(c))
      const row = await tx.hlRecord.findUniqueOrThrow({ where: { id: other.id } })
      await tx.hlRecord.update({ where: { id: other.id }, data: { data: asJson({ ...obj(row.data), calendarIds: left }) } })
    }
    return id
      ? tx.hlRecord.update({ where: { id }, data: { name, data: asJson(data) } })
      : tx.hlRecord.create({ data: { accountId, kind: 'schedule', name, data: asJson(data) } })
  })
  return toSchedule(saved)
}

/** Delete a schedule; the calendars it was on go back to their own hours for that member. */
export async function deleteSchedule(accountId: string, id: string): Promise<void> {
  const all = await listSchedules(accountId)
  const s = all.find((x) => x.id === id)
  if (!s) return
  await prisma.hlRecord.delete({ where: { id } })
  // The member's next schedule becomes the default.
  const next = s.isDefault ? all.find((x) => x.userId === s.userId && x.id !== id) : undefined
  if (next) {
    const row = await prisma.hlRecord.findUniqueOrThrow({ where: { id: next.id } })
    await prisma.hlRecord.update({ where: { id: next.id }, data: { data: asJson({ ...obj(row.data), isDefault: true }) } })
  }
}

/** The team members whose schedule sets their hours on a calendar. */
export async function scheduleHoursFor(accountId: string, calendarId: string, members: string[], db: Db = prisma): Promise<Map<string, MemberHours>> {
  const out = new Map<string, MemberHours>()
  if (!members.length) return out
  for (const s of await listSchedules(accountId, db)) {
    if (!members.includes(s.userId) || !s.calendarIds.includes(calendarId) || out.has(s.userId)) continue
    out.set(s.userId, { hours: { openHours: s.openHours, availabilities: s.availabilities }, timezone: s.timezone })
  }
  return out
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function getPrefs(accountId: string): Promise<HlCalendarPrefs> {
  const row = await prisma.hlRecord.findFirst({ where: { accountId, kind: 'calendar_prefs' } })
  const d = obj(row?.data)
  const base = defaultCalendarPrefs()
  return {
    weekStartsOn: Number.isInteger(d.weekStartsOn) && (d.weekStartsOn as number) >= 0 && (d.weekStartsOn as number) <= 6 ? (d.weekStartsOn as number) : base.weekStartsOn,
    timeFormat: d.timeFormat === '24h' ? '24h' : '12h',
    widgetLanguage: text(d.widgetLanguage, 10) || base.widgetLanguage,
    services: { ...base.services, ...(obj(d.services) as Partial<HlCalendarPrefs['services']>) },
    users: obj(d.users) as HlCalendarPrefs['users'],
  }
}

/** Save the sub-account's preferences and the signed-in user's own (meeting location, timezone). */
export async function savePrefs(accountId: string, raw: Record<string, unknown>, userEmail: string): Promise<HlCalendarPrefs> {
  const cur = await getPrefs(accountId)
  const next: HlCalendarPrefs = { ...cur }
  if (raw.weekStartsOn !== undefined) {
    const w = Number(raw.weekStartsOn)
    if (!Number.isInteger(w) || w < 0 || w > 6) throw new HlInputError('Pick the day the week starts on.')
    next.weekStartsOn = w
  }
  if (raw.timeFormat !== undefined) next.timeFormat = raw.timeFormat === '24h' ? '24h' : '12h'
  if (raw.widgetLanguage !== undefined) next.widgetLanguage = text(raw.widgetLanguage, 10) || 'en'
  if (raw.services !== undefined) {
    const s = obj(raw.services)
    next.services = { serviceMenu: s.serviceMenu === true, rooms: s.rooms === true, equipment: s.equipment === true }
  }
  if (raw.me !== undefined) {
    const me = obj(raw.me)
    const timezone = text(me.timezone, 60)
    if (timezone && !isTimeZone(timezone)) throw new HlInputError('Pick a timezone.')
    next.users = { ...cur.users, [userEmail]: { meetingLocation: text(me.meetingLocation, 300) || undefined, timezone: timezone || undefined } }
  }
  const row = await prisma.hlRecord.findFirst({ where: { accountId, kind: 'calendar_prefs' } })
  if (row) await prisma.hlRecord.update({ where: { id: row.id }, data: { data: asJson(next) } })
  else await prisma.hlRecord.create({ data: { accountId, kind: 'calendar_prefs', name: 'Calendar preferences', data: asJson(next) } })
  return next
}
