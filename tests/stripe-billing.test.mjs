import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// The Clients page's subscriptions and the Payments page's Stripe tab, 2026-11-18: every client's Stripe
// subscription next to the client, matched by email the way the onboarding gate matches, the Stripe
// customers no client has, MRR and what's due — and nothing that writes to Stripe.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadTs(absPath) {
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, createRequire(pathToFileURL(absPath)))
  return m.exports
}

const plan = loadTs(join(root, 'src/lib/stripe-billing-plan.ts'))

const DEC_17 = Math.floor(new Date('2026-12-17T15:00:00Z').getTime() / 1000)
const NOV_1 = Math.floor(new Date('2026-11-01T15:00:00Z').getTime() / 1000)
const price = (over = {}) => ({ id: 'price_growth', object: 'price', unit_amount: 29700, currency: 'usd', nickname: null, product: 'prod_growth', recurring: { interval: 'month', interval_count: 1 }, ...over })
const subscription = (over = {}) => ({
  id: 'sub_1',
  object: 'subscription',
  status: 'trialing',
  customer: { id: 'cus_1', object: 'customer', email: 'Maria@Example.com', name: 'Maria Lopez', phone: null },
  livemode: true,
  created: NOV_1,
  trial_end: DEC_17,
  cancel_at_period_end: false,
  items: { data: [{ price: price(), quantity: 1, current_period_end: DEC_17 }] },
  latest_invoice: 'in_1',
  ...over,
})
const customer = (over = {}) => ({ id: 'cus_1', object: 'customer', email: 'maria@example.com', name: 'Maria Lopez', phone: null, created: NOV_1, delinquent: false, livemode: true, ...over })

test('a subscription is read with its plan, price, dates and customer', () => {
  const s = plan.readSubscription(subscription())
  assert.equal(s.id, 'sub_1')
  assert.equal(s.customerId, 'cus_1')
  assert.equal(s.email, 'maria@example.com', 'email lowercased')
  assert.equal(s.name, 'Maria Lopez')
  assert.equal(s.status, 'trialing')
  assert.equal(s.plan, 'Growth', 'a $297/mo price is the Growth plan even without a nickname')
  assert.equal(s.price, '$297/mo')
  assert.equal(s.amountCents, 29700)
  assert.equal(s.monthlyCents, 29700)
  assert.equal(s.trialEnd, '2026-12-17T15:00:00.000Z')
  assert.equal(s.periodEnd, '2026-12-17T15:00:00.000Z', 'the period lives on the item in newer API versions')
  assert.equal(s.latestInvoiceId, 'in_1')
  assert.equal(s.livemode, true)
  // Older API versions keep the period on the subscription; a bare customer id is fine.
  const old = plan.readSubscription(subscription({ customer: 'cus_9', current_period_end: DEC_17 + 60, items: { data: [{ price: price(), quantity: 1 }] } }))
  assert.equal(old.customerId, 'cus_9')
  assert.equal(old.email, null)
  assert.equal(old.periodEnd, new Date((DEC_17 + 60) * 1000).toISOString())
  assert.equal(plan.readSubscription({ object: 'customer', id: 'cus_1' }), null)
  assert.equal(plan.readSubscription(null), null)
})

test('plan names: nickname, product name, then the Genisys price list; prices read the way the team says them', () => {
  assert.equal(plan.readSubscription(subscription({ items: { data: [{ price: price({ nickname: 'Founding rate' }), quantity: 1 }] } })).plan, 'Founding rate')
  assert.equal(plan.readSubscription(subscription(), new Map([['prod_growth', 'Growth System']])).plan, 'Growth System')
  const scale = plan.readSubscription(subscription({ items: { data: [{ price: price({ unit_amount: 79700, recurring: { interval: 'month', interval_count: 3 } }), quantity: 1 }] } }))
  assert.equal(scale.plan, 'Scale')
  assert.equal(scale.price, '$797/3 months')
  assert.equal(scale.monthlyCents, Math.round(79700 / 3))
  const starter = plan.readSubscription(subscription({ items: { data: [{ price: price({ unit_amount: 9700 }), quantity: 1 }] } }))
  assert.equal(starter.plan, 'Starter')
  const odd = plan.readSubscription(subscription({ items: { data: [{ price: price({ unit_amount: 12345 }), quantity: 2 }] } }))
  assert.equal(odd.plan, null)
  assert.equal(odd.amountCents, 24690, 'quantity counts')
  assert.equal(odd.price, '$246.90/mo')
  assert.equal(plan.money(29700), '$297')
  assert.equal(plan.money(2550), '$25.50')
  assert.equal(plan.money(1000, 'cad'), 'CAD 10')
  assert.equal(plan.priceLabel({ cents: 1000, currency: 'usd', interval: 'year', count: 1 }), '$10/yr')
  assert.equal(plan.priceLabel({ cents: 5000, currency: 'usd', interval: null, count: 1 }), '$50')
  assert.equal(plan.monthlyCents(12000, 'year', 1), 1000)
  assert.equal(plan.shortDate('2026-12-17T15:00:00.000Z'), 'Dec 17')
})

