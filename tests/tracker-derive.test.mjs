import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// The derived client tracker (2026-11-19): every onboarding step read from what the Hub knows —
// Stripe, the onboarding form, Genisys OS, Forge's build, numbers, texting, automations, Google
// profile, SEO — with a hand mark counting only where the Hub has no evidence of its own.

function loadSource(path, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const m = { exports: {} }
  const load = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    throw new Error(`Unexpected dependency: ${name}`)
  }
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename: path })(load, m, m.exports)
  return m.exports
}

const siteStatus = loadSource('lib/site-status.ts')
const billingPlan = loadSource('lib/stripe-billing-plan.ts')
const d = loadSource('lib/tracker/derive.ts', { '@/lib/site-status': siteStatus, '@/lib/stripe-billing-plan': billingPlan })

const NOW = new Date('2026-11-19T15:00:00Z').getTime()
const day = (n) => new Date(NOW - n * 86_400_000).toISOString()

const sub = (over = {}) => ({
  id: 'sub_1',
  customerId: 'cus_1',
  email: 'maria@example.com',
  name: 'Maria Lopez',
  phone: null,
  status: 'trialing',
  plan: 'Growth',
  price: '$297/mo',
  amountCents: 29700,
  currency: 'usd',
  interval: 'month',
  intervalCount: 1,
  monthlyCents: 29700,
  created: day(3),
  trialEnd: '2026-12-16T15:00:00Z',
  periodEnd: '2026-12-16T15:00:00Z',
  cancelAtPeriodEnd: false,
  canceledAt: null,
  endedAt: null,
  collectionPaused: false,
  latestInvoiceId: 'in_1',
  livemode: true,
  ...over,
})

/** A client as the facts gatherer hands them over: nothing known. */
const blank = (over = {}) => ({
  id: 'c1',
  name: 'Maria Lopez Roofing',
  business: 'Maria Lopez Roofing',
  person: 'Maria Lopez',
  email: 'maria@example.com',
  color: '#3b82f6',
  lifecycle: 'onboarding',
  archived: false,
  createdAt: day(3),
  intake: null,
  billing: null,
  billingKnown: true,
  journey: {},
  hl: null,
  ghl: { linked: false, staysOnGhl: false, censusNumbers: [], censusAt: null, registration: null, customize: null },
  siteUrl: null,
  siteLiveAt: null,
  siteBuild: null,
  domainQuestion: null,
  numberRequest: null,
  automationCopy: { done: 0, total: 9, updatedAt: null },
  gbp: null,
  seo: null,
  manual: { ...d.NO_MARKS },
  ...over,
})

const hl = (over = {}) => ({
  id: 'hl1',
  createdAt: day(3),
  archived: false,
  workflows: { published: 13, total: 13 },
  numbers: [],
  domains: [],
  a2p: null,
  ...over,
})

const tollFree = (verificationStatus = 'none', over = {}) => ({
  number: '+18556090482',
  kind: 'toll_free',
  verificationStatus,
  verificationNote: null,
  verificationAt: verificationStatus === 'none' ? null : day(1),
  createdAt: day(2),
  ...over,
})

test('a brand-new client with nothing on record is pending everywhere and at the sign-up stage', () => {
  const r = d.trackerRow(blank(), { hasRow: false, sheetRow: null }, NOW)
  assert.equal(r.current, 'signup')
  assert.equal(r.complete, false)
  assert.equal(r.steps.signup.state, 'pending')
  assert.equal(r.steps.intake.state, 'pending')
  assert.equal(r.steps.subaccount.state, 'pending')
  assert.equal(r.steps.website.state, 'pending')
  assert.equal(r.steps.gbp.state, 'none')
  assert.equal(r.steps.seo.state, 'none')
  assert.equal(r.billing.text, 'Not in Stripe')
  assert.equal(r.stuckDays, 3)
  assert.equal(r.stuck, false)
})

test('a Stripe trial is the sign-up, with the first charge in the note and a link into Stripe', () => {
  const f = blank({ billing: { state: 'trialing', subscription: sub(), created: day(3), href: 'https://dashboard.stripe.com/acct_x/subscriptions/sub_1' } })
  const s = d.deriveSteps(f).signup
  assert.equal(s.state, 'done')
  assert.match(s.note, /Trial · \$297\/mo · first charge Dec 16/)
  assert.equal(s.href, 'https://dashboard.stripe.com/acct_x/subscriptions/sub_1')
  assert.equal(s.at, day(3))
})

