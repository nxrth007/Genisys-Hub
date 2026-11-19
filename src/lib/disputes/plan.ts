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

export const DISPUTE_KEY_ENTRY = 'Stripe Official Restricted'
export const LEGACY_STRIPE_KEY_ENTRY = 'Stripe API Key'
export const WEBHOOK_SECRET_ENTRY = 'Stripe Official Webhook Secret'
export const WEBHOOK_PATH = '/api/webhooks/stripe'
export const TERMS_VERSION = '2026-11-19'

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

export const PRODUCT_DESCRIPTION =
  'Lead Genisys sells contractor lead generation and marketing services to the client: a GoHighLevel sub-account, onboarding, lead and appointment delivery, SMS and email follow-up, and invoicing. The signup plan is a 30-day free trial of the monthly subscription (currently $297/month unless a different price was agreed) and, where contracted, pay-per-appointment billing for qualified appointments the client confirmed.'

export const REFUND_POLICY =
  'Fees for services already rendered are not refunded. That includes a subscription period that has started and pay-per-appointment invoices for appointments already delivered. A client may cancel future billing under the cancellation policy. During the 30-day free trial, canceling before the trial ends means the card on file is not charged.'

export const CANCELLATION_POLICY =
  'The client may cancel the monthly subscription before the next renewal by emailing alex@leadgenisys.com or through the Stripe customer portal when one is offered. Cancellation stops future charges. It does not refund the current period or pay-per-appointment invoices for appointments already delivered. The free trial may be canceled before it converts, in which case no charge is made.'

export const RECURRING_DISCLOSURE =
  'After the 30-day free trial, the card on file is charged the plan price automatically each month until the subscription is canceled. Pay-per-appointment clients are invoiced separately for qualified appointments they confirmed.'

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
  method: 'metadata' | 'email' | 'phone' | 'business_name' | 'person_name' | 'none'
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
  return {
    id,
    amountCents: num(ch.amount) ?? 0,
    created: iso(ch.created) ?? new Date(0).toISOString(),
    paid: ch.paid === true || str(ch.status) === 'succeeded',
    disputed: ch.disputed === true,
    refunded: ch.refunded === true,
    email: cleanEmail(billing ? str(billing.email) : null) ?? cleanEmail(meta.email),
    ip: str(meta.hub_purchase_ip),
    accountId: str(meta.hub_client_id) ?? accountId,
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
  accountId: string | null
}

export type Ce3 = {
  disputed: { customerAccountId: string | null; customerEmail: string | null; customerPurchaseIp: string | null; productDescription: string }
  prior: Array<{ charge: string; customerAccountId: string | null; customerEmail: string | null; customerPurchaseIp: string | null; productDescription: string }>
}

const DAY = 86_400_000

/**
 * Visa CE 3.0 (reason code 10.4): two prior undisputed charges on the same
 * card, 120 to 364 days before the disputed charge. Qualifying pairs are
 * two main elements, or one main and one secondary. Purchase IP is the only
 * main element this Hub can have (no device id). Email is secondary.
 * Account id plus email, with no IP, does not qualify, and an internal
 * client id is not an account id the cardholder would recognize.
 * Returns null when it does not qualify. Callers must not invent the IP or email.
 */
export function selectCompellingEvidence(o: {
  reason: string
  cardBrand: string | null
  networkReasonCode?: string | null
  chargedAt: string | null
  email: string | null
  ip: string | null
  accountId: string | null
  productDescription: string
  priors: PriorCharge[]
}): Ce3 | null {
  if (o.reason !== 'fraudulent') return null
  if (o.cardBrand !== 'visa') return null
  if (o.networkReasonCode && o.networkReasonCode !== '10.4') return null
  const email = cleanEmail(o.email)
  const ip = customerIp(o.ip)
  if (!email || !ip) return null
  const disputedAt = o.chargedAt ? new Date(o.chargedAt).getTime() : NaN
  if (!Number.isFinite(disputedAt)) return null
  const eligible = o.priors
    .filter((p) => p.paid && !p.disputed && !p.refunded && p.amountCents >= 100)
    .map((p) => ({ p, age: disputedAt - new Date(p.created).getTime() }))
    .filter((x) => x.age >= 120 * DAY && x.age < 365 * DAY)
    .filter((x) => cleanEmail(x.p.email) === email && customerIp(x.p.ip) === ip)
    .sort((a, b) => a.age - b.age)
  const picked = eligible.slice(0, 2)
  if (picked.length < 2) return null
  const row = () => ({
    customerAccountId: null as string | null,
    customerEmail: email,
    customerPurchaseIp: ip,
    productDescription: o.productDescription,
  })
  return {
    disputed: row(),
    prior: picked.map((x) => ({ charge: x.p.id, ...row() })),
  }
}

