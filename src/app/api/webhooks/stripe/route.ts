import { NextRequest, NextResponse, after } from 'next/server'
import { hubAlert, hubAlertThrottled, hubLink } from '@/lib/hub-alerts'
import { invalidateBillingSnapshot } from '@/lib/stripe-billing'
import { claimStripeEvent, firstSecret, noteStripeStatus, rememberMember, STRIPE_WEBHOOK_ENTRIES, stripeCustomer } from '@/lib/stripe-onboarding'
import { describeEvent, shortDate, verifyStripeSignature, type StripeNews } from '@/lib/stripe-onboarding-plan'
import { announceSignup } from '@/lib/stripe-signup-alerts'
import { classifyStripeSideEffect, redactSecrets } from '@/lib/disputes/plan'
import { handleStripeSideEffect } from '@/lib/disputes/run'

/**
 * POST /api/webhooks/stripe
 *
 * Stripe calls this for Genisys's account. Alex added the endpoint in the
 * Stripe dashboard on 2026-11-17 (events: checkout.session.completed,
 * customer.subscription.updated, customer.subscription.deleted,
 * invoice.payment_failed); its signing secret is the Vault entry "Stripe
 * Official Webhook Secret". The signup site (nxrth007/freesysystems) has its own
 * Stripe webhooks for its ledger and GHL; this one is the Hub's:
 *   - a trial starts: a team text and a #genisys-alerts post, the client's
 *     journey ticked, Ethan's tracker ticked, the member remembered
 *     (AppSetting stripe.customer:<id>) for the Memberships panel;
 *   - a payment fails, a subscription goes past due or ends: a post.
 *
 * A valid event always gets a 200 straight away; the work runs afterwards
 * (next/server `after`) so a slow Slack or GHL never makes Stripe retry. Each
 * event is handled once (claimStripeEvent), so a retry can't text twice. Only
 * a bad signature (401) or an unreadable body (400) is refused.
 *
 * This route must stay in middleware's PUBLIC_PATHS (tests/public-routes.test.mjs
 * checks). Until 2026-11-19 it wasn't: every delivery met the login check's
 * 401, and Stripe's retries brought sign-ups in one to two days late. A
 * sign-up is announced by src/lib/stripe-signup-alerts.ts, shared with a
 * five-minute poll of Stripe, so it is texted once and within minutes even
 * when this endpoint can't be reached.
 */

