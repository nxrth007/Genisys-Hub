import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsCache = new Map()

function loadTs(rel) {
  const absPath = rel.startsWith('/') ? rel : join(root, rel)
  if (tsCache.has(absPath)) return tsCache.get(absPath)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  tsCache.set(absPath, m.exports)
  const localRequire = createRequire(pathToFileURL(absPath))
  const req = (id) => {
    if (id.startsWith('.')) return loadTs(join(dirname(absPath), id.endsWith('.ts') ? id : `${id}.ts`))
    return localRequire(id)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  return m.exports
}

const plan = loadTs('src/lib/disputes/plan.ts')
const policies = loadTs('src/lib/disputes/policies.ts')
const pdf = loadTs('src/lib/disputes/pdf.ts')
const rateLimit = loadTs('src/lib/rate-limit.ts')

const client = (over = {}) => ({
  clientId: 'c1',
  name: 'Acme Roofing',
  emails: ['owner@acme.test'],
  phones: ['(512) 555-0100'],
  people: ['Maria Lopez'],
  businessNames: ['Acme Roofing LLC'],
  intakeIds: ['in1'],
  disputeCount: 0,
  ...over,
})

test('metadata match is exact when the email agrees, and weak when it belongs to someone else', () => {
  const agreed = plan.matchDispute(
    { email: 'owner@acme.test', phone: null, name: null, metadata: { hub_client_id: 'c1', hub_intake_id: 'in1' } },
    [client(), client({ clientId: 'c2', name: 'Other', emails: ['other@x.test'], intakeIds: [] })],
  )
  assert.equal(agreed.clientId, 'c1')
  assert.equal(agreed.intakeId, 'in1')
  assert.equal(agreed.method, 'metadata')
  assert.equal(agreed.confidence, 'exact')
  const conflict = plan.matchDispute(
    { email: 'other@x.test', phone: null, name: null, metadata: { hub_client_id: 'c1', hub_intake_id: 'in1' } },
    [client(), client({ clientId: 'c2', name: 'Other', emails: ['other@x.test'], intakeIds: [] })],
  )
  assert.equal(conflict.clientId, 'c1')
  assert.equal(conflict.confidence, 'weak')
})

test('email, phone, and a unique business name match; two phones do not guess', () => {
  assert.equal(plan.matchDispute({ email: 'Owner@Acme.test', phone: null, name: null, metadata: {} }, [client()]).method, 'email')
  assert.equal(plan.matchDispute({ email: null, phone: '+1 512-555-0100', name: null, metadata: {} }, [client()]).confidence, 'strong')
  assert.equal(plan.matchDispute({ email: null, phone: '5125550100', name: null, metadata: {} }, [client(), client({ clientId: 'c2', phones: ['5125550100'] })]).confidence, 'none')
  const byName = plan.matchDispute({ email: null, phone: null, name: 'Acme Roofing, LLC', metadata: {} }, [client()])
  assert.equal(byName.method, 'business_name')
  assert.equal(byName.confidence, 'weak')
  const repeat = plan.matchDispute({ email: 'owner@acme.test', phone: null, name: null, metadata: {} }, [client({ disputeCount: 2 })])
  assert.equal(repeat.repeatDisputer, true)
})

test('a dispute webhook is classified and a signup event is not', () => {
  const dispute = {
    id: 'evt_d',
    type: 'charge.dispute.created',
    livemode: false,
    data: { object: { id: 'dp_1', object: 'dispute', amount: 29700, currency: 'usd', reason: 'fraudulent', status: 'needs_response', charge: 'ch_1', evidence_details: { due_by: 1_800_000_000, submission_count: 0 } } },
  }
  const side = plan.classifyStripeSideEffect(dispute)
  assert.equal(side.kind, 'dispute')
  assert.equal(side.dispute.amountCents, 29700)
  assert.equal(side.dispute.reason, 'fraudulent')
  assert.equal(side.dispute.stripeSubmitted, false)
  assert.equal(side.dispute.respondable, true)
  const staged = plan.classifyStripeSideEffect({
    id: 'evt_staged',
    type: 'charge.dispute.updated',
    data: { object: { id: 'dp_2', object: 'dispute', reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: 1_800_000_000, has_evidence: true, submission_count: 0 } } },
  })
  assert.equal(staged.dispute.stripeSubmitted, false)
  const filed = plan.classifyStripeSideEffect({
    id: 'evt_filed',
    type: 'charge.dispute.updated',
    data: { object: { id: 'dp_3', object: 'dispute', reason: 'fraudulent', status: 'under_review', evidence_details: { due_by: 1_800_000_000, has_evidence: true, submission_count: 1 } } },
  })
  assert.equal(filed.dispute.stripeSubmitted, true)
  const closed = plan.readDispute({ id: 'dp_4', object: 'dispute', reason: 'general', status: 'needs_response', evidence_details: { due_by: 0, submission_count: 0 } })
  assert.equal(closed.respondable, false)
  assert.equal(closed.dueBy, null)
  assert.equal(plan.classifyStripeSideEffect({ id: 'evt_s', type: 'checkout.session.completed', data: { object: {} } }), null)
  assert.equal(plan.classifyStripeSideEffect({ id: 'evt_w', type: 'radar.early_fraud_warning.created', livemode: true, data: { object: { id: 'issfr_1', actionable: true, charge: 'ch_9', fraud_type: 'unauthorized_use_of_card' } } }).kind, 'early_fraud_warning')
})

