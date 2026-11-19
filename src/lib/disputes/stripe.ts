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
  checkoutSessionForPurchase,
  invoiceIdFromCharge,
  nextPurchaseFetch,
  purchaseLookupFailed,
  purchaseSignalsFromMetadata,
  purchaseSignalsFromStripe,
  redactSecrets,
  stampPurchaseSignals,
  type Ce3,
  type PurchaseFetch,
  type PurchaseSignals,
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

type SoftResult = { data: unknown | null; status: number; failed: boolean }

/** GET only. 404 is a miss. 403, 429, and network errors are misses that must not be cached. */
async function softGet(key: string, path: string, stripeVersion?: string): Promise<SoftResult> {
  try {
    const r = await call(key, `${API}${path}`, {
      method: 'GET',
      headers: stripeVersion ? { 'Stripe-Version': stripeVersion } : {},
    })
    if (r.ok) return { data: r.data, status: r.status, failed: false }
    if (purchaseLookupFailed(r.status)) console.error(`[disputes] purchase lookup ${path.split('?')[0]}:`, messageOf(r.data, r.status))
    return { data: null, status: r.status, failed: purchaseLookupFailed(r.status) }
  } catch (err) {
    console.error('[disputes] purchase lookup:', redactSecrets(err instanceof Error ? err.message : String(err)))
    return { data: null, status: 0, failed: true }
  }
}

type Loaded<T> = { value: T | null; failed: boolean }

/**
 * Completed lookups, including an empty trio. A 15-minute reconcile must not
 * repeat a walk that already finished. 403 and 429 are not stored.
 */
const PURCHASE_CACHE_MS = 2 * 60 * 60 * 1000
const purchaseCache = new Map<string, { at: number; signals: PurchaseSignals }>()

function recallPurchaseSignals(chargeId: string): PurchaseSignals | null {
  const hit = purchaseCache.get(chargeId)
  if (!hit) return null
  if (Date.now() - hit.at > PURCHASE_CACHE_MS) {
    purchaseCache.delete(chargeId)
    return null
  }
  return hit.signals
}

