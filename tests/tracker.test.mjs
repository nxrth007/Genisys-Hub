import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// Transpile a src module and run it with stubbed dependencies (no DB, no Google).
function loadSource(path, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const m = { exports: {} }
  const load = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    throw new Error(`Unexpected dependency: ${name}`)
  }
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename: path })(load, m, m.exports)
  return m.exports
}

const cols = loadSource('lib/tracker/columns.ts')
const tok = loadSource('lib/tracker/token.ts', { 'node:crypto': crypto })

const HEADERS = ['Client Name', 'Business', 'Contact Email', 'Start Date', 'Sign-Up Link Completed', 'Intake Form Completed', 'Automations Configuration', 'A2P Submitted', 'Notes']

test('step cells map to statuses', () => {
  for (const v of ['✅', 'TRUE', 'yes', 'Done', 'x', '✔']) assert.equal(cols.parseStepCell(v).status, 'done', v)
  for (const v of ['❌', 'FALSE', 'no', '', null, undefined]) assert.deepEqual(cols.parseStepCell(v), { status: 'pending', unrecognised: null })
  assert.deepEqual(cols.parseStepCell('waiting on EIN'), { status: 'pending', unrecognised: 'waiting on EIN' })
})

test('sheet parsing finds columns by header, keeps extras, skips blank rows', () => {
  const values = [
    HEADERS,
    ['Jane Doe', 'Acme Roofing LLC', 'Jane@Acme.com ', '10/01/2026', '✅', '✅', '❌', 'in review', 'VIP'],
    ['', '', '', '', '', '', '', '', ''],
    ['Bob', 'Bob Lawn', '', '', 'TRUE'],
  ]
  const p = cols.parseTrackerSheet(values)
  assert.deepEqual(p.presentSteps, ['signup', 'intake', 'automations', 'a2p'])
  assert.deepEqual(p.missingHeaders, ['Toll-Free Submitted'])
  assert.equal(p.rows.length, 2)
  const [a, b] = p.rows
  assert.equal(a.row, 2)
  assert.equal(a.contactEmail, 'jane@acme.com')
  assert.deepEqual(a.steps, { signup: 'done', intake: 'done', automations: 'pending', a2p: 'pending' })
  assert.deepEqual(a.extra, { 'A2P Submitted': 'in review', Notes: 'VIP' })
  assert.equal(b.row, 4)
  assert.equal(b.steps.signup, 'done')
  assert.equal(b.steps.intake, 'pending')
})

test('header order does not matter', () => {
  const p = cols.parseTrackerSheet([['a2p submitted', 'business'], ['✅', 'Zed Co']])
  assert.equal(p.rows[0].business, 'Zed Co')
  assert.equal(p.rows[0].steps.a2p, 'done')
})

const clients = [
  { id: 'c1', emails: ['jane@acme.com'], businesses: ['Acme Roofing'], names: ['Jane Doe'] },
  { id: 'c2', emails: [null], businesses: ['Bob Lawn'], names: ['Bob'] },
  { id: 'c3', emails: [], businesses: ['Twin Co'], names: [] },
  { id: 'c4', emails: [], businesses: ['Twin Co LLC'], names: [] },
]

test('client matching: email, then business, then name; never guesses', () => {
  assert.deepEqual(cols.matchClient({ contactEmail: 'JANE@acme.com', business: null, clientName: null }, clients), { clientId: 'c1', by: 'email' })
  assert.deepEqual(cols.matchClient({ contactEmail: null, business: 'The Acme Roofing, Inc.', clientName: null }, clients), { clientId: 'c1', by: 'business' })
  assert.deepEqual(cols.matchClient({ contactEmail: null, business: null, clientName: 'bob' }, clients), { clientId: 'c2', by: 'name' })
  const amb = cols.matchClient({ contactEmail: null, business: 'twin co', clientName: null }, clients)
  assert.equal(amb.clientId, null)
  assert.equal(amb.reason, 'ambiguous')
  assert.deepEqual(cols.matchClient({ contactEmail: 'x@y.z', business: 'Nobody', clientName: 'Nope' }, clients), { clientId: null, reason: 'none' })
})

function apply(existing, ops) {
  const out = existing.map((e) => ({ ...e }))
  for (const op of ops) {
    if (op.kind === 'create') out.push({ clientId: op.clientId, ...op.data })
    if (op.kind === 'update') Object.assign(out.find((e) => e.clientId === op.clientId), op.data)
  }
  return out
}

