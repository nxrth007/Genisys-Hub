import { formatSlackError, postChannelMessage, resolveChannelIdByName } from '@/lib/slack'

/**
 * One place for "tell the team something happened" — posts to
 * #genisys-alerts (override with HUB_ALERT_CHANNEL). Best-effort: a Slack
 * outage must never fail the thing that wanted to announce itself.
 */
export const HUB_ALERT_CHANNEL = process.env.HUB_ALERT_CHANNEL?.trim() || 'genisys-alerts'

export async function hubAlert(text: string): Promise<void> {
  try {
    const id = await resolveChannelIdByName(HUB_ALERT_CHANNEL)
    if (!id) {
      console.warn(`[hub-alerts] #${HUB_ALERT_CHANNEL} isn't visible to the Slack bot — alert dropped`)
      return
    }
    await postChannelMessage(id, text)
  } catch (err) {
    console.error('[hub-alerts] Slack post failed:', formatSlackError(err))
  }
}

/** Absolute Hub URL for a path, for links in alerts. */
export function hubLink(path: string): string {
  const base = (process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}${path}`
}

const lastAlertAt = new Map<string, number>()

/** Same as hubAlert, but at most once per `everyMs` for a given key — for failures that repeat. */
export async function hubAlertThrottled(key: string, everyMs: number, text: string): Promise<void> {
  const now = Date.now()
  const last = lastAlertAt.get(key) ?? 0
  if (now - last < everyMs) return
  lastAlertAt.set(key, now)
  await hubAlert(text)
}
