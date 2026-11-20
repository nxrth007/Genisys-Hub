/**
 * Stripe and the client onboarding gate: the part with no Hub in it (the tests
 * load it).
 *
 * The signup at leadgenisys.com (Ethan's Lovable project, repo
 * nxrth007/freesysystems) starts a 30-day free trial of the $297/mo plan in
 * Stripe Checkout with a card on file, then sends the client to the onboarding
 * form with ?session_id=cs_live_…. The form may only take answers from someone
 * who did that, so it asks the Hub (POST /api/public/checkout-verify) and the
 * Hub asks Stripe. Stripe also calls the Hub (POST /api/webhooks/stripe) as
 * trials start, payments fail and subscriptions end. This file decides what
 * counts and what the team is told; src/lib/stripe-onboarding.ts talks to Stripe
 * and the Vault.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Stripe Checkout Session ids, test and live. */
export const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/
/** A subscription in one of these states is a client who may onboard. */
export const MEMBER_STATUSES = new Set(['trialing', 'active'])
/** How old a signed webhook may be (Stripe's own default). */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const email = (v: unknown): string | null => str(v)?.toLowerCase() ?? null
/** Stripe's epoch seconds as an ISO date. */
const iso = (secs: unknown): string | null => {
  const n = num(secs)
  return n ? new Date(n * 1000).toISOString() : null
}
/** A Stripe reference that may be an id or the expanded object. */
const idOf = (v: unknown): string | null => (typeof v === 'string' ? str(v) : isObj(v) ? str(v.id) : null)

export type StripeMember = {
  valid: true
  email: string | null
  name: string | null
  phone: string | null
  customerId: string | null
  subscriptionId: string | null
  /** "trialing" or "active". */
  subscriptionStatus: string
  /** When the free trial ends (ISO), null once they are paying. */
  trialEnd: string | null
  /** The next charge (ISO). */
  periodEnd: string | null
  /** "$297/mo" when the price is known. */
  price: string | null
  livemode: boolean
  /** When the subscription started, i.e. when the checkout completed (ISO). */
  startedAt: string | null
}
export type NotMember = { valid: false; reason: string }

/** "$297/mo", "$25.50/mo", "$10/yr" from a Stripe Price. */
export function priceLabel(price: unknown): string | null {
  if (!isObj(price)) return null
  const amount = num(price.unit_amount)
  if (amount === null) return null
  const currency = str(price.currency)?.toUpperCase() ?? 'USD'
  const recurring = isObj(price.recurring) ? price.recurring : null
  const interval = recurring ? str(recurring.interval) : null
  const count = recurring ? (num(recurring.interval_count) ?? 1) : 1
  const money = moneyLabel(amount, currency)
  if (!interval) return money
  const short: Record<string, string> = { month: 'mo', year: 'yr', week: 'wk', day: 'day' }
  return `${money}/${count === 1 ? (short[interval] ?? interval) : `${count} ${interval}s`}`
}

/** "$297" or "$25.50" from an amount in cents. */
export function moneyLabel(cents: number, currency = 'USD'): string {
  const prefix = currency.toUpperCase() === 'USD' ? '$' : `${currency.toUpperCase()} `
  return prefix + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2))
}

/** "Dec 17" for a text or Slack line. */
export function shortDate(isoDate: string | null): string | null {
  if (!isoDate) return null
  const d = new Date(isoDate)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
}

