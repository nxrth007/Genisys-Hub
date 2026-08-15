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

  const { subaccounts, errors } = await listSubAccounts()

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
      const pipeline =
        pipelines.find((p) => PIPELINE_RE.test(p.name)) ?? pipelines[0]

      if (!pipeline) {
        rep.error = 'No pipeline found in this sub-account.'
        rep.bookings = []
        reps.push(rep)
        continue
      }

      const stages = pipeline.stages ?? []
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

      rep.pipelineName = pipeline.name
      rep.bookedStages = stages
        .filter((st) => bookedStageIds.has(st.id))
        .map((st) => st.name)

      // A sub-account whose stages don't match is reported rather than
      // silently returning zero — "no booked stage" and "no bookings"
      // look identical in a table and mean very different things.
      if (bookedStageIds.size === 0) {
        rep.error = `No stage matching ${stageOverride || 'a booked stage'}. Stages here: ${stages.map((s) => s.name).join(', ') || 'none'}`
        rep.bookings = []
        reps.push(rep)
        continue
      }

      const payload = await getOpportunities(sub.vaultName, {
        pipelineId: pipeline.id,
        max: 1000,
      })

      const bookings = (payload.opportunities as RawObj[])
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
        .filter((b) => {
          if (!b.bookedAt) return true // undated: show rather than drop
          return new Date(b.bookedAt).getTime() >= since.getTime()
        })
        .sort((a, b) => {
          const ta = a.bookedAt ? new Date(a.bookedAt).getTime() : 0
          const tb = b.bookedAt ? new Date(b.bookedAt).getTime() : 0
          return tb - ta
        })

      rep.bookings = bookings
      rep.total = bookings.length
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
