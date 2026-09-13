import { NextRequest } from 'next/server'
import { externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import { joinChannel } from '@/lib/slack'

/**
 * POST { channelId } — have the bot join a public channel.
 *
 * Scopes grant capability, not membership: the bot cannot read or post
 * in a channel it is not in, and that is the most common reason a
 * correctly-scoped token still appears broken. joinChannel() already
 * treats "already_in_channel" as success.
 */
export const POST = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const channelId = String(body.channelId ?? '').trim()
  if (!channelId) throw new WriteError('channelId is required')

  try {
    await joinChannel(channelId)
    return { channelId, joined: true }
  } catch (err) {
    throw new WriteError(
      err instanceof Error
        ? err.message
        : 'Could not join. Private channels need an invite from a member.',
      502,
    )
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
