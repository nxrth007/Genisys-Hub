/**
 * Per-client Slack workspace provisioning.
 *
 * On Client approval, we auto-create a private Slack channel
 * "client-{slug}", invite the team (Alex / Ethan / Garrett) as
 * full members, and send the client's contactEmail a Slack
 * Connect invite. Once the client accepts the invite, the channel
 * shows up in both workspaces — they can chat directly with the
 * team, and we've got a single source of truth for that
 * relationship.
 *
 * The same channel id is also saved as Client.slackChannelId, so
 * the existing alert-delivery pipeline (new appointments, message
 * alerts) auto-targets it without admin having to pick a channel
 * via Settings → Client delivery.
 *
 * Designed to be FIRE-AND-FORGET from the approve endpoint. Never
 * throws. Failures get logged and posted to #genisys-alerts so
 * admin can react manually (re-run via /api/clients/[id]/...
 * when we wire the manual retry button later).
 */
import { prisma } from './prisma'
import {
  createPrivateChannel,
  inviteExternalToChannel,
  postChannelMessage,
  resolveChannelIdByName,
  getTeamInviteUserIds,
  formatSlackError,
} from './slack'

const ALERT_CHANNEL = 'genisys-alerts'

/**
 * Slugify a client name into a Slack-safe channel-name fragment.
 * Slack requires lowercase + [a-z0-9._-]; collapsing everything
 * else to single hyphens keeps the result readable.
 *
 *   "Spring Solar Inc."         → "spring-solar-inc"
 *   "Bob's Roofing & Solar LLC" → "bobs-roofing-solar-llc"
 */
function slugifyForSlack(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) // leave room for the "client-" prefix
}

/**
 * Best-effort post to #genisys-alerts so admin notices when
 * provisioning trips. Swallows its own errors — if Slack itself
 * is down, there's no escalation path beyond the server log.
 */
async function notifyAlertChannel(text: string): Promise<void> {
  try {
    const channelId = await resolveChannelIdByName(ALERT_CHANNEL)
    if (!channelId) return
    await postChannelMessage(channelId, `:warning: ${text}`)
  } catch (err) {
    console.error('[client-workspace] alert post failed', err)
  }
}

export async function provisionClientWorkspace(
  clientId: string,
): Promise<void> {
  const client = await prisma.client
    .findUnique({
      where: { id: clientId },
      select: {
        id: true,
        name: true,
        contactName: true,
        contactRole: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        state: true,
        package: true,
        apptCap: true,
        slackChannelId: true,
        slackInviteSentAt: true,
      },
    })
    .catch((err) => {
      console.error('[client-workspace] db lookup failed', err)
      return null
    })
  if (!client) return

  // Idempotent — if we already provisioned this client, bail.
  // Manual retry endpoint can clear slackChannelId first if
  // someone really wants to re-provision (e.g. they archived the
  // first channel by mistake).
  if (client.slackChannelId) {
    console.log(
      `[client-workspace] ${client.name} already has slackChannelId, skipping`,
    )
    return
  }

  // 1. Create channel + invite team members.
  const slug = slugifyForSlack(client.name) || `c-${clientId.slice(-6)}`
  const channelBaseName = `client-${slug}`
  let channelId: string
  let channelName: string
  try {
    const result = await createPrivateChannel({
      name: channelBaseName,
      topic: `Genisys ↔ ${client.name}`,
      inviteUserIds: getTeamInviteUserIds(),
    })
    channelId = result.channelId
    channelName = result.channelName
  } catch (err) {
    const msg = formatSlackError(err)
    console.error(
      `[client-workspace] channel create failed for ${client.name}:`,
      msg,
    )
    await notifyAlertChannel(
      `Could not auto-create Slack channel for *${client.name}*: ${msg}`,
    )
    return
  }

  // 2. Persist channel id IMMEDIATELY. If subsequent steps fail
  //    (welcome post, Connect invite), retry shouldn't double-
  //    create the channel — the idempotent guard above kicks in.
  await prisma.client
    .update({
      where: { id: clientId },
      data: { slackChannelId: channelId, slackChannelName: channelName },
    })
    .catch((err) =>
      console.error('[client-workspace] failed to save channel id', err),
    )

  // 3. Welcome post — concise team brief so anyone glancing at
  //    the new channel has the full intake snapshot without
  //    bouncing to the Hub.
  const lines: string[] = [
    `:tada: *${client.name}* is now active.`,
    '',
  ]
  if (client.contactName) {
    lines.push(
      `*Contact:* ${client.contactName}${
        client.contactRole ? ` (${client.contactRole})` : ''
      }`,
    )
  }
  if (client.contactEmail) lines.push(`*Email:* ${client.contactEmail}`)
  if (client.contactPhone) lines.push(`*Phone:* ${client.contactPhone}`)
  if (client.address) lines.push(`*Address:* ${client.address}`)
  if (client.state) lines.push(`*State:* ${client.state}`)
  lines.push(
    `*Package:* ${client.package}${
      client.apptCap ? ` · ${client.apptCap} appts/mo` : ''
    }`,
  )
  lines.push('')
  lines.push(
    client.contactEmail
      ? `Sending ${client.contactEmail} a Slack Connect invite — they'll join here once accepted.`
      : `_No contact email on record — invite the client manually when ready._`,
  )

  await postChannelMessage(channelId, lines.join('\n')).catch((err) =>
    console.error(
      '[client-workspace] welcome post failed (channel exists, message dropped)',
      err,
    ),
  )

  // 4. Slack Connect invite to the client's contactEmail. Skipped
  //    if no email on record — the team can manually invite from
  //    the channel later.
  if (!client.contactEmail) return

  try {
    await inviteExternalToChannel({
      channelId,
      externalEmail: client.contactEmail,
    })
    await prisma.client.update({
      where: { id: clientId },
      data: { slackInviteSentAt: new Date() },
    })
  } catch (err) {
    const msg = formatSlackError(err)
    console.error(
      `[client-workspace] Connect invite to ${client.contactEmail} failed:`,
      msg,
    )
    await notifyAlertChannel(
      `Channel for *${client.name}* created (#${channelName}) but Slack Connect invite to ${client.contactEmail} failed: ${msg}. Invite manually from the channel.`,
    )
  }
}
