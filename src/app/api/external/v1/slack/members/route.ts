import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import {
  getChannelMembers,
  inviteToChannel,
  listWorkspaceUsers,
} from '@/lib/slack'

/**
 * GET  ?channelId=          who is in the channel, and who could be added
 * POST { channelId, userIds } invite them
 *
 * Both lists come back together so the UI can show membership inline
 * rather than making someone cross-reference two screens to work out who
 * is already there.
 */

export const GET = withOwnerApi(async (req) => {
  const channelId = (req.nextUrl.searchParams.get('channelId') ?? '').trim()
  if (!channelId) return { error: 'channelId is required', users: [], memberIds: [] }

  try {
    // Sequential: the member list is small and the user list is paginated,
    // and running both at once against one workspace risks a rate limit
    // for no real gain.
    const memberIds = await getChannelMembers(channelId)
    const users = await listWorkspaceUsers()
    return { users, memberIds, error: null }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Could not read members.',
      users: [],
      memberIds: [],
    }
  }
})

export const POST = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const channelId = String(body.channelId ?? '').trim()
  if (!channelId) throw new WriteError('channelId is required')

  const userIds = Array.isArray(body.userIds)
    ? body.userIds.map((u) => String(u ?? '').trim()).filter(Boolean)
    : []
  if (userIds.length === 0) throw new WriteError('Pick at least one person.')

  try {
    return await inviteToChannel(channelId, userIds)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Slack refused the invite.'
    if (/not_in_channel/i.test(msg)) {
      throw new WriteError(
        'The bot has to be in the channel before it can invite anyone. Join it first.',
        409,
      )
    }
    if (/cant_invite/i.test(msg)) {
      throw new WriteError(
        'Slack would not allow that invite — guests and some account types cannot be added this way.',
        409,
      )
    }
    throw new WriteError(msg, 502)
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
