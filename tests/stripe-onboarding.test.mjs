import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadTs(absPath) {
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, createRequire(pathToFileURL(absPath)))
  return m.exports
}

const plan = loadTs(join(root, 'src/lib/stripe-onboarding-plan.ts'))

const TRIAL_END = Math.floor(new Date('2026-12-17T15:00:00Z').getTime() / 1000)
const price = { id: 'price_live297', object: 'price', unit_amount: 29700, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }
const subscription = (over = {}) => ({
  id: 'sub_1', object: 'subscription', status: 'trialing', customer: 'cus_1', livemode: true, created: 1_700_000_000, trial_end: TRIAL_END,
  items: { data: [{ price, current_period_end: TRIAL_END }] },
  ...over,
})
const session = (over = {}) => ({
  id: 'cs_live_a1B2c3', object: 'checkout.session', mode: 'subscription', status: 'complete', livemode: true, customer: 'cus_1',
  customer_details: { email: 'Maria@Example.com', name: 'Maria Lopez', phone: '+15125550123' },
  subscription: subscription(),
  ...over,
})

test('a completed trial checkout is a member: email lowercased, the price and first charge known', () => {
  const m = plan.judgeCheckout(session())
  assert.equal(m.valid, true)
  assert.equal(m.email, 'maria@example.com')
  assert.equal(m.name, 'Maria Lopez')
  assert.equal(m.subscriptionStatus, 'trialing')
  assert.equal(m.price, '$297/mo')
  assert.equal(m.trialEnd, '2026-12-17T15:00:00.000Z')
  assert.equal(m.customerId, 'cus_1')
  assert.equal(m.livemode, true)
  assert.equal(plan.judgeCheckout(session({ subscription: subscription({ status: 'active', trial_end: null }) })).subscriptionStatus, 'active')
})

test('a checkout that is open, a one-off payment, unexpanded or whose subscription ended is not', () => {
  assert.deepEqual(plan.judgeCheckout(session({ status: 'open' })), { valid: false, reason: 'checkout open' })
  assert.deepEqual(plan.judgeCheckout(session({ mode: 'payment' })), { valid: false, reason: 'checkout mode payment' })
  assert.deepEqual(plan.judgeCheckout(session({ subscription: 'sub_1' })), { valid: false, reason: 'no subscription on the checkout' })
  assert.deepEqual(plan.judgeCheckout(session({ subscription: subscription({ status: 'canceled' }) })), { valid: false, reason: 'subscription canceled' })
  assert.deepEqual(plan.judgeCheckout({ object: 'customer' }), { valid: false, reason: 'not a checkout session' })
  assert.equal(plan.judgeCheckout(null).valid, false)
})

test('a client who lost the link is found by email: the newest live subscription decides', () => {
  const customer = { id: 'cus_9', object: 'customer', email: 'bob@example.com', name: 'Bob', phone: null }
  const canceled = subscription({ id: 'sub_old', status: 'canceled', created: 1 })
  const trialing = subscription({ id: 'sub_new', created: 2 })
  const m = plan.judgeSubscriptions([{ customer, subscriptions: { object: 'list', data: [canceled, trialing] } }])
  assert.equal(m.valid, true)
  assert.equal(m.subscriptionId, 'sub_new')
  assert.equal(m.customerId, 'cus_9')
  assert.equal(m.email, 'bob@example.com')
  assert.deepEqual(plan.judgeSubscriptions([]), { valid: false, reason: 'no customer with this email' })
  assert.deepEqual(plan.judgeSubscriptions([{ customer, subscriptions: [canceled] }]), { valid: false, reason: 'subscription canceled' })
  assert.deepEqual(plan.judgeSubscriptions([{ customer, subscriptions: [] }]), { valid: false, reason: 'no subscription' })
})

test('prices and dates read the way the team says them', () => {
  assert.equal(plan.priceLabel(price), '$297/mo')
  assert.equal(plan.priceLabel({ unit_amount: 2550, currency: 'usd', recurring: { interval: 'month' } }), '$25.50/mo')
  assert.equal(plan.priceLabel({ unit_amount: 1000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } }), '$10/yr')
  assert.equal(plan.priceLabel({ unit_amount: 5000, currency: 'usd' }), '$50')
  assert.equal(plan.priceLabel(null), null)
  assert.equal(plan.shortDate('2026-12-17T15:00:00.000Z'), 'Dec 17')
  assert.equal(plan.shortDate(null), null)
})

test("Stripe's signature: the right secret within five minutes, and nothing else", () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}'
  const now = 1_800_000_000
  const header = plan.signStripePayload('whsec_abc', now, body)
  assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/)
  assert.deepEqual(plan.verifyStripeSignature({ secret: 'whsec_abc', header, body, nowSeconds: now + 60 }), { ok: true })
  assert.equal(plan.verifyStripeSignature({ secret: 'whsec_other', header, body, nowSeconds: now }).reason, 'signature mismatch')
  assert.equal(plan.verifyStripeSignature({ secret: 'whsec_abc', header, body: body + ' ', nowSeconds: now }).reason, 'signature mismatch')
  assert.equal(plan.verifyStripeSignature({ secret: 'whsec_abc', header, body, nowSeconds: now + 6 * 60 }).reason, 'timestamp outside tolerance')
  assert.equal(plan.verifyStripeSignature({ secret: 'whsec_abc', header: null, body, nowSeconds: now }).reason, 'no Stripe-Signature header')
  assert.equal(plan.verifyStripeSignature({ secret: 'whsec_abc', header: 'garbage', body, nowSeconds: now }).reason, 'malformed Stripe-Signature header')
  // During a secret rotation Stripe sends two v1 signatures; one matching is enough.
  const rotated = `${header},v1=${'0'.repeat(64)}`
  assert.deepEqual(plan.verifyStripeSignature({ secret: 'whsec_abc', header: rotated, body, nowSeconds: now }), { ok: true })
})