test('a past-due subscription blocks the sign-up; a canceled one too', () => {
  const past = blank({ billing: { state: 'problem', subscription: sub({ status: 'past_due' }), created: day(3), href: null } })
  assert.equal(d.deriveSteps(past).signup.state, 'blocked')
  assert.match(d.deriveSteps(past).signup.note, /Past due/)
  const gone = blank({ billing: { state: 'canceled', subscription: sub({ status: 'canceled', canceledAt: day(1), endedAt: day(1) }), created: day(3), href: null } })
  assert.equal(d.deriveSteps(gone).signup.state, 'blocked')
  assert.equal(d.deriveSteps(gone).signup.at, day(1))
})

test('without Stripe, the journey, then the onboarding form, say the client signed up', () => {
  const whop = blank({ journey: { signup: { status: 'done', note: 'Whop membership mem_1', updatedAt: day(20) } } })
  assert.deepEqual([d.deriveSteps(whop).signup.state, d.deriveSteps(whop).signup.note], ['done', 'Whop membership mem_1'])
  const form = blank({ intake: { receivedAt: day(2) } })
  assert.equal(d.deriveSteps(form).signup.state, 'done')
  assert.match(d.deriveSteps(form).signup.note, /Implied by the onboarding form/)
  const unread = blank({ billingKnown: false })
  assert.equal(d.deriveSteps(unread).signup.state, 'none')
})

test('the onboarding form, the Genisys OS sub-account and the kit workflows read from the facts', () => {
  const f = blank({ intake: { receivedAt: day(2) }, hl: hl() })
  const s = d.deriveSteps(f)
  assert.deepEqual([s.intake.state, s.intake.at], ['done', day(2)])
  assert.deepEqual([s.subaccount.state, s.subaccount.href], ['done', '/genisys-os/hl1'])
  assert.deepEqual([s.automations.state, s.automations.note], ['done', '13 workflows live in Genisys OS'])
  const bare = d.deriveSteps(blank({ hl: hl({ workflows: { published: 0, total: 0 } }) }))
  assert.equal(bare.automations.state, 'in_progress')
})

test('the website: the Clients site link wins, then Forge’s build, then the journey', () => {
  const live = d.deriveSteps(blank({ siteUrl: 'https://www.acmeroofing.com/', siteLiveAt: day(1) })).website
  assert.deepEqual([live.state, live.note, live.href, live.at], ['done', 'Live at acmeroofing.com', 'https://www.acmeroofing.com/', day(1)])
  const building = d.deriveSteps(blank({ siteBuild: { status: 'building', label: 'Lovable is building the site', liveUrl: null, publishedAt: null, updatedAt: day(1) } })).website
  assert.deepEqual([building.state, building.note, building.href], ['in_progress', 'Lovable is building the site', '/sites/c1'])
  const published = d.deriveSteps(blank({ siteBuild: { status: 'published', label: 'Published', liveUrl: 'https://acme.lovable.app', publishedAt: day(1), updatedAt: day(1) } })).website
  assert.deepEqual([published.state, published.note], ['done', 'Published: acme.lovable.app'])
  const failed = d.deriveSteps(blank({ siteBuild: { status: 'failed', label: 'Didn’t finish', liveUrl: null, publishedAt: null, updatedAt: day(1) } })).website
  assert.equal(failed.state, 'blocked')
  const asked = d.deriveSteps(blank({ siteBuild: { status: 'awaiting_approval', label: 'Asked in the Office', liveUrl: null, publishedAt: null, updatedAt: day(1) } })).website
  assert.equal(asked.state, 'pending')
  const journey = d.deriveSteps(blank({ journey: { website: { status: 'blocked', note: 'No brand assets', updatedAt: day(4) } } })).website
  assert.deepEqual([journey.state, journey.note], ['blocked', 'No brand assets'])
})

test('the domain: their Genisys OS domain, else the site’s own domain, never a lovable.app address', () => {
  const bought = d.deriveSteps(blank({ hl: hl({ domains: [{ name: 'acmeroofing.com', origin: 'bought', status: 'active', createdAt: day(2) }] }) })).domain
  assert.equal(bought.state, 'done')
  assert.match(bought.note, /acmeroofing\.com, bought/)
  const own = d.deriveSteps(blank({ hl: hl(), siteUrl: 'https://acmeroofing.com' })).domain
  assert.deepEqual([own.state, own.note], ['done', 'acmeroofing.com, their site’s domain'])
  const lovable = d.deriveSteps(blank({ hl: hl(), siteUrl: 'https://acme.lovable.app' })).domain
  assert.equal(lovable.state, 'pending')
  assert.equal(d.deriveSteps(blank()).domain.state, 'none')
})

