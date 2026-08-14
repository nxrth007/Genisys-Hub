import { prisma } from './prisma'

/**
 * Shift clock for CRM staff.
 *
 * The whole model is one row per shift with a nullable `clockOutAt`, so
 * "is this person on the clock" is a single indexed lookup rather than
 * a state column that can drift out of sync with the rows it describes.
 *
 * Times are stored UTC and returned as ISO strings. Nothing here does
 * timezone math: Mary is ~7 hours off US Eastern, so "this week" means
 * something different depending on who is asking, and the only party
 * who knows the right answer is the browser rendering it. Callers pass
 * an explicit `from`/`to` window; the server just filters.
 */

/** Roles that may see everyone's hours. Matches the Hub's owner set. */
const ADMIN_ROLES = new Set(['admin', 'member'])

export function canSeeAllHours(role: string | null | undefined): boolean {
  return ADMIN_ROLES.has((role ?? '').toLowerCase())
}

export type ClockEntry = {
  id: string
  userId: string
  userName: string | null
  userEmail: string
  clockInAt: string
  clockOutAt: string | null
  /** Elapsed minutes; for an open shift, minutes so far. */
  minutes: number
  open: boolean
  note: string | null
  closedByAdmin: boolean
}

const ENTRY_SELECT = {
  id: true,
  userId: true,
  clockInAt: true,
  clockOutAt: true,
  note: true,
  closedByAdminId: true,
  user: { select: { name: true, email: true } },
} as const

type RawEntry = {
  id: string
  userId: string
  clockInAt: Date
  clockOutAt: Date | null
  note: string | null
  closedByAdminId: string | null
  user: { name: string | null; email: string }
}

function shape(e: RawEntry, now = Date.now()): ClockEntry {
  const end = e.clockOutAt ? e.clockOutAt.getTime() : now
  return {
    id: e.id,
    userId: e.userId,
    userName: e.user.name,
    userEmail: e.user.email,
    clockInAt: e.clockInAt.toISOString(),
    clockOutAt: e.clockOutAt ? e.clockOutAt.toISOString() : null,
    // Clamp at zero. Clock skew between the app server and Postgres can
    // otherwise render a shift that started "in the future" as negative.
    minutes: Math.max(0, Math.round((end - e.clockInAt.getTime()) / 60000)),
    open: e.clockOutAt === null,
    note: e.note,
    closedByAdmin: e.closedByAdminId !== null,
  }
}

/** The caller's currently-open shift, if any. */
export async function openShift(userId: string): Promise<ClockEntry | null> {
  const row = await prisma.timeEntry.findFirst({
    where: { userId, clockOutAt: null },
    orderBy: { clockInAt: 'desc' },
    select: ENTRY_SELECT,
  })
  return row ? shape(row) : null
}

/**
 * Start a shift.
 *
 * Returns the existing shift instead of throwing when one is already
 * open. A double-tap on a phone, or the same person with the CRM open
 * in two tabs, is not an error worth showing a human — it just means
 * they are already clocked in, which is the state they wanted.
 */
export async function clockIn(userId: string): Promise<ClockEntry> {
  const existing = await openShift(userId)
  if (existing) return existing

  const row = await prisma.timeEntry.create({
    data: { userId, clockInAt: new Date() },
    select: ENTRY_SELECT,
  })
  return shape(row)
}

/**
 * End the caller's open shift.
 *
 * Throws when nothing is open — unlike clockIn, that genuinely is a
 * mistake worth surfacing, because the person believes they were on the
 * clock and were not, and silently succeeding would hide lost hours.
 */
export async function clockOut(
  userId: string,
  note?: string | null,
): Promise<ClockEntry> {
  const existing = await prisma.timeEntry.findFirst({
    where: { userId, clockOutAt: null },
    orderBy: { clockInAt: 'desc' },
    select: { id: true },
  })
  if (!existing) return Promise.reject(new Error('NOT_CLOCKED_IN'))

  const trimmed = (note ?? '').trim()
  const row = await prisma.timeEntry.update({
    where: { id: existing.id },
    data: {
      clockOutAt: new Date(),
      note: trimmed ? trimmed.slice(0, 500) : null,
    },
    select: ENTRY_SELECT,
  })
  return shape(row)
}

/**
 * Close someone else's shift, as an admin.
 *
 * People forget to clock out. Without this the row stays open forever
 * and its running total climbs into the hundreds of hours, poisoning
 * every weekly summary that includes it. Flagged via `closedByAdminId`
 * so a corrected shift is visibly distinguishable from a self-reported
 * one when someone asks why the number changed.
 */
export async function adminCloseShift(
  entryId: string,
  adminId: string,
  endAt: Date,
  note?: string | null,
): Promise<ClockEntry> {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: entryId },
    select: { id: true, clockInAt: true, clockOutAt: true },
  })
  if (!entry) return Promise.reject(new Error('NOT_FOUND'))
  if (entry.clockOutAt) return Promise.reject(new Error('ALREADY_CLOSED'))
  if (endAt.getTime() < entry.clockInAt.getTime()) {
    return Promise.reject(new Error('END_BEFORE_START'))
  }

  const trimmed = (note ?? '').trim()
  const row = await prisma.timeEntry.update({
    where: { id: entryId },
    data: {
      clockOutAt: endAt,
      closedByAdminId: adminId,
      note: trimmed ? trimmed.slice(0, 500) : null,
    },
    select: ENTRY_SELECT,
  })
  return shape(row)
}

/**
 * Shifts overlapping [from, to).
 *
 * Overlap, not containment: a shift that starts Sunday night and ends
 * Monday morning belongs to both weeks, and a query that only matched
 * `clockInAt` would drop it from one of them.
 */
export async function listEntries(opts: {
  from: Date
  to: Date
  userId?: string
}): Promise<ClockEntry[]> {
  const rows = await prisma.timeEntry.findMany({
    where: {
      ...(opts.userId ? { userId: opts.userId } : {}),
      clockInAt: { lt: opts.to },
      OR: [{ clockOutAt: null }, { clockOutAt: { gt: opts.from } }],
    },
    orderBy: { clockInAt: 'desc' },
    take: 1000,
    select: ENTRY_SELECT,
  })
  const now = Date.now()
  return rows.map((r) => shape(r, now))
}

/** Everyone currently on the clock — the admin "who's working" strip. */
export async function whoIsOn(): Promise<ClockEntry[]> {
  const rows = await prisma.timeEntry.findMany({
    where: { clockOutAt: null },
    orderBy: { clockInAt: 'asc' },
    select: ENTRY_SELECT,
  })
  const now = Date.now()
  return rows.map((r) => shape(r, now))
}