test('the events the team hears about, and the ones it does not', () => {
  const signup = plan.describeEvent({ id: 'evt_1', type: 'checkout.session.completed', livemode: true, data: { object: { ...session(), subscription: 'sub_1' } } })
  assert.deepEqual(signup, { kind: 'signup', eventId: 'evt_1', sessionId: 'cs_live_a1B2c3', customerId: 'cus_1', subscriptionId: 'sub_1', email: 'maria@example.com', name: 'Maria Lopez', phone: '+15125550123', livemode: true })
  assert.deepEqual(plan.describeEvent({ id: 'evt_2', type: 'checkout.session.completed', data: { object: session({ mode: 'payment' }) } }), { kind: 'ignored', type: 'checkout.session.completed' })

  const failed = plan.describeEvent({ id: 'evt_3', type: 'invoice.payment_failed', livemode: true, data: { object: { object: 'invoice', customer: 'cus_1', customer_email: 'Maria@Example.com', customer_name: 'Maria Lopez', amount_due: 29700, currency: 'usd', attempt_count: 1, next_payment_attempt: TRIAL_END } } })
  assert.equal(failed.kind, 'payment_failed')
  assert.equal(failed.amount, '$297')
  assert.equal(failed.email, 'maria@example.com')
  assert.equal(failed.nextAttempt, '2026-12-17T15:00:00.000Z')

  const status = plan.describeEvent({ id: 'evt_4', type: 'customer.subscription.updated', livemode: true, data: { object: subscription({ status: 'active', trial_end: null }), previous_attributes: { status: 'trialing' } } })
  assert.equal(status.kind, 'status')
  assert.equal(status.status, 'active')
  assert.equal(status.previousStatus, 'trialing')
  assert.equal(status.price, '$297/mo')

  assert.equal(plan.describeEvent({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: subscription({ status: 'canceled' }) } }).kind, 'canceled')
  assert.equal(plan.describeEvent({ id: 'evt_6', type: 'customer.subscription.trial_will_end', data: { object: subscription() } }).trialEnd, '2026-12-17T15:00:00.000Z')
  assert.deepEqual(plan.describeEvent({ id: 'evt_7', type: 'invoice.paid', data: { object: {} } }), { kind: 'ignored', type: 'invoice.paid' })
  assert.deepEqual(plan.describeEvent('nonsense'), { kind: 'ignored', type: 'unknown' })
})

test('the sign-up text names the person, the plan and the first charge', () => {
  assert.equal(
    plan.stripeSignupText({ name: 'Maria Lopez', email: 'maria@example.com', price: '$297/mo', trialEnd: '2026-12-17T15:00:00.000Z', link: 'https://hub/clients' }),
    'Genisys: New sign-up! Maria Lopez (maria@example.com) started the free trial of $297/mo; first charge Dec 17. https://hub/clients',
  )
  assert.equal(plan.stripeSignupText({ name: null, email: null, price: null, trialEnd: null, link: 'https://hub/clients' }), 'Genisys: New sign-up! Someone started the free trial. https://hub/clients')
})

test("which Stripe account a key or id belongs to, read off its marker", () => {
  // Sample keys are assembled here so no key-shaped string sits in the repo (GitHub's push protection reads them as real).
  const sample = (kind, mode, body) => [kind, mode, body].join('_')
  assert.equal(plan.accountMarker(sample('pk', 'live', '51TnjrvIm6NAwaEIm' + 'n'.repeat(80))), 'Im6NAwaEIm')
  assert.equal(plan.accountMarker(sample('rk', 'live', '51TnjrvIm6NAwaEIm' + 'a'.repeat(40))), 'Im6NAwaEIm')
  assert.equal(plan.accountMarker('price_1Ub3otIm6NAwaEImXCIP9UM2'), 'Im6NAwaEIm')
  assert.equal(plan.accountMarker('we_1UctFbIm6NAwaEIm52p7SyHv'), 'Im6NAwaEIm')
  assert.equal(plan.accountMarker('sub_1QzAbCDeFgHiJkLmNoPqRsTu'), 'DeFgHiJkLm')
  assert.equal(plan.accountMarker(sample('sk', 'live', '51MoBy5LkdIwHu7ix' + 'A'.repeat(60))), 'LkdIwHu7ix')
  assert.equal(plan.accountMarker('cus_NffrFeUfNV2Hib'), null, 'customer ids carry no account marker')
  assert.equal(plan.accountMarker(sample('sk', 'test', 'TYooMQauvdEDq54NiTphI7jx')), null, 'an old-style key says nothing')
  assert.equal(plan.SIGNUP_ACCOUNT_MARKER, 'Im6NAwaEIm')
})

test('checkout ids: test and live, nothing else', () => {
  assert.ok(plan.CHECKOUT_SESSION_ID.test('cs_live_a1B2c3D4'))
  assert.ok(plan.CHECKOUT_SESSION_ID.test('cs_test_a1B2c3D4'))
  assert.ok(!plan.CHECKOUT_SESSION_ID.test('cs_live_a1B2c3D4/../x'))
  assert.ok(!plan.CHECKOUT_SESSION_ID.test('sub_123'))
})
