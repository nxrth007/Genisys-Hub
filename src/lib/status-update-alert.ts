/**
 * Status-update Slack alert — fires when a client posts an outcome
 * from their /client dashboard (showed / no-show / won / lost) so
 * admin sees it on their phone instead of having to remember to
 * check the /call-center/status-updates triage tab.
 *
 * Lives in its own module (not in client-delivery.ts) because:
 *   - The delivery side cares about per-client channels + a
 *     SheetSlackDelivery ledger for dedup. This alert posts only
 *     to the internal admin channel, every event, no dedup.
 *   - Failures here must NEVER bubble — the client's status-update
 *     PATCH succeeds the moment we save the DB row. A Slack outage
 *     can't roll that back.
 *
 * Destination channel: defaults to `genisys-alerts` (same channel
 * the appointment-delivery mirror posts to). Configurable via
 * STATUS_UPDATE_ALERT_CHANNEL if Alex ever wants to split them
 * apart.
 */

import { postChannelMessage, resolveChannelIdByName, formatSlackError } from './slack'

const DEFAULT_CHANNEL_NAME = 'genisys-alerts'

/** Lowercased status string → human-friendly label + emoji for the
 *  Slack post. Maps every status the PATCH endpoint can write. */
const STATUS_PRESENTATION: Record<
  string,
  { label: string; emoji: string }
> = {
  showed: { label: 'Showed', emoji: ':white_check_mark:' },
  no_show: { label: 'NO-SHOW', emoji: ':x:' },
  won: { label: 'WON', emoji: ':trophy:' },
  lost: { label: 'Lost', emoji: ':no_entry_sign:' },
}

export type StatusUpdateAlertInput = {
  appointmentId: string
  clientName: string
  customerName: string
  customerPhone: string | null
  address: string | null
  apptDateTime: Date | null
  previousStatus: string
  newStatus: string
  /** Optional free-form notes the client attached to the update.
   *  Truncated in the Slack message so a 5-paragraph essay doesn't
   *  blow up the channel — full notes still live in the Hub. */
  notes: string | null
  /** Display name of the client account holder who pressed the
   *  button (e.g. their `User.name`). Falls back to email when
   *  the name isn't set. Used only for the Slack message header. */
  actorLabel: string
  /** Hub origin so the alert can deep-link to the triage page +
   *  the specific row. */
  hubOrigin: string
}

/**
 * Fire-and-forget Slack alert. Awaits the post so the caller can
 * `void` it if they want truly async, but every error path is
 * caught here — caller never has to wrap in try/catch.
 *
 * Returns true when a message was successfully posted, false when
 * anything went wrong (channel unresolvable, post rejected,
 * disabled by env). The boolean is for logging only; callers
 * shouldn't branch on it.
 */
export async function sendStatusUpdateAlert(
  input: StatusUpdateAlertInput,
): Promise<boolean> {
  // Emergency kill-switch for an active incident (e.g. someone's
  // accidentally re-firing 1000 updates from a script). Doesn't
  // need a code change to silence the firehose.
  if (
    (process.env.STATUS_UPDATE_ALERT_DISABLED || '').toLowerCase() === 'true'
  ) {
    return false
  }

  const channelName =
    process.env.STATUS_UPDATE_ALERT_CHANNEL?.trim() || DEFAULT_CHANNEL_NAME

  let channelId: string | null
  try {
    channelId = await resolveChannelIdByName(channelName)
  } catch (err) {
    console.error(
      `[status-update-alert] failed to resolve channel #${channelName}:`,
      formatSlackError(err),
    )
    return false
  }
  if (!channelId) {
    console.warn(
      `[status-update-alert] channel #${channelName} not visible to the bot — invite the bot or set STATUS_UPDATE_ALERT_CHANNEL.`,
    )
    return false
  }

  const text = formatAlertMessage(input)
  try {
    const res = await postChannelMessage(channelId, text)
    if (!res.ok) {
      console.error(
        `[status-update-alert] postMessage returned ok=false for appointment ${input.appointmentId}`,
      )
      return false
    }
    return true
  } catch (err) {
    console.error(
      `[status-update-alert] postMessage threw for appointment ${input.appointmentId}:`,
      formatSlackError(err),
    )
    return false
  }
}

/** Build the Slack mrkdwn body. Pure function so it's easy to
 *  eyeball + unit-test later. Format mimics the appointment-mirror
 *  post Alex is already used to so the alerts channel stays
 *  visually consistent. */
export function formatAlertMessage(input: StatusUpdateAlertInput): string {
  const presentation = STATUS_PRESENTATION[input.newStatus.toLowerCase()] ?? {
    label: input.newStatus.toUpperCase(),
    emoji: ':bell:',
  }

  const lines: string[] = []
  lines.push(
    `${presentation.emoji} *Client status update from ${input.clientName}*`,
  )
  lines.push('')
  lines.push(
    `*${input.customerName}*${input.customerPhone ? ` · ${input.customerPhone}` : ''}`,
  )
  if (input.address) {
    lines.push(`${input.address}`)
  }
  if (input.apptDateTime) {
    lines.push(
      `Appointment: ${input.apptDateTime.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      })}`,
    )
  }
  lines.push('')
  lines.push(
    `*${presentation.label}* (was: \`${input.previousStatus}\`) — reported by ${input.actorLabel}`,
  )

  if (input.notes?.trim()) {
    // Slack's mrkdwn doesn't honor blockquote with > inside a
    // single line, so put on its own line. Truncate so a long
    // essay doesn't spam the channel; admin can read the full
    // notes in the Hub.
    const trimmed = input.notes.trim()
    const MAX = 600
    const clipped =
      trimmed.length > MAX ? `${trimmed.slice(0, MAX).trimEnd()}…` : trimmed
    lines.push('')
    lines.push(`> ${clipped.split('\n').join('\n> ')}`)
  }

  // Deep-link straight to the triage page with the row scrolled
  // into view. The query params line up with the page's URL
  // contract: ?client=<id>&focus=<appointmentId>.
  lines.push('')
  const hubOrigin = input.hubOrigin.replace(/\/$/, '')
  const url = `${hubOrigin}/call-center/status-updates?focus=${encodeURIComponent(input.appointmentId)}`
  lines.push(`<${url}|View in Hub →>`)

  return lines.join('\n')
}