// --- Evidence ----------------------------------------------------------------

export type EvidenceAck = { kind: string; version: string; acceptedAt: string; ip: string | null; userAgent: string | null; source: string; contentHash?: string }
export type EvidenceLedger = { kind: string; title: string; detail: string | null; occurredAt: string; contentHash: string }
export type EvidenceMail = { direction: 'in' | 'out'; at: string; from: string; to: string; subject: string; snippet: string }
export type EvidenceReceipt = { channel: string; kind: string; to: string; sentAt: string; deliveredAt: string | null; openedAt: string | null; subject: string | null }
export type EvidenceInvoice = { at: string; amountCents: number; currency?: string; appointments: number; emailSentAt: string | null; smsSentAt: string | null }
export type EvidenceLogin = { at: string; email: string | null; ip: string | null; kind: string }

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

export const NARRATIVE_TEMPLATES: Record<string, string> = {
  fraudulent:
    'The cardholder is a Lead Genisys client. The charge is for the lead-generation and marketing system we set up for their business: website, domain, phone number, texting, call routing, forms, and automations. The service delivery timeline in the packet shows when each part of that setup was completed, and when we emailed them the setup report and their dashboard login. This was not a charge by a stranger.',
  product_not_received:
    'Nothing was shipped. The product is the Genisys OS setup for the client\'s business. The service delivery timeline shows each part of that setup as it was completed, then the report we emailed them and any later sign-in to their dashboard. Leads delivered after that are supporting detail, not the service itself.',
  subscription_canceled:
    'The client\'s subscription was still in force on the charge date. The packet shows the cancellation policy they were shown, whether we have a cancellation request, and the service they kept using. Cancellation stops future renewals; it does not refund a period that already started.',
  product_unacceptable:
    'The client received the lead generation and marketing service described at signup. The packet shows what was delivered and the refund policy. We are declining a refund because the service was provided as agreed.',
  credit_not_processed:
    'We have no outstanding credit that was agreed and then withheld. The packet shows the invoices, any refund that was actually issued, and the refund policy. A chargeback is not a substitute for a refund that was never owed.',
  general:
    'Lead Genisys delivered the contracted lead generation and marketing service. The packet is the onboarding record, the timeline of what the client received and used, the invoices, and the messages between us.',
  unrecognized:
    'The charge is the client\'s Lead Genisys subscription or pay-per-appointment invoice. The packet ties the cardholder to the client record and shows the service they used.',
  duplicate:
    'This charge is a distinct billing period or invoice, not a second copy of another charge. The packet lists the cycle it covers.',
}

export function templateFor(reason: string, overrides: Record<string, string> | null): string {
  const custom = overrides?.[reason]?.trim()
  if (custom) return custom
  return NARRATIVE_TEMPLATES[reason] ?? NARRATIVE_TEMPLATES.general
}

function clip(s: string, n: number): string {
  const t = s.trim()
  if (t.length <= n) return t
  return `${t.slice(0, n - 20).trimEnd()}\n[truncated]`
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
  return `${a.kind} version ${a.version} accepted ${when(a.acceptedAt)} from IP ${a.ip ?? 'not recorded'}, browser ${a.userAgent ?? 'not recorded'} (${a.source})`
}