function subscriptionItems(sub: Obj): Obj[] {
  const items = isObj(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : []
  return items.filter(isObj)
}

function memberFromSubscription(sub: Obj, who: { email: string | null; name: string | null; phone: string | null; customerId: string | null }): StripeMember | NotMember {
  const status = str(sub.status) ?? ''
  if (!MEMBER_STATUSES.has(status)) return { valid: false, reason: status ? `subscription ${status}` : 'no subscription' }
  const first = subscriptionItems(sub)[0]
  return {
    valid: true,
    email: who.email,
    name: who.name,
    phone: who.phone,
    customerId: who.customerId ?? idOf(sub.customer),
    subscriptionId: str(sub.id),
    subscriptionStatus: status,
    trialEnd: iso(sub.trial_end),
    // Newer Stripe API versions keep the period on the item, older ones on the subscription.
    periodEnd: iso(sub.current_period_end ?? first?.current_period_end),
    price: priceLabel(first?.price),
    livemode: sub.livemode === true,
    startedAt: iso(sub.start_date ?? sub.created),
  }
}

/**
 * A Checkout Session as Stripe returns it with the subscription expanded,
 * judged: a completed subscription checkout whose subscription is trialing or
 * active is a member. The /payment flow (a one-off charge, mode "payment") is
 * not a signup.
 */
export function judgeCheckout(session: unknown): StripeMember | NotMember {
  if (!isObj(session) || str(session.object) !== 'checkout.session') return { valid: false, reason: 'not a checkout session' }
  if (str(session.status) !== 'complete') return { valid: false, reason: `checkout ${str(session.status) ?? 'unknown'}` }
  if (str(session.mode) !== 'subscription') return { valid: false, reason: `checkout mode ${str(session.mode) ?? 'unknown'}` }
  if (!isObj(session.subscription)) return { valid: false, reason: 'no subscription on the checkout' }
  const d = isObj(session.customer_details) ? session.customer_details : {}
  const m = memberFromSubscription(session.subscription, { email: email(d.email), name: str(d.name), phone: str(d.phone), customerId: idOf(session.customer) })
  return m.valid ? { ...m, livemode: session.livemode === true } : m
}

/**
 * The customers Stripe found for an email, each with their subscriptions,
 * judged: the newest trialing or active subscription wins. For a client who
 * lost their checkout link and confirmed their email instead.
 */
export function judgeSubscriptions(customers: { customer: unknown; subscriptions: unknown }[]): StripeMember | NotMember {
  let reason = 'no customer with this email'
  for (const { customer, subscriptions } of customers) {
    const c = isObj(customer) ? customer : {}
    const list = Array.isArray(subscriptions) ? subscriptions : isObj(subscriptions) && Array.isArray(subscriptions.data) ? subscriptions.data : []
    const who = { email: email(c.email), name: str(c.name), phone: str(c.phone), customerId: str(c.id) }
    reason = 'no subscription'
    const subs = list.filter(isObj).sort((a, b) => (num(b.created) ?? 0) - (num(a.created) ?? 0))
    for (const sub of subs) {
      const m = memberFromSubscription(sub, who)
      if (m.valid) return m
      reason = m.reason
    }
  }
  return { valid: false, reason }
}

// --- Which Stripe account -----------------------------------------------------

/**
 * Stripe keys and object ids carry a 10-character account marker: a live key
 * reads sk_live_51<5 chars><marker>…, an id price_1<5 chars><marker>…. The
 * signup at leadgenisys.com publishes a live key with that marker and bills
 * price_1Ub3otIm6NAwaEImXCIP9UM2, and the Hub's webhook endpoint there is
 * we_1UctFbIm6NAwaEIm…, so that account's marker is:
 */
export const SIGNUP_ACCOUNT_MARKER = 'Im6NAwaEIm'

/** The account marker of a key or an object id, or null when the format doesn't carry one (customers, old-style keys). */
export function accountMarker(keyOrId: string): string | null {
  const m = /^(?:[sr]k|pk)_(?:live|test)_51[A-Za-z0-9]{5}([A-Za-z0-9]{10})/.exec(keyOrId) ?? /^[a-z]+(?:_[a-z]+)*_1[A-Za-z0-9]{5}([A-Za-z0-9]{10})/.exec(keyOrId)
  return m?.[1] ?? null
}

// --- Webhooks ---------------------------------------------------------------

/** What Stripe puts in the Stripe-Signature header for a body, for tests and checks. */
export function signStripePayload(secret: string, timestampSeconds: number, body: string): string {
  return `t=${timestampSeconds},v1=${createHmac('sha256', secret).update(`${timestampSeconds}.${body}`, 'utf8').digest('hex')}`
}

/** Stripe's webhook signature: HMAC-SHA256 of "<t>.<body>" with the endpoint's signing secret, within the tolerance. */
export function verifyStripeSignature(o: { secret: string; header: string | null; body: string; nowSeconds?: number }): { ok: true } | { ok: false; reason: string } {
  if (!o.header) return { ok: false, reason: 'no Stripe-Signature header' }
  const parts = o.header.split(',').map((p) => p.trim().split('=', 2) as [string, string | undefined])
  const t = parts.find(([k]) => k === 't')?.[1] ?? ''
  const given = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '')
  if (!/^\d+$/.test(t) || !given.length) return { ok: false, reason: 'malformed Stripe-Signature header' }
  const now = o.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp outside tolerance' }
  const expected = createHmac('sha256', o.secret).update(`${t}.${o.body}`, 'utf8').digest('hex')
  const ok = given.some((v) => /^[0-9a-f]{64}$/i.test(v) && timingSafeEqual(Buffer.from(v, 'hex'), Buffer.from(expected, 'hex')))
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' }
}

