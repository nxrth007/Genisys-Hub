/**
 * Slack helper — vault-aware.
 *
 * Bot token is pulled from the vault by exact name "Slack Bot Token".
 * Used for:
 *   1. Morning brief DMs to team members
 *   2. Reading/posting in client channels (Slack module, later)
 *
 * The Slack Web API client is re-created per call because the vault token
 * could be rotated at any time. At our scale (~30 calls/day) this is fine.
 */
import { WebClient, type ChatPostMessageResponse } from '@slack/web-api'
import { getSecretByName } from './vault-service'

async function getClient(): Promise<WebClient> {
  const token = await getSecretByName('Slack Bot Token')
  return new WebClient(token)
}

/**
 * Look up a Slack user by their email address. Returns the Slack user ID
 * (e.g. "U12345ABC") or null if the email isn't found in the workspace.
 */
export async function findUserByEmail(email: string): Promise<string | null> {
  const client = await getClient()
  try {
    const res = await client.users.lookupByEmail({ email })
    return res.user?.id ?? null
  } catch (err: unknown) {
    // Slack returns `users_not_found` if the email isn't in the workspace.
    if (err && typeof err === 'object' && 'data' in err) {
      const data = (err as { data?: { error?: string } }).data
      if (data?.error === 'users_not_found') return null
    }
    throw err
  }
}

/**
 * Send a DM to a Slack user by their Slack user ID.
 *
 * Opens a DM channel (im.open) then posts into it. If the user has Slack
 * mobile notifications enabled, their phone buzzes — same UX as SMS.
 */
export async function sendDm(params: {
  userId: string
  text: string
  markdown?: boolean
}): Promise<{ ok: boolean; ts: string; channel: string }> {
  const client = await getClient()

  // Open (or re-open) a DM conversation with the user.
  const im = await client.conversations.open({ users: params.userId })
  const channelId = im.channel?.id
  if (!channelId) throw new Error('Failed to open DM channel')

  const msg: ChatPostMessageResponse = await client.chat.postMessage({
    channel: channelId,
    text: params.text,
    mrkdwn: params.markdown ?? true,
  })

  return {
    ok: msg.ok ?? false,
    ts: msg.ts ?? '',
    channel: channelId,
  }
}

/**
 * Send a DM to a user by email. Convenience wrapper that does the user
 * lookup first. Returns null if the email isn't found in the workspace
 * (instead of throwing) so callers can show a helpful error.
 */
export async function sendDmByEmail(params: {
  email: string
  text: string
  markdown?: boolean
}): Promise<{ ok: boolean; ts: string; channel: string } | null> {
  const userId = await findUserByEmail(params.email)
  if (!userId) return null
  return sendDm({ userId, text: params.text, markdown: params.markdown })
}

/**
 * List public channels the bot can see. Used by the Slack module later
 * for the "pick which channels to monitor" UI.
 */
export async function listChannels(): Promise<
  Array<{ id: string; name: string; topic: string; memberCount: number }>
> {
  const client = await getClient()
  const result = await client.conversations.list({
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
  })

  return (result.channels ?? []).map((ch) => ({
    id: ch.id ?? '',
    name: ch.name ?? '',
    topic: ch.topic?.value ?? '',
    memberCount: ch.num_members ?? 0,
  }))
}