test('dry-run never submits, a weak match never auto-submits, and the kill switch beats a saved live mode', () => {
  const base = { status: 'needs_response', dueBy: new Date(Date.now() + 3600_000).toISOString(), now: new Date().toISOString(), paused: false, narrativeEdited: false, alreadySubmitted: false, matchConfidence: 'exact' }
  const dry = plan.decideAction({ ...base, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'dry_run' }) })
  assert.equal(dry.action, 'compile_only')
  assert.equal(dry.stripeSubmit, false)
  const live = plan.decideAction({ ...base, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live', DISPUTE_SUBMIT_LEAD_HOURS: '48' }) })
  assert.equal(live.stripeSubmit, true)
  const early = plan.decideAction({ ...base, dueBy: new Date(Date.now() + 10 * 86400_000).toISOString(), config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live' }) })
  assert.equal(early.action, 'stage')
  const weak = plan.decideAction({ ...base, matchConfidence: 'weak', config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live' }) })
  assert.equal(weak.action, 'compile_only')
  assert.equal(weak.stripeSubmit, false)
  const past = plan.decideAction({ ...base, dueBy: new Date(Date.now() - 3600_000).toISOString(), config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live' }) })
  assert.equal(past.action, 'compile_only')
  assert.equal(past.stripeSubmit, false)
  const stage = plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'stage' })
  assert.equal(plan.decideManualSubmit(stage).ok, false)
  assert.equal(plan.decideManualSubmit(plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live' })).ok, true)
  assert.equal(plan.allowsStripeWrite(plan.parseDisputeConfig({})), false)
  assert.equal(plan.allowsStripeWrite(stage), true)
  assert.equal(plan.allowsStripeWrite(plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live', DISPUTE_DEFENSE_FORCE_DRY_RUN: '1' })), false)
  const paused = plan.decideAction({ ...base, paused: true, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live' }) })
  assert.equal(paused.stripeSubmit, false)
  const edited = plan.decideAction({ ...base, narrativeEdited: true, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live' }) })
  assert.equal(edited.stripeSubmit, false)
  const forced = plan.parseDisputeConfig({ DISPUTE_DEFENSE_FORCE_DRY_RUN: '1' }, { mode: 'live' })
  assert.equal(forced.mode, 'dry_run')
  assert.equal(plan.decideManualSubmit(forced).ok, false)
  assert.equal(plan.decideEfwRefund({ config: plan.parseDisputeConfig({}), actionable: true, livemode: true }).refund, false)
  assert.equal(plan.decideEfwRefund({ config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live', DISPUTE_EFW_REFUND: '1' }), actionable: true, livemode: true }).refund, true)
})

test('Visa CE 3.0 needs purchase IP plus the same email, and does not treat email plus an internal account id as enough', () => {
  const chargedAt = '2026-11-01T00:00:00.000Z'
  const day = 86400_000
  const ip = '203.0.113.9'
  const prior = (id, daysAgo, over = {}) => ({
    id, amountCents: 29700, created: new Date(new Date(chargedAt).getTime() - daysAgo * day).toISOString(),
    paid: true, disputed: false, refunded: false, email: 'owner@acme.test', ip, accountId: 'c1', ...over,
  })
  const ok = plan.selectCompellingEvidence({
    reason: 'fraudulent', cardBrand: 'visa', networkReasonCode: '10.4', chargedAt, email: 'owner@acme.test', ip, accountId: 'c1', productDescription: 'service',
    priors: [prior('ch_a', 200), prior('ch_b', 300), prior('ch_recent', 10), prior('ch_old', 400), prior('ch_refunded', 220, { refunded: true }), prior('ch_other', 220, { email: 'someone@else.test' })],
  })
  assert.deepEqual(ok.prior.map((p) => p.charge), ['ch_a', 'ch_b'])
  assert.equal(ok.prior[0].customerEmail, 'owner@acme.test')
  assert.equal(ok.prior[0].customerPurchaseIp, ip)
  assert.equal(ok.disputed.customerAccountId, null)
  const emailOnly = plan.selectCompellingEvidence({
    reason: 'fraudulent', cardBrand: 'visa', chargedAt, email: 'owner@acme.test', ip: null, accountId: 'c1', productDescription: 'service',
    priors: [prior('ch_a', 200, { ip: null }), prior('ch_b', 300, { ip: null })],
  })
  assert.equal(emailOnly, null)
  assert.equal(plan.selectCompellingEvidence({ reason: 'product_not_received', cardBrand: 'visa', chargedAt, email: 'owner@acme.test', ip, accountId: 'c1', productDescription: 's', priors: [prior('ch_a', 200), prior('ch_b', 300)] }), null)
  assert.equal(plan.selectCompellingEvidence({ reason: 'fraudulent', cardBrand: 'mastercard', chargedAt, email: 'owner@acme.test', ip, accountId: 'c1', productDescription: 's', priors: [prior('ch_a', 200), prior('ch_b', 300)] }), null)
  assert.equal(plan.selectCompellingEvidence({ reason: 'fraudulent', cardBrand: 'visa', networkReasonCode: '13.1', chargedAt, email: 'owner@acme.test', ip, accountId: 'c1', productDescription: 's', priors: [prior('ch_a', 200), prior('ch_b', 300)] }), null)
})

test('the service delivery timeline leads the packet and leads are supporting', () => {
  const facts = {
    dispute: { id: 'dp_1', reason: 'product_not_received', status: 'needs_response', amountCents: 29700, currency: 'usd', dueBy: null, chargedAt: '2026-10-01T00:00:00.000Z', cardBrand: 'visa', email: 'owner@acme.test', name: 'Acme', phone: null, billingAddress: null, purchaseIp: null, chargeRefunded: false },
    client: { id: 'c1', name: 'Acme Roofing', email: 'owner@acme.test', phone: null, address: '1 Main', packageName: 'pro', serviceStart: '2026-09-01T00:00:00.000Z', website: 'https://acme.test', disputeCount: 0 },
    intake: null,
    acknowledgements: [{ kind: 'terms', version: '2026-11-19', acceptedAt: '2026-09-01T00:00:00.000Z', ip: '203.0.113.8', userAgent: 'Mozilla/5.0', source: 'intake', contentHash: 'abc' }],
    ledger: [
      { kind: 'lead', title: 'Lead delivered: Sam', detail: null, occurredAt: '2026-10-02T00:00:00.000Z', contentHash: 'hlead' },
      { kind: 'setup_site', title: 'Website live', detail: 'https://acme.test — HTTP 200', occurredAt: '2026-09-02T00:00:00.000Z', contentHash: 'hsite' },
      { kind: 'client_report', title: 'Client report emailed to owner@acme.test', detail: 'Snapshot abc', occurredAt: '2026-10-15T00:00:00.000Z', contentHash: 'hrep' },
      { kind: 'login', title: 'Dashboard login (owner@acme.test)', detail: 'The password is not stored.', occurredAt: '2026-10-16T00:00:00.000Z', contentHash: 'hlog' },
    ],
    emails: [],
    receipts: [{ channel: 'email', kind: 'report', to: 'owner@acme.test', sentAt: '2026-10-15T00:00:00.000Z', deliveredAt: null, openedAt: '2026-10-15T01:00:00.000Z', subject: 'your last 30 days' }],
    invoices: [],
    logins: [],
    priors: [],
    narrative: null,
    template: null,
  }
  const built = plan.buildEvidence(facts)
  assert.match(built.fields.uncategorized_text, /Website live/)
  assert.match(built.fields.uncategorized_text, /Client report emailed/)
  assert.match(built.fields.uncategorized_text, /Dashboard login/)
  assert.equal(built.fields.uncategorized_text.includes('Lead delivered'), false)
  assert.equal(built.fields.service_documentation, undefined)
  assert.equal(built.fields.receipt, undefined)
  assert.equal(built.fields.customer_communication, undefined)
  assert.equal(built.fields.refund_policy, undefined)
  assert.equal(built.fields.cancellation_policy, undefined)
  assert.equal(built.fields.customer_signature, undefined)
  const timeline = built.sections.find((s) => s.heading === 'Service delivery timeline')
  const leads = built.sections.find((s) => s.heading === 'Leads and appointments (supporting)')
  assert.ok(timeline.body.includes('HTTP 200'))
  assert.ok(leads.body.includes('Lead delivered'))
  assert.ok(built.sections.findIndex((s) => s.heading === 'Service delivery timeline') < built.sections.findIndex((s) => s.heading === 'Leads and appointments (supporting)'))
  assert.match(built.fields.customer_purchase_ip, /203\.0\.113\.8/)
  const form = plan.evidenceFormBody({ fields: { ...built.fields, service_documentation: 'Website live is not a file id', receipt: 'prose' }, files: { uncategorized_file: 'file_1', not_a_field: 'file_x' }, ce3: null, submit: false })
  assert.match(form, /submit=false/)
  assert.match(form, /uncategorized_file/)
  assert.doesNotMatch(form, /submit=true/)
  assert.doesNotMatch(form, /service_documentation/)
  assert.doesNotMatch(form, /not a file id/)
  assert.doesNotMatch(form, /not_a_field/)
})

test('acceptance parsing, hashes, win/loss, file budget, and redaction', () => {
  const acks = plan.parseAcceptance({
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0',
    acceptance: {
      terms: { accepted: true, version: '2026-11-19', at: '2026-11-19T12:00:00.000Z' },
      refundPolicy: { accepted: true, version: '2026-11-19', at: '2026-11-19T12:00:00.000Z' },
      recurringBilling: { accepted: false },
    },
  }, '2026-11-19T12:00:00.000Z')
  assert.deepEqual(acks.map((a) => a.kind), ['terms', 'refund_policy'])
  assert.equal(acks[0].ip, '203.0.113.5')
  const h1 = plan.chainHash('genesis', { a: 1 })
  const h2 = plan.chainHash(h1, { a: 2 })
  assert.equal(plan.verifyChain([{ prevHash: 'genesis', contentHash: h1, body: { a: 1 } }, { prevHash: h1, contentHash: h2, body: { a: 2 } }]).ok, true)
  assert.equal(plan.verifyChain([{ prevHash: 'genesis', contentHash: h1, body: { a: 9 } }]).ok, false)
  const outcomes = plan.summarizeOutcomes([{ reason: 'fraudulent', status: 'won', amountCents: 100 }, { reason: 'fraudulent', status: 'lost', amountCents: 50 }, { reason: 'general', status: 'needs_response', amountCents: 10 }])
  assert.equal(outcomes.byReason.find((r) => r.reason === 'fraudulent').winRate, 0.5)
  assert.equal(outcomes.totals.open, 1)
  const budget = plan.budgetFiles(1000, [{ bytes: 5_000_000 }, { bytes: 1000 }])
  assert.deepEqual(budget.keep, [false, true])
  assert.match(plan.redactSecrets('key rk_live_abc123 whsec_xyz'), /\[redacted-key\].*\[redacted-secret\]/)
  const stored = plan.redactCredentialLinks('<a href="https://hub.example/login/password?u=user&t=super-secret-token">set</a>')
  assert.equal(stored.includes('super-secret-token'), false)
  assert.match(stored, /not-stored/)
  const escaped = plan.redactCredentialLinks('<a href="https://hub.example/login/password?u=user&amp;t=super-secret-token">set</a><img src="https://genisys-hub.onrender.com/api/public/receipts/abc123deadbeef">')
  assert.equal(escaped.includes('super-secret-token'), false)
  assert.equal(escaped.includes('abc123deadbeef'), false)
  assert.equal(plan.customerIp('203.0.113.8, 10.0.0.1'), '203.0.113.8')
  assert.equal(plan.customerIp('not an ip'), null)
  assert.equal(plan.isPublicEvidenceUrl('https://acme.example'), true)
  assert.equal(plan.isPublicEvidenceUrl('http://127.0.0.1/latest/meta-data'), false)
  assert.equal(plan.isPublicEvidenceUrl('https://169.254.169.254/'), false)
  assert.equal(plan.isPublicEvidenceUrl('http://localhost/admin'), false)
  assert.equal(plan.isPublicIp('10.1.2.3'), false)
  assert.equal(plan.isPublicIp('8.8.8.8'), true)
})

test('the packet PDF is a real PDF under the size cap and names the timeline', () => {
  const bytes = pdf.renderEvidencePdf([
    { heading: 'Service delivery timeline', body: 'Website live — https://acme.test HTTP 200\nClient report emailed' },
    { heading: 'Cover', body: 'Dispute dp_1' },
  ])
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  assert.ok(bytes.includes(Buffer.from('Service delivery timeline')))
  const draftPdf = pdf.renderEvidencePdf([{ heading: 'Policies', body: 'DRAFT \u2014 pending legal review' }])
  assert.ok(draftPdf.includes(Buffer.from('DRAFT')))
  assert.equal(draftPdf.includes(Buffer.from('?')), false)
  assert.ok(draftPdf.includes(Buffer.from('\\227')))
  assert.ok(draftPdf.includes(Buffer.from('/Encoding /WinAnsiEncoding')))
  const longUrl = 'https://acme.example/' + 'path-segment/'.repeat(20) + 'end'
  const longPdf = pdf.renderEvidencePdf([{ heading: 'Service delivery timeline', body: `Website live — ${longUrl}` }])
  assert.ok(longPdf.includes(Buffer.from('path-segment/path-segment')))
  assert.ok(longPdf.includes(Buffer.from('end')))
  assert.ok(bytes.length < plan.MAX_COMBINED_FILE_BYTES)
})

test('the defense uses the restricted key and the webhook route is public', () => {
  const stripe = readFileSync(join(root, 'src/lib/disputes/stripe.ts'), 'utf8')
  const run = readFileSync(join(root, 'src/lib/disputes/run.ts'), 'utf8')
  const middleware = readFileSync(join(root, 'src/middleware.ts'), 'utf8')
  assert.match(stripe, /DISPUTE_KEY_ENTRY/)
  assert.match(stripe, /LEGACY_STRIPE_KEY_ENTRY/)
  assert.doesNotMatch(stripe, /firstSecret\(\[[^\]]*Stripe API Key/)
  assert.match(run, /allowsStripeWrite/)
  assert.match(stripe, /refusing a dispute update that does not set submit explicitly/)
  assert.doesNotMatch(run, /screenshotFor/)
  assert.match(middleware, /\/api\/webhooks\/stripe/)
  assert.equal(plan.DISPUTE_KEY_ENTRY, 'Stripe Official Restricted')
  assert.equal(plan.LEGACY_STRIPE_KEY_ENTRY, 'Stripe API Key')
  assert.ok(plan.DISPUTE_WEBHOOK_EVENTS.includes('charge.dispute.created'))
  assert.ok(plan.DISPUTE_WEBHOOK_EVENTS.includes('radar.early_fraud_warning.created'))
})

test('network reason codes pick the narrative and the emphasis', () => {
  assert.match(plan.templateFor('product_not_received', null, '13.1'), /Visa 13\.1/)
  assert.match(plan.templateFor('fraudulent', null, '10.4'), /Visa 10\.4/)
  assert.match(plan.templateFor('general', null, '4855'), /Mastercard 4855/)
  assert.match(plan.templateFor('general', null, 'f29'), /F29/)
  assert.equal(plan.disputeEmphasis('product_not_received', '13.1').emphasis, 'not_received')
  assert.equal(plan.disputeEmphasis('fraudulent', '10.4').emphasis, 'fraud')
  assert.equal(plan.disputeEmphasis('subscription_canceled', null).emphasis, 'canceled')
  const facts = {
    dispute: { id: 'dp_1', reason: 'product_not_received', status: 'needs_response', amountCents: 29700, currency: 'usd', dueBy: null, chargedAt: '2026-10-01T00:00:00.000Z', cardBrand: 'visa', networkReasonCode: '13.1', email: 'owner@acme.test', name: 'Acme', phone: null, billingAddress: null, purchaseIp: '203.0.113.8', purchaseUa: 'Mozilla/5.0', deviceId: null, chargeRefunded: false },
    client: { id: 'c1', name: 'Acme Roofing', email: 'owner@acme.test', phone: null, address: null, packageName: null, serviceStart: null, website: null, disputeCount: 0 },
    intake: null,
    acknowledgements: [],
    ledger: [{ kind: 'setup_site', title: 'Website live', detail: 'https://acme.test — HTTP 200', occurredAt: '2026-09-02T00:00:00.000Z', contentHash: 'h' }],
    emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  }
  const notReceived = plan.buildEvidence(facts)
  assert.match(notReceived.fields.uncategorized_text, /^Service delivery timeline:/)
  assert.match(notReceived.fields.uncategorized_text, /Visa 13\.1/)
  assert.equal(notReceived.sections[1].heading, 'Service delivery timeline')
  const fraud = plan.buildEvidence({ ...facts, dispute: { ...facts.dispute, reason: 'fraudulent', networkReasonCode: '10.4' } })
  assert.match(fraud.fields.uncategorized_text, /^Purchase IP recorded at checkout: 203\.0\.113\.8/)
  assert.match(fraud.fields.customer_purchase_ip, /203\.0\.113\.8/)
  assert.equal(fraud.sections[1].heading, 'Checkout purchase')
})

test('an inquiry is flagged and not auto-submitted unless the policy is fight', () => {
  const base = { status: 'warning_needs_response', dueBy: new Date(Date.now() + 3600_000).toISOString(), now: new Date().toISOString(), paused: false, narrativeEdited: false, alreadySubmitted: false, matchConfidence: 'exact' }
  const flagged = plan.decideAction({ ...base, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live' }) })
  assert.equal(flagged.action, 'compile_only')
  assert.equal(flagged.stripeSubmit, false)
  const fight = plan.decideAction({ ...base, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live', DISPUTE_INQUIRY_POLICY: 'fight' }) })
  assert.equal(fight.stripeSubmit, true)
  assert.equal(plan.parseDisputeConfig({}).inquiryPolicy, 'flag')
  const killed = plan.decideAction({ ...base, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'live', DISPUTE_INQUIRY_POLICY: 'fight', DISPUTE_DEFENSE_FORCE_DRY_RUN: '1' }) })
  assert.equal(killed.action, 'compile_only')
  assert.equal(killed.stripeSubmit, false)
  const dryFight = plan.decideAction({ ...base, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'dry_run', DISPUTE_INQUIRY_POLICY: 'fight' }) })
  assert.equal(dryFight.action, 'compile_only')
  assert.equal(dryFight.stripeSubmit, false)
  const stageFight = plan.decideAction({ ...base, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'stage', DISPUTE_INQUIRY_POLICY: 'fight' }) })
  assert.equal(stageFight.action, 'stage')
  assert.equal(stageFight.stripeSubmit, false)
  const stageFlag = plan.decideAction({ ...base, config: plan.parseDisputeConfig({ DISPUTE_DEFENSE_MODE: 'stage' }) })
  assert.equal(stageFlag.action, 'compile_only')
  assert.equal(stageFlag.stripeSubmit, false)
})

test('purchase signals and the acceptance contract', () => {
  const signals = plan.parsePurchaseSignals({
    purchase: { ip: '203.0.113.10', userAgent: 'Mozilla/5.0', deviceId: 'short' },
    metadata: { hub_purchase_ip: '198.51.100.8' },
  })
  assert.equal(signals.ip, '203.0.113.10')
  assert.equal(signals.userAgent, 'Mozilla/5.0')
  assert.equal(signals.deviceId, null)
  const fromStripe = plan.parsePurchaseSignals({ metadata: { hub_purchase_ip: '198.51.100.8', hub_purchase_ua: 'Stripe UA', hub_device_id: 'A1B2C3D4E5F60718' } })
  assert.equal(fromStripe.ip, '198.51.100.8')
  assert.equal(fromStripe.deviceId, 'A1B2C3D4E5F60718')
  const hash = 'ab'.repeat(32)
  const acks = plan.parseAcceptance({
    acceptance: {
      terms: { accepted: true, version: '2026-11-19', at: '2026-11-19T18:04:00.000Z', ip: '203.0.113.10', userAgent: 'Mozilla/5.0', textHash: hash, textUrl: 'https://leadgenisys.com/terms' },
      refundPolicy: { accepted: true, version: '2026-11-19', at: '2026-11-19T18:04:00.000Z', textHash: 'nope', textUrl: 'javascript:alert(1)' },
    },
  }, '2026-11-19T18:04:00.000Z')
  assert.equal(acks[0].textHash, hash)
  assert.equal(acks[0].textUrl, 'https://leadgenisys.com/terms')
  assert.equal(acks[1].textHash, null)
  assert.equal(acks[1].textUrl, null)
  const facts = {
    dispute: { id: 'dp_1', reason: 'subscription_canceled', status: 'needs_response', amountCents: 100, currency: 'usd', dueBy: null, chargedAt: null, cardBrand: 'visa', networkReasonCode: '13.2', email: null, name: null, phone: null, billingAddress: null, purchaseIp: null, purchaseUa: null, deviceId: null, chargeRefunded: false },
    client: null, intake: null,
    acknowledgements: [{ kind: 'terms', version: '2026-11-19', acceptedAt: '2026-11-19T18:04:00.000Z', ip: '203.0.113.10', userAgent: 'Mozilla/5.0', source: 'intake', textHash: hash, textUrl: 'https://leadgenisys.com/terms' }, { kind: 'cancellation_policy', version: '2026-11-19', acceptedAt: '2026-11-19T18:04:00.000Z', ip: '203.0.113.10', userAgent: 'Mozilla/5.0', source: 'intake', textHash: hash, textUrl: 'https://leadgenisys.com/cancellation' }],
    ledger: [], emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  }
  const built = plan.buildEvidence(facts)
  assert.equal(built.fields.customer_signature, undefined)
  assert.ok(built.signatureSections)
  assert.match(built.signatureSections[0].body, new RegExp(hash))
  assert.match(built.fields.cancellation_policy_disclosure, /sha256/)
  assert.match(built.fields.cancellation_rebuttal, /cancellation policy/)
  const form = plan.evidenceFormBody({ fields: built.fields, files: { customer_signature: 'file_sig', uncategorized_file: 'file_pdf' }, ce3: null, submit: false })
  assert.match(form, /customer_signature/)
  assert.match(form, /file_sig/)
  assert.doesNotMatch(form, /submit=true/)
})

test('Render client IP prefers Cloudflare and otherwise the first X-Forwarded-For hop', () => {
  const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null })
  assert.equal(rateLimit.clientIp({ headers: headers({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }) }), '203.0.113.9')
  assert.equal(rateLimit.clientIp({ headers: headers({ 'x-forwarded-for': '203.0.113.8, 10.0.0.1' }) }), '203.0.113.8')
  assert.equal(rateLimit.clientIp({ headers: headers({ 'x-forwarded-for': 'not-an-ip, 198.51.100.4' }) }), '198.51.100.4')
  assert.equal(rateLimit.clientIp({ headers: headers({}) }), 'unknown')
  assert.equal(rateLimit.clientIp({ headers: headers({ 'true-client-ip': '198.51.100.9', 'x-forwarded-for': '203.0.113.8' }) }), '203.0.113.8')
  assert.equal(rateLimit.clientIp({ headers: headers({ 'cf-connecting-ip': '::::', 'true-client-ip': '198.51.100.9', 'x-forwarded-for': '203.0.113.8' }) }), '203.0.113.8')
})

test('Amex reason codes follow the network definitions', () => {
  assert.equal(plan.disputeEmphasis('general', 'C08').emphasis, 'not_received')
  assert.equal(plan.disputeEmphasis('general', 'C31').emphasis, 'not_as_described')
  assert.equal(plan.disputeEmphasis('general', 'C04').emphasis, 'credit')
  assert.equal(plan.disputeEmphasis('general', 'C05').emphasis, 'canceled')
  assert.match(plan.templateFor('general', null, 'c08'), /not received/i)
  assert.match(plan.templateFor('general', null, 'C31'), /not as described/i)
  assert.match(plan.templateFor('general', null, 'C04'), /returned or refused/i)
  const facts = {
    dispute: { id: 'dp_1', reason: 'general', status: 'needs_response', amountCents: 100, currency: 'usd', dueBy: null, chargedAt: '2026-10-01T00:00:00.000Z', cardBrand: 'amex', networkReasonCode: 'C08', email: null, name: null, phone: null, billingAddress: null, purchaseIp: null, purchaseUa: null, deviceId: null, chargeRefunded: false },
    client: null, intake: null, acknowledgements: [], ledger: [{ kind: 'setup_site', title: 'Website live', detail: null, occurredAt: '2026-09-02T00:00:00.000Z', contentHash: 'h' }],
    emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  }
  const notReceived = plan.buildEvidence(facts)
  assert.match(notReceived.fields.uncategorized_text, /^Service delivery timeline:/)
  assert.equal(notReceived.fields.refund_refusal_explanation, undefined)
  assert.equal(notReceived.fields.cancellation_rebuttal, undefined)
  const described = plan.buildEvidence({ ...facts, dispute: { ...facts.dispute, networkReasonCode: 'C31' } })
  assert.ok(described.fields.refund_refusal_explanation)
  assert.equal(described.fields.cancellation_rebuttal, undefined)
  const returned = plan.buildEvidence({ ...facts, dispute: { ...facts.dispute, networkReasonCode: 'C04' } })
  assert.ok(returned.fields.refund_refusal_explanation)
  assert.equal(returned.fields.cancellation_rebuttal, undefined)
})

test('Visa CE 3.0 requires the same elements on all three charges and the same card', () => {
  const chargedAt = '2026-11-01T00:00:00.000Z'
  const day = 86400_000
  const ip = '203.0.113.9'
  const device = 'A1B2C3D4E5F60718'
  const prior = (id, daysAgo, over = {}) => ({
    id, amountCents: 29700, created: new Date(new Date(chargedAt).getTime() - daysAgo * day).toISOString(),
    paid: true, disputed: false, refunded: false, email: 'owner@acme.test', ip: null, deviceId: null, accountId: null, fingerprint: 'fpSameCard1', ...over,
  })
  const base = {
    reason: 'fraudulent', cardBrand: 'visa', networkReasonCode: '10.4', chargedAt, email: 'owner@acme.test', ip, deviceId: device, fingerprint: 'fpSameCard1', accountId: null, productDescription: 'service',
  }
  const mixed = plan.selectCompellingEvidence({
    ...base,
    priors: [prior('ch_ip', 200, { ip }), prior('ch_dev', 220, { deviceId: device })],
  })
  assert.equal(mixed, null)
  const shared = plan.selectCompellingEvidence({
    ...base,
    priors: [
      prior('ch_ip', 200, { ip }),
      prior('ch_dev', 220, { deviceId: device }),
      prior('ch_both_a', 240, { ip, deviceId: device }),
      prior('ch_both_b', 260, { ip, deviceId: device }),
    ],
  })
  assert.deepEqual(shared.prior.map((p) => p.charge), ['ch_ip', 'ch_both_a'])
  assert.equal(shared.disputed.customerPurchaseIp, ip)
  assert.equal(shared.disputed.customerDeviceId, null)
  assert.equal(shared.prior[0].customerDeviceId, null)
  assert.equal(shared.prior[1].customerPurchaseIp, ip)
  const both = plan.selectCompellingEvidence({
    ...base,
    priors: [prior('ch_both_a', 240, { ip, deviceId: device }), prior('ch_both_b', 260, { ip, deviceId: device })],
  })
  assert.equal(both.disputed.customerDeviceId, device)
  assert.equal(both.prior[0].customerDeviceId, device)
  assert.equal(both.prior[1].customerDeviceId, device)
  const otherCard = plan.selectCompellingEvidence({
    ...base,
    priors: [prior('ch_a', 200, { ip, fingerprint: 'otherCard99' }), prior('ch_b', 300, { ip, fingerprint: 'otherCard99' })],
  })
  assert.equal(otherCard, null)
  const read = plan.readCharge({
    id: 'ch_a', amount: 29700, created: 1_700_000_000, paid: true, disputed: false, refunded: false,
    billing_details: { email: 'owner@acme.test' },
    metadata: { hub_purchase_ip: ip, hub_device_id: device },
    payment_method_details: { card: { fingerprint: 'fpSameCard1' } },
  }, null)
  assert.equal(read.fingerprint, 'fpSameCard1')
  assert.equal(read.ip, ip)
})

test('intake fields cannot inject a line, a private IP, or a secret into the packet', () => {
  assert.equal(plan.customerIp('::::'), null)
  assert.equal(plan.customerIp('10.0.0.1'), null)
  assert.equal(plan.customerIp('127.0.0.1'), null)
  assert.equal(plan.customerIp('203.0.113.8'), '203.0.113.8')
  const nastyUa = 'Mozilla/5.0\n2020-01-01  login admin admitted the charge'
  const signals = plan.parsePurchaseSignals({
    purchase: { ip: '10.1.1.1', userAgent: nastyUa, deviceId: 'A1B2C3D4E5F60718\nEVIL' },
  })
  assert.equal(signals.ip, null)
  assert.equal(signals.deviceId, null)
  assert.equal(signals.userAgent.includes('\n'), false)
  assert.match(signals.userAgent, /^Mozilla\/5.0 2020-01-01/)
  const hash = 'ab'.repeat(32)
  const acks = plan.parseAcceptance({
    acceptance: {
      terms: {
        accepted: true,
        version: '2026-11-19\nRule for the merchant',
        at: '2026-11-19T18:04:00.000Z',
        ip: '::::',
        userAgent: nastyUa,
        textHash: hash,
        textUrl: 'https://user:secret@leadgenisys.com/terms',
      },
    },
  }, '2026-11-19T18:04:00.000Z')
  assert.equal(acks[0].version.includes('\n'), false)
  assert.equal(acks[0].version.startsWith('2026-11-19'), true)
  assert.ok(acks[0].version.length <= 64)
  assert.equal(acks[0].ip, null)
  assert.equal(acks[0].textUrl, null)
  assert.equal(acks[0].userAgent.includes('\n'), false)
  const picked = plan.pickPurchaseSignals([
    { ip: '203.0.113.10', userAgent: null, deviceId: null },
    { ip: null, userAgent: null, deviceId: 'A1B2C3D4E5F60718' },
  ])
  assert.equal(picked.ip, '203.0.113.10')
  assert.equal(picked.deviceId, null)
  const facts = {
    dispute: { id: 'dp_1', reason: 'fraudulent', status: 'needs_response', amountCents: 100, currency: 'usd', dueBy: null, chargedAt: null, cardBrand: 'visa', networkReasonCode: '10.4', email: null, name: null, phone: null, billingAddress: null, purchaseIp: null, purchaseUa: nastyUa, deviceId: 'bad id', chargeRefunded: false },
    client: null, intake: null,
    acknowledgements: acks.map((a) => ({ ...a, source: 'intake' })),
    ledger: [], emails: [], receipts: [], invoices: [], logins: [{ at: '2026-11-19T18:04:00.000Z', email: 'owner@acme.test', ip: '203.0.113.8', userAgent: nastyUa, kind: 'login' }],
    priors: [], narrative: null, template: null,
  }
  const built = plan.buildEvidence(facts)
  assert.equal(built.fields.uncategorized_text.includes('\n2020-01-01'), false)
  assert.equal(built.fields.access_activity_log.includes('secret'), false)
  assert.equal(built.fields.access_activity_log.includes('\n2020-01-01'), false)
  assert.equal(built.signatureSections[0].body.includes('secret'), false)
  assert.equal(built.signatureSections[0].body.includes('\nRule for the merchant'), false)
})

test('dispute policy text matches the onboarding pages and is quoted only for the hashed edition', () => {
  assert.equal(plan.parseDisputeConfig({}).mode, 'dry_run')
  assert.equal(policies.POLICY_CONTACT_EMAIL, 'ethan@leadgenisys.com')
  assert.equal(policies.BILLING_SUMMARY, '$0 due today on the 30-day free trial, then $297 per month.')
  assert.equal(policies.currentPolicy('terms').version, '2026-08-06')
  assert.equal(policies.currentPolicy('terms').draft, false)
  assert.equal(policies.currentPolicy('refund_policy').version, '2026-11-19')
  assert.equal(policies.currentPolicy('refund_policy').draft, true)
  const forbidden = /alex@leadgenisys\.com|before the next renewal|customer portal|pay-per-appointment|cancel anytime|plan price|unless a different price/i
  for (const edition of policies.POLICY_EDITIONS) {
    assert.equal(edition.textHash, policies.policyTextHash(edition.text))
    assert.equal(edition.textUrl, `https://clientonboarding.leadgenisys.com${edition.path}`)
    assert.doesNotMatch(edition.summary, forbidden)
    assert.doesNotMatch(edition.text, /alex@leadgenisys\.com/)
    if (!edition.text.includes('ethan@leadgenisys.com')) assert.doesNotMatch(edition.summary, /ethan@leadgenisys\.com/)
    if (!edition.text.includes('30 days written notice')) assert.doesNotMatch(edition.summary, /30 days written notice/)
    if (!/section 10/i.test(edition.text)) assert.doesNotMatch(edition.summary, /section 10/i)
    if (edition.kind !== 'terms') assert.doesNotMatch(edition.text, /cancel at any time/i)
  }
  const refund = policies.currentPolicy('refund_policy')
  assert.match(refund.text, /\$0 is due today/)
  assert.match(refund.text, /Cancel within 30 days and you pay nothing/)
  assert.match(refund.text, /non-refundable once work has commenced/)
  assert.match(refund.summary, /\$0 is due today/)
  assert.match(refund.summary, /Cancel within 30 days and you pay nothing/)
  const cancel = policies.currentPolicy('cancellation_policy')
  assert.match(cancel.text, /30 days written notice/)
  assert.match(cancel.text, /ethan@leadgenisys\.com/)
  assert.match(cancel.summary, /30 days written notice/)
  assert.match(cancel.summary, /ethan@leadgenisys\.com/)
  assert.match(cancel.summary, /Cancel within 30 days of signup and you pay nothing/)
  const recur = policies.currentPolicy('recurring_billing')
  assert.match(recur.text, /\$297 per month/)
  assert.equal(recur.text.includes(policies.BILLING_SUMMARY), true)
  assert.match(recur.summary, /\$297 per month/)
  assert.match(recur.summary, /section 5 of the Terms of Service/)
  assert.doesNotMatch(recur.summary, /section 10/i)
  assert.doesNotMatch(recur.summary, /ethan@leadgenisys\.com/)
  assert.doesNotMatch(recur.summary, /30 days written notice/)
  assert.match(policies.currentPolicy('terms').text, /30 days written notice/)
  assert.match(policies.currentPolicy('terms').text, /You can cancel the SMS service at any time/)
  assert.doesNotMatch(policies.currentPolicy('terms').summary, /not cancellation of the subscription/)
  assert.doesNotMatch(policies.PRODUCT_DESCRIPTION, forbidden)
  assert.match(policies.PRODUCT_DESCRIPTION, /\$0 due today/)
  assert.match(policies.PRODUCT_DESCRIPTION, /\$297 per month/)
  assert.match(policies.PRODUCT_DESCRIPTION, /30 days written notice to ethan@leadgenisys\.com/)
  assert.match(policies.PRODUCT_DESCRIPTION, /Cancel within 30 days of signup and you pay nothing/)
  assert.equal(plan.PRODUCT_DESCRIPTION, policies.PRODUCT_DESCRIPTION)

  const baseDispute = {
    id: 'dp_1', reason: 'subscription_canceled', status: 'needs_response', amountCents: 29700, currency: 'usd',
    dueBy: null, chargedAt: '2026-10-01T00:00:00.000Z', cardBrand: 'visa', networkReasonCode: '13.2',
    email: 'owner@acme.test', name: 'Acme', phone: null, billingAddress: null, purchaseIp: null, purchaseUa: null,
    deviceId: null, chargeRefunded: false,
  }
  const ack = (kind, edition, over = {}) => ({
    kind, version: edition.version, acceptedAt: '2026-11-19T18:04:00.000Z', ip: '203.0.113.10',
    userAgent: 'Mozilla/5.0', source: 'intake', textHash: edition.textHash, textUrl: edition.textUrl, ...over,
  })
  const matched = plan.buildEvidence({
    dispute: baseDispute, client: null, intake: null,
    acknowledgements: [ack('cancellation_policy', cancel), ack('refund_policy', refund), ack('recurring_billing', recur)],
    ledger: [], emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  })
  assert.match(matched.fields.cancellation_policy_disclosure, new RegExp(cancel.textHash))
  assert.match(matched.fields.cancellation_policy_disclosure, /https:\/\/clientonboarding\.leadgenisys\.com\/cancellation-policy/)
  assert.match(matched.fields.cancellation_policy_disclosure, /version 2026-11-19/)
  assert.match(matched.fields.cancellation_policy_disclosure, /30 days written notice/)
  assert.match(matched.fields.cancellation_policy_disclosure, /ethan@leadgenisys\.com/)
  assert.match(matched.fields.cancellation_policy_disclosure, /draft/i)
  assert.match(matched.fields.cancellation_rebuttal, /30 days written notice/)
  assert.match(matched.fields.refund_policy_disclosure, /\$0 is due today/)
  assert.match(matched.fields.uncategorized_text, /\$297 per month/)
  assert.match(matched.fields.uncategorized_text, /section 5 of the Terms of Service/)
  assert.match(matched.fields.uncategorized_text, /text sha256/)
  assert.doesNotMatch(matched.fields.uncategorized_text, /30 days written notice to ethan@leadgenisys\.com/)
  assert.match(matched.fields.cancellation_rebuttal, /ledger has no entry on or after this charge/)
  assert.doesNotMatch(matched.fields.cancellation_rebuttal, /no cancellation request/i)
  assert.doesNotMatch(JSON.stringify(matched.fields), forbidden)
  const textLimit = 20_000
  let textTotal = 0
  for (const [key, value] of Object.entries(matched.fields)) {
    assert.ok(value.length <= textLimit, `${key} is ${value.length} characters`)
    textTotal += value.length
  }
  assert.ok(textTotal <= 150_000)
  const bulkyMails = Array.from({ length: 400 }, () => ({
    at: '2026-10-02T00:00:00.000Z', direction: 'in', from: 'owner@acme.test', to: 'ethan@leadgenisys.com',
    subject: 'Question about the invoice', snippet: 'x'.repeat(180),
  }))
  const bulky = plan.buildEvidence({
    dispute: baseDispute, client: null, intake: null,
    acknowledgements: [ack('recurring_billing', recur)],
    ledger: [], emails: bulkyMails, receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  })
  assert.ok(bulky.fields.uncategorized_text.length <= textLimit)
  const quoteAt = bulky.fields.uncategorized_text.lastIndexOf('Recurring billing disclosure')
  assert.ok(quoteAt > 0)
  const quote = bulky.fields.uncategorized_text.slice(quoteAt)
  assert.equal(quote.includes('[truncated]'), false)
  assert.equal(quote.includes(recur.summary), true)
  assert.match(quote, new RegExp(recur.textHash))
  const renamed = plan.buildEvidence({
    dispute: baseDispute, client: null, intake: null,
    acknowledgements: [ack('cancellation_policy', cancel, { version: 'client-label' })],
    ledger: [], emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  })
  assert.match(renamed.fields.cancellation_policy_disclosure, /version client-label/)
  assert.match(renamed.fields.cancellation_policy_disclosure, /hashed text is version 2026-11-19/)
  assert.match(renamed.fields.cancellation_policy_disclosure, /30 days written notice/)
  const crossed = plan.buildEvidence({
    dispute: baseDispute, client: null, intake: null,
    acknowledgements: [ack('refund_policy', cancel)],
    ledger: [], emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  })
  assert.match(crossed.fields.refund_policy_disclosure, /does not substitute/)
  assert.doesNotMatch(crossed.fields.refund_policy_disclosure, /30 days written notice/)
  const policiesSection = matched.sections.find((s) => s.heading === 'Policies')
  assert.match(policiesSection.body, /This is the text the acceptance record hashes to/)
  assert.match(policiesSection.body, new RegExp(cancel.textHash))

  const other = 'cd'.repeat(32)
  const unmatchedAcks = [ack('cancellation_policy', cancel, { textHash: other, version: '2026-01-01', textUrl: 'https://clientonboarding.leadgenisys.com/cancellation-policy' }), ack('refund_policy', refund, { textHash: other })]
  const unmatched = plan.buildEvidence({
    dispute: baseDispute, client: null, intake: null, acknowledgements: unmatchedAcks,
    ledger: [], emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  })
  assert.match(unmatched.fields.cancellation_policy_disclosure, new RegExp(other))
  assert.match(unmatched.fields.cancellation_policy_disclosure, /version 2026-01-01/)
  assert.match(unmatched.fields.cancellation_policy_disclosure, /does not match a cancellation policy/)
  assert.match(unmatched.fields.cancellation_policy_disclosure, /does not substitute/)
  assert.doesNotMatch(unmatched.fields.cancellation_policy_disclosure, /30 days written notice/)
  assert.doesNotMatch(unmatched.fields.cancellation_rebuttal, /30 days written notice/)
  assert.match(unmatched.fields.cancellation_rebuttal, /does not substitute/)
  assert.doesNotMatch(unmatched.fields.refund_policy_disclosure, /\$0 is due today/)
  const credit = plan.buildEvidence({
    dispute: { ...baseDispute, reason: 'credit_not_processed', networkReasonCode: 'C02' },
    client: null, intake: null, acknowledgements: unmatchedAcks,
    ledger: [], emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  })
  assert.match(credit.fields.refund_refusal_explanation, /does not substitute/)
  assert.doesNotMatch(credit.fields.refund_refusal_explanation, /non-refundable/)
  const unmatchedPolicies = unmatched.sections.find((s) => s.heading === 'Policies').body
  assert.match(unmatchedPolicies, /not stated as what the client accepted/)
  assert.doesNotMatch(JSON.stringify(unmatched.fields), forbidden)

  const bare = plan.buildEvidence({
    dispute: baseDispute, client: null, intake: null, acknowledgements: [],
    ledger: [], emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  })
  assert.equal(bare.fields.cancellation_policy_disclosure, undefined)
  assert.equal(bare.fields.refund_policy_disclosure, undefined)
  assert.match(bare.fields.cancellation_rebuttal, /does not yet have a clickwrap/)
  assert.match(bare.fields.cancellation_rebuttal, /ledger has no entry on or after this charge/)
  assert.doesNotMatch(bare.fields.cancellation_rebuttal, /30 days written notice/)
  assert.doesNotMatch(bare.fields.cancellation_rebuttal, /the client accepted/i)
  assert.doesNotMatch(bare.fields.cancellation_rebuttal, /no cancellation request/i)
  const bareCredit = plan.buildEvidence({
    dispute: { ...baseDispute, reason: 'credit_not_processed', networkReasonCode: 'C02' },
    client: null, intake: null, acknowledgements: [],
    ledger: [], emails: [], receipts: [], invoices: [], logins: [], priors: [], narrative: null, template: null,
  })
  assert.match(bareCredit.fields.refund_refusal_explanation, /does not yet have a clickwrap/)
  assert.match(bareCredit.fields.refund_refusal_explanation, /does not state a refund rule/)
  assert.doesNotMatch(bareCredit.fields.refund_refusal_explanation, /non-refundable/)
  assert.doesNotMatch(bareCredit.fields.refund_refusal_explanation, /the client accepted/i)
  assert.doesNotMatch(JSON.stringify(bare.fields), forbidden)
})
