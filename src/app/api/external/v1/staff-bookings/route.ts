import { NextRequest } from 'next/server'
import {
  getCalendarEventsInRange,
  getOpportunities,
  getPipelines,
  listSubAccounts,
} from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { readCache, writeCache } from '@/lib/staff-bookings-cache'

/**
 * GET /api/external/v1/staff-bookings?days=14&stage=
 *
 * Who booked what, attributed automatically.
 *
 * Each Lead Genisys Sales sub-account is operated by exactly one rep, so
 * the sub-account a booking lands in identifies the rep who made it —
 * no per-event assignee, no manual logging. A GHL automation in every
 * sub-account moves the lead into the booked stage the moment they take
 * a slot on one of the strategy-call calendars, which makes the pipeline
 * the single source of truth for a booking having happened.
 *
 * That holds whether the lead books the link themselves or the rep books
 * it for them on the call, because both paths end at the same calendar.
 *
 * Stage matching is by NAME, not id: every sub-account has its own
 * pipeline with its own stage ids, so an id from one is meaningless in
 * another. Names are the only thing consistent across them.
 */

type RawObj = Record<string, unknown>

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/** Default stage matcher — Alex's pipelines use "Call 1 Booked" or "Booked Meeting". */
const BOOKED_RE = /book/i

/** Pipeline to read per sub-account. Same rule the Opportunities board uses. */
const PIPELINE_RE = /contractor/i

const MAX_DAYS = 120

/** `?fresh=1` bypasses the shared cache; the refresh button sends it. */

/**
 * Attendance for a booking.
 *
 * GHL keeps show/no-show on the calendar APPOINTMENT, not on the
 * opportunity, so this has to be joined in by contact. It is also a
 * field a human sets after the call — nothing infers it — so until
 * someone starts marking appointments it reports "unmarked" rather
 * than guessing. An invented "showed" is worse than an honest blank,
 * because it would quietly corrupt any show-rate built on top of it.
 */
type Attendance = 'showed' | 'noshow' | 'cancelled' | 'upcoming' | 'unmarked'

function attendanceOf(status: string | null, startsAt: number | null): Attendance {
  const v = (status ?? '').toLowerCase().replace(/[\s_-]/g, '')
  if (v === 'showed' || v === 'attended') return 'showed'
  if (v === 'noshow') return 'noshow'
  if (v === 'cancelled' || v === 'canceled' || v === 'invalid') return 'cancelled'
  // Confirmed/new only tells us it is booked. Before it happens that is
  // simply "upcoming"; after it has happened, nobody marked it.
  if (startsAt !== null && startsAt > Date.now()) return 'upcoming'
  return 'unmarked'
}

function nameOf(o: RawObj, contact: RawObj): string | null {
  const direct =
    str(o.name) ?? str(o.opportunityName) ?? str(o.title) ?? str(o.opportunity_name)
  if (direct) return direct
  const cn =
    str(contact.name) ??
    [str(contact.firstName), str(contact.lastName)].filter(Boolean).join(' ')
  return cn || str(contact.companyName) || null
}

