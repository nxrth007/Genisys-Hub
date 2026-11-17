/**
 * Stripe for the client onboarding gate: the Vault entries, the calls to
 * Stripe, and what the Hub remembers about each member. The rules are in
 * stripe-onboarding-plan.ts; the routes are /api/public/checkout-verify (the
 * form's question) and /api/webhooks/stripe (Stripe's news).
 *
 * The Stripe key is a restricted key (Checkout Sessions, Customers and
 * Subscriptions: read) Alex made on 2026-11-17, so the Hub can look but never
 * charge or refund here. The Payments page keeps its own, fuller "Stripe API
 * Key".
 */
import { prisma } from '@/lib/prisma'
import { hubAlert, hubAlertThrottled } from '@/lib/hub-alerts'
import { getSecretByName } from '@/lib/vault-service'
import { CHECKOUT_SESSION_ID, judgeCheckout, judgeSubscriptions, type NotMember, type StripeMember } from './stripe-onboarding-plan'

/** Vault entries: the names Alex gave them, then the names suggested before he made them. */
export const STRIPE_KEY_ENTRIES = ['Stripe Official Restricted', 'Stripe Onboarding Key']
export const STRIPE_WEBHOOK_ENTRIES = ['Stripe Official Webhook Secret', 'Stripe Webhook Secret']
export const VERIFY_KEY_ENTRIES = ['Official Client Onboarding Verification Key', 'Client Onboarding Verification Key']

/** The first of these Vault entries that exists and isn't blank, or null (the caller says which to add). */
export async function firstSecret(names: string[]): Promise<{ name: string; value: string } | null> {
  for (const name of names) {
    try {
      const value = (await getSecretByName(name)).trim()
      if (value) return { name, value }
    } catch {
      // not this name; try the next
    }
  }
  return null
}

/** The Vault has no key, or Stripe didn't answer: the form falls back to the signup's own verifier. */
export class StripeUnavailable extends Error {}

const STRIPE = 'https://api.stripe.com/v1'
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function stripeErrorMessage(data: unknown): string {
  const err = isObj(data) && isObj(data.error) ? data.error : null
  return (err && typeof err.message === 'string' ? err.message : 'no detail').slice(0, 200)
}