export async function POST(req: NextRequest) {
  const raw = await req.text()
  const secret = await firstSecret(STRIPE_WEBHOOK_ENTRIES)
  if (!secret) {
    await hubAlertThrottled('stripe-webhook:no_secret', 30 * 60_000, `:rotating_light: *Stripe sent the Hub an event but the Vault has no "${STRIPE_WEBHOOK_ENTRIES[0]}"* — add the endpoint's signing secret (whsec_…) from Stripe → Developers → Webhooks.`)
    return NextResponse.json({ error: 'not_configured' }, { status: 503 })
  }
  const check = verifyStripeSignature({ secret: secret.value, header: req.headers.get('stripe-signature'), body: raw })
  if (!check.ok) {
    await hubAlertThrottled('stripe-webhook:invalid_signature', 30 * 60_000, `:rotating_light: *Stripe webhook rejected a request* (${check.reason}). If real sign-ups aren't showing up, check the Vault entry "${secret.name}" matches the endpoint's signing secret in Stripe → Developers → Webhooks.`)
    return NextResponse.json({ error: 'invalid_signature', reason: check.reason }, { status: 401 })
  }

  let event: unknown
  try {
    event = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const news = describeEvent(event)
  const side = classifyStripeSideEffect(event)
  // The Clients page shows the last event Stripe delivered: proof the secret matches, whatever the event was.
  const e = event as { type?: unknown; livemode?: unknown } | null
  void noteStripeStatus('webhook', { at: new Date().toISOString(), type: typeof e?.type === 'string' ? e.type : 'unknown', livemode: e?.livemode === true })
  // Something changed in Stripe: the Clients and Payments pages read it fresh next time.
  invalidateBillingSnapshot()
  if (news.kind === 'ignored' && !side) return NextResponse.json({ ok: true, ignored: news.type })
  after(() => {
    const jobs: Promise<unknown>[] = []
    if (news.kind !== 'ignored') jobs.push(handle(news).catch((err) => console.error(`[stripe-webhook] ${news.eventId}:`, err)))
    if (side) jobs.push(handleStripeSideEffect(side).catch((err) => console.error(`[stripe-webhook] dispute ${side.eventId}:`, redactSecrets(err instanceof Error ? err.message : String(err)))))
    return Promise.all(jobs).then(() => undefined)
  })
  return NextResponse.json({ ok: true, dispute: side?.kind ?? null })
}

const clientsLink = () => hubLink('/clients')

async function handle(news: Exclude<StripeNews, { kind: 'ignored' }>) {
  if (!(await claimStripeEvent(news.eventId))) return
  switch (news.kind) {
    case 'signup':
      return handleSignup(news)
    case 'status':
      return handleStatus(news)
    case 'canceled':
      return handleCanceled(news)
    case 'payment_failed':
      return handlePaymentFailed(news)
    case 'trial_ending':
      return handleTrialEnding(news)
  }
}

// A trial started: src/lib/stripe-signup-alerts.ts tells the team once, whether this webhook or the five-minute poll sees it first.
const handleSignup = (n: Extract<StripeNews, { kind: 'signup' }>) => announceSignup(n, 'webhook')

async function whoIs(customerId: string | null, fallback: { email?: string | null; name?: string | null } = {}): Promise<string> {
  const c = customerId ? await stripeCustomer(customerId) : null
  const name = fallback.name ?? c?.name ?? null
  const email = fallback.email ?? c?.email ?? null
  return `${name ?? email ?? customerId ?? 'a client'}${name && email ? ` (${email})` : ''}`
}

async function handleStatus(n: Extract<StripeNews, { kind: 'status' }>) {
  if (n.customerId) {
    const c = await stripeCustomer(n.customerId)
    await rememberMember({ customerId: n.customerId, subscriptionId: n.subscriptionId, email: c?.email ?? null, name: c?.name ?? null, phone: c?.phone ?? null, status: n.status, trialEnd: n.trialEnd, periodEnd: n.periodEnd, price: n.price, livemode: n.livemode }).catch((err) => console.error('[stripe-webhook] remember:', err))
  }
  if (!n.livemode || n.status === n.previousStatus) return
  if (n.status === 'past_due' || n.status === 'unpaid') {
    await hubAlert(`:warning: *Subscription ${n.status.replace('_', ' ')}* — ${await whoIs(n.customerId)}. Stripe will retry the card; <${clientsLink()}|Clients>.`).catch(() => {})
  } else if (n.previousStatus === 'trialing' && n.status === 'active') {
    await hubAlert(`:tada: *Trial converted* — ${await whoIs(n.customerId)} is now paying${n.price ? ` ${n.price}` : ''}. <${clientsLink()}|Clients>`).catch(() => {})
  }
}

async function handleCanceled(n: Extract<StripeNews, { kind: 'canceled' }>) {
  if (n.customerId) await rememberMember({ customerId: n.customerId, subscriptionId: n.subscriptionId, status: 'canceled', trialEnd: null, livemode: n.livemode }).catch((err) => console.error('[stripe-webhook] remember:', err))
  if (!n.livemode) return
  await hubAlert(`:no_entry_sign: *Subscription ended* — ${await whoIs(n.customerId)} canceled. <${clientsLink()}|Clients>`).catch(() => {})
}

async function handlePaymentFailed(n: Extract<StripeNews, { kind: 'payment_failed' }>) {
  if (!n.livemode) return
  const next = shortDate(n.nextAttempt)
  await hubAlert(`:credit_card: *Payment failed* — ${await whoIs(n.customerId, { email: n.email, name: n.name })}${n.amount ? `, ${n.amount}` : ''}${n.attempt ? ` (attempt ${n.attempt})` : ''}${next ? `; Stripe retries ${next}` : ''}. <${clientsLink()}|Clients>`).catch(() => {})
}

async function handleTrialEnding(n: Extract<StripeNews, { kind: 'trial_ending' }>) {
  if (!n.livemode) return
  const end = shortDate(n.trialEnd)
  await hubAlert(`:hourglass: *Trial ending* — ${await whoIs(n.customerId)}'s free trial ends${end ? ` ${end}` : ' in 3 days'}; the first charge follows. <${clientsLink()}|Clients>`).catch(() => {})
}

/** A GET is someone checking the URL is live. */
export function GET() {
  return NextResponse.json({ ok: true, endpoint: 'stripe-webhook', accepts: 'POST (Stripe-Signature signed)' })
}
