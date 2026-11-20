import { prisma } from '@/lib/prisma'
import { hubAlert, hubLink } from '@/lib/hub-alerts'
import { recordJourney, setJourneyStage } from '@/lib/client-journey'
import { markTrackerStep } from '@/lib/onboarding-tracker'
import { textTeam } from '@/lib/team-sms'
import { checkoutMember, claimStripeSignup, noteStripeStatus, recentCheckoutSessions, rememberMember, StripeUnavailable } from '@/lib/stripe-onboarding'
import { shortDate, signupIsLate, signupMoment, signupsFromSessions, stripeSignupText, type StripeNews } from '@/lib/stripe-onboarding-plan'

/**
 * Telling the team about a new Stripe trial, whichever door it comes through.
 *
 * The webhook (/api/webhooks/stripe) hears about a checkout seconds after it
 * completes. When Stripe can't get through, it retries on its own schedule,
 * hours and then a day apart: from 2026-11-17 to 11-19 the Hub's login check
 * refused every delivery, and the texts came in one to two days late, worded
 * as if the sign-ups were new. So the scheduler also asks Stripe for its newest
 * checkouts every five minutes (maybePollStripeSignups). Whichever door sees a
 * checkout first claims it (AppSetting stripe.signup:<session id>) and
 * announces it; the other only refreshes the member record. A sign-up announced
 * more than 15 minutes after it happened says when it happened.
 */

export type SignupNews = Extract<StripeNews, { kind: 'signup' }>

const clientsLink = () => hubLink('/clients')

/** Record a new trial and, if no one has yet, tell the team. True when this call announced it. */
export async function announceSignup(n: SignupNews, source: 'webhook' | 'poll'): Promise<boolean> {
  // The checkout doesn't carry the subscription: ask Stripe for the trial's dates and price.
  const looked = n.sessionId ? await checkoutMember(n.sessionId).catch(() => null) : null
  const m = looked && looked.valid ? looked : null
  const email = m?.email ?? n.email
  const name = m?.name ?? n.name
  const customerId = m?.customerId ?? n.customerId
  if (customerId) {
    await rememberMember({ customerId, subscriptionId: m?.subscriptionId ?? n.subscriptionId, email, name, phone: m?.phone ?? n.phone, status: m?.subscriptionStatus ?? 'trialing', trialEnd: m?.trialEnd ?? null, periodEnd: m?.periodEnd ?? null, price: m?.price ?? null, livemode: n.livemode }).catch((err) => console.error(`[stripe-signups] remember (${source}):`, err))
  }
  // Once per checkout: the webhook and the poll can both get here.
  if (n.sessionId && !(await claimStripeSignup(n.sessionId))) return false

  const who = name ?? email ?? 'someone'
  const signedUpAt = m?.startedAt ?? n.at ?? null
  const late = signupIsLate(signedUpAt) ? signupMoment(signedUpAt) : null
  await noteStripeStatus('signup', { at: new Date().toISOString(), who, email, price: m?.price ?? null, trialEnd: m?.trialEnd ?? null, livemode: n.livemode })

  // Only the live Hub texts anyone, and only about real money. The text goes before the Slack post, which has no timeout.
  if (process.env.NODE_ENV === 'production' && n.livemode) {
    try {
      await textTeam(stripeSignupText({ name, email, price: m?.price ?? null, trialEnd: m?.trialEnd ?? null, link: clientsLink(), signedUpAt }), 'Stripe sign-up')
      const tracked = await markTrackerStep('signup', { emails: email ? [email] : [], name }, { addIfMissing: true })
      if (!tracked.ok) console.warn(`[stripe-signups] tracker: ${tracked.detail}`)
    } catch (err) {
      console.error(`[stripe-signups] ${n.sessionId} (${source}): announce failed:`, err)
    }
  }
  const charge = shortDate(m?.trialEnd ?? null)
  await hubAlert(`:moneybag: *New sign-up* — ${who}${name && email ? ` (${email})` : ''} started the free trial${m?.price ? ` of *${m.price}*` : ''}${charge ? `; first charge ${charge}` : ''}${late ? ` _(signed up ${late} ET; this alert is late)_` : ''}${n.livemode ? '' : ' _(Stripe test mode)_'}${source === 'poll' ? ' _(found by the Hub’s own check of Stripe; the webhook hadn’t delivered it)_' : ''}. <${clientsLink()}|Clients>`).catch(() => {})

  // Journey: tick sign-up for a client already on file with this email (most sign-ups have no Client yet; the intake makes it).
  if (email) {
    await recordJourney(`stripe signup ${n.subscriptionId ?? n.sessionId}`, async () => {
      const client = await prisma.client.findFirst({ where: { contactEmail: { equals: email, mode: 'insensitive' } }, select: { id: true } })
      if (client) await setJourneyStage(client.id, 'signup', 'done', { note: `Stripe trial ${m?.subscriptionId ?? n.subscriptionId ?? ''}`.trim(), actor: source === 'poll' ? 'stripe-poll' : 'stripe-webhook' })
    })
  }
  return true
}

const POLL_KEY = 'stripe.signupPoll'
const POLL_EVERY_MS = 5 * 60_000
let lastPoll = 0
let polling = false

/**
 * The net under the webhook: every five minutes, ask Stripe for its newest
 * checkouts and announce any completed live trial nobody has announced yet.
 * The first run only notes the time (AppSetting stripe.signupPoll); checkouts
 * opened before it stay the webhook's, so turning this on never re-texts a
 * sign-up. One Stripe request per run. Returns how many it announced.
 */
export async function maybePollStripeSignups(o: { force?: boolean } = {}): Promise<number> {
  // The scheduler also runs under `next dev`; only the live Hub texts anyone.
  if (process.env.NODE_ENV !== 'production') return 0
  const now = Date.now()
  if (polling || (!o.force && now - lastPoll < POLL_EVERY_MS)) return 0
  lastPoll = now
  polling = true
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: POLL_KEY } })
    let since = NaN
    try {
      since = row ? Date.parse((JSON.parse(row.value) as { since?: string }).since ?? '') : NaN
    } catch {
      since = NaN
    }
    if (!Number.isFinite(since)) {
      const value = JSON.stringify({ since: new Date(now).toISOString() })
      await prisma.appSetting.upsert({ where: { key: POLL_KEY }, create: { key: POLL_KEY, value }, update: { value } })
      console.log('[stripe-signups] poll started: checkouts from now on are checked every 5 minutes')
      return 0
    }
    const news = signupsFromSessions(await recentCheckoutSessions(50), since)
    if (!news.length) return 0
    // Nearly always the webhook got there first: one query for all of them.
    const keys = news.map((n) => `stripe.signup:${n.sessionId}`)
    const done = new Set((await prisma.appSetting.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((r) => r.key))
    let announced = 0
    for (const n of news) {
      if (done.has(`stripe.signup:${n.sessionId}`)) continue
      if (await announceSignup(n, 'poll')) {
        announced++
        console.log(`[stripe-signups] ${n.sessionId}: announced by the poll; the webhook hadn't delivered it`)
      }
    }
    return announced
  } catch (err) {
    if (err instanceof StripeUnavailable) console.warn(`[stripe-signups] poll: ${err.message}`)
    else console.error('[stripe-signups] poll failed:', err)
    return 0
  } finally {
    polling = false
  }
}
