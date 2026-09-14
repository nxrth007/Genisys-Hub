import { NextRequest } from 'next/server'
import { externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import { inviteExternalToChannel } from '@/lib/slack'

/**
 * POST { channelId, email } — Slack Connect invite to a channel.
 *
 * This is NOT a workspace invite. It offers someone outside the
 * workspace shared access to one channel; they stay on their own Slack
 * (or get prompted to make one) and never become a member here.
 *
 * Adding a real workspace member by email needs admin.users.invite,
 * which Slack restricts to Enterprise Grid — unavailable on this plan at
 * any scope, so there is deliberately no endpoint pretending otherwise.
 *
 * Slack Connect is also a paid feature on many plans, so the paywall
 * error is translated rather than surfaced as a raw code.
 */
export const POST = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const channelId = String(body.channelId ?? '').trim()
  const email = String(body.email ?? '').trim()

  if (!channelId) throw new WriteError('channelId is required')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new WriteError('That does not look like an email address.')
  }

  try {
    const r = await inviteExternalToChannel({ channelId, externalEmail: email })
    return { email, inviteId: r.inviteId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Slack refused the invite.'

    if (/not_allowed|paid_only|restricted_action|org_level_email_display/i.test(msg)) {
      throw new WriteError(
        'Slack Connect is not enabled on this workspace plan, so external invites are blocked. Inviting them as a normal member has to be done from Slack itself.',
        409,
      )
    }
    if (/already_in_channel|already_invited/i.test(msg)) {
      throw new WriteError('They have already been invited to this channel.', 409)
    }
    if (/not_in_channel/i.test(msg)) {
      throw new WriteError(
        'The bot has to be in the channel before it can invite anyone. Join it first.',
        409,
      )
    }
    if (/channel_not_found|is_private/i.test(msg)) {
      throw new WriteError(
        'Slack would not share this channel externally. Connect invites do not work on every channel type.',
        409,
      )
    }
    throw new WriteError(msg, 502)
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