test('the toll-free number and its texting verification are two steps', () => {
  const bought = d.deriveSteps(blank({ hl: hl({ numbers: [tollFree('none')] }) }))
  assert.deepEqual([bought.number.state, bought.number.note], ['done', '(855) 609-0482: bought'])
  assert.deepEqual([bought.texting.state, bought.texting.note], ['pending', '(855) 609-0482: verification is filed once the site is live'])
  const reviewing = d.deriveSteps(blank({ hl: hl({ numbers: [tollFree('pending')] }), siteUrl: 'https://acme.com' }))
  assert.deepEqual([reviewing.texting.state, reviewing.texting.note], ['in_progress', '(855) 609-0482: Twilio is reviewing the verification'])
  const approved = d.deriveSteps(blank({ hl: hl({ numbers: [tollFree('approved')] }) }))
  assert.deepEqual([approved.number.note, approved.texting.state, approved.texting.at], ['(855) 609-0482: bought and verified', 'done', day(1)])
  const rejected = d.deriveSteps(blank({ hl: hl({ numbers: [tollFree('rejected', { verificationNote: 'opt-in unclear' })] }) }))
  assert.deepEqual([rejected.texting.state, rejected.texting.note], ['blocked', '(855) 609-0482: verification rejected (opt-in unclear)'])
})

test('Echo’s number question, waiting on a Yes, is a pending number', () => {
  const asked = d.deriveSteps(blank({ hl: hl(), numberRequest: { status: 'awaiting_approval', route: 'hl', number: null, detail: null, updatedAt: day(1) } }))
  assert.equal(asked.number.state, 'pending')
  assert.match(asked.number.note, /Waiting on a Yes/)
  const failed = d.deriveSteps(blank({ hl: hl(), numberRequest: { status: 'failed', route: 'hl', number: null, detail: 'Twilio refused', updatedAt: day(1) } }))
  assert.deepEqual([failed.number.state, failed.number.note], ['blocked', 'Twilio refused'])
})

test('A2P in Genisys OS: filed, waiting on the owner, approved, rejected', () => {
  const a2p = (stage, over = {}) => d.deriveSteps(blank({ hl: hl({ a2p: { stage, campaignStatus: null, filedAt: day(2), approvedAt: null, updatedAt: day(1), ...over } }) })).texting
  assert.equal(a2p('campaign').state, 'in_progress')
  assert.match(a2p('otp').note, /owner’s YES/)
  assert.deepEqual([a2p('approved', { approvedAt: day(1) }).state, a2p('approved', { approvedAt: day(1) }).at], ['done', day(1)])
  assert.equal(a2p('failed').state, 'blocked')
})

test('GHL clients: the number in GHL, the registration, and the ones that stay on GHL', () => {
  const ghl = (over = {}) => ({ linked: true, staysOnGhl: false, censusNumbers: [{ number: '+18885550100', tollFree: true, verificationRequired: true }], censusAt: day(1), registration: null, customize: null, ...over })
  const unverified = d.deriveSteps(blank({ ghl: ghl() }))
  assert.deepEqual([unverified.subaccount.state, unverified.number.state, unverified.texting.state], ['done', 'in_progress', 'pending'])
  assert.match(unverified.number.note, /Verification Required/)
  const stays = d.deriveSteps(blank({ ghl: ghl({ staysOnGhl: true }) }))
  assert.deepEqual([stays.number.state, stays.texting.state, stays.texting.note], ['done', 'done', 'Verified in GHL (stays on GHL)'])
  const unread = d.deriveSteps(blank({ ghl: ghl({ staysOnGhl: true, censusNumbers: [], censusAt: null }) }))
  assert.deepEqual([unread.number.state, unread.number.note, unread.texting.state], ['done', 'Number in GHL (stays on GHL)', 'done'])
  const submitted = d.deriveSteps(blank({ ghl: ghl({ registration: 'submitted' }) }))
  assert.deepEqual([submitted.texting.state, submitted.texting.note], ['in_progress', 'GHL toll-free registration is with GHL'])
  const customized = d.deriveSteps(blank({ ghl: ghl({ customize: { status: 'done', finishedAt: day(1), updatedAt: day(1) } }) }))
  assert.deepEqual([customized.automations.state, customized.automations.note], ['done', 'Lead workflows customized in GHL'])
  const board = d.deriveSteps(blank({ ghl: ghl(), automationCopy: { done: 9, total: 9, updatedAt: day(1) } }))
  assert.equal(board.automations.state, 'done')
  const partly = d.deriveSteps(blank({ ghl: ghl(), automationCopy: { done: 4, total: 9, updatedAt: day(1) } }))
  assert.deepEqual([partly.automations.state, partly.automations.note], ['in_progress', '4 of 9 automations ticked on the board'])
})

