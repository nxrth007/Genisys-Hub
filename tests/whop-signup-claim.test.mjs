import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/whop-signup-claim.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const m = { exports: {} }
runInThisContext(`(function(require, module, exports) {${outputText}\n})`)(() => { throw new Error('no deps') }, m, m.exports)
const { claimSignup, isUniqueViolation } = m.exports

/** Fake of the WhopSignupClaim table: a primary key, async like a DB, throws P2002 on duplicates. */
function fakeTable() {
  const rows = new Map()
  const create = async (id, source) => {
    await new Promise((r) => setTimeout(r, Math.random() * 5))
    if (rows.has(id)) { const e = new Error('Unique constraint failed'); e.code = 'P2002'; throw e }
    rows.set(id, source)
  }
  const store = {
    async insertIfAbsent(id, source) {
      try { await create(id, source); return true } catch (e) { if (isUniqueViolation(e)) return false; throw e }
    },
  }
  return { rows, store }
}

/** Mimics both callers: announce only if the claim is won. */
function announcer(store) {
  const texts = []
  const announce = async (id, source) => { if (await claimSignup(store, id, source)) texts.push(`${source}:${id}`) }
  return { texts, announce }
}

test('webhook then poll: one text, from the webhook', async () => {
  const { store, rows } = fakeTable()
  const a = announcer(store)
  await a.announce('mem_1', 'webhook')
  await a.announce('mem_1', 'poll')
  assert.deepEqual(a.texts, ['webhook:mem_1'])
  assert.equal(rows.get('mem_1'), 'webhook')
})

test('poll then webhook: one text, from the poll; webhook does not overwrite', async () => {
  const { store, rows } = fakeTable()
  const a = announcer(store)
  await a.announce('mem_2', 'poll')
  await a.announce('mem_2', 'webhook')
  assert.deepEqual(a.texts, ['poll:mem_2'])
  assert.equal(rows.get('mem_2'), 'poll')
})

test('concurrent claims -> exactly one announcement', async () => {
  for (let round = 0; round < 20; round++) {
    const { store } = fakeTable()
    const a = announcer(store)
    await Promise.all(Array.from({ length: 10 }, (_, i) => a.announce('mem_3', i % 2 ? 'poll' : 'webhook')))
    assert.equal(a.texts.length, 1)
  }
})

test('different memberships are each announced; blank id never', async () => {
  const { store } = fakeTable()
  const a = announcer(store)
  await Promise.all([a.announce('mem_a', 'poll'), a.announce('mem_b', 'webhook'), a.announce('  ', 'poll')])
  assert.equal(a.texts.length, 2)
})

test('non-unique errors propagate', async () => {
  const store = { insertIfAbsent: async () => { throw Object.assign(new Error('db down'), { code: 'P1001' }) } }
  await assert.rejects(claimSignup(store, 'mem_x', 'poll'), /db down/)
  assert.equal(isUniqueViolation({ code: 'P2002' }), true)
  assert.equal(isUniqueViolation(null), false)
})
