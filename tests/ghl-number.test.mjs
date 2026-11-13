import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()

function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const source = readFileSync(absPath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  const localRequire = createRequire(pathToFileURL(absPath))
  const req = (id) => {
    if (id.startsWith('.')) return loadTs(join(dirname(absPath), id.endsWith('.ts') ? id : `${id}.ts`))
    if (id.startsWith('@/')) {
      const rel = id.slice(2)
      return loadTs(join(root, 'src', rel.endsWith('.ts') ? rel : `${rel}.ts`))
    }
    return localRequire(id)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  cache.set(absPath, m.exports)
  return m.exports
}

const plan = loadTs(join(root, 'src/lib/ghl-number/plan.ts'))
const alertText = loadTs(join(root, 'src/lib/ghl-subaccount-worker/alert-text.ts'))

test('phone formats: any US form to E.164, and back to how Move Numbers lists it', () => {
  for (const raw of ['+1 855-465-6514', '(855) 465-6514', '8554656514', '18554656514', '+1 (855) 465 6514']) assert.equal(plan.e164(raw), '+18554656514', raw)
  assert.equal(plan.e164('+44 7915 918658'), '')
  assert.equal(plan.e164('555-1234'), '')
  assert.equal(plan.e164(''), '')
  assert.equal(plan.e164(null), '')
  assert.equal(plan.displayNumber('+18554656514'), '(855) 465-6514')
  assert.equal(plan.displayNumber('8554656514'), '(855) 465-6514')
  assert.equal(plan.displayNumber('not a number'), 'not a number')
})

test('buy list rows: number, type and price as GHL shows them', () => {
  assert.deepEqual(plan.parseBuyRow('+1 855-465-6514   Toll Free  None  $2.15'), {
    number: '+18554656514',
    type: 'Toll Free',
    price: 2.15,
    text: '+1 855-465-6514 Toll Free None $2.15',
  })
  assert.equal(plan.parseBuyRow('+1 603-555-0101 Local Boston, MA SMS Voice $1.15').type, 'Local')
  assert.equal(plan.parseBuyRow('+1 603-555-0101 Local').price, null)
  assert.equal(plan.parseBuyRow('Number Type Capabilities Price'), null)
  assert.equal(plan.parseBuyRow('+44 7915 918658 Mobile $4.00'), null)
})

test('pickTollFree: the first toll-free number at a price the job may pay', () => {
  const rows = [
    plan.parseBuyRow('+1 603-555-0101 Local $1.15'),
    null,
    plan.parseBuyRow('+1 888-555-0100 Toll Free $3.00'),
    plan.parseBuyRow('+1 877-555-0102 Toll Free'),
    plan.parseBuyRow('+1 855-465-6514 Toll Free None $2.15'),
    plan.parseBuyRow('+1 833-555-0103 Toll Free None $2.15'),
  ]
  assert.equal(plan.pickTollFree(rows).number, '+18554656514')
  assert.equal(plan.pickTollFree(rows, 2), null)
  assert.equal(plan.pickTollFree([]), null)
  assert.equal(plan.pickTollFree([plan.parseBuyRow('+1 855-465-6514 Toll Free $0')]), null)
  assert.equal(plan.MAX_TOLL_FREE_PRICE, 2.5)
})

test('identity check and the buttons the job may press', () => {
  assert.ok(plan.isIdentityCheck('We need some information to help us confirm your identity. Begin verifying'))
  assert.ok(plan.isIdentityCheck('Identity verification is powered by Persona, our vendor'))
  assert.ok(!plan.isIdentityCheck('Buy your Number 1 Number selected Total Amount: $ 2.15 Proceed to Buy'))

  for (const b of ['Buy', 'Buy Now', 'Confirm Purchase', 'Confirm & Buy', 'Purchase']) assert.ok(plan.CONFIRM_BUY.test(b), b)
  // "Proceed to Buy" is pressed once on its own; the confirm loop must never press it again.
  for (const b of ['Proceed to Buy', 'Cancel', 'Add Number', 'Buy your Number', 'Buy 2 numbers']) assert.ok(!plan.CONFIRM_BUY.test(b), b)

  for (const b of ['Move', 'Move Numbers', 'Move number', 'Confirm', 'Yes', 'Continue']) assert.ok(plan.CONFIRM_MOVE.test(b), b)
  for (const b of ['Cancel', 'No', 'Move numbers to another account']) assert.ok(!plan.CONFIRM_MOVE.test(b), b)
})

test('forwardingFrom: where a number rings, from its Edit Configuration', () => {
  assert.deepEqual(plan.forwardingFrom('Calls Go To Business Phone Number 3rd Priority +16035026226 External Phone Number +1 (603) 555-0101 Timeout 30'), {
    external: '+16035550101',
    business: '+16035026226',
  })
  assert.deepEqual(plan.forwardingFrom('External Phone Number Timeout 20 seconds'), { external: '', business: '' })
  assert.deepEqual(plan.forwardingFrom('Nothing here'), { external: '', business: '' })
})

test('autoNumberDecision: only new sub-accounts the Hub made after asking was switched on', () => {
  const since = new Date('2026-11-12T00:00:00Z')
  const after = new Date('2026-11-13T00:00:00Z')
  const base = {
    archived: false,
    locationId: 'loc1',
    subaccountJob: { status: 'succeeded', locationId: 'loc1', detail: 'Created "Acme Roofing"', finishedAt: after },
    job: null,
    autoSince: since,
  }
  assert.deepEqual(plan.autoNumberDecision(base), { queue: true, reason: 'its sub-account is ready' })
  assert.equal(plan.autoNumberDecision({ ...base, archived: true }).queue, false)
  assert.equal(plan.autoNumberDecision({ ...base, autoSince: null }).reason, 'automatic numbers are off')
  assert.equal(plan.autoNumberDecision({ ...base, locationId: null }).queue, false)
  assert.equal(plan.autoNumberDecision({ ...base, subaccountJob: null }).queue, false)
  assert.equal(plan.autoNumberDecision({ ...base, subaccountJob: { ...base.subaccountJob, status: 'needs_human' } }).queue, false)
  assert.equal(plan.autoNumberDecision({ ...base, subaccountJob: { ...base.subaccountJob, locationId: 'other' } }).queue, false)
  assert.equal(
    plan.autoNumberDecision({ ...base, subaccountJob: { ...base.subaccountJob, detail: 'Linked the existing sub-account "Acme"' } }).reason,
    'the sub-account was made by hand',
  )
  assert.equal(plan.autoNumberDecision({ ...base, subaccountJob: { ...base.subaccountJob, finishedAt: new Date('2026-11-01T00:00:00Z') } }).queue, false)
  assert.equal(plan.autoNumberDecision({ ...base, job: { status: 'succeeded' } }).reason, 'it already has its number')
  assert.equal(plan.autoNumberDecision({ ...base, job: { status: 'declined' } }).queue, false)
})

test('daily cap', () => {
  assert.equal(plan.DAILY_BUY_CAP, 5)
  assert.ok(plan.underDailyCap(0))
  assert.ok(plan.underDailyCap(4))
  assert.ok(!plan.underDailyCap(5))
  assert.ok(!plan.underDailyCap(9))
})

test('number texts: plain, short, and each one links to where to act', () => {
  const link = 'https://hub.example/office'
  const kinds = ['approve', 'bought', 'id_check', 'needs_human', 'failed', 'cap', 'stuck', 'waiting']
  for (const k of kinds) {
    const t = alertText.numberAlertText(k, 'Acme Roofing', k === 'bought' ? '(855) 465-6514' : 'GHL showed something new', link)
    assert.ok(t.startsWith('Genisys Hub: '), k)
    assert.ok(t.includes('Acme Roofing'), k)
    assert.ok(t.endsWith(link), k)
    assert.ok(t.length <= 320, `${k} is ${t.length} chars`)
  }
  assert.match(alertText.numberAlertText('approve', 'Acme Roofing', '', link), /Approve its toll-free number \(about \$2\.15\/mo\) in the Office/)
  assert.match(alertText.numberAlertText('bought', 'Acme Roofing', '(855) 465-6514', link), /bought \(855\) 465-6514 for Acme Roofing/)
  assert.match(alertText.numberAlertText('id_check', 'Acme Roofing', '', link), /one-time ID check/)
})