test('backfill is idempotent, only ticks forward, never creates clients', () => {
  const sheet = cols.parseTrackerSheet([
    HEADERS,
    ['Jane Doe', 'Acme Roofing', 'jane@acme.com', '10/01/2026', '✅', '❌', '', '', ''],
    ['Bob', 'Bob Lawn', '', '', '❌', '✅'],
    ['Jane again', 'Acme Roofing', 'jane@acme.com', '', '✅'],
    ['Ghost', 'Ghost LLC', 'ghost@x.com', '', '✅'],
  ])
  const existing = [{
    clientId: 'c2', clientName: 'Bobby (edited in Hub)', business: null, contactEmail: null, startDate: null,
    signupStatus: 'done', intakeStatus: 'pending', automationsStatus: 'pending', a2pStatus: 'pending', tollFreeStatus: 'pending', extra: null, sheetRow: null,
  }]
  const ops = cols.planBackfill(sheet, clients, existing)
  const kinds = ops.map((o) => `${o.kind}:${o.sheetRow}`)
  assert.deepEqual(kinds, ['create:2', 'update:3', 'unmatched:4', 'unmatched:5'])
  assert.equal(ops[0].data.signupStatus, 'done')
  assert.deepEqual(ops[0].doneSteps, ['signup'])
  // Hub "done" signup isn't undone by ❌; Hub name edit wins; blanks filled.
  assert.deepEqual(ops[1].data, { business: 'Bob Lawn', intakeStatus: 'done', sheetRow: 3 })
  assert.equal(ops[2].reason, 'duplicate_row')
  assert.equal(ops[3].reason, 'none')

  const after = apply(existing, ops)
  const again = cols.planBackfill(sheet, clients, after)
  assert.deepEqual(again.map((o) => o.kind), ['unchanged', 'unchanged', 'unmatched', 'unmatched'])
})

test('safe status view exposes only stage, statuses, next step', () => {
  const v = cols.safeStatusView({ business: 'Acme', signupStatus: 'done', intakeStatus: 'done', automationsStatus: 'pending', a2pStatus: 'done', tollFreeStatus: 'pending', updatedAt: new Date('2026-10-28T00:00:00Z'), contactEmail: 'secret@x.com', extra: { Notes: 'internal' } })
  assert.deepEqual(Object.keys(v).sort(), ['business', 'currentStage', 'nextStep', 'steps', 'updatedAt'])
  assert.equal(v.currentStage, 'Automations set up')
  assert.equal(v.steps.length, 5)
  assert.ok(!JSON.stringify(v).includes('secret@x.com'))
  assert.ok(!JSON.stringify(v).includes('internal'))
  const all = cols.safeStatusView({ business: 'A', signupStatus: 'done', intakeStatus: 'done', automationsStatus: 'done', a2pStatus: 'done', tollFreeStatus: 'done', updatedAt: new Date() })
  assert.equal(all.currentStage, null)
})

test('status tokens sign and verify; tampering, wrong nonce and missing secret fail', () => {
  const secret = 'x'.repeat(32)
  const nonce = tok.newNonce()
  const t = tok.signStatusToken('cmclient12345', nonce, secret)
  assert.equal(tok.tokenClientId(t), 'cmclient12345')
  assert.equal(tok.verifyStatusToken(t, nonce, secret), true)
  assert.equal(tok.verifyStatusToken(t, tok.newNonce(), secret), false) // rotated
  assert.equal(tok.verifyStatusToken(t, null, secret), false) // revoked
  assert.equal(tok.verifyStatusToken(t, nonce, 'y'.repeat(32)), false)
  assert.equal(tok.verifyStatusToken(t, nonce, null), false)
  assert.equal(tok.verifyStatusToken(t.replace('cmclient12345', 'cmclient12346'), nonce, secret), false)
  assert.equal(tok.verifyStatusToken(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'), nonce, secret), false)
  assert.equal(tok.tokenClientId('garbage'), null)
  assert.equal(tok.linkSecret({}), null)
  assert.equal(tok.linkSecret({ AUTH_SECRET: 'short' }), null)
  assert.equal(tok.linkSecret({ TRACKER_LINK_SECRET: secret, AUTH_SECRET: 'z'.repeat(20) }), secret)
})
