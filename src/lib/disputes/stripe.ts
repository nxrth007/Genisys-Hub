/**
 * Stripe calls for dispute defense. The only key this file reads is the
 * Vault entry "Stripe Official Restricted". It never reads "Stripe API Key"
 * (the dead account) and it never logs a key or a webhook secret.
 */
import { firstSecret } from '@/lib/stripe-onboarding'
import {
  DISPUTE_KEY_ENTRY,
  DISPUTE_PERMISSIONS,
  DISPUTE_WEBHOOK_EVENTS,
  LEGACY_STRIPE_KEY_ENTRY,
  WEBHOOK_PATH,
  nextPurchaseFetch,
  redactSecrets,
  type Ce3,
  type PurchaseFetch,
} from './plan'

const API = 'https://api.stripe.com/v1'
const FILES = 'https://files.stripe.com/v1/files'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export class DisputeStripeError extends Error {
  status: number
  permission: string | null
  constructor(message: string, status: number, permission: string | null) {
    super(redactSecrets(message).slice(0, 400))
    this.status = status
    this.permission = permission
  }
}

export async function disputeKey(): Promise<{ name: string; value: string; mode: 'live' | 'test' | null }> {
  const s = await firstSecret([DISPUTE_KEY_ENTRY])
  if (!s) throw new DisputeStripeError(`the Vault has no "${DISPUTE_KEY_ENTRY}"`, 0, null)
  if (s.name === LEGACY_STRIPE_KEY_ENTRY) throw new DisputeStripeError('refusing the legacy Stripe key', 0, null)
  const mode = /_live_/.test(s.value) ? 'live' : /_test_/.test(s.value) ? 'test' : null
  return { name: s.name, value: s.value, mode }
}

function permissionOf(data: unknown): string | null {
  const err = isObj(data) && isObj(data.error) ? data.error : null
  const message = err && typeof err.message === 'string' ? err.message : ''
  return /\b(rak_[a-z0-9_]+)\b/.exec(message)?.[1] ?? null
}

function messageOf(data: unknown, status: number): string {
  const err = isObj(data) && isObj(data.error) ? data.error : null
  const message = err && typeof err.message === 'string' ? err.message : ''
  return redactSecrets(message || `Stripe answered ${status}`)
}

async function call(key: string, url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) }, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  const data: unknown = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

async function must(key: string, url: string, init: RequestInit): Promise<unknown> {
  const r = await call(key, url, init)
  if (!r.ok) throw new DisputeStripeError(messageOf(r.data, r.status), r.status, permissionOf(r.data))
  return r.data
}

export async function stripeGet(path: string): Promise<unknown> {
  const key = await disputeKey()
  return must(key.value, `${API}${path}`, { method: 'GET' })
}

