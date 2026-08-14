import { NextRequest } from 'next/server'
import { getOpportunities, listSubAccounts } from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/opportunities?subAccount=&pipelineId=
 *
 * Opportunities for one pipeline, normalized for a board view. GHL nests
 * the contact inconsistently and returns monetaryValue as a number or a
 * string depending on how the record was created, so both are flattened
 * here rather than in the UI.
 */
type RawObj = Record<string, unknown>

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

export const GET = withExternalApi(async (req, auth) => {
  if (!auth.user) throw new Error('Opportunities require a signed-in account.')

  const params = req.nextUrl.searchParams
  const wanted = (params.get('subAccount') ?? '').trim()
  const pipelineId = (params.get('pipelineId') ?? '').trim()

  const { subaccounts } = await listSubAccounts()
  const target = wanted
    ? subaccounts.find((s) => s.vaultName === wanted)
    : subaccounts[0]
  if (!target) throw new Error('No matching sub-account.')

  const payload = (await getOpportunities(target.vaultName, {
    pipelineId: pipelineId || undefined,
    limit: 100,
  })) as RawObj

  const raw = ((payload.opportunities ?? []) as RawObj[]) ?? []

  const opportunities = raw.map((o) => {
    const contact = (o.contact ?? {}) as RawObj
    const valueRaw = o.monetaryValue
    const value =
      typeof valueRaw === 'number'
        ? valueRaw
        : typeof valueRaw === 'string'
          ? Number(valueRaw.replace(/[^0-9.-]/g, '')) || 0
          : 0

    return {
      id: String(o.id ?? ''),
      name: str(o.name) ?? 'Untitled opportunity',
      value,
      status: str(o.status) ?? 'open',
      stageId: str(o.pipelineStageId) ?? str(o.stageId),
      pipelineId: str(o.pipelineId),
      source: str(o.source),
      assignedTo: str(o.assignedTo),
      createdAt: str(o.createdAt) ?? str(o.dateAdded),
      updatedAt: str(o.updatedAt),
      contactId: str(contact.id) ?? str(o.contactId),
      contactName:
        str(contact.name) ??
        [str(contact.firstName), str(contact.lastName)]
          .filter(Boolean)
          .join(' ') ||
        null,
      contactEmail: str(contact.email),
      contactPhone: str(contact.phone),
    }
  })

  return { opportunities }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