function rememberPurchaseSignals(chargeId: string, signals: PurchaseSignals): void {
  if (purchaseCache.size > 2000) purchaseCache.clear()
  purchaseCache.set(chargeId, { at: Date.now(), signals })
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
 * so a missing permission does not drop the rest of the charge or the packet.
 * The pre-basil re-read contributes its invoice id and nothing else.
 */
export async function enrichChargePurchaseContext(charges: Obj[]): Promise<void> {
  const pending = charges.filter((ch) => {
    const id = typeof ch.id === 'string' ? ch.id : ''
    const live = purchaseSignalsFromMetadata(ch.metadata)
    if (live.ip || live.userAgent || live.deviceId) return false
    if (!id) return nextPurchaseFetch({ charge: ch }) !== null
    const recalled = recallPurchaseSignals(id)
    if (!recalled) return nextPurchaseFetch({ charge: ch }) !== null
    if (recalled.ip || recalled.userAgent || recalled.deviceId) stampPurchaseSignals(ch, recalled)
    return false
  })
  if (!pending.length) return
  let key: { value: string }
  try {
    key = await disputeKey()
  } catch (err) {
    console.error('[disputes] purchase lookup:', redactSecrets(err instanceof Error ? err.message : String(err)))
    return
  }
  const invoices = new Map<string, Promise<Loaded<Obj>>>()
  const chargeInvoices = new Map<string, Promise<{ invoiceId: string | null | undefined; failed: boolean }>>()
  const invoicesByPayment = new Map<string, Promise<Loaded<Obj>>>()
  const subscriptions = new Map<string, Promise<Loaded<Obj>>>()
  const sessionsBySubscription = new Map<string, Promise<{ sessions: Obj[]; failed: boolean }>>()
  const sessionsByPayment = new Map<string, Promise<{ sessions: Obj[]; failed: boolean }>>()

  const loadInvoice = (id: string) =>
    cachedGet(invoices, id, async () => {
      if (!INVOICE_ID.test(id)) return { value: null, failed: false }
      const result = await softGet(key.value, `/invoices/${encodeURIComponent(id)}`)
      const invoice = isObj(result.data) && result.data.id === id ? result.data : null
      return { value: invoice, failed: result.failed }
    })
  const loadInvoiceIdFromCharge = (chargeId: string) =>
    cachedGet(chargeInvoices, chargeId, async () => {
      if (!/^ch_[A-Za-z0-9]+$/.test(chargeId)) return { invoiceId: undefined, failed: false }
      const result = await softGet(key.value, `/charges/${encodeURIComponent(chargeId)}`, CHARGE_INVOICE_VERSION)
      if (!isObj(result.data)) return { invoiceId: undefined, failed: result.failed }
      return { invoiceId: invoiceIdFromCharge(result.data), failed: result.failed }
    })
  const loadInvoiceByPayment = (paymentIntentId: string) =>
    cachedGet(invoicesByPayment, paymentIntentId, async () => {
      if (!PAYMENT_INTENT_ID.test(paymentIntentId)) return { value: null, failed: false }
      const q = new URLSearchParams()
      q.set('limit', '1')
      q.set('payment[type]', 'payment_intent')
      q.set('payment[payment_intent]', paymentIntentId)
      const result = await softGet(key.value, `/invoice_payments?${q}`)
      if (result.failed || !isObj(result.data)) return { value: null, failed: result.failed }
      const invoiceId = invoiceIdFromCharge({ invoice: firstObject(result.data)?.invoice })
      if (!invoiceId) return { value: null, failed: false }
      return loadInvoice(invoiceId)
    })
  const loadSubscription = (id: string) =>
    cachedGet(subscriptions, id, async () => {
      if (!SUBSCRIPTION_ID.test(id)) return { value: null, failed: false }
      const result = await softGet(key.value, `/subscriptions/${encodeURIComponent(id)}`)
      const subscription = isObj(result.data) && (result.data.object === 'subscription' || result.data.id === id) ? result.data : null
      return { value: subscription, failed: result.failed }
    })
  const loadSession = async (step: Extract<PurchaseFetch, { kind: 'checkout_session' }>): Promise<Loaded<Obj>> => {
    let failed = false
    if (step.subscriptionId && SUBSCRIPTION_ID.test(step.subscriptionId)) {
      const page = await cachedGet(sessionsBySubscription, step.subscriptionId, () => listCheckoutSessions(key.value, 'subscription', step.subscriptionId as string))
      if (page.failed) failed = true
      const picked = checkoutSessionForPurchase(page.sessions)
      if (picked) return { value: picked, failed }
    }
    if (step.paymentIntentId && PAYMENT_INTENT_ID.test(step.paymentIntentId)) {
      const page = await cachedGet(sessionsByPayment, step.paymentIntentId, () => listCheckoutSessions(key.value, 'payment_intent', step.paymentIntentId as string))
      if (page.failed) failed = true
      const picked = checkoutSessionForPurchase(page.sessions)
      if (picked) return { value: picked, failed }
    }
    return { value: null, failed }
  }

  await mapPool(pending, 4, async (ch) => {
    try {
      let failed = false
      let finished = false
      const triedInvoiceIds: string[] = []
      const triedChargeIds: string[] = []
      const triedPaymentIntents: string[] = []
      const triedSubscriptionIds: string[] = []
      const triedSessionKeys: string[] = []
      for (let n = 0; n < 6; n++) {
        const step = nextPurchaseFetch({ charge: ch, triedInvoiceIds, triedChargeIds, triedPaymentIntents, triedSubscriptionIds, triedSessionKeys })
        if (!step) {
          finished = true
          break
        }
        if (step.kind === 'invoice') {
          triedInvoiceIds.push(step.id)
          const loaded = await loadInvoice(step.id)
          if (loaded.failed) failed = true
          if (loaded.value) ch.invoice = loaded.value
        } else if (step.kind === 'charge_invoice') {
          triedChargeIds.push(step.chargeId)
          const legacy = await loadInvoiceIdFromCharge(step.chargeId)
          if (legacy.failed) failed = true
          if (typeof legacy.invoiceId === 'string') ch.invoice = legacy.invoiceId
          else if (legacy.invoiceId === null) ch.invoice = null
        } else if (step.kind === 'invoice_payment') {
          triedPaymentIntents.push(step.paymentIntentId)
          const loaded = await loadInvoiceByPayment(step.paymentIntentId)
          if (loaded.failed) failed = true
          if (loaded.value) ch.invoice = loaded.value
        } else if (step.kind === 'subscription') {
          triedSubscriptionIds.push(step.id)
          const loaded = await loadSubscription(step.id)
          if (loaded.failed) failed = true
          if (loaded.value) attachSubscription(ch, loaded.value)
        } else {
          triedSessionKeys.push(`${step.subscriptionId ?? ''}|${step.paymentIntentId ?? ''}`)
          const loaded = await loadSession(step)
          if (loaded.failed) failed = true
          if (loaded.value) ch.checkout_session = loaded.value
        }
      }
      const chargeId = typeof ch.id === 'string' ? ch.id : ''
      if (chargeId && !failed && finished) rememberPurchaseSignals(chargeId, purchaseSignalsFromStripe({ charge: ch }))
    } catch (err) {
      console.error('[disputes] purchase lookup:', redactSecrets(err instanceof Error ? err.message : String(err)))
    }
  })
}

async function listCheckoutSessions(key: string, field: 'subscription' | 'payment_intent', id: string): Promise<{ sessions: Obj[]; failed: boolean }> {
  const q = new URLSearchParams()
  q.set('limit', '10')
  q.set(field, id)
  const result = await softGet(key, `/checkout/sessions?${q}`)
  if (!isObj(result.data)) return { sessions: [], failed: result.failed }
  const rows = Array.isArray(result.data.data) ? result.data.data.filter(isObj) : []
  const sessions = rows.filter((row) => {
    if (!(row.object === 'checkout.session' || (typeof row.id === 'string' && row.id.startsWith('cs_')))) return false
    const value = row[field]
    const found = typeof value === 'string' ? value : isObj(value) && typeof value.id === 'string' ? value.id : null
    return !found || found === id
  })
  return { sessions, failed: result.failed }
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
