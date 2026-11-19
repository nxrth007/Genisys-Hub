import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadTs(rel) {
  const absPath = join(root, rel)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, createRequire(pathToFileURL(absPath)))
  return m.exports
}

const plan = loadTs('src/lib/disputes/plan.ts')
const pdf = loadTs('src/lib/disputes/pdf.ts')

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

test('metadata match is exact and wins over a different email', () => {
  const m = plan.matchDispute(
    { email: 'other@x.test', phone: null, name: null, metadata: { hub_client_id: 'c1', hub_intake_id: 'in1' } },
    [client(), client({ clientId: 'c2', name: 'Other', emails: ['other@x.test'], intakeIds: [] })],
  )
  assert.equal(m.clientId, 'c1')
  assert.equal(m.intakeId, 'in1')
  assert.equal(m.method, 'metadata')
  assert.equal(m.confidence, 'exact')
})

test('email, phone, and a unique business name match; two phones do not guess', () => {
  assert.equal(plan.matchDispute({ email: 'Owner@Acme.test', phone: null, name: null, metadata: {} }, [client()]).method, 'email')
  assert.equal(plan.matchDispute({ email: null, phone: '+1 512-555-0100', name: null, metadata: {} }, [client()]).confidence, 'strong')
  assert.equal(plan.matchDispute({ email: null, phone: '5125550100', name: null, metadata: {} }, [client(), client({ clientId: 'c2', phones: ['5125550100'] })]).confidence, 'none')
  assert.equal(plan.matchDispute({ email: null, phone: null, name: 'Acme Roofing, LLC', metadata: {} }, [client()]).method, 'business_name')
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
  assert.equal(weak.stripeSubmit, false)
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

test('Visa CE 3.0 needs two undisputed charges in the 120 to 365 day window sharing two identifiers', () => {
  const chargedAt = '2026-11-01T00:00:00.000Z'
  const day = 86400_000
  const prior = (id, daysAgo, over = {}) => ({
    id, amountCents: 29700, created: new Date(new Date(chargedAt).getTime() - daysAgo * day).toISOString(),
    paid: true, disputed: false, refunded: false, email: 'owner@acme.test', ip: null, accountId: 'c1', ...over,
  })
  const ok = plan.selectCompellingEvidence({
    reason: 'fraudulent', cardBrand: 'visa', chargedAt, email: 'owner@acme.test', ip: null, accountId: 'c1', productDescription: 'service',
    priors: [prior('ch_a', 200), prior('ch_b', 300), prior('ch_recent', 10), prior('ch_old', 400), prior('ch_refunded', 220, { refunded: true })],
  })
  assert.deepEqual(ok.prior.map((p) => p.charge), ['ch_a', 'ch_b'])
  assert.equal(plan.selectCompellingEvidence({ reason: 'product_not_received', cardBrand: 'visa', chargedAt, email: 'owner@acme.test', ip: null, accountId: 'c1', productDescription: 's', priors: [prior('ch_a', 200), prior('ch_b', 300)] }), null)
  assert.equal(plan.selectCompellingEvidence({ reason: 'fraudulent', cardBrand: 'mastercard', chargedAt, email: 'a@b.c', ip: null, accountId: 'c1', productDescription: 's', priors: [prior('ch_a', 200), prior('ch_b', 300)] }), null)
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
  assert.match(built.fields.service_documentation, /Website live/)
  assert.match(built.fields.service_documentation, /Client report emailed/)
  assert.match(built.fields.service_documentation, /Dashboard login/)
  assert.equal(built.fields.service_documentation.includes('Lead delivered'), false)
  const timeline = built.sections.find((s) => s.heading === 'Service delivery timeline')
  const leads = built.sections.find((s) => s.heading === 'Leads and appointments (supporting)')
  assert.ok(timeline.body.includes('HTTP 200'))
  assert.ok(leads.body.includes('Lead delivered'))
  assert.ok(built.sections.findIndex((s) => s.heading === 'Service delivery timeline') < built.sections.findIndex((s) => s.heading === 'Leads and appointments (supporting)'))
  assert.match(built.fields.customer_purchase_ip, /203\.0\.113\.8/)
  const form = plan.evidenceFormBody({ fields: built.fields, files: { uncategorized_file: 'file_1' }, ce3: null, submit: false })
  assert.match(form, /submit=false/)
  assert.match(form, /uncategorized_file/)
  assert.doesNotMatch(form, /submit=true/)
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
})

test('the packet PDF is a real PDF under the size cap and names the timeline', () => {
  const bytes = pdf.renderEvidencePdf([
    { heading: 'Service delivery timeline', body: 'Website live — https://acme.test HTTP 200\nClient report emailed' },
    { heading: 'Cover', body: 'Dispute dp_1' },
  ])
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  assert.ok(bytes.includes(Buffer.from('Service delivery timeline')))
  assert.ok(bytes.length < plan.MAX_COMBINED_FILE_BYTES)
})

test('the defense uses the restricted key and the webhook route is public', () => {
  const stripe = readFileSync(join(root, 'src/lib/disputes/stripe.ts'), 'utf8')
  const run = readFileSync(join(root, 'src/lib/disputes/run.ts'), 'utf8')
  const middleware = readFileSync(join(root, 'src/middleware.ts'), 'utf8')
  assert.match(stripe, /DISPUTE_KEY_ENTRY/)
  assert.match(stripe, /LEGACY_STRIPE_KEY_ENTRY/)
  assert.doesNotMatch(stripe, /firstSecret\(\[[^\]]*Stripe API Key/)
  assert.match(run, /DISPUTE_DEFENSE|compile_only|dry_run/)
  assert.match(middleware, /\/api\/webhooks\/stripe/)
  assert.equal(plan.DISPUTE_KEY_ENTRY, 'Stripe Official Restricted')
  assert.equal(plan.LEGACY_STRIPE_KEY_ENTRY, 'Stripe API Key')
  assert.ok(plan.DISPUTE_WEBHOOK_EVENTS.includes('charge.dispute.created'))
  assert.ok(plan.DISPUTE_WEBHOOK_EVENTS.includes('radar.early_fraud_warning.created'))
})
