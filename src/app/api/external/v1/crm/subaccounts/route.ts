import { NextRequest } from 'next/server'
import { listSubAccounts } from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { requireUser } from '../_shared'

/**
 * GET /api/external/v1/crm/subaccounts
 *
 * Every GHL sub-account the Hub can see. Unlike the Hub's own /crm page
 * this hides nothing — Alex asked to see them all — but any sub-account
 * whose token fails to resolve is reported in `errors` rather than
 * silently dropped, so a dead connection is visible instead of missing.
 */
export const GET = withExternalApi(async (_req, auth) => {
  const denied = requireUser(auth)
  if (denied) throw new Error(denied)

  const { subaccounts, errors, discoveredEntries } = await listSubAccounts()

  return {
    subAccounts: subaccounts.map((s) => ({
      vaultName: s.vaultName,
      locationId: s.locationId,
      locationName: s.locationName,
    })),
    errors,
    discoveredEntries,
  }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
