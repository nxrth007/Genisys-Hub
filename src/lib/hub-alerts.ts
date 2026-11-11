import { formatSlackError, postChannelMessage, resolveChannelIdByName } from '@/lib/slack'
import { prisma } from '@/lib/prisma'

/**
 * One place for "tell the team something happened" — posts to
 * #genisys-alerts unless HUB_ALERT_CHANNEL names a different channel
 * (no #). Best-effort: a Slack outage must never fail the thing that
 * wanted to announce itself. A failed post is stored so Settings can
 * show it when the channel is gone.
 */
export const HUB_ALERT_CHANNEL = process.env.HUB_ALERT_CHANNEL?.trim().replace(/^#/, '') || 'genisys-alerts'

const DELIVERY_KEY = 'hubAlerts.delivery'

export type HubAlertDelivery = {
  channel: string
  ok: boolean | null
  detail: string | null
  at: string | null
}

async function recordDelivery(ok: boolean, detail: string | null): Promise<void> {
  try {
    const value = JSON.stringify({
      ok,
      channel: HUB_ALERT_CHANNEL,
      detail: detail ? detail.slice(0, 400) : null,
      at: new Date().toISOString(),
    })
    await prisma.appSetting.upsert({
      where: { key: DELIVERY_KEY },
      create: { key: DELIVERY_KEY, value },
      update: { value },
    })
  } catch (err) {
    console.warn('[hub-alerts] could not record delivery:', err)
  }
}

export async function hubAlertDelivery(): Promise<HubAlertDelivery> {
  const empty: HubAlertDelivery = { channel: HUB_ALERT_CHANNEL, ok: null, detail: null, at: null }
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: DELIVERY_KEY } })
    if (!row?.value) return empty
    const v = JSON.parse(row.value) as { ok?: unknown; detail?: unknown; at?: unknown }
    return {
      channel: HUB_ALERT_CHANNEL,
      ok: typeof v.ok === 'boolean' ? v.ok : null,
      detail: typeof v.detail === 'string' ? v.detail : null,
      at: typeof v.at === 'string' ? v.at : null,
    }
  } catch {
    return empty
  }
}

export async function hubAlert(text: string): Promise<void> {
  try {
    const id = await resolveChannelIdByName(HUB_ALERT_CHANNEL)
    if (!id) {
      const detail = `#${HUB_ALERT_CHANNEL} isn't visible to the Slack bot`
      console.warn(`[hub-alerts] ${detail} — alert dropped. Set HUB_ALERT_CHANNEL to a channel the bot is in.`)
      await recordDelivery(false, detail)
      return
    }
    await postChannelMessage(id, text)
    await recordDelivery(true, null)
  } catch (err) {
    const detail = formatSlackError(err)
    console.error('[hub-alerts] Slack post failed:', detail)
    await recordDelivery(false, detail)
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
