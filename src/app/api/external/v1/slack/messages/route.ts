import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import { getChannelMessages, postChannelMessage } from '@/lib/slack'

/**
 * GET  ?channelId=   read a channel
 * POST { channelId, text }   post to it
 *
 * Posting reaches real people in a real workspace, so it is owner-gated
 * and deliberately has no "send to everyone" shape — one channel, one
 * message, chosen explicitly.
 */

export const GET = withOwnerApi(async (req) => {
  const channelId = (req.nextUrl.searchParams.get('channelId') ?? '').trim()
  if (!channelId) return { error: 'channelId is required', messages: [] }

  const rawLimit = Number(req.nextUrl.searchParams.get('limit'))
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, rawLimit) : 50

  try {
    return await getChannelMessages(channelId, limit)
  } catch (err) {
    // The usual cause is the bot not being in the channel, which the UI
    // can fix with the join button rather than making it a dead end.
    return {
      error: err instanceof Error ? err.message : 'Could not read channel.',
      messages: [],
      channelName: '',
      channelTopic: '',
      memberCount: 0,
      userMap: {},
    }
  }
})

export const POST = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const channelId = String(body.channelId ?? '').trim()
  const text = String(body.text ?? '').trim()
  if (!channelId) throw new WriteError('Pick a channel first.')
  if (!text) throw new WriteError('The message is empty.')
  if (text.length > 4000) {
    throw new WriteError('Slack caps a message at 4000 characters.')
  }

  try {
    const r = await postChannelMessage(channelId, text)
    return { ok: r.ok, ts: r.ts }
  } catch (err) {
    throw new WriteError(
      err instanceof Error ? err.message : 'Slack rejected the message.',
      502,
    )
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
