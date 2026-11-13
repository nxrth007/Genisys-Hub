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

test('phone formats: any US form to E.164, and back', () => {
  for (const raw of ['+1 855-465-6514', '(855) 465-6514', '8554656514', '18554656514', '+1 (855) 465 6514']) assert.equal(plan.e164(raw), '+18554656514', raw)
  assert.equal(plan.e164('+44 7915 918658'), '')
  assert.equal(plan.e164(''), '')
  assert.equal(plan.e164(null), '')
  assert.equal(plan.displayNumber('+18554656514'), '(855) 465-6514')
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
  assert.equal(plan.parseBuyRow('Number Type Capabilities Price'), null)
})

test('pickTollFree: the first toll-free number at a price the job may pay', () => {
  const rows = [
    plan.parseBuyRow('+1 603-555-0101 Local $1.15'),
    null,
    plan.parseBuyRow('+1 888-555-0100 Toll Free $3.00'),
    plan.parseBuyRow('+1 855-465-6514 Toll Free None $2.15'),
  ]
  assert.equal(plan.pickTollFree(rows).number, '+18554656514')
  assert.equal(plan.pickTollFree(rows, 2), null)
  assert.equal(plan.pickTollFree([]), null)
  assert.equal(plan.MAX_TOLL_FREE_PRICE, 2.5)
})

test('identity check and the confirm buttons the job may press', () => {
  assert.ok(plan.isIdentityCheck('We need some information to help us confirm your identity. Begin verifying'))
  assert.ok(!plan.isIdentityCheck('Buy your Number 1 Number selected Total Amount: $ 2.15 Proceed to Buy'))
  for (const b of ['Buy', 'Buy Now', 'Confirm Purchase', 'Purchase']) assert.ok(plan.CONFIRM_BUY.test(b), b)
  // "Proceed to Buy" is pressed once on its own; the confirm loop must never press it again.
  for (const b of ['Proceed to Buy', 'Cancel', 'Add Number', 'Buy 2 numbers']) assert.ok(!plan.CONFIRM_BUY.test(b), b)
})

test('forwardingFrom: where a number rings, from its Edit Configuration', () => {
  assert.deepEqual(plan.forwardingFrom('Calls Go To Business Phone Number 3rd Priority +16035026226 External Phone Number +1 (603) 555-0101 Timeout 30'), {
    external: '+16035550101',
    business: '+16035026226',
  })
  assert.deepEqual(plan.forwardingFrom('External Phone Number Timeout 20 seconds'), { external: '', business: '' })
})

test('adoptable: the toll-free number already in the sub-account (bought during the ID check)', () => {
  assert.equal(plan.adoptable([{ number: '+16035550101', tollFree: false }, { number: '+18556762067', tollFree: true }]), '+18556762067')
  // A local number alone doesn't count: the client gets a toll-free one.
  assert.equal(plan.adoptable([{ number: '+16035550101', tollFree: false }]), null)
  assert.equal(plan.adoptable([]), null)
  assert.equal(plan.adoptable([{ number: '+44 7915 918658', tollFree: true }]), null)
})

test('daily cap', () => {
  assert.equal(plan.DAILY_BUY_CAP, 5)
  assert.ok(plan.underDailyCap(4))
  assert.ok(!plan.underDailyCap(5))
})
