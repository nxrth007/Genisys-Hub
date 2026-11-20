/**
 * Stripe dispute defense, with no Hub and no network in it (the tests load it).
 *
 * Matching, the evidence packet, Visa Compelling Evidence 3.0, the submit
 * policy, the hash chain, and the webhook classifier all live here.
 * src/lib/disputes/run.ts talks to Prisma and Stripe.
 *
 * The key the defense uses is the Vault entry "Stripe Official Restricted".
 * "Stripe API Key" is the previous, dead account and is never read.
 */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { PRODUCT_DESCRIPTION, POLICY_EDITIONS, TERMS_CANCELLATION_CLAUSE, TERMS_REFUND_CLAUSE, currentPolicy, policyEditionForAcceptance, type PolicyEdition } from './policies'

export { PRODUCT_DESCRIPTION }

export const DISPUTE_KEY_ENTRY = 'Stripe Official Restricted'
export const LEGACY_STRIPE_KEY_ENTRY = 'Stripe API Key'
export const WEBHOOK_SECRET_ENTRY = 'Stripe Official Webhook Secret'
export const WEBHOOK_PATH = '/api/webhooks/stripe'
/**
 * Stored when an intake omits `version`. Not the Terms of Service version
 * (2026-08-06) and not a claim that this client accepted the draft pages.
 */
export const TERMS_VERSION = '2026-11-19'
/**
 * A terms box checked at Stripe Checkout. Stripe keeps the consent on the
 * Checkout Session; it records the box, not the page text, so there is no hash.
 */
export const CHECKOUT_CONSENT_SOURCE = 'stripe_checkout'
export const CHECKOUT_TERMS_VERSION = 'stripe-checkout'

/** Combined evidence files must stay under this. Each file must stay under 5 MB. */
export const MAX_COMBINED_FILE_BYTES = Math.floor(4.5 * 1024 * 1024)
export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_EVIDENCE_FILES = 5
export const TEXT_FIELD_LIMIT = 20_000
/** Stripe caps each text evidence field. access_activity_log is 20,000; the combined cap is 150,000. */
export const UNCATEGORIZED_LIMIT = 20_000
export const COMBINED_TEXT_LIMIT = 150_000

/**
 * These evidence keys take a Stripe file id (purpose dispute_evidence).
 * A sentence in one of them makes Stripe reject the whole update, so the
 * text packet never lands. Prose goes in the text fields; the PDF is uncategorized_file.
 */
export const FILE_EVIDENCE_FIELDS = new Set([
  'cancellation_policy',
  'customer_communication',
  'customer_signature',
  'duplicate_charge_documentation',
  'receipt',
  'refund_policy',
  'service_documentation',
  'shipping_documentation',
  'uncategorized_file',
])

/** What Alex adds to the existing webhook endpoint in the Stripe Dashboard. */
export const DISPUTE_WEBHOOK_EVENTS = [
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
  'radar.early_fraud_warning.created',
  'radar.early_fraud_warning.updated',
  'invoice.paid',
  'checkout.session.completed',
] as const

/**
 * Restricted-key permissions. Read can be probed with a GET. Write cannot
 * be probed without mutating a live object, so the probe reports those as
 * "not verified". The Hub does not create the webhook endpoint itself.
 */
export const DISPUTE_PERMISSIONS = {
  read: [
    'Disputes: Read',
    'Charges: Read',
    'PaymentIntents: Read',
    'Customers: Read',
    'Invoices: Read',
    'Subscriptions: Read',
    'Checkout Sessions: Read',
    'Files: Read',
    'Radar: Read (early fraud warnings)',
    'Webhook endpoints: Read (so the Hub can see which events are subscribed)',
  ],
  write: [
    'Disputes: Write (save evidence and submit)',
    'Files: Write (upload the packet, purpose dispute_evidence)',
    'Customers: Write (stamp hub_client_id / hub_intake_id on the customer)',
    'Charges: Write (stamp the same metadata on the charge)',
    'PaymentIntents: Write (stamp the same metadata on the PaymentIntent)',
  ],
  optional: [
    'Refunds: Write — only if early-fraud auto-refund is turned on (it ships off)',
    'Webhook endpoints: Write — only if you register the endpoint from code; the Hub does not',
  ],
} as const

const ACK_KINDS = ['terms', 'refund_policy', 'cancellation_policy', 'recurring_billing', 'milestone'] as const
export type AckKind = (typeof ACK_KINDS)[number]

export type DisputeMode = 'dry_run' | 'stage' | 'live'

export type DisputeConfig = {
  mode: DisputeMode
  submitLeadHours: number
  efwRefund: boolean
  alertSms: boolean
  /** Extra client emails (onboarding confirmation). Off until turned on. */
  clientNotices: boolean
  /** Open pixel on emails the Hub already sends (invoices) and on notices. */
  openTracking: boolean
  /** One-click "confirm service started" after onboarding. Off until turned on. */
  milestoneAck: boolean
  stampMetadata: boolean
  /**
   * Inquiries (warning_* statuses). `flag` compiles the packet and does not
   * auto-submit, so a person can refund. `fight` treats the inquiry like a
   * chargeback. Default is flag.
   */
  inquiryPolicy: 'flag' | 'fight'
  /** Kill switch. Wins over a saved "live" mode. */
  forceDryRun: boolean
}

const DEFAULT_CONFIG: DisputeConfig = {
  mode: 'dry_run',
  submitLeadHours: 48,
  efwRefund: false,
  alertSms: true,
  clientNotices: false,
  openTracking: true,
  milestoneAck: false,
  stampMetadata: true,
  inquiryPolicy: 'flag',
  forceDryRun: false,
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim())

export function parseDisputeConfig(
  env: Record<string, string | undefined>,
  stored?: Partial<DisputeConfig> | null,
): DisputeConfig {
  const modeRaw = (stored?.mode ?? env.DISPUTE_DEFENSE_MODE ?? DEFAULT_CONFIG.mode).trim()
  const mode: DisputeMode = modeRaw === 'stage' || modeRaw === 'live' ? modeRaw : 'dry_run'
  const hours = Number(stored?.submitLeadHours ?? env.DISPUTE_SUBMIT_LEAD_HOURS ?? DEFAULT_CONFIG.submitLeadHours)
  const cfg: DisputeConfig = {
    mode,
    submitLeadHours: Number.isFinite(hours) && hours >= 1 && hours <= 240 ? Math.round(hours) : 48,
    efwRefund: stored?.efwRefund ?? truthy(env.DISPUTE_EFW_REFUND),
    alertSms: stored?.alertSms ?? (env.DISPUTE_ALERT_SMS === undefined ? true : truthy(env.DISPUTE_ALERT_SMS)),
    clientNotices: stored?.clientNotices ?? truthy(env.DISPUTE_CLIENT_NOTICES),
    openTracking: stored?.openTracking ?? (env.DISPUTE_OPEN_TRACKING === undefined ? true : truthy(env.DISPUTE_OPEN_TRACKING)),
    milestoneAck: stored?.milestoneAck ?? truthy(env.DISPUTE_MILESTONE_ACK),
    stampMetadata: stored?.stampMetadata ?? (env.DISPUTE_STAMP_METADATA === undefined ? true : truthy(env.DISPUTE_STAMP_METADATA)),
    inquiryPolicy: (stored?.inquiryPolicy ?? env.DISPUTE_INQUIRY_POLICY ?? DEFAULT_CONFIG.inquiryPolicy) === 'fight' ? 'fight' : 'flag',
    forceDryRun: truthy(env.DISPUTE_DEFENSE_FORCE_DRY_RUN),
  }
  if (cfg.forceDryRun) cfg.mode = 'dry_run'
  return cfg
}

/** Public config for the admin page. No secrets. */
export function publicConfig(cfg: DisputeConfig): Omit<DisputeConfig, 'forceDryRun'> & { forceDryRun: boolean; submitsToStripe: boolean; canSubmit: boolean } {
  return {
    ...cfg,
    /** Stage and live may call Stripe. Dry-run and the kill switch never do. */
    submitsToStripe: allowsStripeWrite(cfg),
    /** submit=true is final. Only live mode, and only when the kill switch is off. */
    canSubmit: cfg.mode === 'live' && !cfg.forceDryRun,
  }
}

/** False in dry-run and when the kill switch is on. Stage and live may write. */
export function allowsStripeWrite(cfg: DisputeConfig): boolean {
  return cfg.mode !== 'dry_run' && !cfg.forceDryRun
}

// --- Hashing -----------------------------------------------------------------

/**
 * The password-set link (`t=`) is a secret. The report HTML escapes `&` to
 * `&amp;` before this runs, and the open-pixel URL is a bearer token too.
 * Snapshots keep the invite, not either secret.
 */
export function redactCredentialLinks(html: string): string {
  return redactSecrets(html)
    .replace(/([?&](?:amp;|#38;|#x26;)?t=)[^&"'#\s<>]+/gi, '$1[not-stored]')
    .replace(/(\/api\/public\/(?:receipts|acknowledge)\/)[A-Za-z0-9_-]+/g, '$1[not-stored]')
}

export function redactSecrets(s: string): string {
  return s
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/\bwhsec_[A-Za-z0-9]+/g, '[redacted-secret]')
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  const o = value as Record<string, unknown>
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** SHA-256 of prevHash, a newline, and the canonical body. */
export function chainHash(prevHash: string, body: unknown): string {
  return sha256(`${prevHash}\n${canonicalJson(body)}`)
}

export function verifyChain(events: { prevHash: string; contentHash: string; body: unknown }[]): { ok: boolean; brokenAt: number | null } {
  let prev = 'genesis'
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.prevHash !== prev) return { ok: false, brokenAt: i }
    if (e.contentHash !== chainHash(prev, e.body)) return { ok: false, brokenAt: i }
    prev = e.contentHash
  }
  return { ok: true, brokenAt: null }
}

export function ledgerHash(e: { clientId: string; kind: string; title: string; detail: string | null; occurredAt: string; source: string; sourceId: string }): string {
  return sha256(canonicalJson(e))
}

// --- Identity matching -------------------------------------------------------

export type MatchCandidate = {
  clientId: string
  name: string
  emails: Array<string | null | undefined>
  phones: Array<string | null | undefined>
  people: Array<string | null | undefined>
  businessNames: Array<string | null | undefined>
  intakeIds: string[]
  disputeCount: number
}

export type DisputeIdentity = {
  email: string | null
  phone: string | null
  name: string | null
  metadata: Record<string, string>
}

export type MatchResult = {
  clientId: string | null
  intakeId: string | null
  method: 'metadata' | 'email' | 'phone' | 'business_name' | 'person_name' | 'manual' | 'none'
  confidence: 'exact' | 'strong' | 'weak' | 'none'
  disputeCount: number
  repeatDisputer: boolean
}

export const normName = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(llc|inc|co|corp|ltd|the|and)\b/g, ' ').replace(/\s+/g, ' ').trim()

