import { NextRequest } from 'next/server'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/me
 * Connection test — confirms the token is valid without returning data.
 */
export const GET = withExternalApi(async (_req, auth) => ({
  tokenName: auth.name,
  scope: auth.scope,
  hub: 'Genisys Hub',
}))

export const OPTIONS = (req: NextRequest) => externalOptions(req)
