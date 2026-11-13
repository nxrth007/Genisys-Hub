import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// The daily read of each linked client's GHL numbers (src/lib/ghl-number/census-plan.ts).
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const m = { exports: {} }
  cache.set(absPath, m.exports)
  const req = (id) => (id.startsWith('.') ? loadTs(join(dirname(absPath), `${id}.ts`)) : {})
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  cache.set(absPath, m.exports)
  return m.exports
}
const plan = loadTs(join(root, 'src/lib/ghl-number/census-plan.ts'))

test("a Manage Numbers row: the number, toll-free or local, GHL's tags; headers and buy rows aren't numbers", () => {
  assert.deepEqual(plan.parseNumberRow("+1 855-389-5833 Default Number Verification Required Toll Free Ethan's number 20 s"), {
    number: '+18553895833',
    tollFree: true,
    verificationRequired: true,
    isDefault: true,
  })
  assert.deepEqual(plan.parseNumberRow("+1 903-484-1901 Default Number Local Ethan's number 20 s"), {
    number: '+19034841901',
    tollFree: false,
    verificationRequired: false,
    isDefault: true,
  })
  assert.equal(plan.parseNumberRow('Numbers Friendly Name Forwarding Number Call Timeout'), null)
  assert.equal(plan.parseNumberRow('+1 855-419-5954 Toll Free None $2.15'), null)
})

test('what a loaded page says: numbers, none, no phone system; still loading is null', () => {
  const rows = ["+1 855-389-5833 Default Number Verification Required Toll Free Ethan's number 20 s", "+1 855-389-5833 Default Number Toll Free", 'Numbers Friendly Name']
  assert.deepEqual(plan.censusFromPage('Manage Numbers …', rows), {
    state: 'has',
    numbers: [{ number: '+18553895833', tollFree: true, verificationRequired: true, isDefault: true }],
  })
  assert.deepEqual(plan.censusFromPage('Manage Numbers Manage your Phone Numbers … Numbers Friendly Name Forwarding Number Call Timeout No Data', ['Numbers Friendly Name Forwarding Number Call Timeout']), {
    state: 'none',
    numbers: [],
  })
  assert.deepEqual(plan.censusFromPage('Manage Numbers Your phone system requires configuration Please reach out to our support team for assistance.', []), { state: 'unavailable', numbers: [] })
  assert.equal(plan.censusFromPage('Phone System Loading…', []), null)
})

test('who is read next: never read or re-linked first, then everything due oldest first (failed after two hours, good after a day)', () => {
  const NOW = Date.UTC(2026, 10, 13, 12)
  const h = (n) => new Date(NOW - n * 60 * 60_000)
  const row = (locationId, checkedAt, triedAt = checkedAt) => ({ locationId, state: checkedAt ? 'has' : 'error', checkedAt, triedAt })
  const clients = [
    { id: 'fresh', locationId: 'L1', census: null },
    { id: 'relinked', locationId: 'L2', census: row('OLD', h(1)) },
    { id: 'recent', locationId: 'L3', census: row('L3', h(3)) },
    { id: 'stale', locationId: 'L4', census: row('L4', h(30)) },
    { id: 'staler', locationId: 'L5', census: row('L5', h(48)) },
    { id: 'failedJustNow', locationId: 'L6', census: row('L6', h(30), h(1)) },
    { id: 'failedEarlier', locationId: 'L7', census: row('L7', h(30), h(3)) },
    { id: 'neverWorked', locationId: 'L8', census: row('L8', null, h(5)) },
  ]
  assert.deepEqual(plan.dueForCensus(clients, NOW, 20), ['fresh', 'relinked', 'staler', 'stale', 'neverWorked', 'failedEarlier'])
  assert.deepEqual(plan.dueForCensus(clients, NOW, 3), ['fresh', 'relinked', 'staler'])
  assert.deepEqual(plan.dueForCensus([{ id: 'recent', locationId: 'L3', census: row('L3', h(3)) }], NOW), [])
})

test("what Echo's question goes by: only a read of the linked sub-account counts", () => {
  assert.equal(plan.askView(null, null), null)
  assert.equal(plan.askView(null, 'L1'), 'unchecked')
  assert.equal(plan.askView({ locationId: 'OLD', state: 'has' }, 'L1'), 'unchecked')
  assert.equal(plan.askView({ locationId: 'L1', state: 'has' }, 'L1'), 'has')
  assert.equal(plan.askView({ locationId: 'L1', state: 'none' }, 'L1'), 'none')
  assert.equal(plan.askView({ locationId: 'L1', state: 'unavailable' }, 'L1'), 'unavailable')
  assert.equal(plan.askView({ locationId: 'L1', state: 'error' }, 'L1'), 'unchecked')
})

test("a client's phone, for Sites: Hell-level first (Forte), then a number in GHL, a question under way, none, no phone system", () => {
  const p = (o) => plan.phoneState({ hlNumber: false, request: null, census: null, ...o })
  assert.equal(p({ hlNumber: true, census: 'none' }), 'hell_level')
  assert.equal(p({ request: { status: 'bought', route: 'ghl' } }), 'ghl')
  assert.equal(p({ request: { status: 'bought', route: 'hl' } }), 'hell_level')
  assert.equal(p({ census: 'has' }), 'ghl')
  assert.equal(p({ census: 'has', request: { status: 'declined', route: 'hl' } }), 'ghl')
  assert.equal(p({ census: 'none', request: { status: 'awaiting_approval', route: 'hl' } }), 'asked')
  assert.equal(p({ census: 'none', request: { status: 'ghl_working', route: 'ghl' } }), 'asked')
  assert.equal(p({ census: 'none' }), 'needs')
  assert.equal(p({ census: 'none', request: { status: 'declined', route: 'hl' } }), 'needs')
  assert.equal(p({ census: 'unavailable' }), 'no_phone_system')
  assert.equal(p({ census: 'error' }), 'unchecked')
  assert.equal(p({}), 'unchecked')
})

test('saved numbers are read back safely', () => {
  assert.deepEqual(plan.readCensusNumbers([{ number: '+18553895833', tollFree: true, verificationRequired: true, isDefault: false }, { number: '' }, null, 'x']), [
    { number: '+18553895833', tollFree: true, verificationRequired: true, isDefault: false },
  ])
  assert.deepEqual(plan.readCensusNumbers(null), [])
  assert.deepEqual(plan.readCensusNumbers({}), [])
  assert.equal(plan.currentCensus({ locationId: 'L1' }, 'L2'), null)
  assert.deepEqual(plan.currentCensus({ locationId: 'L1' }, 'L1'), { locationId: 'L1' })
})
