import { formatSlackError, postChannelMessage, resolveChannelIdByName } from '@/lib/slack'

/** Where the weekly summaries and failures go. Override with SEO_ALERT_CHANNEL. */
export const SEO_ALERT_CHANNEL = process.env.SEO_ALERT_CHANNEL?.trim() || 'genisys-alerts'

/** Best-effort: a Slack outage must never fail an SEO run. */
export async function seoAlert(text: string): Promise<void> {
  try {
    const id = await resolveChannelIdByName(SEO_ALERT_CHANNEL)
    if (!id) {
      console.warn(`[seo] #${SEO_ALERT_CHANNEL} isn't visible to the Slack bot — alert dropped`)
      return
    }
    await postChannelMessage(id, text)
  } catch (err) {
    console.error('[seo] Slack alert failed:', formatSlackError(err))
  }
}
