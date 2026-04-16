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
 * Slack returns `missing_scope` errors with `needed` / `provided` fields
 * in the response body. By default the SDK surfaces only the top-level
 * error code ("missing_scope"), which is useless for debugging. This
 * extracts the specific scope that's required.
 */
export function formatSlackError(err: unknown): string {
  if (err && typeof err === 'object' && 'data' in err) {
    const data = (err as { data?: { error?: string; needed?: string; provided?: string } }).data
    if (data?.error === 'missing_scope' && data.needed) {
      return `Slack bot is missing scope: ${data.needed}. Reinstall the app at api.slack.com/apps → your app → Install App → Reinstall to Workspace.`
    }
    if (data?.error) return `Slack API: ${data.error}`
  }
  if (err instanceof Error) return err.message
  return 'Unknown Slack error'
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
    isPrivate: ch.is_private ?? false,
    isMember: ch.is_member ?? false,
  }))
}

// -------------------------------------------------------------------------
// Channel messages — for the /slack module
// -------------------------------------------------------------------------

export type SlackMsg = {
  ts: string
  userId: string
  userName: string
  text: string
  threadTs?: string
  replyCount?: number
  timestamp: string // ISO string
}

/**
 * Fetch recent messages from a channel. The bot must be a member of the
 * channel — call joinChannel() first if needed.
 */
export async function getChannelMessages(
  channelId: string,
  limit = 50
): Promise<{ messages: SlackMsg[]; channelName: string }> {
  const client = await getClient()

  // Get channel info for the name
  let channelName = channelId
  try {
    const info = await client.conversations.info({ channel: channelId })
    channelName = info.channel?.name ?? channelId
  } catch {
    // fallback to ID
  }

  const result = await client.conversations.history({
    channel: channelId,
    limit,
  })

  // Batch resolve user IDs to display names
  const userIds = new Set<string>()
  for (const msg of result.messages ?? []) {
    if (msg.user) userIds.add(msg.user)
  }

  const userNames = new Map<string, string>()
  const userIdArray = Array.from(userIds)
  // Resolve in batches of 10 to avoid rate limits
  for (let i = 0; i < userIdArray.length; i += 10) {
    const batch = userIdArray.slice(i, i + 10)
    await Promise.all(
      batch.map(async (uid) => {
        try {
          const info = await client.users.info({ user: uid })
          userNames.set(
            uid,
            info.user?.profile?.display_name ||
              info.user?.real_name ||
              info.user?.name ||
              uid
          )
        } catch {
          userNames.set(uid, uid)
        }
      })
    )
  }

  const messages: SlackMsg[] = (result.messages ?? [])
    .filter((m) => m.subtype !== 'channel_join' && m.subtype !== 'channel_leave')
    .map((m) => ({
      ts: m.ts ?? '',
      userId: m.user ?? '',
      userName: userNames.get(m.user ?? '') ?? m.user ?? 'Unknown',
      text: m.text ?? '',
      threadTs: m.thread_ts,
      replyCount: m.reply_count,
      timestamp: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : '',
    }))
    .reverse() // Slack returns newest first; we want oldest first (chat order)

  return { messages, channelName }
}

/**
 * Post a message to a channel (as the bot).
 */
export async function postChannelMessage(
  channelId: string,
  text: string,
  threadTs?: string
): Promise<{ ok: boolean; ts: string }> {
  const client = await getClient()
  const msg = await client.chat.postMessage({
    channel: channelId,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  })
  return { ok: msg.ok ?? false, ts: msg.ts ?? '' }
}

/**
 * Join a public channel. Required before the bot can read messages.
 * No-ops if already a member. Throws for private channels (bot must be invited).
 */
export async function joinChannel(channelId: string): Promise<void> {
  const client = await getClient()
  try {
    await client.conversations.join({ channel: channelId })
  } catch (err: unknown) {
    // already_in_channel is fine
    if (err && typeof err === 'object' && 'data' in err) {
      const data = (err as { data?: { error?: string } }).data
      if (data?.error === 'already_in_channel') return
    }
    throw err
  }
}