async function stripeGet(key: string, path: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${STRIPE}${path}`, { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  const data: unknown = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

async function stripeKey(): Promise<string> {
  const s = await firstSecret(STRIPE_KEY_ENTRIES)
  if (!s) throw new StripeUnavailable(`the Vault has no "${STRIPE_KEY_ENTRIES[0]}"`)
  return s.value
}

/** Stripe asked for a key, list or object; anything but an answer is "unavailable" (never "not a member"). */
async function stripeMust(key: string, path: string): Promise<unknown> {
  const r = await stripeGet(key, path)
  if (!r.ok) throw new StripeUnavailable(`Stripe answered ${r.status}: ${stripeErrorMessage(r.data)}`)
  return r.data
}

/**
 * Stripe's answer for a checkout id: a member, or why not. An id Stripe doesn't
 * know (404) is "not a member", the same as an unfinished checkout, so ids
 * can't be probed; a key or permission problem is "unavailable".
 */
export async function checkoutMember(sessionId: string): Promise<StripeMember | NotMember> {
  if (!CHECKOUT_SESSION_ID.test(sessionId)) return { valid: false, reason: 'not a checkout id' }
  const key = await stripeKey()
  const r = await stripeGet(key, `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`)
  if (r.status === 404) return { valid: false, reason: 'no such checkout' }
  if (!r.ok) throw new StripeUnavailable(`Stripe answered ${r.status}: ${stripeErrorMessage(r.data)}`)
  return judgeCheckout(r.data)
}

/** Stripe's answer for an email: the newest trialing or active subscription of a customer with that email. */
export async function emailMember(email: string): Promise<StripeMember | NotMember> {
  const key = await stripeKey()
  const list = await stripeMust(key, `/customers?email=${encodeURIComponent(email.trim().toLowerCase())}&limit=10`)
  const customers = isObj(list) && Array.isArray(list.data) ? list.data.filter(isObj) : []
  const found: { customer: unknown; subscriptions: unknown }[] = []
  for (const customer of customers.slice(0, 5)) {
    const id = typeof customer.id === 'string' ? customer.id : ''
    if (!id) continue
    found.push({ customer, subscriptions: await stripeMust(key, `/subscriptions?customer=${encodeURIComponent(id)}&status=all&limit=10`) })
  }
  return judgeSubscriptions(found)
}

/** Who a Stripe customer id is, for events that carry only the id. */
export async function stripeCustomer(customerId: string): Promise<{ email: string | null; name: string | null; phone: string | null } | null> {
  try {
    const key = await stripeKey()
    const c = await stripeMust(key, `/customers/${encodeURIComponent(customerId)}`)
    if (!isObj(c)) return null
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return { email: s(c.email)?.toLowerCase() ?? null, name: s(c.name), phone: s(c.phone) }
  } catch {
    return null
  }
}

// --- What the Hub remembers --------------------------------------------------

/**
 * One row per Stripe customer (AppSetting `stripe.customer:<id>`), plus
 * `stripe.email:<email>` pointing at it, kept current by the webhook. Read by
 * the Genisys OS Memberships panel; nothing bills from it.
 */
export type StripeMemberRecord = {
  customerId: string
  subscriptionId: string | null
  email: string | null
  name: string | null
  phone: string | null
  /** trialing, active, past_due, canceled, … */
  status: string | null
  trialEnd: string | null
  periodEnd: string | null
  price: string | null
  livemode: boolean
  updatedAt: string
}

const customerKey = (id: string) => `stripe.customer:${id}`
const emailKey = (email: string) => `stripe.email:${email.trim().toLowerCase()}`

export async function rememberedMember(customerId: string): Promise<StripeMemberRecord | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: customerKey(customerId) } })
  if (!row) return null
  try {
    return JSON.parse(row.value) as StripeMemberRecord
  } catch {
    return null
  }
}

export async function rememberedMemberByEmail(email: string): Promise<StripeMemberRecord | null> {
  const pointer = await prisma.appSetting.findUnique({ where: { key: emailKey(email) } })
  return pointer ? rememberedMember(pointer.value) : null
}

/** Merge what an event or lookup knows into the customer's row; unknowns (null) never erase what's there. */
export async function rememberMember(update: Partial<StripeMemberRecord> & { customerId: string }): Promise<StripeMemberRecord> {
  const current = await rememberedMember(update.customerId)
  const next: StripeMemberRecord = {
    customerId: update.customerId,
    subscriptionId: update.subscriptionId ?? current?.subscriptionId ?? null,
    email: update.email ?? current?.email ?? null,
    name: update.name ?? current?.name ?? null,
    phone: update.phone ?? current?.phone ?? null,
    status: update.status ?? current?.status ?? null,
    trialEnd: update.trialEnd === undefined ? (current?.trialEnd ?? null) : update.trialEnd,
    periodEnd: update.periodEnd ?? current?.periodEnd ?? null,
    price: update.price ?? current?.price ?? null,
    livemode: update.livemode ?? current?.livemode ?? true,
    updatedAt: new Date().toISOString(),
  }
  const value = JSON.stringify(next)
  await prisma.appSetting.upsert({ where: { key: customerKey(next.customerId) }, create: { key: customerKey(next.customerId), value }, update: { value } })
  if (next.email) {
    await prisma.appSetting.upsert({ where: { key: emailKey(next.email) }, create: { key: emailKey(next.email), value: next.customerId }, update: { value: next.customerId } })
  }
  return next
}

/**
 * Each Stripe event is handled once, whichever delivery arrives first: the
 * AppSetting key is unique, so only the caller whose insert succeeds gets true.
 */
export async function claimStripeEvent(eventId: string): Promise<boolean> {
  const id = eventId.trim()
  if (!id) return false
  try {
    await prisma.appSetting.create({ data: { key: `stripe.event:${id}`, value: new Date().toISOString() } })
    return true
  } catch (err) {
    if (!!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') return false
    throw err
  }
}

// --- What the Clients page shows about the gate ------------------------------

/**
 * The gate's health, as the Clients page's onboarding strip shows it (the team
 * doesn't read Slack): the Hub's own check of its Stripe key and Vault entries,
 * the last time the form asked the Hub and how that went, the last event Stripe
 * delivered, and the last sign-up. Each part is one AppSetting row
 * (`stripe.status:<part>`), written as things happen.
 */
export type StripeGateStatus = {
  selfCheck: { at: string; ok: boolean; problems: string[]; keyMode: 'live' | 'test' | null } | null
  verify: { at: string; outcome: 'ok' | 'not_member' | 'unauthorized' | 'unavailable'; asked: 'session' | 'email' | 'unknown' } | null
  webhook: { at: string; type: string; livemode: boolean } | null
  signup: { at: string; who: string; email: string | null; price: string | null; trialEnd: string | null; livemode: boolean } | null
}

const statusKey = (part: keyof StripeGateStatus) => `stripe.status:${part}`

export async function noteStripeStatus<K extends keyof StripeGateStatus>(part: K, data: NonNullable<StripeGateStatus[K]>): Promise<void> {
  const value = JSON.stringify(data)
  await prisma.appSetting
    .upsert({ where: { key: statusKey(part) }, create: { key: statusKey(part), value }, update: { value } })
    .catch((err) => console.error(`[stripe-onboarding] status ${part}:`, err))
}

export async function stripeGateStatus(): Promise<StripeGateStatus> {
  const parts: (keyof StripeGateStatus)[] = ['selfCheck', 'verify', 'webhook', 'signup']
  const rows = await prisma.appSetting.findMany({ where: { key: { in: parts.map(statusKey) } } })
  const read = <K extends keyof StripeGateStatus>(part: K): StripeGateStatus[K] => {
    const row = rows.find((r) => r.key === statusKey(part))
    if (!row) return null as StripeGateStatus[K]
    try {
      return JSON.parse(row.value) as StripeGateStatus[K]
    } catch {
      return null as StripeGateStatus[K]
    }
  }
  return { selfCheck: read('selfCheck'), verify: read('verify'), webhook: read('webhook'), signup: read('signup') }
}

// --- Self-check ------------------------------------------------------------

let lastSelfCheck = 0
const SELF_CHECK_EVERY_MS = 6 * 60 * 60_000
const SELF_CHECK_DONE_KEY = 'stripe.selfCheck.v1'

/**
 * Within a minute of a deploy, every six hours after, and whenever the Clients
 * page asks (`force`): can the Hub actually ask Stripe, is the key a live one,
 * and are the other two Vault entries there? The result is kept for the
 * Clients page; Slack hears once when it all first works and (throttled) when
 * something is wrong.
 */
export async function maybeCheckStripeOnboarding(force = false): Promise<StripeGateStatus['selfCheck']> {
  if (!force) {
    if (process.env.NODE_ENV !== 'production') return null
    if (Date.now() - lastSelfCheck < SELF_CHECK_EVERY_MS) return null
  }
  lastSelfCheck = Date.now()
  const problems: string[] = []
  let keyMode: 'live' | 'test' | null = null
  const key = await firstSecret(STRIPE_KEY_ENTRIES)
  if (!key) {
    problems.push(`no "${STRIPE_KEY_ENTRIES[0]}" in the Vault`)
  } else {
    keyMode = /^(rk|sk)_live_/.test(key.value) ? 'live' : 'test'
    const r = await stripeGet(key.value, '/customers?limit=1').catch((err: unknown) => ({ ok: false, status: 0, data: { error: { message: err instanceof Error ? err.message : String(err) } } }))
    if (!r.ok) problems.push(`Stripe refused the "${key.name}" key (${r.status || 'no answer'}: ${stripeErrorMessage(r.data)})`)
    else if (keyMode !== 'live') problems.push(`"${key.name}" is a test-mode key, and real sign-ups are live`)
  }
  if (!(await firstSecret(STRIPE_WEBHOOK_ENTRIES))) problems.push(`no "${STRIPE_WEBHOOK_ENTRIES[0]}" in the Vault, so Stripe's events will be refused`)
  if (!(await firstSecret(VERIFY_KEY_ENTRIES))) problems.push(`no "${VERIFY_KEY_ENTRIES[0]}" in the Vault, so the form can't ask the Hub`)
  const result = { at: new Date().toISOString(), ok: problems.length === 0, problems, keyMode }
  await noteStripeStatus('selfCheck', result)
  if (problems.length) {
    console.warn(`[stripe-onboarding] self-check: ${problems.join('; ')}`)
    await hubAlertThrottled('stripe-onboarding:selfcheck', SELF_CHECK_EVERY_MS, `:warning: *Stripe sign-up check* — ${problems.join('; ')}. Fix it in the Vault; until then the onboarding form asks the signup site's own verifier.`)
    return result
  }
  if (!(await prisma.appSetting.findUnique({ where: { key: SELF_CHECK_DONE_KEY } }))) {
    await prisma.appSetting.create({ data: { key: SELF_CHECK_DONE_KEY, value: result.at } }).catch(() => null)
    await hubAlert(":white_check_mark: *Stripe is connected to the Hub* — the restricted key, the webhook secret and the form's password are all in the Vault, and Stripe answered. New sign-ups will be announced here as they happen.")
  }
  return result
}
