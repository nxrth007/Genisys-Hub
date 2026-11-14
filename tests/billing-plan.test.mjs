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

const plan = loadTs(join(root, 'src/lib/hl/billing-plan.ts'))

const mem = (o = {}) => ({
  id: 'mem_1',
  status: 'active',
  customerName: null,
  customerEmail: 'Owner@Acme.com',
  customerUsername: null,
  productTitle: 'Genisys Growth System',
  renewalPrice: '$297.00 / month',
  joinedAt: '2026-10-01T15:00:00Z',
  periodEndsAt: '2026-12-01T15:00:00Z',
  cancelAtPeriodEnd: false,
  canceledAt: null,
  cancellationReason: null,
  ...o,
})
const pay = (o = {}) => ({
  id: 'pay_1',
  status: 'paid',
  substatus: null,
  createdAt: '2026-11-01T15:00:00Z',
  paidAt: '2026-11-01T15:00:05Z',
  total: 297,
  usdTotal: 297,
  afterFees: 280,
  refunded: 0,
  currency: 'usd',
  billingReason: 'subscription_cycle',
  customerName: null,
  customerEmail: 'owner@acme.com',
  customerUsername: null,
  productTitle: null,
  planId: null,
  membershipId: 'mem_1',
  membershipStatus: 'active',
  cardBrand: 'visa',
  cardLast4: '4242',
  ...o,
})
const q = (o = {}) => ({ membershipId: null, emails: ['owner@acme.com'], siteLive: true, ...o })
const now = new Date('2026-11-14T12:00:00Z')

test('the sign-up’s membership id is read from the journey note', () => {
  assert.equal(plan.membershipIdFrom('Whop membership mem_AbC123'), 'mem_AbC123')
  assert.equal(plan.membershipIdFrom('Implied by intake form'), null)
  assert.equal(plan.membershipIdFrom(null), null)
  assert.equal(plan.normEmail('  Owner@Acme.COM '), 'owner@acme.com')
  assert.equal(plan.normEmail('not an email'), null)
})

test('theirs: the sign-up’s membership first, else their email (paying before ended, then newest)', () => {
  const other = mem({ id: 'mem_2', customerEmail: 'someone@else.com' })
  assert.equal(plan.pickMembership([mem(), other], q({ membershipId: 'mem_2', emails: [] })).by, 'their Whop sign-up')
  const old = mem({ id: 'mem_old', status: 'canceled', joinedAt: '2026-12-01T00:00:00Z' })
  const pick = plan.pickMembership([old, mem()], q())
  assert.deepEqual([pick.m.id, pick.by, pick.others], ['mem_1', 'their email (owner@acme.com)', 1])
  assert.equal(plan.pickMembership([other], q()), null)
  assert.equal(plan.pickMembership([mem()], q({ emails: [] })), null)
})

test('a paying client: status, next charge, last payment, total and card', () => {
  const b = plan.billingOf([mem()], [pay(), pay({ id: 'pay_0', paidAt: '2026-10-01T15:00:05Z', createdAt: '2026-10-01T15:00:00Z' }), pay({ id: 'pay_x', membershipId: 'mem_9' })], q(), now)
  assert.deepEqual([b.label, b.tone, b.periodLabel, b.periodEndsAt], ['Paying', 'green', 'Next charge', '2026-12-01T15:00:00Z'])
  assert.deepEqual(b.lastPaid, { at: '2026-11-01T15:00:05Z', amount: 297, currency: 'usd' })
  assert.deepEqual([b.paidCount, b.paidUsd, b.refundedUsd], [2, 594, 0])
  assert.equal(b.card, 'Visa •••• 4242')
  assert.equal(b.warning, null)
})

test('the free month: its first charge, and a warning when it ends within a week with no live site', () => {
  const trial = mem({ status: 'trialing', periodEndsAt: '2026-11-18T15:00:00Z' })
  const open = pay({ status: 'open', paidAt: null })
  const b = plan.billingOf([trial], [open], q({ siteLive: false }), now)
  assert.deepEqual([b.label, b.periodLabel, b.paidCount, b.lastPaid], ['Free month', 'First charge', 0, null])
  assert.equal(b.warning, 'Their free month ends Nov 18 and their website isn’t live yet.')
  assert.equal(plan.billingOf([trial], [open], q({ siteLive: true }), now).warning, null)
  assert.equal(plan.billingOf([mem({ status: 'trialing', periodEndsAt: '2026-12-10T00:00:00Z' })], [], q({ siteLive: false }), now).warning, null)
})

test('past due, canceling and canceled read plainly', () => {
  const due = plan.billingOf([mem({ status: 'past_due' })], [], q(), now)
  assert.deepEqual([due.label, due.tone, due.warning], ['Past due', 'red', 'Their last charge didn’t go through.'])
  const ending = plan.billingOf([mem({ cancelAtPeriodEnd: true, cancellationReason: 'Too expensive' })], [], q(), now)
  assert.deepEqual([ending.label, ending.periodLabel], ['Canceling', 'Ends'])
  assert.equal(ending.warning, 'Set to cancel: it ends Dec 1 (“Too expensive”).')
  const gone = plan.billingOf([mem({ status: 'canceled', canceledAt: '2026-11-02T00:00:00Z' })], [], q(), now)
  assert.deepEqual([gone.label, gone.tone, gone.periodLabel, gone.periodEndsAt], ['Canceled', 'gray', null, null])
})

test('payments without a membership id are matched by email; refunds are counted apart', () => {
  const b = plan.billingOf([mem()], [pay({ membershipId: null, refunded: 297 }), pay({ id: 'p2', membershipId: null, customerEmail: 'x@y.com' })], q(), now)
  assert.deepEqual([b.paidCount, b.paidUsd, b.refundedUsd], [1, 297, 297])
})
