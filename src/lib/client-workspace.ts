/**
 * Per-client Slack workspace provisioning.
 *
 * On Client approval, we auto-create a private Slack channel
 * named after the business (e.g. "solar-guys-llc"), invite the
 * team (Alex / Ethan / Garrett) as
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
 * AppSetting key for the master toggle. When the row is missing or
 * stores 'true', auto-provisioning runs on Client approval. When
 * 'false', the approve flow skips the Slack call entirely so admin
 * can provision channels manually (or hold off until Slack scopes
 * are configured) — the existing per-client channel assignment in
 * Settings → ClientSlackDelivery still works while this is off.
 *
 * Default ON to preserve the behavior shipped with the feature; the
 * Settings UI flips this without a deploy.
 */
const PROVISIONING_ENABLED_KEY = 'clientWorkspaceProvisioning.enabled'

export async function isClientWorkspaceProvisioningEnabled(): Promise<boolean> {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: PROVISIONING_ENABLED_KEY },
    })
    if (!row) return true
    return row.value === 'true'
  } catch (err) {
    // DB hiccup — bias toward "feature on" so an outage doesn't
    // silently disable provisioning. The orchestrator itself
    // never throws; worst case the channel create fails and we
    // post to #genisys-alerts.
    console.error(
      '[client-workspace] failed to read provisioning toggle, defaulting to enabled',
      err,
    )
    return true
  }
}

export async function setClientWorkspaceProvisioningEnabled(
  enabled: boolean,
): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: PROVISIONING_ENABLED_KEY },
    create: { key: PROVISIONING_ENABLED_KEY, value: enabled ? 'true' : 'false' },
    update: { value: enabled ? 'true' : 'false' },
  })
}

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
    // Slack channel names cap at 80 chars. We previously reserved
    // room for a "client-" prefix; that's gone now (Alex's preference,
    // 2026-05-12) but keeping the safety margin so collision-resolver
    // suffixes ("-2", "-3") still fit.
    .slice(0, 76)
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
  // Master toggle gate. Admin can flip auto-provisioning off via
  // Settings → Client workspace provisioning if Slack scopes
  // aren't yet configured, or to provision channels manually for
  // a stretch. Per-client channel assignment + alert delivery
  // still works through the existing Settings UI.
  if (!(await isClientWorkspaceProvisioningEnabled())) {
    console.log(
      `[client-workspace] auto-provision toggle is OFF, skipping ${clientId}`,
    )
    return
  }

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
  // Channel name = the business name as a slack-safe slug. No more
  // "client-" prefix (2026-05-12 per Alex) — the channel obviously
  // belongs to a client by virtue of being in our workspace, so the
  // prefix was just noise. Example: "Solar Guys LLC" → "solar-guys-llc".
  const slug = slugifyForSlack(client.name) || `c-${clientId.slice(-6)}`
  const channelBaseName = slug
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
