import { prisma } from '@/lib/prisma'
import { sendSmsToPhone } from '@/lib/ghl'

/**
 * Text Alex and Ethan about things they want to know right away (new
 * clients, new Whop sign-ups). Sent from the Genisys GHL account on the
 * same outbound line as the reminders and the morning SMS brief. Each
 * person is texted separately; one failure doesn't stop the other.
 */

export const TEAM_ALERT_PHONES: { name: string; phone: string }[] = [
  { name: 'Alex', phone: '+16034185315' },
  { name: 'Ethan', phone: '+16035026226' },
]

export async function textTeam(message: string): Promise<{ name: string; ok: boolean; error: string | null }[]> {
  const config = await prisma.remindersConfig.findUnique({ where: { id: 'singleton' }, select: { senderPhone: true } }).catch(() => null)
  const results: { name: string; ok: boolean; error: string | null }[] = []
  for (const p of TEAM_ALERT_PHONES) {
    try {
      await sendSmsToPhone('GHL Genisys Token', { phone: p.phone, message, firstName: p.name, fromNumber: config?.senderPhone || undefined })
      results.push({ name: p.name, ok: true, error: null })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[team-sms] text to ${p.name} failed:`, error)
      results.push({ name: p.name, ok: false, error })
    }
  }
  return results
}

/** The text for a finished onboarding form. Plain characters only, so it stays one cheap SMS encoding. */
export function onboardingText(o: { business: string; owner: string | null; city: string | null; created: boolean; link: string }): string {
  return o.created
    ? `Genisys: New client onboarded! ${o.business}${o.owner ? ` (${o.owner})` : ''}${o.city ? ` in ${o.city}` : ''} finished the onboarding form and was added to Clients in the Hub. ${o.link}`
    : `Genisys: ${o.business} finished the onboarding form again. Their answers were added to the client already in the Hub. ${o.link}`
}

/** The text for a new Whop membership. */
export function whopSignupText(o: {
  name: string | null
  email: string | null
  username?: string | null
  product: string | null
  price: string | null
  link: string
}): string {
  // A name when Whop or the Hub has one; otherwise the email and Whop username so they can still be identified.
  const who = o.name || o.email || (o.username ? `@${o.username}` : 'Someone')
  const extra = [o.name ? o.email : null, o.username ? `Whop @${o.username}` : null].filter(Boolean).join(', ')
  return `Genisys: New Whop sign-up! ${who}${extra ? ` (${extra})` : ''} joined ${o.product || 'Genisys'}${o.price ? ` at ${o.price}` : ''}. ${o.link}`
}