test('a hand mark counts only where the Hub has nothing, and says so', () => {
  const marks = { ...d.NO_MARKS, automations: 'done', texting: 'done', updatedAt: day(5), source: 'sheet' }
  const byHand = d.deriveSteps(blank({ manual: marks }))
  assert.deepEqual([byHand.automations.state, byHand.automations.byHand, byHand.automations.note, byHand.automations.at], ['done', true, 'Marked done by hand', day(5)])
  assert.equal(byHand.texting.byHand, true)
  // Evidence wins: a rejected verification stays blocked whatever the sheet says.
  const evidence = d.deriveSteps(blank({ manual: marks, hl: hl({ numbers: [tollFree('rejected')] }) }))
  assert.deepEqual([evidence.texting.state, evidence.texting.byHand], ['blocked', false])
  assert.deepEqual([evidence.automations.state, evidence.automations.byHand], ['done', false])
})

test('Google profile and SEO read their boards', () => {
  const verified = d.deriveSteps(blank({ gbp: { status: 'verified', profileUrl: 'https://maps.google.com/x' } })).gbp
  assert.deepEqual([verified.state, verified.href], ['done', 'https://maps.google.com/x'])
  assert.equal(d.deriveSteps(blank({ gbp: { status: 'verifying', profileUrl: null } })).gbp.state, 'in_progress')
  assert.equal(d.deriveSteps(blank({ gbp: { status: 'needed', profileUrl: null } })).gbp.state, 'pending')
  const auto = d.deriveSteps(blank({ seo: { mode: 'autopilot', enabled: true, archived: false, lastRunAt: day(2), lastScore: 85 } })).seo
  assert.deepEqual([auto.state, auto.note], ['done', 'Weekly engine on · last run Nov 17 · score 85'])
  assert.equal(d.deriveSteps(blank({ seo: { mode: 'audit', enabled: true, archived: false, lastRunAt: null, lastScore: null } })).seo.state, 'in_progress')
  assert.equal(d.deriveSteps(blank({ seo: { mode: 'autopilot', enabled: false, archived: false, lastRunAt: null, lastScore: null } })).seo.state, 'pending')
})

test('a fully set-up client is complete; one waiting a week with nothing happening is stuck', () => {
  const done = blank({
    billing: { state: 'active', subscription: sub({ status: 'active' }), created: day(40), href: null },
    intake: { receivedAt: day(39) },
    hl: hl({ createdAt: day(39), numbers: [tollFree('approved', { createdAt: day(38), verificationAt: day(30) })] }),
    siteUrl: 'https://acme.com',
    siteLiveAt: day(35),
  })
  const r = d.trackerRow(done, { hasRow: false, sheetRow: null }, NOW)
  assert.deepEqual([r.current, r.complete, r.stuck, r.stuckDays], [null, true, false, null])
  assert.equal(r.lastChangeAt, day(30))
  const waiting = blank({ intake: { receivedAt: day(12) }, hl: hl({ createdAt: day(12) }), createdAt: day(12) })
  const w = d.trackerRow(waiting, { hasRow: false, sheetRow: null }, NOW)
  assert.deepEqual([w.current, w.stuckDays, w.stuck], ['website', 12, true])
  const churned = d.trackerRow(blank({ lifecycle: 'churned', createdAt: day(60) }), { hasRow: false, sheetRow: null }, NOW)
  assert.deepEqual([churned.stuckDays, churned.stuck], [null, false])
})

