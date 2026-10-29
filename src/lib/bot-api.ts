import type { NextRequest } from 'next/server'
import { withOwnerApi, type ExternalAuth } from '@/lib/external-api'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * Guard for machine (bot) endpoints: owner-minted DB token only (the
 * shared env token is refused by withOwnerApi), per-token rate limit,
 * and one audit line per call. These endpoints never return a secret.
 */
export function withBotApi(
  name: string,
  handler: (req: NextRequest, auth: ExternalAuth) => Promise<unknown>,
  limitPerMinute = 30,
) {
  return withOwnerApi(async (req, auth) => {
    const rl = checkRateLimit(`bot:${name}:${auth.tokenId}`, limitPerMinute, 60_000)
    if (!rl.ok) {
      throw Object.assign(new Error('rate_limited'), { retryAfterMs: rl.retryAfterMs })
    }
    console.info(`[bot-api] ${name} token=${auth.tokenId} (${auth.name}) user=${auth.user?.email ?? '-'} q=${req.nextUrl.search.slice(0, 200)}`)
    return handler(req, auth)
  })
}

export function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && raw !== null && raw !== '' ? Math.min(max, Math.max(min, Math.trunc(n))) : def
}