export type StripeNews =
  /** A trial started: checkout.session.completed for a subscription. The subscription itself isn't in the event; the Hub looks it up. */
  | { kind: 'signup'; eventId: string; sessionId: string; customerId: string | null; subscriptionId: string | null; email: string | null; name: string | null; phone: string | null; livemode: boolean; /** When it happened (ISO): the event's time, or the checkout's for the poll. */ at: string | null }
  /** customer.subscription.updated: trialing → active, past_due, … */
  | { kind: 'status'; eventId: string; customerId: string | null; subscriptionId: string | null; status: string; previousStatus: string | null; trialEnd: string | null; periodEnd: string | null; price: string | null; livemode: boolean }
  | { kind: 'canceled'; eventId: string; customerId: string | null; subscriptionId: string | null; livemode: boolean }
  | { kind: 'payment_failed'; eventId: string; customerId: string | null; email: string | null; name: string | null; amount: string | null; attempt: number | null; nextAttempt: string | null; livemode: boolean }
  | { kind: 'trial_ending'; eventId: string; customerId: string | null; subscriptionId: string | null; trialEnd: string | null; livemode: boolean }
  | { kind: 'ignored'; type: string }

/** A Stripe event, read for what the team should hear about. */
export function describeEvent(event: unknown): StripeNews {
  if (!isObj(event) || typeof event.type !== 'string') return { kind: 'ignored', type: 'unknown' }
  const type = event.type
  const eventId = str(event.id) ?? ''
  const data = isObj(event.data) ? event.data : {}
  const obj = isObj(data.object) ? data.object : {}
  const livemode = event.livemode === true
  switch (type) {
    case 'checkout.session.completed': {
      if (str(obj.mode) !== 'subscription' || str(obj.status) !== 'complete') return { kind: 'ignored', type }
      const d = isObj(obj.customer_details) ? obj.customer_details : {}
      return { kind: 'signup', eventId, sessionId: str(obj.id) ?? '', customerId: idOf(obj.customer), subscriptionId: idOf(obj.subscription), email: email(d.email), name: str(d.name), phone: str(d.phone), livemode, at: iso(event.created) }
    }
    case 'customer.subscription.updated': {
      const prev = isObj(data.previous_attributes) ? data.previous_attributes : {}
      const first = subscriptionItems(obj)[0]
      return { kind: 'status', eventId, customerId: idOf(obj.customer), subscriptionId: str(obj.id), status: str(obj.status) ?? 'unknown', previousStatus: str(prev.status), trialEnd: iso(obj.trial_end), periodEnd: iso(obj.current_period_end ?? first?.current_period_end), price: priceLabel(first?.price), livemode }
    }
    case 'customer.subscription.deleted':
      return { kind: 'canceled', eventId, customerId: idOf(obj.customer), subscriptionId: str(obj.id), livemode }
    case 'customer.subscription.trial_will_end':
      return { kind: 'trial_ending', eventId, customerId: idOf(obj.customer), subscriptionId: str(obj.id), trialEnd: iso(obj.trial_end), livemode }
    case 'invoice.payment_failed': {
      const due = num(obj.amount_due)
      return { kind: 'payment_failed', eventId, customerId: idOf(obj.customer), email: email(obj.customer_email), name: str(obj.customer_name), amount: due === null ? null : moneyLabel(due, str(obj.currency) ?? 'USD'), attempt: num(obj.attempt_count), nextAttempt: iso(obj.next_payment_attempt), livemode }
    }
    default:
      return { kind: 'ignored', type }
  }
}