export function cleanEmail(v: string | null | undefined): string | null {
  const e = (v ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

/** Last 10 digits of a NANP number, or null. */
export function phoneKey(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? ten : null
}

function meta(m: Record<string, string>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = (m[k] ?? '').trim()
    if (v) return v
  }
  return null
}

export function matchDispute(id: DisputeIdentity, candidates: MatchCandidate[]): MatchResult {
  const none = (partial?: Partial<MatchResult>): MatchResult => ({
    clientId: null, intakeId: null, method: 'none', confidence: 'none', disputeCount: 0, repeatDisputer: false, ...partial,
  })
  const hit = (c: MatchCandidate, method: MatchResult['method'], confidence: MatchResult['confidence'], intakeId: string | null): MatchResult => ({
    clientId: c.clientId,
    intakeId,
    method,
    confidence,
    disputeCount: c.disputeCount,
    repeatDisputer: c.disputeCount >= 2,
  })

  const linkedIntake = (c: MatchCandidate, wanted: string | null) => {
    if (wanted && c.intakeIds.includes(wanted)) return wanted
    return c.intakeIds.length === 1 ? c.intakeIds[0] : null
  }
  /** A charge email that belongs to someone else makes an otherwise exact match unsafe to file. */
  const emailAgrees = (c: MatchCandidate, email: string | null) => !email || c.emails.some((e) => cleanEmail(e) === email)

  const clientId = meta(id.metadata, 'hub_client_id', 'client_id', 'clientId')
  const intakeId = meta(id.metadata, 'hub_intake_id', 'intake_id', 'intakeId')
  const email = cleanEmail(id.email)
  if (clientId) {
    const c = candidates.find((x) => x.clientId === clientId)
    if (c) return hit(c, 'metadata', emailAgrees(c, email) ? 'exact' : 'weak', linkedIntake(c, intakeId))
  }
  if (intakeId) {
    const c = candidates.find((x) => x.intakeIds.includes(intakeId))
    if (c) return hit(c, 'metadata', emailAgrees(c, email) ? 'exact' : 'weak', intakeId)
  }

  if (email) {
    const found = candidates.filter((c) => c.emails.some((e) => cleanEmail(e) === email))
    if (found.length === 1) return hit(found[0], 'email', 'strong', linkedIntake(found[0], null))
  }

  const phone = phoneKey(id.phone)
  if (phone) {
    const found = candidates.filter((c) => c.phones.some((p) => phoneKey(p) === phone))
    if (found.length === 1) return hit(found[0], 'phone', emailAgrees(found[0], email) ? 'strong' : 'weak', linkedIntake(found[0], null))
  }

  const business = normName(id.name ?? '')
  if (business.length >= 3) {
    // A unique business name is a hint, not proof. Auto-submit stays off (weak).
    const byBiz = candidates.filter((c) => [c.name, ...c.businessNames].some((n) => n && normName(n) === business))
    if (byBiz.length === 1) return hit(byBiz[0], 'business_name', 'weak', linkedIntake(byBiz[0], null))
    const byPerson = candidates.filter((c) => c.people.some((n) => n && normName(n) === business))
    if (byPerson.length === 1) return hit(byPerson[0], 'person_name', 'weak', linkedIntake(byPerson[0], null))
  }
  return none()
}

/** True when `header` (a From or To) contains this address as a whole token. */
export function emailHeaderHas(header: string, email: string): boolean {
  const e = email.trim().toLowerCase()
  if (!e.includes('@')) return false
  return header.toLowerCase().split(/[\s,;<>"']+/).filter(Boolean).includes(e)
}

// --- Stripe objects ----------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const idOf = (v: unknown): string | null => (typeof v === 'string' ? str(v) : isObj(v) ? str(v.id) : null)
const iso = (secs: unknown): string | null => {
  const n = num(secs)
  return n ? new Date(n * 1000).toISOString() : null
}

export type ParsedDispute = {
  stripeDisputeId: string
  stripeChargeId: string | null
  stripePaymentIntentId: string | null
  stripeCustomerId: string | null
  stripeInvoiceId: string | null
  status: string
  reason: string
  networkReasonCode: string | null
  amountCents: number
  currency: string
  dueBy: string | null
  chargedAt: string | null
  livemode: boolean
  cardBrand: string | null
  /** submission_count > 0. has_evidence only means evidence was staged. */
  stripeSubmitted: boolean
  /** due_by of 0 means the bank is not accepting a response. */
  respondable: boolean
  pastDue: boolean
  email: string | null
  name: string | null
  phone: string | null
  billingAddress: string | null
  metadata: Record<string, string>
  chargeRefunded: boolean
  purchaseIp: string | null
  purchaseUa: string | null
  deviceId: string | null
  /** Card fingerprint from the disputed charge. Used only to keep CE 3.0 on the same card. */
  cardFingerprint: string | null
}

function metaMap(v: unknown): Record<string, string> {
  if (!isObj(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && val.trim()) out[k] = val.trim()
  }
  return out
}

function addressLine(v: unknown): string | null {
  if (!isObj(v)) return null
  const parts = [str(v.line1), str(v.line2), str(v.city), str(v.state), str(v.postal_code), str(v.country)].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

function cardFingerprintFromCharge(ch: Obj): string | null {
  const details = isObj(ch.payment_method_details) ? ch.payment_method_details : null
  const card = details && isObj(details.card) ? details.card : null
  return card ? str(card.fingerprint) : null
}

/** Stripe card fingerprints are short alphanumeric ids. Anything else is ignored. */
function cardFingerprintOf(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return /^[A-Za-z0-9]{8,64}$/.test(t) ? t : null
}

/**
 * Purchase IP, user agent, and device id are one trio. The first source that
 * still has a usable value after validation supplies all three fields. A later
 * source does not fill what the earlier one left blank.
 *
 * Order: charge metadata, the invoice's subscription snapshot
 * (`parent.subscription_details.metadata` on 2025-03-31.basil and later,
 * `subscription_details.metadata` on older versions), the Subscription's
 * metadata, then the Checkout Session metadata.
 */
export type PurchaseFetch =
  | { kind: 'invoice'; id: string }
  | { kind: 'charge_invoice'; chargeId: string }
  | { kind: 'invoice_payment'; paymentIntentId: string }
  | { kind: 'subscription'; id: string }
  | { kind: 'checkout_session'; subscriptionId: string | null; paymentIntentId: string | null }

export function purchaseSignalsFromMetadata(meta: unknown): PurchaseSignals {
  const m = metaMap(meta)
  return {
    ip: customerIp(m.hub_purchase_ip),
    userAgent: oneLine(m.hub_purchase_ua, 500),
    deviceId: deviceIdOf(m.hub_device_id),
  }
}

function usablePurchase(s: PurchaseSignals | null | undefined): boolean {
  return !!(s && (s.ip || s.userAgent || s.deviceId))
}

function hubPurchaseMeta(v: unknown): Record<string, string> | null {
  const meta = metaMap(v)
  if (meta.hub_purchase_ip || meta.hub_purchase_ua || meta.hub_device_id) return meta
  return null
}

/** Basil nests the snapshot under parent. A quote parent is not a subscription. */
function parentSubscriptionDetails(invoice: Obj): Obj | null {
  const parent = isObj(invoice.parent) ? invoice.parent : null
  if (!parent || !isObj(parent.subscription_details)) return null
  if (typeof parent.type === 'string' && parent.type !== 'subscription_details') return null
  return parent.subscription_details
}

function isSubscriptionObject(v: unknown): v is Obj {
  if (!isObj(v)) return false
  if (str(v.object) === 'subscription') return true
  const id = str(v.id)
  return !!id && id.startsWith('sub_')
}

function isCheckoutSession(v: unknown): v is Obj {
  if (!isObj(v)) return false
  if (str(v.object) === 'checkout.session') return true
  const id = str(v.id)
  return !!id && id.startsWith('cs_')
}

function subscriptionObjectFromInvoice(invoice: unknown): Obj | null {
  if (!isObj(invoice)) return null
  const details = parentSubscriptionDetails(invoice)
  if (details && isSubscriptionObject(details.subscription)) return details.subscription
  if (isSubscriptionObject(invoice.subscription)) return invoice.subscription
  const legacy = isObj(invoice.subscription_details) ? invoice.subscription_details : null
  if (legacy && isSubscriptionObject(legacy.subscription)) return legacy.subscription
  return null
}

/** The subscription snapshot on an invoice. Parent wins when it carries the keys; the older field is not mixed in. */
export function invoiceSubscriptionMetadata(invoice: unknown): Record<string, string> {
  if (!isObj(invoice)) return {}
  const parent = parentSubscriptionDetails(invoice)
  const fromParent = parent ? hubPurchaseMeta(parent.metadata) : null
  if (fromParent) return fromParent
  const legacy = isObj(invoice.subscription_details) ? hubPurchaseMeta(invoice.subscription_details.metadata) : null
  return legacy ?? {}
}

export function subscriptionIdFromInvoice(invoice: unknown): string | null {
  if (!isObj(invoice)) return null
  const details = parentSubscriptionDetails(invoice)
  const fromParent = details ? idOf(details.subscription) : null
  if (fromParent?.startsWith('sub_')) return fromParent
  const legacy = idOf(invoice.subscription)
  if (legacy?.startsWith('sub_')) return legacy
  const legacyDetails = isObj(invoice.subscription_details) ? invoice.subscription_details : null
  const fromLegacy = legacyDetails ? idOf(legacyDetails.subscription) : null
  return fromLegacy?.startsWith('sub_') ? fromLegacy : null
}

function paymentIntentIdOf(charge: Obj): string | null {
  const id = idOf(charge.payment_intent)
  return id?.startsWith('pi_') ? id : null
}

/**
 * Invoice id on a Charge. `undefined` when the field is absent (basil) or
 * is not an `in_` id. `null` when the field is present and null.
 * An expanded `{ id }` is accepted. Nothing else on the charge is read,
 * so a pre-basil retrieve cannot change metadata, payment intent, or billing.
 */
export function invoiceIdFromCharge(charge: unknown): string | null | undefined {
  if (!isObj(charge) || !('invoice' in charge)) return undefined
  if (charge.invoice === null) return null
  const id = idOf(charge.invoice)
  return id && /^in_[A-Za-z0-9]+$/.test(id) ? id : undefined
}

/** 404 is a missing object. 403, 429, and other non-2xx responses are skips, not packet failures. */
export function purchaseLookupFailed(status: number): boolean {
  if (status >= 200 && status < 300) return false
  return status !== 404
}

/** Oldest checkout session that has a usable purchase trio. Sessions are not mixed. */
export function checkoutSessionForPurchase(sessions: unknown[]): Obj | null {
  const usable = sessions.filter((s): s is Obj => isCheckoutSession(s) && usablePurchase(purchaseSignalsFromMetadata(s.metadata)))
  if (!usable.length) return null
  usable.sort((a, b) => (num(a.created) ?? Number.MAX_SAFE_INTEGER) - (num(b.created) ?? Number.MAX_SAFE_INTEGER))
  return usable[0]
}

/**
 * Write one already-chosen trio onto charge metadata.
 * The three purchase keys are replaced together. Other keys stay.
 */
export function stampPurchaseSignals(charge: Obj, signals: PurchaseSignals): void {
  const meta: Obj = isObj(charge.metadata) ? { ...charge.metadata } : {}
  delete meta.hub_purchase_ip
  delete meta.hub_purchase_ua
  delete meta.hub_device_id
  if (signals.ip) meta.hub_purchase_ip = signals.ip
  if (signals.userAgent) meta.hub_purchase_ua = signals.userAgent
  if (signals.deviceId) meta.hub_device_id = signals.deviceId
  charge.metadata = meta
}

/**
 * Signals already present on the charge and any invoice, subscription, or
 * checkout session object nested on it. Explicit objects override the nested ones.
 */
export function purchaseSignalsFromStripe(o: {
  charge?: unknown
  invoice?: unknown
  subscription?: unknown
  checkoutSession?: unknown
} = {}): PurchaseSignals {
  const charge = isObj(o.charge) ? o.charge : null
  const invoice = o.invoice !== undefined ? o.invoice : charge && isObj(charge.invoice) ? charge.invoice : null
  const subscription =
    o.subscription !== undefined
      ? o.subscription
      : subscriptionObjectFromInvoice(invoice) ?? (charge && isSubscriptionObject(charge.subscription) ? charge.subscription : null)
  const checkoutSession =
    o.checkoutSession !== undefined ? o.checkoutSession : charge && isCheckoutSession(charge.checkout_session) ? charge.checkout_session : null
  return pickPurchaseSignals([
    charge ? purchaseSignalsFromMetadata(charge.metadata) : null,
    purchaseSignalsFromMetadata(invoiceSubscriptionMetadata(invoice)),
    isObj(subscription) ? purchaseSignalsFromMetadata(subscription.metadata) : null,
    isObj(checkoutSession) ? purchaseSignalsFromMetadata(checkoutSession.metadata) : null,
  ])
}

function tried(list: readonly string[] | undefined, value: string): boolean {
  return !!list?.includes(value)
}

/**
 * The next read-only Stripe lookup for this charge, or null when the trio is
 * already known or every earlier place has been tried. A charge that already
 * has a usable value does not ask for the invoice.
 */
export function nextPurchaseFetch(o: {
  charge: unknown
  triedInvoiceIds?: readonly string[]
  triedChargeIds?: readonly string[]
  triedPaymentIntents?: readonly string[]
  triedSubscriptionIds?: readonly string[]
  triedSessionKeys?: readonly string[]
}): PurchaseFetch | null {
  const charge = isObj(o.charge) ? o.charge : null
  if (!charge) return null
  if (usablePurchase(purchaseSignalsFromStripe({ charge }))) return null
  const invoiceId = typeof charge.invoice === 'string' && charge.invoice.startsWith('in_') ? charge.invoice : null
  if (!isObj(charge.invoice) && invoiceId && !tried(o.triedInvoiceIds, invoiceId)) return { kind: 'invoice', id: invoiceId }
  const paymentIntentId = paymentIntentIdOf(charge)
  const chargeId = str(charge.id)
  // Basil removed charge.invoice. Re-read the charge on an older API version before listing invoice payments.
  // An explicit null means an older charge that has no invoice.
  if (!('invoice' in charge) && !isObj(charge.invoice) && !invoiceId && chargeId?.startsWith('ch_') && !tried(o.triedChargeIds, chargeId)) {
    return { kind: 'charge_invoice', chargeId }
  }
  if (!('invoice' in charge) && !isObj(charge.invoice) && !invoiceId && paymentIntentId && !tried(o.triedPaymentIntents, paymentIntentId)) {
    return { kind: 'invoice_payment', paymentIntentId }
  }
  const subscriptionId = subscriptionIdFromInvoice(charge.invoice)
  if (subscriptionId && !subscriptionObjectFromInvoice(charge.invoice) && !isSubscriptionObject(charge.subscription) && !tried(o.triedSubscriptionIds, subscriptionId)) {
    return { kind: 'subscription', id: subscriptionId }
  }
  if (!isCheckoutSession(charge.checkout_session) && (subscriptionId || paymentIntentId)) {
    const key = `${subscriptionId ?? ''}|${paymentIntentId ?? ''}`
    if (!tried(o.triedSessionKeys, key)) return { kind: 'checkout_session', subscriptionId, paymentIntentId }
  }
  return null
}

export function readDispute(dispute: unknown, charge?: unknown): ParsedDispute | null {
  if (!isObj(dispute)) return null
  const id = str(dispute.id)
  if (!id) return null
  const looksLikeDispute = str(dispute.object) === 'dispute' || id.startsWith('dp_') || id.startsWith('du_') || (!!str(dispute.reason) && !!str(dispute.status))
  if (!looksLikeDispute) return null
  const embedded = isObj(dispute.charge) ? dispute.charge : isObj(charge) ? charge : null
  const evidenceDetails = isObj(dispute.evidence_details) ? dispute.evidence_details : {}
  const card = embedded && isObj(embedded.payment_method_details) && isObj(embedded.payment_method_details.card) ? embedded.payment_method_details.card : null
  const billing = embedded && isObj(embedded.billing_details) ? embedded.billing_details : null
  const meta = { ...metaMap(embedded?.metadata), ...metaMap(dispute.metadata) }
  const purchase = purchaseSignalsFromStripe({ charge: embedded })
  const dueSecs = num(evidenceDetails.due_by)
  const submissionCount = num(evidenceDetails.submission_count) ?? 0
  return {
    stripeDisputeId: id,
    stripeChargeId: idOf(dispute.charge) ?? (embedded ? str(embedded.id) : null),
    stripePaymentIntentId: idOf(dispute.payment_intent) ?? (embedded ? idOf(embedded.payment_intent) : null),
    stripeCustomerId: idOf(dispute.customer) ?? (embedded ? idOf(embedded.customer) : null),
    stripeInvoiceId: embedded ? idOf(embedded.invoice) : null,
    status: str(dispute.status) ?? 'needs_response',
    reason: str(dispute.reason) ?? 'general',
    networkReasonCode: str(dispute.network_reason_code),
    amountCents: num(dispute.amount) ?? 0,
    currency: str(dispute.currency) ?? 'usd',
    dueBy: dueSecs ? new Date(dueSecs * 1000).toISOString() : null,
    chargedAt: embedded ? iso(embedded.created) : null,
    livemode: dispute.livemode === true,
    cardBrand: card ? str(card.brand) : null,
    stripeSubmitted: submissionCount > 0,
    respondable: dueSecs !== 0,
    pastDue: evidenceDetails.past_due === true,
    email: cleanEmail(billing ? str(billing.email) : null) ?? cleanEmail(str(dispute.evidence && isObj(dispute.evidence) ? dispute.evidence.customer_email_address : null)),
    name: (billing ? str(billing.name) : null) ?? (isObj(dispute.evidence) ? str(dispute.evidence.customer_name) : null),
    phone: (billing ? str(billing.phone) : null),
    billingAddress: addressLine(billing ? billing.address : null),
    metadata: meta,
    chargeRefunded: embedded?.refunded === true || str(dispute.status) === 'charge_refunded',
    purchaseIp: purchase.ip,
    purchaseUa: purchase.userAgent,
    deviceId: purchase.deviceId,
    cardFingerprint: cardFingerprintOf(card ? str(card.fingerprint) : null),
  }
}

export type SideEffect =
  | { kind: 'dispute'; eventId: string; type: string; dispute: ParsedDispute; livemode: boolean }
  | { kind: 'early_fraud_warning'; eventId: string; warningId: string; chargeId: string | null; customerId: string | null; actionable: boolean; fraudType: string | null; livemode: boolean; raw: Obj }
  | { kind: 'invoice_paid'; eventId: string; customerId: string | null; email: string | null; name: string | null; amountCents: number | null; currency: string; chargeId: string | null; paymentIntentId: string | null; invoiceId: string | null; livemode: boolean }

/** Dispute, early-fraud, and paid-invoice events. Everything else is null (the signup handler keeps those). */
export function classifyStripeSideEffect(event: unknown): SideEffect | null {
  if (!isObj(event) || typeof event.type !== 'string') return null
  const type = event.type
  const eventId = str(event.id) ?? ''
  const data = isObj(event.data) ? event.data : {}
  const obj = isObj(data.object) ? data.object : {}
  const livemode = event.livemode === true
  if (type.startsWith('charge.dispute.')) {
    const dispute = readDispute(obj)
    if (!dispute) return null
    return { kind: 'dispute', eventId, type, dispute, livemode }
  }
  if (type === 'radar.early_fraud_warning.created' || type === 'radar.early_fraud_warning.updated') {
    const warningId = str(obj.id)
    if (!warningId) return null
    return {
      kind: 'early_fraud_warning',
      eventId,
      warningId,
      chargeId: idOf(obj.charge),
      customerId: null,
      actionable: obj.actionable === true,
      fraudType: str(obj.fraud_type),
      livemode,
      raw: obj,
    }
  }
  if (type === 'invoice.paid') {
    return {
      kind: 'invoice_paid',
      eventId,
      customerId: idOf(obj.customer),
      email: cleanEmail(str(obj.customer_email)),
      name: str(obj.customer_name),
      amountCents: num(obj.amount_paid),
      currency: str(obj.currency) ?? 'usd',
      chargeId: idOf(obj.charge),
      paymentIntentId: idOf(obj.payment_intent),
      invoiceId: str(obj.id),
      livemode,
    }
  }
  return null
}

// --- Submission policy -------------------------------------------------------

const OPEN = new Set(['needs_response', 'warning_needs_response'])

export type DefenseAction = {
  /** skip: nothing to file. compile_only: save the packet, do not call Stripe. stage: Stripe update with submit=false. submit: submit=true. */
  action: 'skip' | 'compile_only' | 'stage' | 'submit'
  stripeSubmit: boolean
  reason: string
}

export function decideAction(o: {
  config: DisputeConfig
  status: string
  dueBy: string | null
  now: string
  paused: boolean
  narrativeEdited: boolean
  alreadySubmitted: boolean
  matchConfidence: 'exact' | 'strong' | 'weak' | 'none'
  /** due_by of 0, or Stripe's past_due flag. Defaults to still open. */
  respondable?: boolean
  pastDue?: boolean
}): DefenseAction {
  if (o.alreadySubmitted || !OPEN.has(o.status)) {
    return { action: 'skip', stripeSubmit: false, reason: o.alreadySubmitted ? 'evidence was already submitted' : `status ${o.status} is not waiting on evidence` }
  }
  const due = o.dueBy ? new Date(o.dueBy).getTime() : NaN
  const now = new Date(o.now).getTime()
  const deadlinePassed = o.pastDue === true || (Number.isFinite(due) && now >= due)
  if (o.respondable === false || deadlinePassed) {
    return { action: 'compile_only', stripeSubmit: false, reason: o.respondable === false ? 'the bank is not accepting evidence for this dispute' : 'the evidence deadline has passed, so Stripe is not called' }
  }
  const dry = o.config.mode === 'dry_run' || o.config.forceDryRun
  if (dry) return { action: 'compile_only', stripeSubmit: false, reason: 'dry-run builds the packet and does not call the Stripe dispute update' }
  if (o.status.startsWith('warning_') && o.config.inquiryPolicy !== 'fight') {
    return { action: 'compile_only', stripeSubmit: false, reason: 'inquiry is flagged for a human refund decision and is not submitted' }
  }
  // A weak or missing match must not upload another client's records onto the dispute.
  if (o.matchConfidence === 'weak' || o.matchConfidence === 'none') {
    return { action: 'compile_only', stripeSubmit: false, reason: `the client match is ${o.matchConfidence}, so nothing is sent to Stripe until someone links the client` }
  }
  const hold = o.paused || o.narrativeEdited
  if (hold) {
    const why = o.paused ? 'an admin paused it' : 'an admin edited the narrative'
    return { action: 'stage', stripeSubmit: false, reason: `${why}, so the packet is staged and not submitted` }
  }
  if (o.config.mode === 'stage') return { action: 'stage', stripeSubmit: false, reason: 'mode is stage: save evidence on the dispute with submit=false' }
  const leadMs = o.config.submitLeadHours * 3600_000
  if (!Number.isFinite(due)) return { action: 'stage', stripeSubmit: false, reason: 'no due date yet, so the packet is staged' }
  if (now >= due - leadMs) return { action: 'submit', stripeSubmit: true, reason: `inside the ${o.config.submitLeadHours}h window before the deadline` }
  return { action: 'stage', stripeSubmit: false, reason: 'outside the auto-submit window' }
}

/** A person pressed Submit. Only live mode may set submit=true. Stage saves with submit=false. */
export function decideManualSubmit(config: DisputeConfig): { ok: true } | { ok: false; reason: string } {
  if (config.forceDryRun || config.mode === 'dry_run') {
    return { ok: false, reason: 'Defense is in dry-run. Switch the mode to live before submitting. Submitting evidence is final.' }
  }
  if (config.mode !== 'live') {
    return { ok: false, reason: 'Stage mode saves evidence with submit=false. Switch to live to submit. Submitting evidence is final.' }
  }
  return { ok: true }
}

export function decideEfwRefund(o: { config: DisputeConfig; actionable: boolean; livemode: boolean }): { refund: boolean; reason: string } {
  if (!o.actionable) return { refund: false, reason: 'Stripe did not mark the warning actionable' }
  if (!o.config.efwRefund) return { refund: false, reason: 'early-fraud auto-refund is off' }
  if (o.config.mode !== 'live' || o.config.forceDryRun) return { refund: false, reason: 'auto-refund only runs in live mode' }
  if (!o.livemode) return { refund: false, reason: 'test-mode warning' }
  return { refund: true, reason: 'live mode and the refund switch are both on' }
}

// --- Compelling evidence -----------------------------------------------------

export function readCharge(ch: unknown, accountId: string | null): PriorCharge | null {
  if (!isObj(ch)) return null
  const id = str(ch.id)
  if (!id || !id.startsWith('ch_')) return null
  const billing = isObj(ch.billing_details) ? ch.billing_details : null
  const meta = metaMap(ch.metadata)
  const purchase = purchaseSignalsFromStripe({ charge: ch })
  return {
    id,
    amountCents: num(ch.amount) ?? 0,
    created: iso(ch.created) ?? new Date(0).toISOString(),
    paid: ch.paid === true || str(ch.status) === 'succeeded',
    disputed: ch.disputed === true,
    refunded: ch.refunded === true,
    email: cleanEmail(billing ? str(billing.email) : null) ?? cleanEmail(meta.email),
    ip: purchase.ip,
    deviceId: purchase.deviceId,
    accountId: str(meta.hub_client_id) ?? accountId,
    fingerprint: cardFingerprintOf(cardFingerprintFromCharge(ch)),
  }
}

export type PriorCharge = {
  id: string
  amountCents: number
  created: string
  paid: boolean
  disputed: boolean
  refunded: boolean
  email: string | null
  ip: string | null
  deviceId: string | null
  accountId: string | null
  /** Present when the charge payload included a card fingerprint. */
  fingerprint?: string | null
}

export type Ce3Party = {
  customerAccountId: string | null
  customerEmail: string | null
  customerPurchaseIp: string | null
  /** Visa device id. Only set when it is at least 15 characters and actually matched. */
  customerDeviceId: string | null
  productDescription: string
}

export type Ce3 = {
  disputed: Ce3Party
  prior: Array<Ce3Party & { charge: string }>
}

const DAY = 86_400_000

/** Priors outside this window cannot satisfy Visa CE 3.0, so the reconcile does not look them up. */
export const PURCHASE_LOOKUP_PRIOR_CAP = 24

function sameCardFingerprint(disputed: string | null | undefined, prior: string | null | undefined): boolean {
  const fp = cardFingerprintOf(disputed)
  const priorFp = cardFingerprintOf(prior)
  if (fp && priorFp) return priorFp === fp
  if (fp || priorFp) return false
  return true
}

/**
 * Charges whose purchase metadata is worth a Stripe read during reconcile:
 * the disputed charge, plus paid priors in the CE 3.0 window on the same card.
 * Recent, refunded, and too-old charges are omitted. The prior list is capped.
 */
export function chargesForPurchaseLookup<T>(charges: readonly T[], o: {
  disputeChargeId: string | null
  chargedAtMs: number | null
  fingerprint?: string | null
}): T[] {
  const disputed = o.disputeChargeId ? charges.find((c) => isObj(c) && c.id === o.disputeChargeId) : undefined
  const chosen: T[] = []
  if (disputed) chosen.push(disputed)
  if (o.chargedAtMs == null || !Number.isFinite(o.chargedAtMs)) return chosen
  const ranked: { charge: T; age: number }[] = []
  for (const charge of charges) {
    if (!isObj(charge) || charge === disputed) continue
    const parsed = readCharge(charge, null)
    if (!parsed || !parsed.paid || parsed.disputed || parsed.refunded || parsed.amountCents < 100) continue
    const createdMs = new Date(parsed.created).getTime()
    if (!Number.isFinite(createdMs) || createdMs <= 0) continue
    const age = o.chargedAtMs - createdMs
    if (age < 120 * DAY || age >= 365 * DAY) continue
    if (!sameCardFingerprint(o.fingerprint, parsed.fingerprint)) continue
    ranked.push({ charge, age })
  }
  ranked.sort((a, b) => a.age - b.age)
  for (const row of ranked.slice(0, PURCHASE_LOOKUP_PRIOR_CAP)) chosen.push(row.charge)
  return chosen
}

/**
 * Visa CE 3.0 on Stripe (network code 10.4): two prior undisputed charges on
 * the same card, 120 to 364 days before the disputed charge. Stripe's match
 * is two main elements (purchase IP, and a device id of at least 15
 * characters) or one of those plus a secondary element (email). The same
 * elements must be present on the disputed charge and both priors. An
 * internal client id is not a recognizable account id. Device id and device
 * fingerprint are one slot; this Hub only has a device id.
 */
export function selectCompellingEvidence(o: {
  reason: string
  cardBrand: string | null
  networkReasonCode?: string | null
  chargedAt: string | null
  email: string | null
  ip: string | null
  deviceId?: string | null
  /** When set, a prior charge with a different or missing fingerprint is not the same card. */
  fingerprint?: string | null
  accountId: string | null
  productDescription: string
  priors: PriorCharge[]
}): Ce3 | null {
  const emphasis = disputeEmphasis(o.reason, o.networkReasonCode).emphasis
  if (emphasis !== 'fraud') return null
  if (o.cardBrand !== 'visa') return null
  const code = normalizeNetworkCode(o.networkReasonCode)
  if (code && code !== '10.4') return null
  const email = cleanEmail(o.email)
  const ip = customerIp(o.ip)
  const device = deviceIdOf(o.deviceId)
  if (!email && !(ip && device)) return null
  const disputedAt = o.chargedAt ? new Date(o.chargedAt).getTime() : NaN
  if (!Number.isFinite(disputedAt)) return null
  const fp = cardFingerprintOf(o.fingerprint)
  type Bits = { ip: boolean; device: boolean; email: boolean }
  const bitsOf = (p: PriorCharge): Bits => ({
    ip: !!ip && customerIp(p.ip) === ip,
    device: !!device && deviceIdOf(p.deviceId) === device,
    email: !!email && cleanEmail(p.email) === email,
  })
  const qualifies = (b: Bits) => {
    const mains = (b.ip ? 1 : 0) + (b.device ? 1 : 0)
    return mains >= 2 || (mains >= 1 && b.email)
  }
  const sameCard = (p: PriorCharge) => sameCardFingerprint(fp, p.fingerprint)
  const eligible = o.priors
    .filter((p) => p.paid && !p.disputed && !p.refunded && p.amountCents >= 100 && sameCard(p))
    .map((p) => ({ p, age: disputedAt - new Date(p.created).getTime(), bits: bitsOf(p) }))
    .filter((x) => x.age >= 120 * DAY && x.age < 365 * DAY)
    .sort((a, b) => a.age - b.age)
  let chosen: typeof eligible | null = null
  let shared: Bits | null = null
  for (let i = 0; i < eligible.length && !chosen; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const both: Bits = {
        ip: eligible[i].bits.ip && eligible[j].bits.ip,
        device: eligible[i].bits.device && eligible[j].bits.device,
        email: eligible[i].bits.email && eligible[j].bits.email,
      }
      if (!qualifies(both)) continue
      chosen = [eligible[i], eligible[j]]
      shared = both
      break
    }
  }
  if (!chosen || !shared) return null
  const row: Ce3Party = {
    customerAccountId: null,
    customerEmail: shared.email ? email : null,
    customerPurchaseIp: shared.ip && ip ? ip : null,
    customerDeviceId: shared.device && device ? device : null,
    productDescription: o.productDescription,
  }
  return {
    disputed: row,
    prior: chosen.map((x) => ({ charge: x.p.id, ...row })),
  }
}

// --- Evidence ----------------------------------------------------------------

export type EvidenceAck = {
  kind: string
  version: string
  acceptedAt: string
  ip: string | null
  userAgent: string | null
  source: string
  contentHash?: string
  textHash?: string | null
  textUrl?: string | null
}
export type EvidenceLedger = { kind: string; title: string; detail: string | null; occurredAt: string; contentHash: string }
export type EvidenceMail = { direction: 'in' | 'out'; at: string; from: string; to: string; subject: string; snippet: string }
export type EvidenceReceipt = { channel: string; kind: string; to: string; sentAt: string; deliveredAt: string | null; openedAt: string | null; subject: string | null }
export type EvidenceInvoice = { at: string; amountCents: number; currency?: string; appointments: number; emailSentAt: string | null; smsSentAt: string | null }
export type EvidenceLogin = { at: string; email: string | null; ip: string | null; userAgent?: string | null; kind: string }

export type EvidenceFacts = {
  dispute: {
    id: string
    reason: string
    status: string
    amountCents: number
    currency: string
    dueBy: string | null
    chargedAt: string | null
    cardBrand: string | null
    networkReasonCode: string | null
    email: string | null
    name: string | null
    phone: string | null
    billingAddress: string | null
    purchaseIp: string | null
    purchaseUa: string | null
    deviceId: string | null
    cardFingerprint?: string | null
    chargeRefunded: boolean
  }
  client: { id: string; name: string; email: string | null; phone: string | null; address: string | null; packageName: string | null; serviceStart: string | null; website: string | null; disputeCount: number } | null
  intake: { id: string; receivedAt: string; businessName: string | null; fullName: string | null; email: string | null; phone: string | null; address: string | null; services: string | null } | null
  acknowledgements: EvidenceAck[]
  ledger: EvidenceLedger[]
  emails: EvidenceMail[]
  receipts: EvidenceReceipt[]
  invoices: EvidenceInvoice[]
  logins: EvidenceLogin[]
  priors: PriorCharge[]
  narrative: string | null
  template: string | null
}

export type BuiltEvidence = {
  fields: Record<string, string>
  ce3: Ce3 | null
  sections: { heading: string; body: string }[]
  /** Clickwrap rendered as its own PDF for the customer_signature file field. Null when nobody accepted terms. */
  signatureSections: { heading: string; body: string }[] | null
  ledgerHashes: string[]
  summary: string
}

/** The Sites "Report for the client" checklist, in the order the packet shows them. */
export const SETUP_MILESTONES = [
  { key: 'site', kind: 'setup_site', label: 'Website live' },
  { key: 'domain', kind: 'setup_domain', label: 'Domain' },
  { key: 'number', kind: 'setup_number', label: 'Toll-free number' },
  { key: 'texting', kind: 'setup_texting', label: 'Texting approved' },
  { key: 'calls', kind: 'setup_calls', label: 'Calls ring the owner' },
  { key: 'form', kind: 'setup_form', label: 'Site uses Genisys OS form and chat' },
  { key: 'automations', kind: 'setup_automations', label: 'Lead automations on' },
  { key: 'reviews', kind: 'setup_reviews', label: 'Google review requests on' },
  { key: 'profile', kind: 'setup_profile', label: 'Business profile complete' },
] as const

export const TIMELINE_KINDS = [
  ...SETUP_MILESTONES.map((m) => m.kind),
  'client_report',
  'login_invite',
  'login',
] as const

export function serviceTimeline(ledger: { kind: string; title: string; detail: string | null; occurredAt: string }[]): string {
  const lines: string[] = []
  for (const m of SETUP_MILESTONES) {
    const rows = ledger.filter((l) => l.kind === m.kind)
    if (!rows.length) {
      lines.push(`${m.label}: not recorded as complete`)
      continue
    }
    for (const r of rows) lines.push(`${when(r.occurredAt)}  ${r.title}${r.detail ? ` — ${r.detail}` : ''}`)
  }
  const reports = ledger.filter((l) => l.kind === 'client_report')
  lines.push(reports.length ? reports.map((r) => `${when(r.occurredAt)}  ${r.title}${r.detail ? ` — ${r.detail}` : ''}`).join('\n') : 'Client report: not sent yet')
  const invites = ledger.filter((l) => l.kind === 'login_invite')
  if (invites.length) lines.push(...invites.map((r) => `${when(r.occurredAt)}  ${r.title}${r.detail ? ` — ${r.detail}` : ''}`))
  else lines.push('Dashboard login invite: not recorded')
  const logins = ledger.filter((l) => l.kind === 'login')
  if (logins.length) lines.push(...logins.map((r) => `${when(r.occurredAt)}  ${r.title}${r.detail ? ` — ${r.detail}` : ''}`))
  else lines.push('Dashboard login: none recorded yet')
  return lines.join('\n')
}

export type EvidenceEmphasis = 'fraud' | 'not_received' | 'not_as_described' | 'canceled' | 'credit' | 'duplicate' | 'unrecognized' | 'general'

/** Network codes we know, and the Stripe reason they line up with. */
const NETWORK_CODES: Record<string, { emphasis: EvidenceEmphasis; label: string }> = {
  '10.4': { emphasis: 'fraud', label: 'Visa 10.4 other fraud, card absent' },
  '13.1': { emphasis: 'not_received', label: 'Visa 13.1 merchandise or services not received' },
  '13.2': { emphasis: 'canceled', label: 'Visa 13.2 cancelled recurring transaction' },
  '13.3': { emphasis: 'not_as_described', label: 'Visa 13.3 not as described or defective' },
  '13.7': { emphasis: 'canceled', label: 'Visa 13.7 cancelled merchandise or services' },
  '4837': { emphasis: 'fraud', label: 'Mastercard 4837 no cardholder authorization' },
  '4863': { emphasis: 'fraud', label: 'Mastercard 4863 cardholder does not recognize' },
  '4855': { emphasis: 'not_received', label: 'Mastercard 4855 goods or services not provided' },
  '4841': { emphasis: 'canceled', label: 'Mastercard 4841 canceled recurring' },
  '4853': { emphasis: 'not_as_described', label: 'Mastercard 4853 cardholder dispute, not as described' },
  '4860': { emphasis: 'credit', label: 'Mastercard 4860 credit not processed' },
  F29: { emphasis: 'fraud', label: 'American Express F29 card-not-present fraud' },
  F24: { emphasis: 'fraud', label: 'American Express F24 no cardholder authorization' },
  C08: { emphasis: 'not_received', label: 'American Express C08 goods or services not received' },
  C31: { emphasis: 'not_as_described', label: 'American Express C31 goods or services not as described' },
  C04: { emphasis: 'credit', label: 'American Express C04 goods or services returned or refused' },
  C05: { emphasis: 'canceled', label: 'American Express C05 goods or services canceled' },
  C28: { emphasis: 'canceled', label: 'American Express C28 cancelled recurring billing' },
  C02: { emphasis: 'credit', label: 'American Express C02 credit not processed' },
}

const EMPHASIS_FROM_REASON: Record<string, EvidenceEmphasis> = {
  fraudulent: 'fraud',
  product_not_received: 'not_received',
  product_unacceptable: 'not_as_described',
  subscription_canceled: 'canceled',
  credit_not_processed: 'credit',
  duplicate: 'duplicate',
  unrecognized: 'unrecognized',
  general: 'general',
}

export function normalizeNetworkCode(code: string | null | undefined): string | null {
  const t = (code ?? '').trim().toUpperCase().replace(/\s+/g, '')
  return t || null
}

export function disputeEmphasis(reason: string, networkReasonCode: string | null | undefined): { emphasis: EvidenceEmphasis; code: string | null; label: string | null } {
  const code = normalizeNetworkCode(networkReasonCode)
  const known = code ? NETWORK_CODES[code] : undefined
  if (known) return { emphasis: known.emphasis, code, label: known.label }
  return { emphasis: EMPHASIS_FROM_REASON[reason] ?? 'general', code, label: null }
}

const EMPHASIS_NARRATIVES: Record<EvidenceEmphasis, string> = {
  fraud:
    'The cardholder is a Lead Genisys client, not a stranger. This is a card-absent fraud claim. The purchase IP and device id recorded at checkout are in customer_purchase_ip and, when two older undisputed charges share them, in the Visa Compelling Evidence block. The service delivery timeline after that shows the website, domain, phone number, texting, call routing, form, and automations we set up for their business.',
  not_received:
    'Nothing was shipped. The service delivery timeline is the proof of what was delivered: the website going live, the domain, the toll-free number, texting approval, calls ringing the owner, the Genisys OS form and chat on the site, lead automations, Google review requests, and a completed business profile, then the setup report we emailed and any later sign-in. Leads that arrived after that are supporting detail.',
  not_as_described:
    'The service delivery timeline is what the client received: website, domain, toll-free number, texting, call routing, form and chat, automations, review requests, and the business profile. That is the lead-generation system described at signup. The refund fields quote the refund policy the client accepted, from the hashed policy page or from section 10 of the Terms of Service they agreed to at Stripe Checkout.',
  canceled:
    'The subscription was still in force on the charge date. The service delivery timeline shows the system the client kept. The cancellation fields quote the cancellation policy the client accepted, from the hashed policy page or from section 10 of the Terms of Service they agreed to at Stripe Checkout.',
  credit:
    'The timeline shows the service that was delivered. The refund fields quote the refund policy the client accepted, from the hashed policy page or from section 10 of the Terms of Service they agreed to at Stripe Checkout, and they note a refund when one was actually issued.',
  duplicate:
    'This charge is a distinct billing period or invoice, not a second copy of another charge. The packet lists the cycle it covers.',
  unrecognized:
    'The cardholder is a Lead Genisys client. The purchase IP recorded at checkout and the service delivery timeline tie this charge to the website, number, and automations we set up for their business.',
  general:
    'Lead Genisys delivered the contracted lead generation and marketing service. The service delivery timeline is the setup record, followed by the invoices and the messages between us.',
}

const NETWORK_NARRATIVES: Record<string, string> = {
  '10.4': `Visa 10.4, other fraud, card absent. ${EMPHASIS_NARRATIVES.fraud}`,
  '13.1': `Visa 13.1, services not received. ${EMPHASIS_NARRATIVES.not_received}`,
  '13.2': `Visa 13.2, cancelled recurring transaction. ${EMPHASIS_NARRATIVES.canceled}`,
  '13.3': `Visa 13.3, not as described. ${EMPHASIS_NARRATIVES.not_as_described}`,
  '13.7': `Visa 13.7, cancelled merchandise or services. ${EMPHASIS_NARRATIVES.canceled}`,
  '4837': `Mastercard 4837, no cardholder authorization. ${EMPHASIS_NARRATIVES.fraud}`,
  '4863': `Mastercard 4863, cardholder does not recognize the charge. ${EMPHASIS_NARRATIVES.fraud}`,
  '4855': `Mastercard 4855, goods or services not provided. ${EMPHASIS_NARRATIVES.not_received}`,
  '4841': `Mastercard 4841, canceled recurring. ${EMPHASIS_NARRATIVES.canceled}`,
  '4853': `Mastercard 4853, not as described. ${EMPHASIS_NARRATIVES.not_as_described}`,
  '4860': `Mastercard 4860, credit not processed. ${EMPHASIS_NARRATIVES.credit}`,
  F29: `American Express F29, card-not-present fraud. ${EMPHASIS_NARRATIVES.fraud}`,
  F24: `American Express F24, no cardholder authorization. ${EMPHASIS_NARRATIVES.fraud}`,
  C08: `American Express C08, goods or services not received. ${EMPHASIS_NARRATIVES.not_received}`,
  C31: `American Express C31, goods or services not as described. ${EMPHASIS_NARRATIVES.not_as_described}`,
  C04: `American Express C04, goods or services returned or refused. ${EMPHASIS_NARRATIVES.credit}`,
  C05: `American Express C05, goods or services canceled. ${EMPHASIS_NARRATIVES.canceled}`,
  C28: `American Express C28, cancelled recurring billing. ${EMPHASIS_NARRATIVES.canceled}`,
  C02: `American Express C02, credit not processed. ${EMPHASIS_NARRATIVES.credit}`,
}

export const NARRATIVE_TEMPLATES: Record<string, string> = {
  fraudulent: EMPHASIS_NARRATIVES.fraud,
  product_not_received: EMPHASIS_NARRATIVES.not_received,
  subscription_canceled: EMPHASIS_NARRATIVES.canceled,
  product_unacceptable: EMPHASIS_NARRATIVES.not_as_described,
  credit_not_processed: EMPHASIS_NARRATIVES.credit,
  general: EMPHASIS_NARRATIVES.general,
  unrecognized: EMPHASIS_NARRATIVES.unrecognized,
  duplicate: EMPHASIS_NARRATIVES.duplicate,
}

export function templateFor(reason: string, overrides: Record<string, string> | null, networkReasonCode?: string | null): string {
  const code = normalizeNetworkCode(networkReasonCode)
  const custom = (code && overrides?.[code]?.trim()) || overrides?.[reason]?.trim()
  if (custom) return custom
  if (code && NETWORK_NARRATIVES[code]) return NETWORK_NARRATIVES[code]
  return NARRATIVE_TEMPLATES[reason] ?? EMPHASIS_NARRATIVES[disputeEmphasis(reason, code).emphasis]
}

function clip(s: string, n: number): string {
  const t = s.trim()
  if (t.length <= n) return t
  return `${t.slice(0, n - 20).trimEnd()}\n[truncated]`
}

/**
 * Join body and a required suffix inside `limit`.
 * The suffix stays whole. Extra length is cut from the body, which is the part Stripe would otherwise clip off the end.
 */
function appendWithinLimit(body: string, suffix: string, limit: number): string {
  const cleanBody = body.trim()
  const cleanSuffix = suffix.trim()
  if (!cleanSuffix) return clip(cleanBody, limit)
  if (!cleanBody) return clip(cleanSuffix, limit)
  const sep = '\n\n'
  if (cleanSuffix.length + sep.length >= limit) return clip(cleanSuffix, limit)
  const room = limit - cleanSuffix.length - sep.length
  const head = cleanBody.length <= room ? cleanBody : clip(cleanBody, room)
  return `${head}${sep}${cleanSuffix}`
}

function money(cents: number, currency = 'usd'): string {
  const prefix = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `
  return prefix + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2))
}

function when(isoDate: string | null): string {
  if (!isoDate) return 'unknown date'
  const d = new Date(isoDate)
  return Number.isNaN(d.getTime()) ? isoDate : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

export function purchaseIp(acks: EvidenceAck[], chargedAt: string | null, fallback: string | null): string | null {
  const withIp = acks.filter((a) => a.ip && a.kind !== 'milestone')
  if (!withIp.length) return fallback
  if (!chargedAt) return withIp[0].ip
  const t = new Date(chargedAt).getTime()
  withIp.sort((a, b) => Math.abs(new Date(a.acceptedAt).getTime() - t) - Math.abs(new Date(b.acceptedAt).getTime() - t))
  return withIp[0].ip ?? fallback
}

function hasAck(acks: EvidenceAck[], kind: string): EvidenceAck | undefined {
  return acks.find((a) => a.kind === kind)
}

function ackLine(a: EvidenceAck): string {
  const ua = oneLine(a.userAgent, 300)
  return `${a.kind} version ${versionOf(a.version)} accepted ${when(a.acceptedAt)} from IP ${customerIp(a.ip) ?? 'not recorded'}, browser ${ua ?? 'not recorded'} (${oneLine(a.source, 40) ?? 'unknown'})`
}

function hashAndUrl(a: EvidenceAck): string {
  const hash = textHashOf(a.textHash ?? null)
  const url = textUrlOf(a.textUrl ?? null)
  return `${hash ? `, text sha256 ${hash}` : ''}${url ? `, ${url}` : ''}`
}

function policyCite(a: EvidenceAck): string {
  return `version ${versionOf(a.version)} on ${when(a.acceptedAt)} from IP ${customerIp(a.ip) ?? 'not recorded'}${hashAndUrl(a)}`
}

function matchedPolicy(a: EvidenceAck): PolicyEdition | null {
  return policyEditionForAcceptance({ kind: a.kind, textHash: a.textHash })
}

/** Version, hash, and URL from the intake, plus the summary only when the hash is that page. */
function acceptedPolicySentence(a: EvidenceAck, label: string): string {
  const edition = matchedPolicy(a)
  const cite = `Shown and accepted at ${oneLine(a.source, 40) ?? 'intake'}, ${policyCite(a)}.`
  if (!edition) {
    return `${cite} That acceptance record does not match a ${label} text on file, so this packet does not substitute a different ${label}.`
  }
  const draft = edition.draft ? " The matched text is marked draft, pending the owner's legal review." : ''
  const versionNote = versionOf(a.version) === edition.version
    ? ''
    : ` The record's version string is ${versionOf(a.version)}; the hashed text is version ${edition.version}.`
  return `${cite} The text hash matches ${edition.textUrl} version ${edition.version}.${versionNote}${draft} ${edition.summary}`
}

function policiesBody(acks: EvidenceAck[]): string {
  const blocks = POLICY_EDITIONS.flatMap((edition) => {
    const ack = acks.find((a) => a.kind === edition.kind)
    // A draft nobody accepted has no place in front of a bank.
    if (edition.draft && !ack) return []
    const matched = ack ? matchedPolicy(ack) : null
    const isThis = !!ack && matched?.textHash === edition.textHash
    const includeText = isThis || !edition.draft
    let status: string
    if (!ack) {
      status = "No acceptance record for this client. The text below is what the onboarding site publishes. It is not stated as this client's acceptance."
    } else if (isThis) {
      status = `This is the text the acceptance record hashes to (${policyCite(ack)}).`
    } else if (matched) {
      status = `The acceptance record matches a different edition (version ${matched.version}, sha256 ${matched.textHash}), not this text.`
    } else if (!textHashOf(ack.textHash ?? null) && ack.source === CHECKOUT_CONSENT_SOURCE) {
      status = `The client checked the Terms of Service box at Stripe Checkout (${policyCite(ack)}). Stripe records the checked box, not a text hash, so the text below is the published version, not a hashed copy of what was shown.`
    } else {
      status = `An acceptance record is on file (${policyCite(ack)}) but its text hash does not match this edition, so this edition is not stated as what the client accepted.`
    }
    return [
      [
        edition.title,
        `Version ${edition.version}${edition.draft ? ", draft, pending the owner's legal review" : ''}`,
        edition.textUrl,
        `sha256 ${edition.textHash}`,
        status,
        ...(includeText
          ? ['', 'Summary quoted in Stripe fields when the hash matches:', edition.summary, '', 'Full text:', edition.text]
          : ['', 'The text of this edition is not included.']),
      ].join('\n'),
    ]
  })
  return [
    "Each block is one published version of a policy. A Stripe disclosure field quotes it only when the client's textHash is the SHA-256 of that block's full text, or, for the Terms of Service, when Stripe Checkout recorded the client's agreement.",
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

/**
 * Section 10 of the Terms carries the cancellation and refund rules. It is quoted
 * when the client's terms acceptance is the hashed Terms page, or Stripe Checkout's
 * terms box. An intake acceptance without a hash quotes nothing.
 */
function termsDisclosure(terms: EvidenceAck | undefined, topic: 'cancellation' | 'refund'): string | null {
  if (!terms) return null
  const clause = topic === 'cancellation' ? TERMS_CANCELLATION_CLAUSE : TERMS_REFUND_CLAUSE
  const edition = matchedPolicy(terms)
  if (edition) {
    return `The client accepted the Terms of Service, ${policyCite(terms)}. The text hash matches ${edition.textUrl} version ${edition.version}. Section 10 of those Terms states: ${clause}`
  }
  if (!textHashOf(terms.textHash ?? null) && terms.source === CHECKOUT_CONSENT_SOURCE) {
    const published = currentPolicy('terms')
    if (published.draft) return null
    return `The client checked "I agree to the Terms of Service" at Stripe Checkout, ${policyCite(terms)}. Stripe records the checked box, not a text hash. The published Terms of Service, ${published.textUrl} version ${published.version}, section 10, state: ${clause}`
  }
  return null
}

export function buildEvidence(facts: EvidenceFacts): BuiltEvidence {
  const d = facts.dispute
  const client = facts.client
  const acks = facts.acknowledgements
  const product = PRODUCT_DESCRIPTION
  const emphasis = disputeEmphasis(d.reason, d.networkReasonCode)
  const ip = customerIp(d.purchaseIp) ?? customerIp(purchaseIp(acks, d.chargedAt, null))
  const deviceId = deviceIdOf(d.deviceId)
  const email = cleanEmail(client?.email) ?? cleanEmail(facts.intake?.email) ?? d.email
  const name = client?.name ?? facts.intake?.businessName ?? d.name ?? 'the client'
  const person = facts.intake?.fullName ?? d.name
  const address = client?.address ?? facts.intake?.address ?? d.billingAddress
  const serviceDate = client?.serviceStart ?? facts.intake?.receivedAt ?? facts.ledger.find((l) => l.kind === 'onboarding')?.occurredAt ?? d.chargedAt
  const terms = hasAck(acks, 'terms')
  const refundAck = hasAck(acks, 'refund_policy')
  const cancelAck = hasAck(acks, 'cancellation_policy')
  const recurring = hasAck(acks, 'recurring_billing')

  const activity = [
    ...facts.logins.map((l) => {
      const ua = oneLine(l.userAgent, 120)
      const loginIp = customerIp(l.ip)
      return `${when(l.at)}  ${oneLine(l.kind, 40) ?? 'login'}${l.email ? ` ${l.email}` : ''}${loginIp ? ` ip ${loginIp}` : ''}${ua ? ` ua ${ua}` : ''}`
    }),
    ...facts.ledger
      .filter((l) => ['login', 'login_invite', 'client_report', 'reply', 'email_in', 'email_out', 'setup_site', 'setup_form'].includes(l.kind))
      .map((l) => `${when(l.occurredAt)}  ${l.title}`),
  ].slice(0, 80)

  const comms = [
    ...facts.emails.map((m) => `${when(m.at)}  ${m.direction === 'in' ? 'Client wrote' : 'We wrote'} ${m.from} → ${m.to}: ${m.subject} — ${m.snippet}`),
    ...facts.receipts.map((r) => {
      const open = r.openedAt ? `opened ${when(r.openedAt)} (a mail scanner can prefetch a pixel, so an open is supporting evidence, not proof by itself)` : 'no open recorded'
      const delivered = r.deliveredAt ? `delivered ${when(r.deliveredAt)}` : 'sent'
      return `${when(r.sentAt)}  ${r.channel} ${r.kind} to ${r.to} (${delivered}; ${open})${r.subject ? `: ${r.subject}` : ''}`
    }),
  ]

  const timeline = serviceTimeline(facts.ledger)
  const usage = facts.ledger.map((l) => `${when(l.occurredAt)}  [${l.kind}] ${l.title}${l.detail ? ` — ${l.detail}` : ''}`)
  const leads = facts.ledger.filter((l) => l.kind === 'lead' || l.kind === 'appointment')
  const invoices = facts.invoices.map((inv) => `${when(inv.at)}  ${money(inv.amountCents)} covering ${inv.appointments} appointment${inv.appointments === 1 ? '' : 's'}${inv.emailSentAt ? `, emailed ${when(inv.emailSentAt)}` : ''}${inv.smsSentAt ? `, texted ${when(inv.smsSentAt)}` : ''}`)

  const afterPurchase = facts.ledger.filter((l) => d.chargedAt && new Date(l.occurredAt).getTime() >= new Date(d.chargedAt).getTime())
  const afterNote = afterPurchase.length
    ? `After this charge the ledger shows ${afterPurchase.length} service event${afterPurchase.length === 1 ? '' : 's'}.`
    : 'The ledger has no entry on or after this charge.'
  const cancelEdition = cancelAck ? matchedPolicy(cancelAck) : null
  const refundEdition = refundAck ? matchedPolicy(refundAck) : null
  const recurringEdition = recurring ? matchedPolicy(recurring) : null
  const cancelFromTerms = cancelAck ? null : termsDisclosure(terms, 'cancellation')
  const refundFromTerms = refundAck ? null : termsDisclosure(terms, 'refund')
  const rebuttal = cancelAck
    ? cancelEdition
      ? `The client accepted the cancellation policy ${policyCite(cancelAck)}. The text hash matches ${cancelEdition.textUrl} version ${cancelEdition.version}. ${cancelEdition.summary} ${afterNote}`
      : `The client has a cancellation acceptance (${policyCite(cancelAck)}) that does not match a cancellation policy text on file, so this packet does not substitute a different cancellation rule. ${afterNote}`
    : cancelFromTerms
      ? `${cancelFromTerms} ${afterNote}`
      : `The Hub does not yet have a clickwrap record of the cancellation policy for this client. ${afterNote}`

  const refusal = d.chargeRefunded
    ? 'The charge has already been refunded. No further credit is owed.'
    : refundAck
      ? refundEdition
        ? `The client accepted the refund policy ${policyCite(refundAck)}. The text hash matches ${refundEdition.textUrl} version ${refundEdition.version}. ${refundEdition.summary} The ledger shows what was delivered.`
        : `The client has a refund acceptance (${policyCite(refundAck)}) that does not match a refund policy text on file, so this packet does not substitute a different refund rule. The ledger shows what was delivered.`
      : refundFromTerms
        ? `${refundFromTerms} The ledger shows what was delivered.`
        : 'The Hub does not yet have a clickwrap record of the refund policy for this client. This packet does not state a refund rule as something this client accepted.'

  const narrative = (facts.narrative?.trim() || facts.template?.trim() || templateFor(d.reason, null, d.networkReasonCode)).trim()
  const repeat = client && client.disputeCount >= 2 ? `This client has ${client.disputeCount} disputes on file.` : ''
  const purchaseUa = oneLine(d.purchaseUa, 500)
  const purchaseLines = [
    ip ? `Purchase IP recorded at checkout: ${ip}.` : 'No purchase IP was recorded at checkout.',
    deviceId ? `Device id recorded at checkout: ${deviceId}.` : '',
    purchaseUa ? `User agent at checkout: ${purchaseUa}` : '',
  ].filter(Boolean)
  const leadBlock = emphasis.emphasis === 'fraud' || emphasis.emphasis === 'unrecognized'
    ? [...purchaseLines, narrative]
    : emphasis.emphasis === 'not_received' || emphasis.emphasis === 'not_as_described'
      ? [`Service delivery timeline:\n${timeline}`, narrative]
      : [narrative]
  const uncategorized = [...leadBlock, repeat, `Packet prepared by Genisys Hub. Dispute ${d.id}. Reason ${d.reason}${emphasis.label ? ` (${emphasis.label})` : ''}. Amount ${money(d.amountCents, d.currency)}.`].filter(Boolean).join('\n\n')

  const clickwrap = !terms
    ? ''
    : terms.source === CHECKOUT_CONSENT_SOURCE
      ? `Terms of Service box checked at Stripe Checkout: ${ackLine(terms)}. Stripe holds that consent on the Checkout Session.`
      : `Clickwrap ${ackLine(terms)}${hashAndUrl(terms)}. The acceptance record and the policy text on file are in the attached packet.`
  const fields: Record<string, string> = {
    product_description: product,
    customer_name: person || name,
    customer_email_address: email ?? '',
    billing_address: address ?? '',
    customer_purchase_ip: ip ?? '',
    service_date: serviceDate ? serviceDate.slice(0, 10) : '',
    access_activity_log: [activity.join('\n'), clickwrap].filter(Boolean).join('\n'),
    refund_policy_disclosure: refundAck ? acceptedPolicySentence(refundAck, 'refund policy') : refundFromTerms ?? '',
    cancellation_policy_disclosure: cancelAck ? acceptedPolicySentence(cancelAck, 'cancellation policy') : cancelFromTerms ?? '',
    cancellation_rebuttal: emphasis.emphasis === 'canceled' ? rebuttal : '',
    refund_refusal_explanation: emphasis.emphasis === 'not_as_described' || emphasis.emphasis === 'credit' ? refusal : '',
    duplicate_charge_explanation: d.reason === 'duplicate' ? narrative : '',
    uncategorized_text: [
      uncategorized,
      emphasis.emphasis === 'not_received' || emphasis.emphasis === 'not_as_described' ? '' : `Service delivery timeline:\n${timeline}`,
      emphasis.emphasis === 'fraud' || emphasis.emphasis === 'unrecognized' ? '' : purchaseLines.join('\n'),
      comms.length ? `Communications:\n${comms.join('\n')}` : '',
      invoices.length ? `Invoices:\n${invoices.join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
  }
  if (recurring) {
    const line = recurringEdition
      ? `Recurring billing disclosure ${policyCite(recurring)}. The text hash matches ${recurringEdition.textUrl} version ${recurringEdition.version}${recurringEdition.draft ? ", draft, pending the owner's legal review" : ''}. ${recurringEdition.summary}`
      : `Recurring billing disclosure ${policyCite(recurring)}. That acceptance record does not match a recurring-billing text on file, so this packet does not substitute a different billing disclosure.`
    fields.uncategorized_text = appendWithinLimit(fields.uncategorized_text, line, UNCATEGORIZED_LIMIT)
  }

  // Drop empty strings so we don't wipe a Stripe field with a blank.
  for (const k of Object.keys(fields)) if (!fields[k].trim()) delete fields[k]
  fitText(fields)

  const ce3 = selectCompellingEvidence({
    reason: d.reason,
    cardBrand: d.cardBrand,
    networkReasonCode: d.networkReasonCode,
    chargedAt: d.chargedAt,
    email,
    ip,
    deviceId,
    fingerprint: d.cardFingerprint ?? null,
    accountId: null,
    productDescription: product,
    priors: facts.priors,
  })

  const sections: { heading: string; body: string }[] = [
    {
      heading: 'Cover',
      body: [
        `Dispute ${d.id}`,
        `Reason: ${d.reason}${d.cardBrand ? ` (${d.cardBrand})` : ''}${emphasis.label ? ` — ${emphasis.label}` : ''}`,
        `Amount: ${money(d.amountCents, d.currency)}`,
        `Status: ${d.status}`,
        `Due: ${when(d.dueBy)}`,
        `Charged: ${when(d.chargedAt)}`,
        `Client: ${client ? `${client.name} (${client.id})` : 'not matched'}`,
        `Match notes are in the Hub dispute record.`,
        repeat,
        '',
        narrative,
      ].filter(Boolean).join('\n'),
    },
    {
      heading: 'Agreement and acceptance',
      body: acks.length
        ? ['Each line is a clickwrap or milestone confirmation. The SHA-256 of the stored record is the provenance.', ...acks.map((a) => `${ackLine(a)}${a.contentHash ? `\n  sha256 ${a.contentHash}` : ''}`)].join('\n')
        : 'No clickwrap is on file yet. The onboarding form did not send an acceptance block for this client. What follows is the delivery record, which does not depend on a signature.',
    },
    {
      heading: 'Onboarding',
      body: facts.intake
        ? [`Received ${when(facts.intake.receivedAt)}`, `Business: ${facts.intake.businessName ?? '—'}`, `Contact: ${facts.intake.fullName ?? '—'}`, `Email: ${facts.intake.email ?? '—'}`, `Phone: ${facts.intake.phone ?? '—'}`, `Address: ${facts.intake.address ?? '—'}`, facts.intake.services ? `Services they described: ${facts.intake.services}` : ''].filter(Boolean).join('\n')
        : 'No onboarding intake is linked.',
    },
    { heading: 'Service delivery timeline', body: timeline },
    {
      heading: 'Leads and appointments (supporting)',
      body: leads.length
        ? `These are leads and appointments after the system was set up. They support the case. The setup timeline above is the service that was sold.\n\n${leads.slice(0, 15).map((l) => `${when(l.occurredAt)}  ${l.title}`).join('\n')}`
        : 'No lead or appointment rows are in the ledger. The service sold is the setup in the timeline above.',
    },
    { heading: 'Full ledger', body: usage.length ? usage.join('\n') : 'No ledger entries yet.' },
    { heading: 'Invoices and receipts', body: invoices.length ? invoices.join('\n') : 'No Hub invoices on file. Stripe receipts, if enabled in the Dashboard, are a separate copy.' },
    { heading: 'Communications', body: comms.length ? comms.join('\n') : 'No emails, texts, or replies matched this client.' },
    { heading: 'Policies', body: policiesBody(acks) },
  ]
  if (ce3) {
    sections.push({
      heading: 'Visa Compelling Evidence 3.0',
      body: `Two prior undisputed charges qualify: ${ce3.prior.map((p) => p.charge).join(', ')}. Email ${ce3.disputed.customerEmail ?? '—'}, IP ${ce3.disputed.customerPurchaseIp ?? '—'}, device ${ce3.disputed.customerDeviceId ?? '—'}.`,
    })
  }
  const purchaseSection = {
    heading: 'Checkout purchase',
    body: purchaseLines.join('\n') || 'No purchase IP or device id was recorded.',
  }
  const timelineAt = sections.findIndex((s) => s.heading === 'Service delivery timeline')
  if (emphasis.emphasis === 'fraud' || emphasis.emphasis === 'unrecognized') {
    const ceAt = sections.findIndex((s) => s.heading === 'Visa Compelling Evidence 3.0')
    const lead = []
    if (ceAt >= 0) lead.push(sections.splice(ceAt, 1)[0])
    lead.push(purchaseSection)
    sections.splice(1, 0, ...lead)
  } else if (emphasis.emphasis === 'not_received' || emphasis.emphasis === 'not_as_described') {
    if (timelineAt > 1) {
      const [row] = sections.splice(timelineAt, 1)
      sections.splice(1, 0, row)
    }
  }

  const signatureAcks = acks.filter((a) => a.kind !== 'milestone')
  const signatureSections = signatureAcks.length
    ? [{
        heading: 'Clickwrap acceptance',
        body: signatureAcks.map((a) => {
          const hash = textHashOf(a.textHash ?? null)
          const url = textUrlOf(a.textUrl ?? null)
          return [ackLine(a), hash ? `Text SHA-256: ${hash}` : '', url ? `Text URL: ${url}` : ''].filter(Boolean).join('\n')
        }).join('\n\n'),
      }]
    : null

  return {
    fields,
    ce3,
    sections,
    signatureSections,
    ledgerHashes: facts.ledger.map((l) => l.contentHash),
    summary: `${name} · ${emphasis.label ?? d.reason} · ${money(d.amountCents, d.currency)} · ${facts.ledger.length} ledger events`,
  }
}

function fitText(fields: Record<string, string>): void {
  for (const [k, v] of Object.entries(fields)) {
    fields[k] = clip(v, k === 'uncategorized_text' ? UNCATEGORIZED_LIMIT : TEXT_FIELD_LIMIT)
  }
  let total = Object.values(fields).reduce((n, v) => n + v.length, 0)
  if (total <= COMBINED_TEXT_LIMIT) return
  const order = ['uncategorized_text', 'service_documentation', 'customer_communication', 'access_activity_log', 'receipt']
  for (const k of order) {
    if (total <= COMBINED_TEXT_LIMIT) break
    if (!fields[k]) continue
    const over = total - COMBINED_TEXT_LIMIT
    const next = clip(fields[k], Math.max(200, fields[k].length - over))
    total -= fields[k].length - next.length
    fields[k] = next
  }
}

export function evidenceFormBody(o: { fields: Record<string, string>; files: Record<string, string>; ce3: Ce3 | null; submit: boolean }): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o.fields)) {
    if (!v || FILE_EVIDENCE_FIELDS.has(k)) continue
    p.set(`evidence[${k}]`, v)
  }
  for (const [field, fileId] of Object.entries(o.files)) {
    if (fileId && FILE_EVIDENCE_FIELDS.has(field)) p.set(`evidence[${field}]`, fileId)
  }
  if (o.ce3) {
    const base = 'evidence[enhanced_evidence][visa_compelling_evidence_3]'
    const put = (path: string, value: string | null) => { if (value) p.set(`${base}${path}`, value) }
    put('[disputed_transaction][customer_account_id]', o.ce3.disputed.customerAccountId)
    put('[disputed_transaction][customer_email_address]', o.ce3.disputed.customerEmail)
    put('[disputed_transaction][customer_purchase_ip]', o.ce3.disputed.customerPurchaseIp)
    put('[disputed_transaction][customer_device_id]', o.ce3.disputed.customerDeviceId)
    put('[disputed_transaction][product_description]', o.ce3.disputed.productDescription)
    put('[disputed_transaction][merchandise_or_services]', 'services')
    o.ce3.prior.forEach((prior, i) => {
      const prefix = `[prior_undisputed_transactions][${i}]`
      p.set(`${base}${prefix}[charge]`, prior.charge)
      put(`${prefix}[customer_account_id]`, prior.customerAccountId)
      put(`${prefix}[customer_email_address]`, prior.customerEmail)
      put(`${prefix}[customer_purchase_ip]`, prior.customerPurchaseIp)
      put(`${prefix}[customer_device_id]`, prior.customerDeviceId)
      put(`${prefix}[product_description]`, prior.productDescription)
      // Stripe accepts merchandise_or_services on the disputed transaction only; on a prior it is a 400.
    })
  }
  p.set('submit', o.submit ? 'true' : 'false')
  return p.toString()
}

export function budgetFiles(pdfBytes: number, extras: { bytes: number }[]): { keep: boolean[]; notes: string[] } {
  const notes: string[] = []
  const keep = extras.map(() => false)
  if (pdfBytes > MAX_FILE_BYTES) notes.push('The packet itself is over 5 MB and cannot be uploaded until it is shortened.')
  let used = pdfBytes
  let count = 1
  for (let i = 0; i < extras.length; i++) {
    const n = extras[i].bytes
    if (count >= MAX_EVIDENCE_FILES) { notes.push('Stopped at 5 evidence files.'); break }
    if (n > MAX_FILE_BYTES) { notes.push(`Skipped a file of ${n} bytes (over 5 MB).`); continue }
    if (used + n > MAX_COMBINED_FILE_BYTES) { notes.push('Skipped a file so the combined evidence stays under 4.5 MB.'); continue }
    keep[i] = true
    used += n
    count++
  }
  return { keep, notes }
}

// --- Intake acceptance -------------------------------------------------------

export type ParsedAcceptance = {
  kind: AckKind
  version: string
  acceptedAt: string
  ip: string | null
  userAgent: string | null
  textHash: string | null
  textUrl: string | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * The onboarding form may send:
 *   acceptance.terms / refundPolicy / cancellationPolicy / recurringBilling
 *   each { accepted, version, at, ip, userAgent, textHash, textUrl }
 * Flat ip and userAgent on the body fill anything the block left blank.
 * A false or missing accepted flag is not an acceptance.
 * textHash is the SHA-256 hex of the exact text shown. textUrl is where that text lives.
 */
export function parseAcceptance(body: unknown, receivedAt: string): ParsedAcceptance[] {
  if (!isRecord(body)) return []
  const answers = isRecord(body.answers) ? body.answers : body
  const block = isRecord(body.acceptance) ? body.acceptance : isRecord(answers.acceptance) ? answers.acceptance : {}
  const ip = customerIp(str(body.ip) ?? str(body.customerIp) ?? str(answers.ip))
  const ua = oneLine(str(body.userAgent) ?? str(body.user_agent) ?? str(answers.userAgent), 500)
  const map: { key: string; kind: AckKind }[] = [
    { key: 'terms', kind: 'terms' },
    { key: 'refundPolicy', kind: 'refund_policy' },
    { key: 'refund_policy', kind: 'refund_policy' },
    { key: 'cancellationPolicy', kind: 'cancellation_policy' },
    { key: 'cancellation_policy', kind: 'cancellation_policy' },
    { key: 'recurringBilling', kind: 'recurring_billing' },
    { key: 'recurring_billing', kind: 'recurring_billing' },
  ]
  const out: ParsedAcceptance[] = []
  const seen = new Set<string>()
  for (const { key, kind } of map) {
    if (seen.has(kind)) continue
    const row = block[key]
    if (!isRecord(row)) continue
    const accepted = row.accepted === true || row.accepted === 'true' || row.accepted === 'yes'
    if (!accepted) continue
    seen.add(kind)
    const at = str(row.at) ?? str(row.acceptedAt) ?? receivedAt
    const parsed = new Date(at)
    out.push({
      kind,
      version: versionOf(str(row.version)),
      acceptedAt: Number.isNaN(parsed.getTime()) ? receivedAt : parsed.toISOString(),
      ip: customerIp(str(row.ip)) ?? ip,
      userAgent: oneLine(str(row.userAgent) ?? str(row.user_agent), 500) ?? ua,
      textHash: textHashOf(str(row.textHash) ?? str(row.text_hash) ?? str(row.hash)),
      textUrl: textUrlOf(str(row.textUrl) ?? str(row.text_url) ?? str(row.url)),
    })
  }
  return out
}

/**
 * Stripe Checkout's terms box. Present when the signup site asks for
 * `consent_collection.terms_of_service=required`; Stripe then stores
 * `consent.terms_of_service=accepted` on the Checkout Session, behind the
 * Dashboard's Terms URL. The time is the session's creation (Stripe keeps no
 * separate acceptance time) and the IP and browser are the purchase trio the
 * signup site stamped on the session. There is no text hash to cite.
 */
export function checkoutConsentAcceptance(session: unknown): ParsedAcceptance | null {
  if (!isCheckoutSession(session)) return null
  const consent = isObj(session.consent) ? session.consent : null
  if (!consent || str(consent.terms_of_service) !== 'accepted') return null
  const acceptedAt = iso(session.created)
  if (!acceptedAt) return null
  const signals = purchaseSignalsFromMetadata(session.metadata)
  return { kind: 'terms', version: CHECKOUT_TERMS_VERSION, acceptedAt, ip: signals.ip, userAgent: signals.userAgent, textHash: null, textUrl: null }
}

export function acknowledgementHash(a: { kind: string; version: string; acceptedAt: string; ip: string | null; userAgent: string | null; email: string | null; textHash?: string | null; textUrl?: string | null }): string {
  return sha256(canonicalJson({ ...a, textHash: a.textHash ?? null, textUrl: a.textUrl ?? null }))
}

export type PurchaseSignals = { ip: string | null; userAgent: string | null; deviceId: string | null }

/** Stripe metadata keys and the intake `purchase` object. See the README for the contract. */
export function parsePurchaseSignals(source: unknown): PurchaseSignals {
  const empty: PurchaseSignals = { ip: null, userAgent: null, deviceId: null }
  if (!isRecord(source)) return empty
  const answers = isRecord(source.answers) ? source.answers : source
  const purchase = isRecord(source.purchase) ? source.purchase : isRecord(answers.purchase) ? answers.purchase : {}
  const meta = isRecord(source.metadata) ? source.metadata : {}
  const ip = customerIp(str(purchase.ip) ?? str(purchase.hub_purchase_ip) ?? str(meta.hub_purchase_ip) ?? str(source.hub_purchase_ip) ?? str(answers.hub_purchase_ip))
  const userAgent = oneLine(str(purchase.userAgent) ?? str(purchase.user_agent) ?? str(purchase.hub_purchase_ua) ?? str(meta.hub_purchase_ua) ?? str(source.hub_purchase_ua) ?? str(answers.hub_purchase_ua), 500)
  const deviceId = deviceIdOf(str(purchase.deviceId) ?? str(purchase.device_id) ?? str(purchase.hub_device_id) ?? str(meta.hub_device_id) ?? str(source.hub_device_id) ?? str(answers.hub_device_id))
  return { ip, userAgent, deviceId }
}

/** First source that has a usable IP, user agent, or device id. Fields are not mixed across sources. */
export function pickPurchaseSignals(sources: Array<Partial<PurchaseSignals> | null | undefined>): PurchaseSignals {
  for (const s of sources) {
    if (!s) continue
    const ip = customerIp(s.ip)
    const userAgent = oneLine(s.userAgent, 500)
    const deviceId = deviceIdOf(s.deviceId)
    if (ip || userAgent || deviceId) return { ip, userAgent, deviceId }
  }
  return { ip: null, userAgent: null, deviceId: null }
}

function textHashOf(v: string | null): string | null {
  if (!v) return null
  const t = v.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(t) ? t : null
}

function textUrlOf(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  if (t.length > 500 || !isPublicEvidenceUrl(t)) return null
  try {
    return new URL(t).toString().slice(0, 500)
  } catch {
    return null
  }
}

/**
 * Visa's device id must be 15 to 200 visible characters, and is ignored
 * unless it is. Shorter or unsafe values are not stored and are not sent as CE 3.0.
 */
export function deviceIdOf(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  if (!/^[A-Za-z0-9._:+/=-]{15,200}$/.test(t)) return null
  if (!/[A-Za-z0-9]/.test(t)) return null
  return t
}

/** One evidence line. Control characters become spaces so a field cannot forge a new row. */
export function oneLine(v: string | null | undefined, max: number): string | null {
  const t = (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.slice(0, max)
}

function versionOf(v: string | null | undefined): string {
  const raw = (v ?? '').trim()
  if (!raw) return TERMS_VERSION
  if (/^[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw
  // Keep what was sent, on one line, instead of claiming the current terms version.
  return oneLine(raw, 64) ?? TERMS_VERSION
}

// --- Win / loss --------------------------------------------------------------

export type OutcomeRow = { reason: string; status: string; amountCents: number }

export function summarizeOutcomes(rows: OutcomeRow[]): {
  byReason: { reason: string; won: number; lost: number; open: number; wonCents: number; lostCents: number; winRate: number | null }[]
  totals: { won: number; lost: number; open: number; winRate: number | null }
} {
  const map = new Map<string, { won: number; lost: number; open: number; wonCents: number; lostCents: number }>()
  for (const r of rows) {
    const slot = map.get(r.reason) ?? { won: 0, lost: 0, open: 0, wonCents: 0, lostCents: 0 }
    if (r.status === 'won') { slot.won++; slot.wonCents += r.amountCents }
    else if (r.status === 'lost') { slot.lost++; slot.lostCents += r.amountCents }
    else slot.open++
    map.set(r.reason, slot)
  }
  const byReason = [...map.entries()].map(([reason, s]) => ({
    reason,
    ...s,
    winRate: s.won + s.lost > 0 ? s.won / (s.won + s.lost) : null,
  })).sort((a, b) => b.won + b.lost + b.open - (a.won + a.lost + a.open))
  const totals = byReason.reduce((t, r) => ({ won: t.won + r.won, lost: t.lost + r.lost, open: t.open + r.open }), { won: 0, lost: 0, open: 0 })
  return { byReason, totals: { ...totals, winRate: totals.won + totals.lost > 0 ? totals.won / (totals.won + totals.lost) : null } }
}

export function repeatLabel(count: number): string | null {
  if (count >= 2) return `Repeat disputer (${count} disputes)`
  if (count === 1) return 'Disputed a charge'
  return null
}

/** A single public IP Stripe will accept in customer_purchase_ip. Lists, prose, and private addresses are dropped. */
export function customerIp(v: string | null | undefined): string | null {
  const first = (v ?? '').split(',')[0]?.trim() ?? ''
  if (!first || first.length > 45 || !isIP(first) || !isPublicIp(first)) return null
  return first
}

function ipv4ToInt(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const p = m.slice(1).map((x) => Number(x))
  if (p.some((n) => n > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}

/** False for loopback, private, link-local, CGNAT, and multicast addresses. */
export function isPublicIp(address: string): boolean {
  const v4 = ipv4ToInt(address)
  if (v4 !== null) {
    const block = (base: number, bits: number) => (v4 >>> (32 - bits)) === (base >>> (32 - bits))
    if (block(0, 8)) return false
    if (block(0x0a000000, 8)) return false
    if (block(0x7f000000, 8)) return false
    if (block(0xa9fe0000, 16)) return false
    if (block(0xac100000, 12)) return false
    if (block(0xc0a80000, 16)) return false
    if (block(0x64400000, 10)) return false
    if (block(0xe0000000, 4)) return false
    if (v4 === 0xffffffff) return false
    return true
  }
  const v6 = address.toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6)
  if (mapped) return isPublicIp(mapped[1])
  if (v6 === '::1' || v6 === '::') return false
  if (v6.startsWith('fc') || v6.startsWith('fd')) return false
  if (/^fe[89ab]/.test(v6)) return false
  if (v6.startsWith('ff')) return false
  return v6.includes(':')
}

/** An http(s) URL the evidence fetcher may request. Rejects credentials, localhost, and private IPs. */
export function isPublicEvidenceUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host === 'metadata.google.internal' || host === 'metadata.google.com') return false
  if (/^\d+$/.test(host)) return false
  if (ipv4ToInt(host) !== null) return isPublicIp(host)
  if (host.includes(':')) return isPublicIp(host)
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return false
  return true
}
