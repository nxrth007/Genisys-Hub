import { NextRequest } from 'next/server'
import { getOpportunities, listSubAccounts } from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/opportunities?subAccount=&pipelineId=
 *   &debug=1   return the raw field names GHL sent, to diagnose mapping
 *
 * Opportunities for one pipeline, normalized for a board view.
 */
type RawObj = Record<string, unknown>

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/**
 * Opportunity title.
 *
 * GHL is inconsistent about where this lives — `name` on some records,
 * `opportunityName` or `title` on others, and older ones carry nothing at
 * all and are displayed by contact name in GHL's own UI. Falling back
 * through all of those beats showing "Untitled opportunity" for a record
 * that plainly has a name when you open it in GHL.
 */
function opportunityTitle(o: RawObj, contact: RawObj): string | null {
  const direct =
    str(o.name) ??
    str(o.opportunityName) ??
    str(o.title) ??
    str(o.opportunity_name)
  if (direct) return direct

  const contactName =
    str(contact.name) ??
    [str(contact.firstName), str(contact.lastName)].filter(Boolean).join(' ')
  return contactName || str(contact.companyName) || null
}

export const GET = withExternalApi(async (req, auth) => {
  if (!auth.user) throw new Error('Opportunities require a signed-in account.')

  const params = req.nextUrl.searchParams
  const wanted = (params.get('subAccount') ?? '').trim()
  const pipelineId = (params.get('pipelineId') ?? '').trim()
  const debug = params.get('debug') === '1'

  const { subaccounts } = await listSubAccounts()
  const target = wanted
    ? subaccounts.find((s) => s.vaultName === wanted)
    : subaccounts[0]
  if (!target) throw new Error('No matching sub-account.')

  const payload = await getOpportunities(target.vaultName, {
    pipelineId: pipelineId || undefined,
    max: 1000,
  })

  const raw = payload.opportunities as RawObj[]

  // Escape hatch for exactly the situation that produced this: the board
  // says "Untitled" while GHL shows a name. Returns the shape of one
  // record so the mapping can be fixed from evidence, not guesswork.
  if (debug) {
    const sample = raw[0] ?? {}
    return {
      count: raw.length,
      sampleKeys: Object.keys(sample).sort(),
      sample,
    }
  }

  const opportunities = raw.map((o) => {
    const contact = (o.contact ?? {}) as RawObj
    const valueRaw = o.monetaryValue
    const value =
      typeof valueRaw === 'number'
        ? valueRaw
        : typeof valueRaw === 'string'
          ? Number(valueRaw.replace(/[^0-9.-]/g, '')) || 0
          : 0

    const contactName =
      str(contact.name) ??
      ([str(contact.firstName), str(contact.lastName)]
        .filter(Boolean)
        .join(' ') ||
        null)

    return {
      id: String(o.id ?? ''),
      name: opportunityTitle(o, contact) ?? 'Untitled opportunity',
      value,
      status: str(o.status) ?? 'open',
      stageId: str(o.pipelineStageId) ?? str(o.stageId),
      pipelineId: str(o.pipelineId),
      source: str(o.source),
      assignedTo: str(o.assignedTo),
      createdAt: str(o.createdAt) ?? str(o.dateAdded),
      updatedAt: str(o.updatedAt),
      contactId: str(contact.id) ?? str(o.contactId),
      contactName,
      contactEmail: str(contact.email),
      contactPhone: str(contact.phone),
    }
  })

  return { opportunities, fetched: payload.fetched }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
