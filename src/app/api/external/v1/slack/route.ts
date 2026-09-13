import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { getSlackIdentity, listChannels } from '@/lib/slack'

/**
 * GET /api/external/v1/slack — workspace overview.
 *
 * Identity first, channels second. auth.test needs no scope, so when it
 * succeeds and the channel list fails, the answer is "missing a scope"
 * rather than "the token is dead" — Slack reports both as a bare error
 * otherwise, and they need different fixes.
 *
 * Owner-gated: this can read and post into any channel the bot is in.
 */
export const GET = withOwnerApi(async () => {
  const identity = await getSlackIdentity()

  if (!identity.ok) {
    return { identity, channels: [], channelsError: null }
  }

  try {
    const channels = await listChannels()
    return {
      identity,
      channels: channels.sort((a, b) => a.name.localeCompare(b.name)),
      channelsError: null,
    }
  } catch (err) {
    return {
      identity,
      channels: [],
      channelsError:
        err instanceof Error ? err.message : 'Could not list channels.',
    }
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
