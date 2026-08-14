import { NextRequest } from 'next/server'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError } from '@/lib/external-write'
import {
  openShift,
  clockIn,
  clockOut,
  adminCloseShift,
  listEntries,
  whoIsOn,
  canSeeAllHours,
} from '@/lib/timeclock'

/**
 * /api/external/v1/clock — staff shift clock for the CRM.
 *
 * GET  ?scope=me|all&from=&to=   status + entries in a window
 * POST { action: 'in' | 'out', note? }
 * PATCH { entryId, endAt, note? }  admin closes a forgotten shift
 *
 * The window is always supplied by the caller. The server has no
 * opinion about where a week starts, because the people using this are
 * spread across timezones and the browser is the only party that knows
 * which local week the user is looking at.
 */

/** Widest window we'll serve, so a malformed range can't scan the table. */
const MAX_WINDOW_DAYS = 120
const DEFAULT_WINDOW_MS = 14 * 86400_000

/**
 * Resolve the query window. Deliberately total — it never throws.
 *
 * withExternalApi() turns any thrown error into a bare `internal_error`
 * 500 with no message, so a typo'd date here would surface to the CRM
 * as an unexplained server failure. Falling back to the default window
 * and echoing the resolved range back in the response means a caller
 * who sent something wrong can see what they actually got.
 */
function parseWindow(url: URL): { from: Date; to: Date } {
  const valid = (raw: string | null): Date | null => {
    if (!raw) return null
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d
  }

  const to = valid(url.searchParams.get('to')) ?? new Date()
  const requested = valid(url.searchParams.get('from'))
  let from = requested ?? new Date(to.getTime() - DEFAULT_WINDOW_MS)

  // An inverted or oversized range collapses to the default rather than
  // scanning the table.
  const span = to.getTime() - from.getTime()
  if (span <= 0 || span > MAX_WINDOW_DAYS * 86400_000) {
    from = new Date(to.getTime() - DEFAULT_WINDOW_MS)
  }
  return { from, to }
}

export const GET = withExternalApi(async (req, auth) => {
  const url = new URL(req.url)
  const { from, to } = parseWindow(url)

  const isAdmin = canSeeAllHours(auth.user?.role)
  const wantsAll = url.searchParams.get('scope') === 'all'

  // The shared environment token has no person behind it, so there is
  // no "my shift" to report — it can read the roster view only.
  const me = auth.user
    ? {
        id: auth.user.id,
        name: auth.user.name,
        email: auth.user.email,
        role: auth.user.role,
      }
    : null

  const scopeAll = wantsAll && isAdmin
  const [entries, current, onNow] = await Promise.all([
    listEntries({
      from,
      to,
      ...(scopeAll || !me ? {} : { userId: me.id }),
    }),
    me ? openShift(me.id) : Promise.resolve(null),
    isAdmin ? whoIsOn() : Promise.resolve([]),
  ])

  return {
    me,
    isAdmin,
    scope: scopeAll ? 'all' : 'me',
    from: from.toISOString(),
    to: to.toISOString(),
    /** The caller's open shift, or null. Drives the big button. */
    current,
    /** Everyone on the clock right now. Admin-only; [] otherwise. */
    onNow,
    entries,
  }
})

export const POST = externalWrite(async ({ auth, body }) => {
  const action = String(body.action ?? '').toLowerCase()

  if (action === 'in') {
    return { entry: await clockIn(auth.user.id) }
  }

  if (action === 'out') {
    const note = typeof body.note === 'string' ? body.note : null
    try {
      return { entry: await clockOut(auth.user.id, note) }
    } catch (err) {
      if (err instanceof Error && err.message === 'NOT_CLOCKED_IN') {
        throw new WriteError("You're not clocked in right now.", 409)
      }
      throw err
    }
  }

  throw new WriteError("action must be 'in' or 'out'", 400)
})

export const PATCH = externalWrite(async ({ auth, body }) => {
  if (!canSeeAllHours(auth.user.role)) {
    throw new WriteError('Only an admin can edit someone else’s shift.', 403)
  }

  const entryId = String(body.entryId ?? '').trim()
  if (!entryId) throw new WriteError('entryId is required', 400)

  const endAt = body.endAt ? new Date(String(body.endAt)) : new Date()
  if (Number.isNaN(endAt.getTime())) {
    throw new WriteError('endAt must be an ISO timestamp', 400)
  }

  const note = typeof body.note === 'string' ? body.note : null
  try {
    return { entry: await adminCloseShift(entryId, auth.user.id, endAt, note) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg === 'NOT_FOUND') throw new WriteError('Shift not found.', 404)
    if (msg === 'ALREADY_CLOSED') {
      throw new WriteError('That shift is already closed.', 409)
    }
    if (msg === 'END_BEFORE_START') {
      throw new WriteError('Clock-out cannot be before clock-in.', 400)
    }
    throw err
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
