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