test('summary and filters count the roster only', () => {
  const rows = [
    d.trackerRow(blank({ id: 'a', name: 'A', intake: { receivedAt: day(12) }, hl: hl({ createdAt: day(12) }), createdAt: day(12) }), { hasRow: false, sheetRow: null }, NOW),
    d.trackerRow(blank({ id: 'b', name: 'B', billing: { state: 'problem', subscription: sub({ status: 'past_due' }), created: day(3), href: null } }), { hasRow: false, sheetRow: null }, NOW),
    d.trackerRow(blank({ id: 'c', name: 'C', lifecycle: 'churned' }), { hasRow: false, sheetRow: null }, NOW),
  ]
  const s = d.summarizeTracker(rows)
  assert.deepEqual([s.roster, s.complete, s.stuck, s.blocked], [2, 0, 1, 1])
  assert.equal(s.byStep.website, 1)
  assert.equal(s.byStep.signup, 1)
  assert.equal(s.states.intake.done, 1)
  assert.deepEqual(d.filterRows(rows, { show: 'stuck' }).map((r) => r.clientId), ['a'])
  assert.deepEqual(d.filterRows(rows, { show: 'blocked' }).map((r) => r.clientId), ['b'])
  assert.deepEqual(d.filterRows(rows, { stage: 'signup' }).map((r) => r.clientId), ['b', 'c'])
  assert.deepEqual(d.filterRows(rows, { step: 'intake', state: 'done' }).map((r) => r.clientId), ['a'])
  assert.deepEqual(d.filterRows(rows, { q: 'b' }).map((r) => r.clientId), ['b'])
  assert.deepEqual(d.filterRows(rows, { show: 'working' }).map((r) => r.clientId), ['a', 'b'])
})

test('"In Stripe only" hides clients Stripe has never heard of, not ones it could not read', () => {
  const row = (over) => d.trackerRow(blank(over), { hasRow: false, sheetRow: null }, NOW)
  const rows = [
    row({ id: 'a', name: 'A' }), // Stripe read, no record: Not in Stripe
    row({ id: 'b', name: 'B', billing: { state: 'trialing', subscription: sub(), created: day(3), href: null } }),
    row({ id: 'c', name: 'C', billingKnown: false }), // Stripe could not be read: kept
    row({ id: 'd', name: 'D', billing: { state: 'canceled', subscription: sub({ status: 'canceled', canceledAt: day(1), endedAt: day(1) }), created: day(3), href: null } }),
  ]
  assert.equal(rows[0].billing.text, 'Not in Stripe')
  assert.equal(d.inStripe(rows[0]), false)
  assert.equal(d.inStripe(rows[2]), true)
  assert.deepEqual(d.filterRows(rows, { stripe: true }).map((r) => r.clientId), ['b', 'c', 'd'])
  assert.deepEqual(d.filterRows(rows, { stripe: true, show: 'working' }).map((r) => r.clientId), ['b', 'c', 'd'])
  assert.deepEqual(d.filterRows(rows, {}).map((r) => r.clientId), ['a', 'b', 'c', 'd'])
})

test('the client’s status link shows labels and coarse states only', () => {
  const steps = d.deriveSteps(blank({ intake: { receivedAt: day(2) }, hl: hl({ numbers: [tollFree('pending')] }), siteUrl: 'https://acme.com', billing: { state: 'trialing', subscription: sub(), created: day(3), href: 'https://stripe' } }))
  const v = d.publicStatusView(steps, { business: 'Acme', updatedAt: day(0) })
  assert.equal(v.currentStage, 'Texting registration')
  assert.match(v.nextStep, /carriers/)
  assert.deepEqual(
    v.steps.map((s) => `${s.label}:${s.status}`),
    ['Sign-up:done', 'Onboarding form:done', 'Your account:done', 'Website:done', 'Phone number:done', 'Texting registration:in_progress', 'Automations:done', 'Google profile:pending'],
  )
  assert.equal(JSON.stringify(v).includes('stripe'), false)
  assert.equal(JSON.stringify(v).includes('855'), false)
})

test('step ids: the new ones and the sheet’s old ones both resolve; only five can be set by hand', () => {
  assert.equal(d.readStep('texting'), 'texting')
  assert.equal(d.readStep('a2p'), 'texting')
  assert.equal(d.readStep('tollfree'), 'number')
  assert.equal(d.readStep('website'), 'website')
  assert.equal(d.readStep('nope'), null)
  assert.deepEqual(d.MANUAL_STEPS, ['signup', 'intake', 'automations', 'texting', 'number'])
  assert.equal(d.isManualStep('website'), false)
})
