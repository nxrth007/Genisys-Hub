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

export type TeamTextResult = { name: string; ok: boolean; error: string | null; from: string | null }

export type TeamTextLogEntry = {
  at: string
  /** What the text was about ("Whop sign-up", "Onboarding", "Test"…). */
  label: string
  preview: string
  results: TeamTextResult[]
}

const LOG_KEY = 'team.sms.log'

/**
 * Text everyone on the list. Each text is tried from the reminders' sender
 * number first and, if GHL refuses it (a number no longer on the account,
 * say), again from the account's default number. Every attempt is logged
 * (shown on Payments → Whop) and a run where nobody got the text posts a
 * Slack alert, so a failure is never silent.
 */
export async function textTeam(message: string, label = 'Alert'): Promise<TeamTextResult[]> {
  const config = await prisma.remindersConfig.findUnique({ where: { id: 'singleton' }, select: { senderPhone: true } }).catch(() => null)
  const sender = config?.senderPhone?.trim() || null
  const results: TeamTextResult[] = []
  for (const p of TEAM_ALERT_PHONES) {
    let error: string | null = null
    let from: string | null = null
    for (const fromNumber of sender ? [sender, null] : [null]) {
      try {
        await sendSmsToPhone('GHL Genisys Token', { phone: p.phone, message, firstName: p.name, fromNumber: fromNumber ?? undefined })
        error = null
        from = fromNumber ?? 'account default'
        break
      } catch (err) {
        error = `${fromNumber ? `from ${fromNumber}` : 'from the default number'}: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[team-sms] text to ${p.name} failed ${error}`)
      }
    }
    results.push({ name: p.name, ok: !error, error, from })
  }
  await logTeamText({ at: new Date().toISOString(), label, preview: message.slice(0, 160), results }).catch(() => {})
  if (results.every((r) => !r.ok)) {
    const { hubAlertThrottled } = await import('@/lib/hub-alerts')
    await hubAlertThrottled(
      'team-sms-failed',
      30 * 60_000,
      `:warning: *Team text didn't send* (${label}): ${results.map((r) => `${r.name}: ${r.error}`).join(' · ')}. Details on Payments → Whop.`,
    ).catch(() => {})
  }
  return results
}

/**
 * One text per key per window, for alarms a stream of requests would otherwise
 * repeat every few seconds (a webhook refusing the same sender, say). Mirrors
 * hubAlertThrottled; the memory is this process's, which is the one Render
 * instance. Returns null when the window swallowed it.
 */
const lastTextAt = new Map<string, number>()

export async function textTeamThrottled(key: string, everyMs: number, message: string, label = 'Alert'): Promise<TeamTextResult[] | null> {
  const now = Date.now()
  if (now - (lastTextAt.get(key) ?? 0) < everyMs) return null
  lastTextAt.set(key, now)
  return textTeam(message, label)
}

async function logTeamText(entry: TeamTextLogEntry): Promise<void> {
  const row = await prisma.appSetting.findUnique({ where: { key: LOG_KEY } })
  let log: TeamTextLogEntry[] = []
  try {
    log = row ? (JSON.parse(row.value) as TeamTextLogEntry[]) : []
  } catch {
    log = []
  }
  const value = JSON.stringify([entry, ...log].slice(0, 30))
  await prisma.appSetting.upsert({ where: { key: LOG_KEY }, create: { key: LOG_KEY, value }, update: { value } })
}

/** The newest team texts first, for Payments → Whop. */
export async function teamTextLog(): Promise<TeamTextLogEntry[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: LOG_KEY } })
  try {
    return row ? (JSON.parse(row.value) as TeamTextLogEntry[]) : []
  } catch {
    return []
  }
}

/** The text for a finished onboarding form. Plain characters only, so it stays one cheap SMS encoding. */
export function onboardingText(o: { business: string; owner: string | null; city: string | null; created: boolean; link: string }): string {
  return o.created
    ? `Genisys: New client onboarded! ${o.business}${o.owner ? ` (${o.owner})` : ''}${o.city ? ` in ${o.city}` : ''} finished the onboarding form and was added to Clients in the Hub. ${o.link}`
    : `Genisys: ${o.business} finished the onboarding form again. Their answers were added to the client already in the Hub. ${o.link}`
}

/**
 * A submission the Hub stored but could not turn into a client (no business
 * name, or a phone number where the name should be). Until now the only trace
 * was a Slack post nobody reads, and the client waited.
 */
export function onboardingNoClientText(o: { business: string; why: string; link: string }): string {
  return `Genisys: ${o.business} finished the onboarding form, but the Hub could not make a client from it. ${o.why}. Review it under Clients > Onboarding answers: ${o.link}`
}

export type OnboardingRejection = 'invalid_secret' | 'invalid_json' | 'empty_payload'

/** A submission the webhook turned away: the form sent it and the Hub did not keep it. */
export function onboardingRejectedText(o: { reason: OnboardingRejection; business: string | null; link: string }): string {
  const who = o.business ? ` for ${o.business}` : ''
  const why =
    o.reason === 'invalid_secret'
      ? 'its webhook secret does not match the Vault. The Hub will pick it up from the onboarding sheet within 15 minutes; check INTAKE_WEBHOOK_SECRET in the form project'
      : o.reason === 'invalid_json'
        ? 'the Hub could not read it (not valid JSON). The form may have changed its payload; the onboarding sheet still has the answers'
        : 'it carried no answers. The form may have changed its field names; the onboarding sheet still has the answers'
  return `Genisys: the onboarding form sent a submission${who} but the Hub turned it away: ${why}. ${o.link}`
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