test('where a subscription stands: problems, running, ending, ended', () => {
  const state = (over) => plan.stateOf(plan.readSubscription(subscription(over)))
  assert.equal(state({}), 'trialing')
  assert.equal(state({ status: 'active', trial_end: null }), 'active')
  assert.equal(state({ status: 'active', cancel_at_period_end: true }), 'ending')
  assert.equal(state({ status: 'active', pause_collection: { behavior: 'void' } }), 'ending')
  assert.equal(state({ status: 'past_due' }), 'problem')
  assert.equal(state({ status: 'unpaid' }), 'problem')
  assert.equal(state({ status: 'incomplete' }), 'problem')
  assert.equal(state({ status: 'paused' }), 'problem', 'a trial that ended with no card')
  assert.equal(state({ status: 'canceled', canceled_at: DEC_17, ended_at: DEC_17 }), 'canceled')
  assert.equal(state({ status: 'incomplete_expired' }), 'canceled')
  assert.equal(plan.stateOf(null), 'none')
  // Of several, the one that matters: a problem beats a newer active one; active beats an older canceled one.
  const read = (over) => plan.readSubscription(subscription(over))
  assert.equal(plan.decidingSubscription([read({ id: 'old', status: 'canceled', created: 1 }), read({ id: 'new', status: 'active', created: 2 })]).id, 'new')
  assert.equal(plan.decidingSubscription([read({ id: 'late', status: 'active', created: 3 }), read({ id: 'due', status: 'past_due', created: 2 })]).id, 'due')
  assert.equal(plan.decidingSubscription([]), null)
})

test('clients match Stripe customers by email whatever the capitalisation, then by name when it is unique', () => {
  const clients = [
    { id: 'c1', name: 'Lopez Roofing LLC', emails: ['  MARIA@example.com '], people: ['Maria Lopez'], archived: false, lifecycle: 'active' },
    { id: 'c2', name: 'Acme Plumbing', emails: [null, 'office@acmeplumbing.com'], people: ['Bob Acme'], archived: false, lifecycle: 'onboarding' },
    { id: 'c3', name: 'Shoreline Decks', emails: ['owner@shorelinedecks.com'], people: [], archived: false, lifecycle: 'active' },
    { id: 'c4', name: 'Archived Co', emails: ['gone@archived.com'], people: [], archived: true, lifecycle: 'churned' },
  ]
  const subs = [
    plan.readSubscription(subscription()), // Maria, trialing
    plan.readSubscription(subscription({ id: 'sub_2', status: 'active', customer: { id: 'cus_2', object: 'customer', email: 'bob@gmail.com', name: 'Acme Plumbing', phone: null } })),
    plan.readSubscription(subscription({ id: 'sub_3', status: 'past_due', customer: { id: 'cus_3', object: 'customer', email: 'stranger@nowhere.com', name: 'Stranger Services', phone: null } })),
    plan.readSubscription(subscription({ id: 'sub_4', status: 'canceled', customer: 'cus_4', canceled_at: NOV_1, ended_at: NOV_1 })),
  ]
  const customers = [
    plan.readCustomer(customer()),
    plan.readCustomer(customer({ id: 'cus_2', email: 'bob@gmail.com', name: 'Acme Plumbing' })),
    plan.readCustomer(customer({ id: 'cus_3', email: 'stranger@nowhere.com', name: 'Stranger Services' })),
    plan.readCustomer(customer({ id: 'cus_4', email: 'gone@archived.com', name: null })),
    plan.readCustomer(customer({ id: 'cus_5', email: 'lead@shoreline-decks.com', name: 'Shoreline Decks Inc', delinquent: true })), // no subscription, name differs by suffix
  ]
  const m = plan.matchClients(clients, customers, subs)
  assert.equal(m.byClient.c1.matchedBy, 'email')
  assert.equal(m.byClient.c1.state, 'trialing')
  assert.equal(m.byClient.c1.subscription.id, 'sub_1')
  assert.equal(m.byClient.c2.matchedBy, 'name', 'Bob signed up with his Gmail, but the Stripe customer is named after the business')
  assert.equal(m.byClient.c2.state, 'active')
  assert.equal(m.byClient.c3.matchedBy, 'name', '"Shoreline Decks Inc" is "Shoreline Decks" once the suffix goes')
  assert.equal(m.byClient.c3.state, 'none', 'a customer with no subscription is still not a subscriber')
  assert.deepEqual(m.byClient.c3.customers.map((c) => c.id), ['cus_5'])
  assert.equal(m.byClient.c4.state, 'canceled', 'an archived client still matches, so the customer is not "lost"')
  assert.equal(m.byClient.c4.customers[0].id, 'cus_4')
  assert.deepEqual(m.unmatched.map((u) => u.customer.id), ['cus_3'])
  assert.equal(m.unmatched[0].state, 'problem')
  assert.equal(m.unmatched[0].suggestion, null)
})

