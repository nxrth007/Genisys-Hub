import { NextRequest } from 'next/server'
import { externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import { createChannel } from '@/lib/slack'

/**
 * POST { name, topic?, isPrivate } — create a channel.
 *
 * Creating a channel is visible to the whole workspace and cannot be
 * undone from here (Slack only archives), so it is owner-gated and the
 * UI confirms the sanitised name before sending.
 */
export const POST = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const name = String(body.name ?? '').trim()
  if (!name) throw new WriteError('Give the channel a name.')
  if (name.length > 80) {
    throw new WriteError('Slack caps a channel name at 80 characters.')
  }

  const topic = String(body.topic ?? '').trim() || undefined
  const isPrivate = body.isPrivate === true

  try {
    return await createChannel({ name, topic, isPrivate })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Slack refused the create.'
    // name_taken is the common one and reads badly raw.
    if (/name_taken/i.test(msg)) {
      throw new WriteError('A channel with that name already exists.', 409)
    }
    throw new WriteError(msg, 502)
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