export function buildEvidence(facts: EvidenceFacts): BuiltEvidence {
  const d = facts.dispute
  const client = facts.client
  const acks = facts.acknowledgements
  const product = PRODUCT_DESCRIPTION
  const ip = customerIp(purchaseIp(acks, d.chargedAt, d.purchaseIp))
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
    ...facts.logins.map((l) => `${when(l.at)}  ${l.kind}${l.email ? ` ${l.email}` : ''}${l.ip ? ` ip ${l.ip}` : ''}`),
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
  const rebuttal = cancelAck
    ? `The client accepted cancellation policy version ${cancelAck.version} on ${when(cancelAck.acceptedAt)}. ${afterPurchase.length ? `After this charge the ledger still shows ${afterPurchase.length} service events, which is use of a period that had started.` : 'The Hub has no cancellation request dated before this charge.'} Cancellation stops the next renewal. It does not refund a period that already started.`
    : `The Hub does not yet have a clickwrap record of the cancellation policy for this client. ${afterPurchase.length ? `The ledger shows ${afterPurchase.length} service events on or after the charge, which is use of the service.` : 'No cancellation request is on file before this charge.'}`

  const refusal = d.chargeRefunded
    ? 'The charge has already been refunded. No further credit is owed.'
    : refundAck
      ? `The client accepted refund policy version ${refundAck.version} on ${when(refundAck.acceptedAt)}: fees for service already rendered are not refunded. The ledger and invoices show the service was delivered.`
      : 'The Hub does not yet have a clickwrap record of the refund policy for this client. The ledger shows the service that was delivered. A refund was not issued because the service had been provided.'

  const narrative = (facts.narrative?.trim() || facts.template?.trim() || templateFor(d.reason, null)).trim()
  const repeat = client && client.disputeCount >= 2 ? `This client has ${client.disputeCount} disputes on file.` : ''
  const uncategorized = [narrative, repeat, `Packet prepared by Genisys Hub. Dispute ${d.id}. Reason ${d.reason}. Amount ${money(d.amountCents, d.currency)}.`].filter(Boolean).join('\n\n')

  const clickwrap = terms ? `Clickwrap ${ackLine(terms)}. The full text and hash are in the attached packet.` : ''
  const fields: Record<string, string> = {
    product_description: product,
    customer_name: person || name,
    customer_email_address: email ?? '',
    billing_address: address ?? '',
    customer_purchase_ip: ip ?? '',
    service_date: serviceDate ? serviceDate.slice(0, 10) : '',
    access_activity_log: [activity.join('\n'), clickwrap].filter(Boolean).join('\n'),
    refund_policy_disclosure: refundAck ? `Shown and accepted at ${refundAck.source} on ${when(refundAck.acceptedAt)}, version ${refundAck.version}, IP ${refundAck.ip ?? 'not recorded'}. ${REFUND_POLICY}` : '',
    cancellation_policy_disclosure: cancelAck ? `Shown and accepted at ${cancelAck.source} on ${when(cancelAck.acceptedAt)}, version ${cancelAck.version}, IP ${cancelAck.ip ?? 'not recorded'}. ${CANCELLATION_POLICY}` : '',
    cancellation_rebuttal: d.reason === 'subscription_canceled' ? rebuttal : '',
    refund_refusal_explanation: d.reason === 'product_unacceptable' || d.reason === 'credit_not_processed' ? refusal : '',
    duplicate_charge_explanation: d.reason === 'duplicate' ? narrative : '',
    uncategorized_text: [uncategorized, 'Service delivery timeline:', timeline, comms.length ? `Communications:\n${comms.join('\n')}` : '', invoices.length ? `Invoices:\n${invoices.join('\n')}` : ''].filter(Boolean).join('\n\n'),
  }
  if (recurring) {
    fields.uncategorized_text = `${fields.uncategorized_text}\n\nRecurring billing disclosure version ${recurring.version} accepted ${when(recurring.acceptedAt)} from IP ${recurring.ip ?? 'not recorded'}: ${RECURRING_DISCLOSURE}`
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
    accountId: null,
    productDescription: product,
    priors: facts.priors,
  })

  const sections: { heading: string; body: string }[] = [
    {
      heading: 'Cover',
      body: [
        `Dispute ${d.id}`,
        `Reason: ${d.reason}${d.cardBrand ? ` (${d.cardBrand})` : ''}`,
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
    { heading: 'Policies', body: [`Version ${TERMS_VERSION}`, '', 'Refund policy (included in the Stripe refund fields only when the client accepted it):', REFUND_POLICY, '', 'Cancellation policy (same rule):', CANCELLATION_POLICY, '', 'Recurring billing disclosure:', RECURRING_DISCLOSURE].join('\n') },
  ]
  if (ce3) {
    sections.push({
      heading: 'Visa Compelling Evidence 3.0',
      body: `Two prior undisputed charges qualify: ${ce3.prior.map((p) => p.charge).join(', ')}. Shared account id ${ce3.disputed.customerAccountId ?? '—'}, email ${ce3.disputed.customerEmail ?? '—'}, IP ${ce3.disputed.customerPurchaseIp ?? '—'}.`,
    })
  }

  return {
    fields,
    ce3,
    sections,
    ledgerHashes: facts.ledger.map((l) => l.contentHash),
    summary: `${name} · ${d.reason} · ${money(d.amountCents, d.currency)} · ${facts.ledger.length} ledger events`,
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
    put('[disputed_transaction][product_description]', o.ce3.disputed.productDescription)
    put('[disputed_transaction][merchandise_or_services]', 'services')
    o.ce3.prior.forEach((prior, i) => {
      const prefix = `[prior_undisputed_transactions][${i}]`
      p.set(`${base}${prefix}[charge]`, prior.charge)
      put(`${prefix}[customer_account_id]`, prior.customerAccountId)
      put(`${prefix}[customer_email_address]`, prior.customerEmail)
      put(`${prefix}[customer_purchase_ip]`, prior.customerPurchaseIp)
      put(`${prefix}[product_description]`, prior.productDescription)
      put(`${prefix}[merchandise_or_services]`, 'services')
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

export type ParsedAcceptance = { kind: AckKind; version: string; acceptedAt: string; ip: string | null; userAgent: string | null }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * The onboarding form may send:
 *   acceptance.terms / refundPolicy / cancellationPolicy / recurringBilling
 *   each { accepted, version, at, ip, userAgent }
 * Flat ip and userAgent on the body fill anything the block left blank.
 * A false or missing accepted flag is not an acceptance.
 */
export function parseAcceptance(body: unknown, receivedAt: string): ParsedAcceptance[] {
  if (!isRecord(body)) return []
  const answers = isRecord(body.answers) ? body.answers : body
  const block = isRecord(body.acceptance) ? body.acceptance : isRecord(answers.acceptance) ? answers.acceptance : {}
  const ip = str(body.ip) ?? str(body.customerIp) ?? str(answers.ip) ?? null
  const ua = str(body.userAgent) ?? str(body.user_agent) ?? str(answers.userAgent) ?? null
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
      version: str(row.version) ?? TERMS_VERSION,
      acceptedAt: Number.isNaN(parsed.getTime()) ? receivedAt : parsed.toISOString(),
      ip: str(row.ip) ?? ip,
      userAgent: str(row.userAgent) ?? str(row.user_agent) ?? ua,
    })
  }
  return out
}

export function acknowledgementHash(a: { kind: string; version: string; acceptedAt: string; ip: string | null; userAgent: string | null; email: string | null }): string {
  return sha256(canonicalJson(a))
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

/** A single IP address Stripe will accept in customer_purchase_ip. Lists and prose are dropped. */
export function customerIp(v: string | null | undefined): string | null {
  const first = (v ?? '').split(',')[0]?.trim() ?? ''
  if (!first || first.length > 45) return null
  if (ipv4ToInt(first) !== null) return first
  if (/^[0-9a-f:]+$/i.test(first) && first.includes(':')) return first
  return null
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