test('a customer no client has gets a suggestion when one client shares its name, and an email never gets stolen by a name', () => {
  const clients = [
    { id: 'c1', name: 'Blue Sky Solar', emails: ['a@bluesky.com'], people: [], archived: false, lifecycle: 'active' },
    { id: 'c2', name: 'Blue Sky Roofing', emails: ['b@blueskyroofing.com'], people: [], archived: false, lifecycle: 'active' },
    { id: 'c3', name: 'Granite Masonry', emails: ['hello@granite.com'], people: ['Pat Granite'], archived: false, lifecycle: 'active' },
  ]
  const customers = [
    plan.readCustomer(customer({ id: 'cus_a', email: 'someone@else.com', name: 'Blue Sky' })), // two clients share these words: no suggestion
    plan.readCustomer(customer({ id: 'cus_b', email: 'pat@personal.com', name: 'Granite Masonry Co' })), // one client: suggested? no — matched by name outright
    plan.readCustomer(customer({ id: 'cus_c', email: 'HELLO@granite.com', name: 'Totally Different' })), // email wins over the odd name
  ]
  const m = plan.matchClients(clients, customers, [])
  assert.deepEqual(m.byClient.c3.customers.map((c) => c.id).sort(), ['cus_b', 'cus_c'])
  assert.equal(m.byClient.c3.matchedBy, 'email')
  assert.deepEqual(m.unmatched.map((u) => u.customer.id), ['cus_a'])
  assert.equal(m.unmatched[0].suggestion, null)
  const one = plan.matchClients([clients[2]], [plan.readCustomer(customer({ id: 'cus_d', email: 'x@y.com', name: 'Granite Masonry of Boston' }))], [])
  assert.equal(one.byClient.c3.state, 'none')
  assert.deepEqual(one.unmatched[0].suggestion, { clientId: 'c3', name: 'Granite Masonry' })
})

