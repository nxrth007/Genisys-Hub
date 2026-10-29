import { externalOptions } from '@/lib/external-api'
import { withBotApi, clampInt } from '@/lib/bot-api'
import { searchRuntimeLogs } from '@/lib/render'

/**
 * GET /api/external/v1/render/logs?q=[whop-webhook]&minutes=60&limit=100
 *
 * Owner-token only. Searches the Hub's Render runtime logs using the
 * Vault's "Render API Key" server-side; returns redacted log lines, never
 * the key.
 */
export const GET = withBotApi('render.logs', async (req) => {
  const p = req.nextUrl.searchParams
  const text = (p.get('q') ?? '').slice(0, 200)
  return searchRuntimeLogs({
    text,
    minutes: clampInt(p.get('minutes'), 60, 1, 7 * 24 * 60),
    limit: clampInt(p.get('limit'), 100, 1, 100),
  })
})

export const OPTIONS = externalOptions
