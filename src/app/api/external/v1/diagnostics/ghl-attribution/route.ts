import { NextRequest } from 'next/server'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import {
  listSubAccounts,
  getLocationUsers,
  getCalendarEventsInRange,
} from '@/lib/ghl'
import { canSeeAllHours } from '@/lib/timeclock'

/**
 * GET /api/external/v1/diagnostics/ghl-attribution
 *
 * One-shot, read-only diagnostic answering a single question:
 * **can we tell which rep booked a given appointment?**
 *
 * The Lead Genisys Sales sub-accounts each appear to hold exactly one
 * rep, which would make the sub-account the unit of attribution — no
 * per-event assignedUserId needed. That is a reading of five screenshots,
 * not a verified fact, and the scoreboard would be built on top of it.
 * So this checks it against live data before anything depends on it.
 *
 * Three things it establishes:
 *   1. How many users each sub-account actually has (1 = clean attribution)
 *   2. Whether appointments are spread across rep sub-accounts or pooled
 *      into one shared closer calendar
 *   3. Whether events carry a usable assignedUserId anyway, as a fallback
 *
 * Admin-only, and writes nothing.
 */

/** Days of calendar history to sample. Enough to see a real pattern. */
const LOOKBACK_DAYS = 30
/** Per sub-account cap on returned event samples, to keep the payload sane. */
const SAMPLE_LIMIT = 5

type EventLike = Record<string, unknown>

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : null

export const GET = withExternalApi(async (req, auth) => {
  if (!canSeeAllHours(auth.user?.role)) {
    return { error: 'Admins only.', subAccounts: [] }
  }

  const url = new URL(req.url)
  const days = Number(url.searchParams.get('days')) || LOOKBACK_DAYS
  const end = new Date()
  const start = new Date(end.getTime() - days * 86400_000)

  const { subaccounts, errors } = await listSubAccounts()

  // Sequential per sub-account. GHL rate-limits aggressively and this is a
  // one-shot diagnostic — being slow is fine, being throttled into a
  // half-empty answer is not, because a missing result here looks
  // identical to "this rep books nothing".
  const rows = []
  for (const sub of subaccounts) {
    const row: Record<string, unknown> = {
      vaultName: sub.vaultName,
      locationName: sub.locationName,
      locationId: sub.locationId,
    }

    try {
      const uData = await getLocationUsers(sub.vaultName)
      const users = (uData.users ?? []) as Array<Record<string, unknown>>
      row.userCount = users.length
      row.users = users.map((u) => {
        // GHL returns either a single `name` or first/last separately,
        // depending on how the user was created.
        const composed = [str(u.firstName), str(u.lastName)]
          .filter(Boolean)
          .join(' ')
        return {
          id: str(u.id),
          name: str(u.name) ?? (composed.length > 0 ? composed : null),
          email: str(u.email),
          roles: u.roles ?? null,
        }
      })
    } catch (err) {
      row.usersError = err instanceof Error ? err.message : 'lookup failed'
      row.userCount = null
      row.users = []
    }

    try {
      const { events, calendars } = await getCalendarEventsInRange(
        sub.vaultName,
        { start: start.toISOString(), end: end.toISOString() },
      )
      const evs = events as EventLike[]

      // The heart of it: do events name a user, and how many distinct ones?
      const assigned = new Set<string>()
      let withAssignee = 0
      for (const e of evs) {
        const id = str(e.assignedUserId) ?? str(e.userId)
        if (id) {
          assigned.add(id)
          withAssignee++
        }
      }

      row.calendarCount = calendars.length
      row.calendars = calendars.map((c) => ({ id: c.id, name: c.name }))
      row.eventCount = evs.length
      row.eventsWithAssignedUser = withAssignee
      row.distinctAssignedUserIds = [...assigned]
      row.sampleEvents = evs.slice(-SAMPLE_LIMIT).map((e) => ({
        id: str(e.id),
        title: str(e.title),
        startTime: str(e.startTime),
        calendarName: str(e.calendarName),
        assignedUserId: str(e.assignedUserId) ?? str(e.userId),
        contactId: str(e.contactId),
        appointmentStatus: str(e.appointmentStatus) ?? str(e.status),
        /** Every key GHL returned, so a useful field we didn't think to
         *  read shows up here instead of being silently dropped. */
        availableKeys: Object.keys(e).sort(),
      }))
    } catch (err) {
      row.eventsError = err instanceof Error ? err.message : 'lookup failed'
      row.eventCount = null
    }

    rows.push(row)
  }

  // Read the answer off the data rather than making Alex do it by eye.
  const withCounts = rows.filter((r) => typeof r.userCount === 'number')
  const oneUserEach =
    withCounts.length > 0 && withCounts.every((r) => r.userCount === 1)
  const withEvents = rows.filter(
    (r) => typeof r.eventCount === 'number' && (r.eventCount as number) > 0,
  )
  const totalEvents = rows.reduce(
    (n, r) => n + (typeof r.eventCount === 'number' ? r.eventCount : 0),
    0,
  )
  const anyAssignee = rows.some(
    (r) => ((r.eventsWithAssignedUser as number) ?? 0) > 0,
  )

  let attribution: string
  if (totalEvents === 0) {
    attribution =
      'INCONCLUSIVE — no calendar events in the window. Either nothing is being booked into GHL calendars, or bookings live somewhere this does not look. Try a longer ?days= window before drawing conclusions.'
  } else if (withEvents.length === 1) {
    attribution =
      'POOLED — every appointment sits on one sub-account. Attribution by sub-account will NOT work; it has to come from assignedUserId or the contact owner.'
  } else if (oneUserEach) {
    attribution =
      'PER-REP — appointments are spread across sub-accounts and each holds exactly one user, so the sub-account identifies the rep. Sub-account attribution works.'
  } else {
    attribution =
      'MIXED — appointments span several sub-accounts but at least one holds more than a single user, so the sub-account alone does not identify a rep. Check assignedUserId coverage below.'
  }

  return {
    window: { start: start.toISOString(), end: end.toISOString(), days },
    verdict: {
      attribution,
      everySubAccountHasExactlyOneUser: oneUserEach,
      subAccountsWithEvents: withEvents.length,
      totalEvents,
      eventsCarryAssignedUserId: anyAssignee,
    },
    subAccountErrors: errors,
    subAccounts: rows,
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