test('the summary: counts by status, MRR from active and past-due, what is due in 30 days, what is wrong', () => {
  const now = new Date('2026-11-18T12:00:00Z').getTime()
  const at = (days) => Math.floor((now + days * 86_400_000) / 1000)
  const read = (over) => plan.readSubscription(subscription(over))
  const subs = [
    read({ id: 'a', status: 'active', trial_end: null, items: { data: [{ price: price(), quantity: 1, current_period_end: at(10) }] } }),
    read({ id: 'b', status: 'active', trial_end: null, items: { data: [{ price: price(), quantity: 1, current_period_end: at(45) }] } }),
    read({ id: 'c', status: 'trialing', trial_end: at(5), items: { data: [{ price: price(), quantity: 1, current_period_end: at(5) }] } }),
    read({ id: 'd', status: 'past_due', items: { data: [{ price: price(), quantity: 1, current_period_end: at(-2) }] } }),
    read({ id: 'e', status: 'active', cancel_at_period_end: true, items: { data: [{ price: price(), quantity: 1, current_period_end: at(12) }] } }),
    read({ id: 'f', status: 'canceled', canceled_at: at(-3), ended_at: at(-3) }),
    read({ id: 'g', status: 'canceled', canceled_at: at(-60), ended_at: at(-60) }),
  ]
  const s = plan.summarize(subs, now)
  assert.equal(s.total, 7)
  assert.deepEqual(s.counts, { active: 3, trialing: 1, past_due: 1, canceled: 2 })
  assert.deepEqual(s.states, { active: 2, trialing: 1, problem: 1, ending: 1, canceled: 2 })
  assert.equal(s.mrrCents, 29700 * 4, 'active (incl. the one ending) and past due count, trials do not')
  assert.equal(s.trialMonthlyCents, 29700)
  assert.deepEqual(s.upcoming.map((u) => [u.subscription.id, u.kind]), [['c', 'first charge'], ['a', 'renewal']], 'soonest first; the one ending and the one 45 days out are not due')
  assert.equal(s.upcoming[0].amountCents, 29700)
  assert.deepEqual(s.problems.map((x) => x.id), ['d'])
  assert.deepEqual(s.ending.map((x) => x.id), ['e'])
  assert.deepEqual(s.canceledRecently.map((x) => x.id), ['f'])
  assert.deepEqual(plan.summarize([], now).states, { active: 0, trialing: 0, problem: 0, ending: 0, canceled: 0 })
})

test("a restricted key's refusal names the permission; anything else is not a denial", () => {
  const d = plan.readDenial({ path: '/charges?limit=100', status: 403, data: { error: { type: 'invalid_request_error', message: "You do not have the required permissions for this endpoint on this API key. Having the 'rak_charge_read' permission would allow this request to continue." } } })
  assert.equal(d.what, 'Charges (payments)')
  assert.equal(d.permission, 'rak_charge_read')
  assert.equal(plan.permissionLabel(d.permission), 'Charges: Read')
  assert.equal(plan.readDenial({ path: '/balance', status: 403, data: { error: { message: 'Forbidden' } } }).what, 'Balance')
  assert.equal(plan.readDenial({ path: '/balance_transactions?limit=100', status: 403, data: {} }).what, 'Balance transactions')
  assert.equal(plan.readDenial({ path: '/charges', status: 401, data: { error: { message: 'Invalid API Key provided' } } }), null, 'a bad key is not a missing permission')
  assert.equal(plan.readDenial({ path: '/charges', status: 500, data: {} }), null)
  assert.equal(plan.permissionLabel('rak_mystery_read'), 'rak_mystery_read', 'unknown ones show as Stripe names them')
  assert.equal(plan.permissionLabel(null), null)
})

test('keys: restricted and publishable are read-only to the Hub, only a full secret key is not', () => {
  // Assembled at runtime so no key-shaped string sits in the repo (GitHub's push protection reads them as real).
  const sample = (kind, mode) => [kind, mode, '51Tnjrv' + 'x'.repeat(30)].join('_')
  assert.deepEqual(plan.describeKey(sample('rk', 'live')), { kind: 'restricted', mode: 'live', readOnly: true })
  assert.deepEqual(plan.describeKey(sample('sk', 'test')), { kind: 'secret', mode: 'test', readOnly: false })
  assert.deepEqual(plan.describeKey(sample('pk', 'live')), { kind: 'publishable', mode: 'live', readOnly: true })
  assert.deepEqual(plan.describeKey('nonsense'), { kind: 'unknown', mode: null, readOnly: true })
})

test('Stripe Dashboard links land in the right account and mode', () => {
  assert.equal(plan.stripeLink('customer', 'cus_1', { accountId: 'acct_1Abc' }), 'https://dashboard.stripe.com/acct_1Abc/customers/cus_1')
  assert.equal(plan.stripeLink('subscription', 'sub_1', { accountId: null, livemode: false }), 'https://dashboard.stripe.com/test/subscriptions/sub_1')
  assert.equal(plan.stripeLink('invoice', 'in_1'), 'https://dashboard.stripe.com/invoices/in_1')
  assert.equal(plan.stripeLink('payment', 'pi_1', { accountId: 'acct_1Abc', livemode: true }), 'https://dashboard.stripe.com/acct_1Abc/payments/pi_1')
})

