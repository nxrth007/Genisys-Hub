import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

/**
 * The sign-up announcement (src/lib/stripe-signup-alerts.ts), shared by the
 * Stripe webhook and the five-minute poll of Stripe. The real module runs with
 * a fake database, Stripe, GHL and Slack, so the test sees exactly what would
 * have been texted.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadTs(relPath, stubs = {}) {
  const absPath = join(root, relPath)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const real = createRequire(pathToFileURL(absPath))
  const m = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, (spec) => (spec in stubs ? stubs[spec] : real(spec)))
  return m.exports
}

const plan = loadTs('src/lib/stripe-onboarding-plan.ts')

class StripeUnavailable extends Error {}

/** The module with fakes. `sessions` is what Stripe's checkout list returns (a function may throw). */
function setup({ sessions = { data: [] }, member = null } = {}) {
  const store = new Map()
  const texts = []
  const slack = []
  const prisma = {
    appSetting: {
      findUnique: async ({ where }) => (store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null),
      upsert: async ({ where, create, update }) => {
        store.set(where.key, store.has(where.key) ? update.value : create.value)
        return {}
      },
      findMany: async ({ where }) => where.key.in.filter((k) => store.has(k)).map((key) => ({ key })),
    },
    client: { findFirst: async () => null },
  }
  const state = { sessions }
  const alerts = loadTs('src/lib/stripe-signup-alerts.ts', {
    '@/lib/prisma': { prisma },
    '@/lib/hub-alerts': { hubAlert: async (text) => void slack.push(text), hubLink: (path) => `https://hub.example${path}` },
    '@/lib/client-journey': { recordJourney: async (_label, fn) => fn(), setJourneyStage: async () => {} },
    '@/lib/onboarding-tracker': { markTrackerStep: async () => ({ ok: true }) },
    '@/lib/team-sms': { textTeam: async (message, label) => (texts.push({ message, label }), []) },
    '@/lib/stripe-onboarding': {
      checkoutMember: async () => member ?? { valid: false, reason: 'not looked up in this test' },
      claimStripeSignup: async (id) => {
        const key = `stripe.signup:${id}`
        if (store.has(key)) return false
        store.set(key, new Date().toISOString())
        return true
      },
      noteStripeStatus: async () => {},
      rememberMember: async () => ({}),
      recentCheckoutSessions: async () => (typeof state.sessions === 'function' ? state.sessions() : state.sessions),
      StripeUnavailable,
    },
    '@/lib/stripe-onboarding-plan': plan,
  })
  return { alerts, store, texts, slack, state }
}

/** Only the live Hub texts anyone: run `fn` as if in production. */
async function inProduction(fn) {
  const was = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    return await fn()
  } finally {
    if (was === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = was
  }
}

const news = (over = {}) => ({ kind: 'signup', eventId: 'evt_1', sessionId: 'cs_live_1', customerId: 'cus_1', subscriptionId: 'sub_1', email: 'maria@example.com', name: 'Maria Lopez', phone: null, livemode: true, at: new Date().toISOString(), ...over })
const seconds = (ms) => Math.floor(ms / 1000)

test('the webhook and the poll seeing the same checkout text the team once', async () => {
  const { alerts, texts } = setup()
  await inProduction(async () => {
    assert.equal(await alerts.announceSignup(news(), 'webhook'), true)
    assert.equal(await alerts.announceSignup(news({ eventId: 'poll:cs_live_1' }), 'poll'), false)
    assert.equal(await alerts.announceSignup(news({ eventId: 'evt_1_retry' }), 'webhook'), false, "Stripe's retry of the same checkout")
  })
  assert.equal(texts.length, 1)
  assert.equal(texts[0].label, 'Stripe sign-up')
  assert.match(texts[0].message, /^Genisys: New sign-up! Maria Lopez \(maria@example\.com\) started the free trial\./)
})

test('a sign-up delivered two days late is texted as late, with when it happened', async () => {
  const member = { valid: true, email: 'gtc@example.com', name: 'Terell Collin Gray', phone: null, customerId: 'cus_9', subscriptionId: 'sub_9', subscriptionStatus: 'trialing', trialEnd: '2026-12-18T14:29:58.000Z', periodEnd: null, price: '$297/mo', livemode: true, startedAt: '2026-11-18T14:29:58.000Z' }
  const { alerts, texts, slack } = setup({ member })
  await inProduction(() => alerts.announceSignup(news({ sessionId: 'cs_live_9', at: null }), 'webhook'))
  assert.equal(texts.length, 1)
  assert.match(texts[0].message, /^Genisys: Late sign-up alert\. Terell Collin Gray \(gtc@example\.com\) started the free trial of \$297\/mo on Nov 18 at 9:29 AM ET; first charge Dec 18\./)
  assert.match(slack[0], /signed up Nov 18 at 9:29 AM ET; this alert is late/)
})

test('test-mode checkouts and a Hub outside production never text', async () => {
  const live = setup()
  await inProduction(() => live.alerts.announceSignup(news({ livemode: false, sessionId: 'cs_test_1' }), 'webhook'))
  assert.equal(live.texts.length, 0)
  const dev = setup()
  await dev.alerts.announceSignup(news(), 'webhook')
  assert.equal(dev.texts.length, 0)
  assert.equal(await dev.alerts.maybePollStripeSignups({ force: true }), 0)
})

test('the poll starts by noting the time, then texts only completed live checkouts nobody announced', async () => {
  const { alerts, store, texts, slack, state } = setup()
  await inProduction(async () => {
    assert.equal(await alerts.maybePollStripeSignups({ force: true }), 0, 'the first run only notes the time')
    assert.equal(texts.length, 0)
    const since = Date.parse(JSON.parse(store.get('stripe.signupPoll')).since)
    assert.ok(Math.abs(since - Date.now()) < 10_000)

    const after = seconds(since + 60_000)
    const checkout = (id, over = {}) => ({ id, object: 'checkout.session', mode: 'subscription', status: 'complete', livemode: true, created: after, customer: `cus_${id}`, subscription: `sub_${id}`, customer_details: { email: `${id}@example.com`, name: `Person ${id}` }, ...over })
    state.sessions = {
      data: [
        checkout('new'),
        checkout('webhooked'),
        checkout('before', { created: seconds(Date.parse('2026-11-18T14:29:58Z')) }),
        checkout('open', { status: 'open' }),
        checkout('payment', { mode: 'payment' }),
      ],
    }
    store.set('stripe.signup:webhooked', 'announced by the webhook')
    assert.equal(await alerts.maybePollStripeSignups({ force: true }), 1)
    assert.equal(await alerts.maybePollStripeSignups({ force: true }), 0, 'a second look finds nothing new')
  })
  assert.equal(texts.length, 1)
  assert.match(texts[0].message, /^Genisys: New sign-up! Person new \(new@example\.com\)/)
  assert.match(slack[0], /found by the Hub’s own check of Stripe/)
})

test('a poll Stripe cannot answer says so in the log and returns quietly', async () => {
  const { alerts, state } = setup()
  const warn = console.warn
  const warned = []
  console.warn = (...args) => void warned.push(args.join(' '))
  try {
    await inProduction(async () => {
      await alerts.maybePollStripeSignups({ force: true })
      state.sessions = () => {
        throw new StripeUnavailable('the Vault has no "Stripe Official Restricted"')
      }
      assert.equal(await alerts.maybePollStripeSignups({ force: true }), 0)
    })
  } finally {
    console.warn = warn
  }
  assert.ok(warned.some((w) => /Stripe Official Restricted/.test(w)))
})
