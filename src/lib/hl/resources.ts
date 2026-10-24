import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { HlInputError } from './http'

/**
 * GHL's Rooms and Equipment: what a service calendar's bookings take up.
 * A room holds so many bookings at once (its capacity), and a booking on a
 * calendar with rooms takes one of them. Equipment has a quantity, less any
 * out of service, and a booking on a calendar with it takes one of each.
 * They're HlRecord rows of kind room and equipment, each listing the
 * calendars that use it (GHL's "Select calendar"). A booking's share is kept
 * in its meta.resources: { any: true, room, equipment: [ids] }.
 */

type Db = typeof prisma | Prisma.TransactionClient
export type ResourceKind = 'room' | 'equipment'

export type HlResource = {
  id: string
  kind: ResourceKind
  name: string
  description: string
  /** A room's capacity, or the equipment's total quantity. */
  quantity: number
  /** Equipment only: units that can't be booked. */
  outOfService: number
  calendarIds: string[]
  isActive: boolean
  updatedAt: string
}

/** What a booking took. */
export type Taken = { any: true; room: string | null; equipment: string[] }

const DAY = 86_400_000
const asJson = (v: unknown) => v as Prisma.InputJsonValue
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const count = (v: unknown, fallback: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 10_000) : fallback
}

function toResource(r: { id: string; kind: string; name: string; data: unknown; updatedAt: Date }): HlResource {
  const d = obj(r.data)
  return {
    id: r.id,
    kind: r.kind === 'equipment' ? 'equipment' : 'room',
    name: r.name,
    description: text(d.description, 1000),
    quantity: count(d.quantity, 1),
    outOfService: r.kind === 'equipment' ? count(d.outOfService, 0) : 0,
    calendarIds: Array.isArray(d.calendarIds) ? d.calendarIds.filter((x): x is string => typeof x === 'string') : [],
    isActive: d.isActive !== false,
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listResources(accountId: string, kind: ResourceKind, db: Db = prisma): Promise<HlResource[]> {
  const rows = await db.hlRecord.findMany({ where: { accountId, kind }, orderBy: { name: 'asc' } })
  return rows.map(toResource)
}

async function clean(accountId: string, kind: ResourceKind, raw: Record<string, unknown>, before?: HlResource) {
  const name = raw.name !== undefined ? text(raw.name, 120) : (before?.name ?? '')
  if (!name) throw new HlInputError(kind === 'room' ? 'Name the room.' : 'Name the equipment.')
  const quantity = raw.quantity !== undefined ? count(raw.quantity, -1) : (before?.quantity ?? 1)
  if (quantity < 1) throw new HlInputError(kind === 'room' ? 'A room holds at least 1.' : 'Have at least 1 of it.')
  const outOfService = kind === 'equipment' ? (raw.outOfService !== undefined ? count(raw.outOfService, 0) : (before?.outOfService ?? 0)) : 0
  if (outOfService > quantity) throw new HlInputError('More out of service than there are.')
  let calendarIds = before?.calendarIds ?? []
  if (raw.calendarIds !== undefined) {
    if (!Array.isArray(raw.calendarIds)) throw new HlInputError('Calendars must be a list.')
    const want = [...new Set(raw.calendarIds.filter((x): x is string => typeof x === 'string'))]
    const found = await prisma.hlCalendar.findMany({ where: { accountId, id: { in: want } }, select: { id: true } })
    calendarIds = want.filter((id) => found.some((f) => f.id === id))
  }
  return {
    name,
    data: {
      description: raw.description !== undefined ? text(raw.description, 1000) : (before?.description ?? ''),
      quantity,
      ...(kind === 'equipment' ? { outOfService } : {}),
      calendarIds,
      isActive: typeof raw.isActive === 'boolean' ? raw.isActive : (before?.isActive ?? true),
    },
  }
}

export async function createResource(accountId: string, kind: ResourceKind, raw: Record<string, unknown>): Promise<HlResource> {
  const { name, data } = await clean(accountId, kind, raw)
  return toResource(await prisma.hlRecord.create({ data: { accountId, kind, name, data: asJson(data) } }))
}

export async function updateResource(accountId: string, kind: ResourceKind, id: string, raw: Record<string, unknown>): Promise<HlResource> {
  const row = await prisma.hlRecord.findFirst({ where: { id, accountId, kind } })
  if (!row) throw new HlInputError(kind === 'room' ? 'Room not found.' : 'Equipment not found.')
  const { name, data } = await clean(accountId, kind, raw, toResource(row))
  return toResource(await prisma.hlRecord.update({ where: { id }, data: { name, data: asJson({ ...obj(row.data), ...data }) } }))
}

/** Bookings that took it keep their note of it; it just stops being needed. */
export async function deleteResource(accountId: string, kind: ResourceKind, id: string): Promise<void> {
  await prisma.hlRecord.deleteMany({ where: { id, accountId, kind } })
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

type Needs = { rooms: HlResource[]; equipment: HlResource[] }
type Use = { start: number; end: number; room: string | null; equipment: string[] }

/** The active rooms and equipment a calendar's bookings need. */
async function needsOf(db: Db, accountId: string, calendarId: string): Promise<Needs> {
  const rows = await db.hlRecord.findMany({ where: { accountId, kind: { in: ['room', 'equipment'] } } })
  const all = rows.map(toResource).filter((r) => r.isActive && r.calendarIds.includes(calendarId))
  return { rooms: all.filter((r) => r.kind === 'room'), equipment: all.filter((r) => r.kind === 'equipment') }
}

/** What bookings between two instants took (cancelled ones gave theirs back). */
async function usesBetween(db: Db, accountId: string, from: Date, to: Date, excludeId?: string): Promise<Use[]> {
  const rows = await db.hlAppointment.findMany({
    where: {
      accountId,
      status: { notIn: ['cancelled', 'invalid'] },
      startTime: { lt: to },
      endTime: { gt: from },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      meta: { path: ['resources', 'any'], equals: true },
    },
    select: { startTime: true, endTime: true, meta: true },
  })
  return rows.map((r) => {
    const t = obj(obj(r.meta).resources)
    return { start: r.startTime.getTime(), end: r.endTime.getTime(), room: typeof t.room === 'string' ? t.room : null, equipment: Array.isArray(t.equipment) ? t.equipment.filter((x): x is string => typeof x === 'string') : [] }
  })
}

/** The room (one with space) and equipment a booking at this time takes; false when they're in use. */
function pick(needs: Needs, uses: Use[], start: number, end: number): Taken | false {
  const during = uses.filter((u) => u.start < end && u.end > start)
  let room: string | null = null
  if (needs.rooms.length) {
    room = needs.rooms.find((r) => during.filter((u) => u.room === r.id).length < r.quantity)?.id ?? null
    if (!room) return false
  }
  for (const e of needs.equipment) if (during.filter((u) => u.equipment.includes(e.id)).length >= e.quantity - e.outOfService) return false
  return { any: true, room, equipment: needs.equipment.map((e) => e.id) }
}

/** Slots whose room and equipment are free (all of them when the calendar needs none). */
export async function slotsWithResources<S extends { start: Date; end: Date }>(db: Db, accountId: string, calendarId: string, slots: S[], excludeId?: string): Promise<S[]> {
  if (!slots.length) return slots
  const needs = await needsOf(db, accountId, calendarId)
  if (!needs.rooms.length && !needs.equipment.length) return slots
  const from = Math.min(...slots.map((s) => s.start.getTime()))
  const to = Math.max(...slots.map((s) => s.end.getTime()))
  const uses = await usesBetween(db, accountId, new Date(from - DAY), new Date(to + DAY), excludeId)
  return slots.filter((s) => pick(needs, uses, s.start.getTime(), s.end.getTime()))
}

/**
 * What a booking at this time takes, to keep in its meta.resources: null
 * when its calendar needs nothing, false when what it needs is in use.
 */
export async function resourcesFor(db: Db, accountId: string, calendarId: string | null, start: Date, end: Date, excludeId?: string): Promise<Taken | null | false> {
  if (!calendarId) return null
  const needs = await needsOf(db, accountId, calendarId)
  if (!needs.rooms.length && !needs.equipment.length) return null
  const uses = await usesBetween(db, accountId, start, end, excludeId)
  return pick(needs, uses, start.getTime(), end.getTime())
}

/** Which room a booking took, by name (for the appointment drawer). */
export async function resourceNames(accountId: string): Promise<Record<string, string>> {
  const rows = await prisma.hlRecord.findMany({ where: { accountId, kind: { in: ['room', 'equipment'] } }, select: { id: true, name: true } })
  return Object.fromEntries(rows.map((r) => [r.id, r.name]))
}