export const GET = withExternalApi(async (req, auth) => {
  if (!auth.user) {
    throw new Error('Staff bookings require a signed-in account.')
  }

  const params = req.nextUrl.searchParams
  const rawDays = Number(params.get('days'))
  const days =
    Number.isFinite(rawDays) && rawDays > 0 && rawDays <= MAX_DAYS
      ? Math.floor(rawDays)
      : 14
  const since = new Date(Date.now() - days * 86400_000)
  const stageOverride = (params.get('stage') ?? '').trim().toLowerCase()
  const fresh = params.get('fresh') === '1'

  const { subaccounts, errors } = await listSubAccounts()

  const cacheKey = `${days}|${stageOverride}`
  if (!fresh) {
    const hit = readCache(cacheKey)
    if (hit) return hit
  }

  // Sub-accounts run concurrently — they are separate GHL locations with
  // separate rate budgets, so one slow account no longer blocks the rest.
  // Work WITHIN an account stays sequential, which keeps the burst per
  // location small; a throttled partial result would read as "this rep
  // booked nothing", the one wrong answer this must never produce.
  const reps = await Promise.all(
    subaccounts.map(async (sub) => {
    const rep: Record<string, unknown> = {
      vaultName: sub.vaultName,
      locationName: sub.locationName,
      locationId: sub.locationId,
    }

    try {
      const pipeData = await getPipelines(sub.vaultName)
      const pipelines = (pipeData.pipelines ?? []) as Array<{
        id: string
        name: string
        stages?: Array<{ id: string; name: string }>
      }>
      // Every matching pipeline, not just the first. Sub-accounts split
      // across "Contractors (Cold Callers)" and "Contractors (SMS)", so
      // picking one arbitrarily pointed half the team at the wrong board.
      const matching = pipelines.filter((p) => PIPELINE_RE.test(p.name))
      const scanned = matching.length > 0 ? matching : pipelines.slice(0, 1)
      const pipeline = scanned[0]

      if (!pipeline) {
        rep.error = 'No pipeline found in this sub-account.'
        rep.bookings = []
        return rep
      }

      const stages = scanned.flatMap((p) => p.stages ?? [])
      const bookedStageIds = new Set(
        stages
          .filter((st) =>
            stageOverride
              ? st.name.toLowerCase().includes(stageOverride)
              : BOOKED_RE.test(st.name),
          )
          .map((st) => st.id),
      )
      const stageName = new Map(stages.map((st) => [st.id, st.name]))

      rep.pipelineName = scanned.map((p) => p.name).join(' + ')
      // Deduped: both scanned pipelines have their own "Booked Meeting"
      // stage, and listing it twice reads as a configuration error rather
      // than as the same stage existing on two boards.
      rep.bookedStages = [
        ...new Set(
          stages.filter((st) => bookedStageIds.has(st.id)).map((st) => st.name),
        ),
      ]
      // Only one pipeline per sub-account is scanned. If a booking lands
      // in another one it is invisible here and looks like it never
      // happened, so name the others rather than hiding the assumption.
      const scannedIds = new Set(scanned.map((p) => p.id))
      rep.otherPipelines = pipelines
        .filter((p) => !scannedIds.has(p.id))
        .map((p) => p.name)
      rep.allStages = stages.map((st) => st.name)

      // A sub-account whose stages don't match is reported rather than
      // silently returning zero — "no booked stage" and "no bookings"
      // look identical in a table and mean very different things.
      if (bookedStageIds.size === 0) {
        rep.error = `No stage matching ${stageOverride || 'a booked stage'}. Stages here: ${stages.map((s) => s.name).join(', ') || 'none'}`
        rep.bookings = []
        return rep
      }

      // Ask GHL only for the booked stages instead of paging through
      // every opportunity in the pipeline and discarding most of them.
      // Genisys alone carries 252 on one board; this turns three pages
      // of fetch-then-throw-away into one short page.
      const raw: RawObj[] = []
      const seen = new Set<string>()
      for (const p of scanned) {
        for (const st of (p.stages ?? []).filter((x) =>
          bookedStageIds.has(x.id),
        )) {
          const payload = await getOpportunities(sub.vaultName, {
            pipelineId: p.id,
            stageId: st.id,
            max: 500,
          })
          for (const opp of payload.opportunities as RawObj[]) {
            // If GHL ignores the stage filter we'd get the whole pipeline
            // back once per stage, so dedupe by id.
            const id = String(opp.id ?? '')
            if (id && seen.has(id)) continue
            if (id) seen.add(id)
            raw.push(opp)
          }
        }
      }

      // Appointments for this sub-account, indexed by contact. The window
      // reaches forward as well as back: a booking made today is usually
      // for a call that hasn't happened yet.
      const byContact = new Map<
        string,
        Array<{ id: string | null; start: number | null; status: string | null }>
      >()
      try {
        const { events } = await getCalendarEventsInRange(sub.vaultName, {
          start: new Date(since.getTime() - 7 * 86400_000).toISOString(),
          end: new Date(Date.now() + 90 * 86400_000).toISOString(),
        })
        for (const ev of events as RawObj[]) {
          const cid = str(ev.contactId)
          if (!cid) continue
          const startRaw = str(ev.startTime) ?? str(ev.startDate)
          const start = startRaw ? new Date(startRaw).getTime() : null
          const list = byContact.get(cid) ?? []
          list.push({
            id: str(ev.id),
            start: Number.isNaN(start as number) ? null : start,
            status: str(ev.appointmentStatus) ?? str(ev.status),
          })
          byContact.set(cid, list)
        }
      } catch {
        // No calendar access just means attendance stays unknown; the
        // bookings themselves are still correct.
      }
      rep.attendanceAvailable = byContact.size > 0

      const bookings = raw
        .filter((o) => {
          const sid = str(o.pipelineStageId) ?? str(o.stageId)
          return sid !== null && bookedStageIds.has(sid)
        })
        .map((o) => {
          const contact = (o.contact ?? {}) as RawObj
          const sid = (str(o.pipelineStageId) ?? str(o.stageId)) as string
          // updatedAt is when it entered the booked stage in practice —
          // the automation moves it on booking. createdAt is when the
          // lead first appeared, which can be much earlier.
          const bookedAt = str(o.updatedAt) ?? str(o.createdAt) ?? str(o.dateAdded)
          const cid = str(contact.id) ?? str(o.contactId)
          // Of a contact's appointments, the one that decides attendance
          // is the most recent that has already started; if none has,
          // the next upcoming one.
          const evs = (cid ? (byContact.get(cid) ?? []) : []).slice().sort(
            (x, y) => (x.start ?? 0) - (y.start ?? 0),
          )
          const now = Date.now()
          const past = evs.filter((e) => e.start !== null && e.start <= now)
          const chosen = past.length > 0 ? past[past.length - 1] : evs[0]

          return {
            id: String(o.id ?? ''),
            name: nameOf(o, contact) ?? 'Untitled',
            stage: stageName.get(sid) ?? 'Booked',
            attendance: chosen
              ? attendanceOf(chosen.status, chosen.start)
              : ('unmarked' as const),
            appointmentAt: chosen?.start
              ? new Date(chosen.start).toISOString()
              : null,
            // Needed to write the outcome back. Null means no calendar
            // event matched this contact, so attendance is read-only.
            appointmentId: chosen?.id ?? null,
            subAccount: sub.vaultName,
            status: str(o.status) ?? 'open',
            bookedAt,
            createdAt: str(o.createdAt) ?? str(o.dateAdded),
            updatedAt: str(o.updatedAt),
            contactId: str(contact.id) ?? str(o.contactId),
            contactName:
              str(contact.name) ??
              ([str(contact.firstName), str(contact.lastName)]
                .filter(Boolean)
                .join(' ') ||
                null),
            contactPhone: str(contact.phone),
            contactEmail: str(contact.email),
          }
        })
        .sort((a, b) => {
          const ta = a.bookedAt ? new Date(a.bookedAt).getTime() : 0
          const tb = b.bookedAt ? new Date(b.bookedAt).getTime() : 0
          return tb - ta
        })

      // Two counts on purpose.
      //
      // The date filter is the least trustworthy part of this: GHL's
      // updatedAt is what tells us when the automation moved a lead into
      // the booked stage, and when it's absent we fall back to createdAt
      // — which is when the LEAD was created, often months earlier. A
      // booking made yesterday on an old lead would then be silently
      // filtered out, and "0" would look like the rep did nothing.
      //
      // Reporting both makes that visible instead: 0 in-window against a
      // non-zero all-time count says the dates are wrong, not the rep.
      const tagged = bookings.map((b) => ({
        ...b,
        inWindow: b.bookedAt
          ? new Date(b.bookedAt).getTime() >= since.getTime()
          : true, // undated: count rather than drop
      }))

      // Every booking is returned, tagged, rather than the list being
      // filtered to the window. A summary that counts a record and then
      // refuses to show it is worse than not counting it: Garett's test
      // read as "0 / 1 all time" with no way to reach the 1.
      rep.bookings = tagged
      rep.total = tagged.filter((b) => b.inWindow).length
      rep.totalAllTime = tagged.length
      rep.undated = tagged.filter((b) => !b.bookedAt).length
    } catch (err) {
      rep.error = err instanceof Error ? err.message : 'Lookup failed'
      rep.bookings = []
    }

    return rep
    }),
  )

  // Includes out-of-window rows; the UI marks them. `totals.bookings`
  // stays the in-window figure so the headline number keeps its meaning.
  const allBookings = reps.flatMap((r) =>
    ((r.bookings ?? []) as RawObj[]).map((b) => ({
      ...b,
      rep: r.locationName,
      vaultName: r.vaultName,
    })),
  )

  const result = {
    window: { since: since.toISOString(), days },
    stageFilter: stageOverride || 'auto (name contains "book")',
    totals: {
      // Spreading a RawObj erases the tag's type, hence the cast.
      bookings: allBookings.filter((b) => (b as RawObj).inWindow === true)
        .length,
      bookingsAllTime: reps.reduce(
        (n, r) => n + ((r.totalAllTime as number) ?? 0),
        0,
      ),
      reps: reps.length,
      repsWithErrors: reps.filter((r) => r.error).length,
    },
    subAccountErrors: errors,
    reps,
    bookings: allBookings,
  }

  writeCache(cacheKey, result)
  return result
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
