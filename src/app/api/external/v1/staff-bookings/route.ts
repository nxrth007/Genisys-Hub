import { NextRequest } from 'next/server'
import { getOpportunities, getPipelines, listSubAccounts } from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'

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
  const find = (params.get('find') ?? '').trim().toLowerCase()

  const { subaccounts, errors } = await listSubAccounts()

  /**
   * `?find=` — locate a record regardless of every filter above.
   *
   * Exists because "a booking I know happened isn't in the table" has
   * four plausible causes (wrong pipeline, unmatched stage name, outside
   * the window, wrong sub-account) and they are indistinguishable from
   * the outside. This searches every sub-account, every pipeline, every
   * stage, with no date cutoff, and reports exactly where the record
   * lives — so the cause is read off evidence instead of guessed at.
   */
  if (find) {
    const hits = []
    for (const sub of subaccounts) {
      try {
        const pipeData = await getPipelines(sub.vaultName)
        const pipelines = (pipeData.pipelines ?? []) as Array<{
          id: string
          name: string
          stages?: Array<{ id: string; name: string }>
        }>
        for (const p of pipelines) {
          const stageName = new Map(
            (p.stages ?? []).map((st) => [st.id, st.name]),
          )
          const payload = await getOpportunities(sub.vaultName, {
            pipelineId: p.id,
            max: 1000,
          })
          for (const o of payload.opportunities as RawObj[]) {
            const contact = (o.contact ?? {}) as RawObj
            const title = nameOf(o, contact) ?? ''
            const hay = [
              title,
              str(contact.name) ?? '',
              str(contact.firstName) ?? '',
              str(contact.lastName) ?? '',
              str(contact.email) ?? '',
              str(contact.phone) ?? '',
            ]
              .join(' ')
              .toLowerCase()
            if (!hay.includes(find)) continue
            const sid = str(o.pipelineStageId) ?? str(o.stageId)
            hits.push({
              name: title || 'Untitled',
              subAccount: sub.locationName,
              vaultName: sub.vaultName,
              pipeline: p.name,
              stage: (sid && stageName.get(sid)) || sid || 'unknown',
              stageMatchesBookedFilter: Boolean(
                sid &&
                  (stageOverride
                    ? (stageName.get(sid) ?? '')
                        .toLowerCase()
                        .includes(stageOverride)
                    : BOOKED_RE.test(stageName.get(sid) ?? '')),
              ),
              pipelineIsScanned: PIPELINE_RE.test(p.name),
              createdAt: str(o.createdAt) ?? str(o.dateAdded),
              updatedAt: str(o.updatedAt),
              withinWindow:
                new Date(
                  str(o.updatedAt) ?? str(o.createdAt) ?? 0,
                ).getTime() >= since.getTime(),
            })
          }
        }
      } catch {
        // A sub-account we can't read simply contributes no hits.
      }
    }
    return {
      find,
      hits,
      hint:
        hits.length === 0
          ? 'No opportunity matched anywhere. The automation may not have created one, or the contact name differs.'
          : 'Check pipelineIsScanned, stageMatchesBookedFilter and withinWindow — whichever is false is why it is missing from the table.',
    }
  }

  // Sequential across sub-accounts. GHL throttles hard, and a partial
  // result here reads as "this rep booked nothing" — the one wrong
  // answer a bookings table must never produce.
  const reps = []
  for (const sub of subaccounts) {
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
        reps.push(rep)
        continue
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
        reps.push(rep)
        continue
      }

      const raw: RawObj[] = []
      for (const p of scanned) {
        const payload = await getOpportunities(sub.vaultName, {
          pipelineId: p.id,
          max: 1000,
        })
        raw.push(...(payload.opportunities as RawObj[]))
      }

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
          return {
            id: String(o.id ?? ''),
            name: nameOf(o, contact) ?? 'Untitled',
            stage: stageName.get(sid) ?? 'Booked',
            status: str(o.status) ?? 'open',
            bookedAt,
            createdAt: str(o.createdAt) ?? str(o.dateAdded),
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
      const inWindow = bookings.filter((b) => {
        if (!b.bookedAt) return true // undated: count rather than drop
        return new Date(b.bookedAt).getTime() >= since.getTime()
      })

      rep.bookings = inWindow
      rep.total = inWindow.length
      rep.totalAllTime = bookings.length
      rep.undated = bookings.filter((b) => !b.bookedAt).length
    } catch (err) {
      rep.error = err instanceof Error ? err.message : 'Lookup failed'
      rep.bookings = []
    }

    reps.push(rep)
  }

  const allBookings = reps.flatMap((r) =>
    ((r.bookings ?? []) as RawObj[]).map((b) => ({
      ...b,
      rep: r.locationName,
      vaultName: r.vaultName,
    })),
  )

  return {
    window: { since: since.toISOString(), days },
    stageFilter: stageOverride || 'auto (name contains "book")',
    totals: {
      bookings: allBookings.length,
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
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