/**
 * A sign-up alert sent this long after the checkout says when the person signed
 * up, so a late one is never read as new. From 2026-11-17 to 11-19 the Hub's
 * login check refused Stripe's deliveries, and Stripe's retries then brought
 * one- and two-day-old sign-ups in as "New sign-up!".
 */
export const LATE_SIGNUP_MS = 15 * 60_000

/** Is a sign-up from `signedUpAt` (ISO) old news at `now`? An unknown time counts as on time. */
export function signupIsLate(signedUpAt: string | null | undefined, now: number = Date.now()): boolean {
  const at = signedUpAt ? Date.parse(signedUpAt) : NaN
  return Number.isFinite(at) && now - at > LATE_SIGNUP_MS
}

/** "Nov 18 at 9:29 AM", Eastern time, plain spaces only (newer ICU puts a narrow no-break space before AM). */
export function signupMoment(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null
  const d = new Date(isoDate)
  if (Number.isNaN(d.getTime())) return null
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
  return `${day} at ${time}`.replace(/\s+/g, ' ')
}

/** The team text for a new trial. One that arrives late says when they signed up instead of calling it new. */
export function stripeSignupText(o: { name: string | null; email: string | null; price: string | null; trialEnd: string | null; link: string; signedUpAt?: string | null; now?: number }): string {
  const who = o.name || o.email || 'Someone'
  const extra = o.name && o.email ? ` (${o.email})` : ''
  const charge = shortDate(o.trialEnd)
  const price = o.price ? ` of ${o.price}` : ''
  const when = signupIsLate(o.signedUpAt, o.now) ? signupMoment(o.signedUpAt) : null
  if (when) return `Genisys: Late sign-up alert. ${who}${extra} started the free trial${price} on ${when} ET${charge ? `; first charge ${charge}` : ''}. ${o.link}`
  return `Genisys: New sign-up! ${who}${extra} started the free trial${price}${charge ? `; first charge ${charge}` : ''}. ${o.link}`
}

/**
 * The poll's view of checkout.session.completed (src/lib/stripe-signup-alerts.ts):
 * from Stripe's list of newest Checkout Sessions, the completed live trial
 * checkouts opened at or after `sinceMs`, oldest first, shaped like the
 * webhook's sign-up news. `at` is when the checkout was opened; the
 * announcement prefers the subscription's own start time.
 */
export function signupsFromSessions(list: unknown, sinceMs: number): Array<Extract<StripeNews, { kind: 'signup' }>> {
  const items = isObj(list) && Array.isArray(list.data) ? list.data.filter(isObj) : []
  const out: Array<Extract<StripeNews, { kind: 'signup' }>> = []
  for (const s of items) {
    const id = str(s.id)
    const created = num(s.created)
    if (!id || created === null || created * 1000 < sinceMs) continue
    if (str(s.mode) !== 'subscription' || str(s.status) !== 'complete' || s.livemode !== true) continue
    const d = isObj(s.customer_details) ? s.customer_details : {}
    out.push({ kind: 'signup', eventId: `poll:${id}`, sessionId: id, customerId: idOf(s.customer), subscriptionId: idOf(s.subscription), email: email(d.email), name: str(d.name), phone: str(d.phone), livemode: true, at: iso(created) })
  }
  return out.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
}