test('the chip on a client row says what matters next', () => {
  const read = (over) => plan.readSubscription(subscription(over))
  const label = (state, sub) => plan.billingLabel({ state, subscription: sub })
  assert.deepEqual(label('trialing', read({})), { text: 'Trial · $297/mo', detail: 'first charge Dec 17', tone: 'blue' })
  assert.deepEqual(label('active', read({ status: 'active' })), { text: 'Active · $297/mo', detail: 'renews Dec 17', tone: 'mint' })
  assert.deepEqual(label('problem', read({ status: 'past_due' })), { text: 'Past due · $297/mo', detail: 'Stripe is retrying the card', tone: 'pink' })
  assert.deepEqual(label('problem', read({ status: 'paused' })), { text: 'No card · $297/mo', detail: 'trial ended without a card', tone: 'pink' })
  assert.deepEqual(label('ending', read({ status: 'active', cancel_at_period_end: true })), { text: 'Ending', detail: 'ends Dec 17', tone: 'amber' })
  assert.deepEqual(label('canceled', read({ status: 'canceled', ended_at: DEC_17 })), { text: 'Canceled', detail: 'ended Dec 17', tone: 'amber' })
  assert.deepEqual(label('canceled', read({ status: 'incomplete_expired' })), { text: 'Never started', detail: null, tone: 'amber' })
  assert.deepEqual(plan.billingLabel(null), { text: 'Not in Stripe', detail: null, tone: 'muted' })
  assert.deepEqual(plan.billingLabel({ state: 'none', subscription: null }), { text: 'Not in Stripe', detail: null, tone: 'muted' })
})

// --- Nothing here writes to Stripe -----------------------------------------------------------

const READ_ONLY_FILES = [
  'src/lib/stripe-billing.ts',
  'src/lib/stripe-billing-plan.ts',
  'src/app/api/clients/subscriptions/route.ts',
  'src/app/api/payments/stripe/overview/route.ts',
  'src/components/clients/subscriptions-panel.tsx',
]

test('the subscription tracking only reads from Stripe: no POST, no refunds, no cancellations, no edits', () => {
  for (const file of READ_ONLY_FILES) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.ok(!/method:\s*['"`](POST|DELETE|PUT|PATCH)/i.test(source), `${file} sends a write to Stripe`)
    assert.ok(!/\/v1\/(refunds|invoiceitems)|\/refunds|\/cancel\b|\bdelete\(/i.test(source), `${file} touches a Stripe write path`)
    assert.ok(!/stripe\.com\/v1\/.*\bcreate\b/i.test(source), `${file} creates something in Stripe`)
  }
  // The Payments tab's write actions stay behind the full-secret-key check: a restricted key is refused before Stripe is asked.
  const actions = readFileSync(join(root, 'src/app/api/payments/stripe/actions/route.ts'), 'utf8')
  assert.match(actions, /vaultKey\.readOnly/, 'the actions route checks the key is not read-only')
  assert.ok(actions.indexOf('vaultKey.readOnly') < actions.indexOf("'/refunds'"), 'the read-only refusal comes before any refund')
  assert.ok(!actions.includes("'Stripe API Key'"), 'the old account\'s key is not read any more')
  const overview = readFileSync(join(root, 'src/app/api/payments/stripe/overview/route.ts'), 'utf8')
  assert.ok(!overview.includes("getSecretByName('Stripe API Key')"), 'the Payments page no longer reads the old account')
  const stripeTab = readFileSync(join(root, 'src/app/payments/stripe-tab.tsx'), 'utf8')
  assert.match(stripeTab, /canWrite\s*=\s*!ro/, 'write buttons depend on the key not being read-only')
})

test('the Payments page and the gate read the same Vault entries, the dashboard key first', () => {
  const billing = readFileSync(join(root, 'src/lib/stripe-billing.ts'), 'utf8')
  assert.match(billing, /STRIPE_PAYMENTS_KEY_ENTRIES = \[STRIPE_PAYMENTS_KEY_ENTRY, \.\.\.STRIPE_KEY_ENTRIES\]/)
  assert.match(billing, /STRIPE_PAYMENTS_KEY_ENTRY = 'Stripe Official Payments Key'/)
})
