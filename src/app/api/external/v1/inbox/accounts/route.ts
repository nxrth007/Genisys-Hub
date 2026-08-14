import { NextRequest } from 'next/server'
import { listConnectedAccounts } from '@/lib/gmail'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/inbox/accounts
 * Which connected Gmail accounts can be sent from.
 */
export const GET = withExternalApi(async (_req, auth) => {
  if (!auth.user) throw new Error('This requires a signed-in account.')
  const accounts = await listConnectedAccounts()
  return {
    accounts: accounts.map((a) => ({ email: a.email, messages: a._count.emails })),
  }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
