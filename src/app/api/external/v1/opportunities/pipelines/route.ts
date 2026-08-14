import { NextRequest } from 'next/server'
import { getPipelines, listSubAccounts } from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/opportunities/pipelines?subAccount=<vaultName>
 *
 * Pipelines and their stages. Defaults to the first sub-account so the
 * board has something to render before anything is picked.
 */
type RawObj = Record<string, unknown>

export const GET = withExternalApi(async (req, auth) => {
  if (!auth.user) throw new Error('Opportunities require a signed-in account.')

  const { subaccounts, errors } = await listSubAccounts()
  const wanted = (req.nextUrl.searchParams.get('subAccount') ?? '').trim()
  const target = wanted
    ? subaccounts.find((s) => s.vaultName === wanted)
    : subaccounts[0]

  if (!target) {
    throw new Error(
      wanted ? `Unknown sub-account "${wanted}".` : 'No GHL sub-accounts found.',
    )
  }

  const payload = (await getPipelines(target.vaultName)) as RawObj
  const raw = (payload.pipelines ?? []) as RawObj[]

  const pipelines = raw.map((p) => {
    const stages = ((p.stages ?? []) as RawObj[])
      .map((st) => ({
        id: String(st.id ?? ''),
        name: String(st.name ?? 'Untitled stage'),
        position: Number(st.position ?? 0),
      }))
      // Position is authoritative; array order is not.
      .sort((a, b) => a.position - b.position)

    return { id: String(p.id ?? ''), name: String(p.name ?? 'Pipeline'), stages }
  })

  return {
    subAccounts: subaccounts.map((s) => ({
      vaultName: s.vaultName,
      locationName: s.locationName,
    })),
    subAccountErrors: errors,
    activeSubAccount: target.vaultName,
    pipelines,
  }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