export async function stripeForm(path: string, body: string): Promise<unknown> {
  const key = await disputeKey()
  return must(key.value, `${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
}

export async function listDisputes(status: string, max = 100): Promise<Obj[]> {
  const key = await disputeKey()
  const items: Obj[] = []
  let after: string | null = null
  for (;;) {
    const path = `/disputes?limit=100&status=${encodeURIComponent(status)}${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`
    const data = await must(key.value, `${API}${path}`, { method: 'GET' })
    const page = isObj(data) && Array.isArray(data.data) ? data.data.filter(isObj) : []
    items.push(...page)
    const last = page[page.length - 1]
    if (!isObj(data) || data.has_more !== true || !last || typeof last.id !== 'string' || items.length >= max) return items.slice(0, max)
    after = last.id
  }
}

export async function retrieveDispute(id: string): Promise<unknown> {
  const key = await disputeKey()
  const expanded = await call(key.value, `${API}/disputes/${encodeURIComponent(id)}?expand[]=charge`, { method: 'GET' })
  if (expanded.ok) return expanded.data
  return must(key.value, `${API}/disputes/${encodeURIComponent(id)}`, { method: 'GET' })
}

export async function listCustomerCharges(customerId: string): Promise<Obj[]> {
  const key = await disputeKey()
  const data = await must(key.value, `${API}/charges?customer=${encodeURIComponent(customerId)}&limit=100`, { method: 'GET' })
  return isObj(data) && Array.isArray(data.data) ? data.data.filter(isObj) : []
}

const INVOICE_ID = /^in_[A-Za-z0-9]+$/
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]+$/
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/

/** Last API version that still returns Charge.invoice. Basil (2025-03-31) removed it. */
const CHARGE_INVOICE_VERSION = '2024-09-30.acacia'

async function softGet(key: string, path: string, stripeVersion?: string): Promise<unknown | null> {
  try {
    const r = await call(key, `${API}${path}`, {
      method: 'GET',
      headers: stripeVersion ? { 'Stripe-Version': stripeVersion } : {},
    })
    if (r.ok) return r.data
    if (r.status !== 404) console.error(`[disputes] purchase lookup ${path.split('?')[0]}:`, messageOf(r.data, r.status))
    return null
  } catch (err) {
    console.error('[disputes] purchase lookup:', redactSecrets(err instanceof Error ? err.message : String(err)))
    return null
  }
}

function firstObject(data: unknown): Obj | null {
  const row = isObj(data) && Array.isArray(data.data) ? data.data.find(isObj) : null
  return row ?? null
}

async function cachedGet<T>(map: Map<string, Promise<T>>, id: string, load: () => Promise<T>): Promise<T> {
  const existing = map.get(id)
  if (existing) return existing
  const pending = load()
  map.set(id, pending)
  return pending
}

function attachSubscription(charge: Obj, subscription: Obj): void {
  const invoice = isObj(charge.invoice) ? charge.invoice : null
  const parent = invoice && isObj(invoice.parent) ? invoice.parent : null
  const details = parent && isObj(parent.subscription_details) ? parent.subscription_details : null
  const parentType = parent && typeof parent.type === 'string' ? parent.type : null
  if (details && parentType !== 'quote_details') {
    details.subscription = subscription
    return
  }
  if (invoice) {
    invoice.subscription = subscription
    return
  }
  charge.subscription = subscription
}

/**
 * Fills in purchase metadata Stripe did not copy onto the charge.
 * Reads only, and only the next object in line: invoice snapshot, then the
 * subscription, then the checkout session. A charge that already has a usable
 * IP, user agent, or device id is left alone. Failures are logged and skipped
 * so a missing permission does not drop the rest of the charge.
 */
export async function enrichChargePurchaseContext(charges: Obj[]): Promise<void> {
  if (!charges.some((ch) => nextPurchaseFetch({ charge: ch }))) return
  let key: { value: string }
  try {
    key = await disputeKey()
  } catch (err) {
    console.error('[disputes] purchase lookup:', redactSecrets(err instanceof Error ? err.message : String(err)))
    return
  }
  const invoices = new Map<string, Promise<Obj | null>>()
  const invoicesByPayment = new Map<string, Promise<Obj | null>>()
  const subscriptions = new Map<string, Promise<Obj | null>>()
  const sessionsBySubscription = new Map<string, Promise<Obj | null>>()
  const sessionsByPayment = new Map<string, Promise<Obj | null>>()

  const loadInvoice = (id: string) =>
    cachedGet(invoices, id, async () => {
      if (!INVOICE_ID.test(id)) return null
      const data = await softGet(key.value, `/invoices/${encodeURIComponent(id)}`)
      return isObj(data) && data.id === id ? data : null
    })
  const loadInvoiceIdFromCharge = (chargeId: string) =>
    cachedGet(invoices, `charge:${chargeId}`, async () => {
      if (!/^ch_[A-Za-z0-9]+$/.test(chargeId)) return null
      const data = await softGet(key.value, `/charges/${encodeURIComponent(chargeId)}`, CHARGE_INVOICE_VERSION)
      if (!isObj(data) || !('invoice' in data)) return null
      return data
    })
  const loadInvoiceByPayment = (paymentIntentId: string) =>
    cachedGet(invoicesByPayment, paymentIntentId, async () => {
      if (!PAYMENT_INTENT_ID.test(paymentIntentId)) return null
      const q = new URLSearchParams()
      q.set('limit', '1')
      q.set('payment[type]', 'payment_intent')
      q.set('payment[payment_intent]', paymentIntentId)
      const data = await softGet(key.value, `/invoice_payments?${q}`)
      const row = firstObject(data)
      if (row && isObj(row.invoice) && typeof row.invoice.id === 'string') return row.invoice
      const invoiceId = row && typeof row.invoice === 'string' ? row.invoice : null
      if (!invoiceId) return null
      return loadInvoice(invoiceId)
    })
  const loadSubscription = (id: string) =>
    cachedGet(subscriptions, id, async () => {
      if (!SUBSCRIPTION_ID.test(id)) return null
      const data = await softGet(key.value, `/subscriptions/${encodeURIComponent(id)}`)
      return isObj(data) && (data.object === 'subscription' || data.id === id) ? data : null
    })
  const loadSession = async (step: Extract<PurchaseFetch, { kind: 'checkout_session' }>): Promise<Obj | null> => {
    if (step.subscriptionId && SUBSCRIPTION_ID.test(step.subscriptionId)) {
      const found = await cachedGet(sessionsBySubscription, step.subscriptionId, () => listCheckoutSession(key.value, 'subscription', step.subscriptionId as string))
      if (found) return found
    }
    if (step.paymentIntentId && PAYMENT_INTENT_ID.test(step.paymentIntentId)) {
      return cachedGet(sessionsByPayment, step.paymentIntentId, () => listCheckoutSession(key.value, 'payment_intent', step.paymentIntentId as string))
    }
    return null
  }

  await mapPool(charges, 4, async (ch) => {
    const triedInvoiceIds: string[] = []
    const triedChargeIds: string[] = []
    const triedPaymentIntents: string[] = []
    const triedSubscriptionIds: string[] = []
    const triedSessionKeys: string[] = []
    for (let n = 0; n < 6; n++) {
      const step = nextPurchaseFetch({ charge: ch, triedInvoiceIds, triedChargeIds, triedPaymentIntents, triedSubscriptionIds, triedSessionKeys })
      if (!step) return
      if (step.kind === 'invoice') {
        triedInvoiceIds.push(step.id)
        const invoice = await loadInvoice(step.id)
        if (invoice) ch.invoice = invoice
      } else if (step.kind === 'charge_invoice') {
        triedChargeIds.push(step.chargeId)
        const legacy = await loadInvoiceIdFromCharge(step.chargeId)
        if (legacy && 'invoice' in legacy) {
          const id = typeof legacy.invoice === 'string' && legacy.invoice.startsWith('in_') ? legacy.invoice : null
          ch.invoice = id
        }
      } else if (step.kind === 'invoice_payment') {
        triedPaymentIntents.push(step.paymentIntentId)
        const invoice = await loadInvoiceByPayment(step.paymentIntentId)
        if (invoice) ch.invoice = invoice
      } else if (step.kind === 'subscription') {
        triedSubscriptionIds.push(step.id)
        const subscription = await loadSubscription(step.id)
        if (subscription) attachSubscription(ch, subscription)
      } else {
        triedSessionKeys.push(`${step.subscriptionId ?? ''}|${step.paymentIntentId ?? ''}`)
        const session = await loadSession(step)
        if (session) ch.checkout_session = session
      }
    }
  })
}

async function listCheckoutSession(key: string, field: 'subscription' | 'payment_intent', id: string): Promise<Obj | null> {
  const q = new URLSearchParams()
  q.set('limit', '1')
  q.set(field, id)
  const row = firstObject(await softGet(key, `/checkout/sessions?${q}`))
  if (!row) return null
  return row.object === 'checkout.session' || (typeof row.id === 'string' && row.id.startsWith('cs_')) ? row : null
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

export async function uploadDisputeFile(bytes: Buffer, filename: string, mime: string): Promise<string> {
  const key = await disputeKey()
  if (bytes.length > 5 * 1024 * 1024) throw new DisputeStripeError(`${filename} is over 5 MB`, 0, null)
  const boundary = `----HubDispute${Math.random().toString(16).slice(2)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ndispute_evidence\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename.replace(/"/g, '')}"\r\nContent-Type: ${mime}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, bytes, tail])
  const data = await must(key.value, FILES, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  const id = isObj(data) && typeof data.id === 'string' ? data.id : ''
  if (!id) throw new DisputeStripeError('Stripe did not return a file id', 0, null)
  return id
}

export async function updateDisputeEvidence(disputeId: string, formBody: string, idempotencyKey?: string): Promise<unknown> {
  // Stripe's default for `submit` is true. A body that forgets the flag would file the dispute.
  if (!/(^|&)submit=(?:true|false)(?:&|$)/.test(formBody)) {
    throw new DisputeStripeError('refusing a dispute update that does not set submit explicitly', 0, null)
  }
  const key = await disputeKey()
  return must(key.value, `${API}/disputes/${encodeURIComponent(disputeId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 255) } : {}),
    },
    body: formBody,
  })
}

export async function stampMetadata(resource: 'customers' | 'charges' | 'payment_intents', id: string, metadata: Record<string, string>): Promise<void> {
  const entries = Object.entries(metadata).filter(([, v]) => v.trim())
  if (!id || !entries.length) return
  const body = new URLSearchParams()
  for (const [k, v] of entries) body.set(`metadata[${k}]`, v.slice(0, 500))
  await stripeForm(`/${resource}/${encodeURIComponent(id)}`, body.toString())
}

export async function refundCharge(chargeId: string): Promise<void> {
  const body = new URLSearchParams()
  body.set('charge', chargeId)
  body.set('reason', 'fraudulent')
  await stripeForm('/refunds', body.toString())
}

export type ProbeResult = {
  keyName: string
  mode: 'live' | 'test' | null
  checkedAt: string
  reads: { label: string; ok: boolean; status: number; missing: string | null }[]
  webhook: { found: boolean; url: string | null; missingEvents: string[]; listensToAll: boolean } | null
  writesNotVerified: readonly string[]
  optional: readonly string[]
}

export async function probeDisputeKey(): Promise<ProbeResult> {
  const key = await disputeKey()
  const probes: { path: string; label: string }[] = [
    { path: '/disputes?limit=1', label: 'Disputes: Read' },
    { path: '/charges?limit=1', label: 'Charges: Read' },
    { path: '/payment_intents?limit=1', label: 'PaymentIntents: Read' },
    { path: '/customers?limit=1', label: 'Customers: Read' },
    { path: '/invoices?limit=1', label: 'Invoices: Read' },
    { path: '/subscriptions?limit=1', label: 'Subscriptions: Read' },
    { path: '/checkout/sessions?limit=1', label: 'Checkout Sessions: Read' },
    { path: '/files?limit=1', label: 'Files: Read' },
    { path: '/webhook_endpoints?limit=1', label: 'Webhook endpoints: Read' },
    { path: '/radar/early_fraud_warnings?limit=1', label: 'Radar early fraud warnings: Read' },
  ]
  const reads: ProbeResult['reads'] = []
  let webhook: ProbeResult['webhook'] = null
  for (const probe of probes) {
    const r = await call(key.value, `${API}${probe.path}`, { method: 'GET' })
    reads.push({ label: probe.label, ok: r.ok, status: r.status, missing: r.ok ? null : permissionOf(r.data) })
    if (probe.path.startsWith('/webhook_endpoints') && r.ok && isObj(r.data) && Array.isArray(r.data.data)) {
      const endpoints = r.data.data.filter(isObj)
      const ours = endpoints.find((e) => typeof e.url === 'string' && e.url.includes(WEBHOOK_PATH))
      if (!ours) webhook = { found: false, url: null, missingEvents: [...DISPUTE_WEBHOOK_EVENTS], listensToAll: false }
      else {
        const enabled = Array.isArray(ours.enabled_events) ? ours.enabled_events.filter((x): x is string => typeof x === 'string') : []
        const all = enabled.includes('*')
        webhook = {
          found: true,
          url: typeof ours.url === 'string' ? ours.url : null,
          listensToAll: all,
          missingEvents: all ? [] : DISPUTE_WEBHOOK_EVENTS.filter((ev) => !enabled.includes(ev)),
        }
      }
    }
  }
  return {
    keyName: key.name,
    mode: key.mode,
    checkedAt: new Date().toISOString(),
    reads,
    webhook,
    writesNotVerified: DISPUTE_PERMISSIONS.write,
    optional: DISPUTE_PERMISSIONS.optional,
  }
}

/** Used by the form builder's return type so a caller can pass Ce3 through without this file parsing it. */
export type { Ce3 }
