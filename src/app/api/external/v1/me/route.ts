import { NextRequest } from 'next/server'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/me
 * Who am I? Used as a connection test and to show the signed-in user.
 */
export const GET = withExternalApi(async (_req, auth) => ({
  tokenName: auth.name,
  scope: auth.scope,
  hub: 'Genisys Hub',
  user: auth.user,
}))

export const OPTIONS = (req: NextRequest) => externalOptions(req)
