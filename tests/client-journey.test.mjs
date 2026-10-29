import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// Transpile a src module and run it with stubbed dependencies (no DB, no GHL).
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

function memoryPrisma() {
  const stages = []
  const events = []
  const key = (w) => w.clientId_stage
  const find = (w) => stages.find((r) => r.clientId === key(w).clientId && r.stage === key(w).stage) ?? null
  const prisma = {
    clientJourneyStage: {
      findMany: async ({ where }) => stages.filter((r) => r.clientId === where.clientId),
      findUnique: async ({ where }) => find(where),
      upsert: async ({ where, create, update }) => {
        const row = find(where)
        if (row) return Object.assign(row, update, { updatedAt: new Date() })
        const r = { startedAt: null, completedAt: null, blockedAt: null, note: null, ...create, updatedAt: new Date() }
        stages.push(r)
        return r
      },
    },
    clientJourneyEvent: {
      create: async ({ data }) => (events.push(data), data),
      findMany: async () => events,
    },
    $transaction: async (ops) => Promise.all(ops),
  }
  return { prisma, stages, events }
}

test('transitionData sets the right timestamps', () => {
  const { transitionData } = loadSource('lib/client-journey.ts', { './prisma': { prisma: {} } })
  const now = new Date('2026-10-28T00:00:00Z')
  assert.deepEqual(transitionData('in_progress', null, now), { startedAt: now, completedAt: null, blockedAt: null })
  assert.deepEqual(transitionData('done', { startedAt: now }, now), { completedAt: now, blockedAt: null })
  assert.deepEqual(transitionData('blocked', null, now), { startedAt: now, blockedAt: now, completedAt: null })
  assert.deepEqual(transitionData('pending', null, now), { completedAt: null, blockedAt: null })
})

test('advance marks done, starts the next stage, and audits each change', async () => {
  const db = memoryPrisma()
  const j = loadSource('lib/client-journey.ts', { './prisma': { prisma: db.prisma } })
  assert.equal((await j.getJourney('c1')).current, 'signup')
  await j.setJourneyStage('c1', 'signup', 'done')
  const next = await j.advanceJourneyStage('c1', 'intake', { actor: 'system' })
  assert.equal(next, 'subaccount')
  const journey = await j.getJourney('c1')
  assert.deepEqual(journey.stages.map((s) => s.status), ['done', 'done', 'in_progress', 'pending', 'pending', 'pending'])
  assert.equal(journey.current, 'subaccount')
  assert.equal(db.events.length, 3)
  // Same status + note again is a no-op (no extra audit row).
  await j.setJourneyStage('c1', 'signup', 'done')
  assert.equal(db.events.length, 3)
})

test('block records the reason; a later link advances past it', async () => {
  const db = memoryPrisma()
  const j = loadSource('lib/client-journey.ts', { './prisma': { prisma: db.prisma } })
  await j.blockJourneyStage('c2', 'subaccount', 'GHL 403: plan does not allow')
  let s = (await j.getJourney('c2')).stages.find((x) => x.stage === 'subaccount')
  assert.equal(s.status, 'blocked')
  assert.match(s.note, /403/)
  assert.ok(s.blockedAt)
  await j.advanceJourneyStage('c2', 'subaccount', { note: 'Linked by hand', actor: 'u1' })
  s = (await j.getJourney('c2')).stages.find((x) => x.stage === 'subaccount')
  assert.equal(s.status, 'done')
  assert.equal(s.blockedAt, null)
  assert.equal((await j.getJourney('c2')).stages.find((x) => x.stage === 'website').status, 'in_progress')
  assert.deepEqual(db.events.map((e) => [e.fromStatus, e.toStatus]), [[null, 'blocked'], ['blocked', 'done'], [null, 'in_progress']])
})

test('recordJourney never throws', async () => {
  const { recordJourney } = loadSource('lib/client-journey.ts', { './prisma': { prisma: {} } })
  const warn = console.warn
  console.warn = () => {}
  try {
    await recordJourney('x', async () => { throw new Error('db down') })
  } finally {
    console.warn = warn
  }
})

class GhlAgencyError extends Error {
  constructor(message, status) { super(message); this.status = status }
}

test('GHL provider falls back to the next vault entry when the first fails', async () => {
  const calls = []
  const ghl = {
    GHL_AGENCY_KEY_VAULT_NAME: 'GHL Agency Key',
    upsertContactByEmail: async (entry) => {
      calls.push(entry)
      if (entry === 'GHL Genisys Token') throw new Error('Vault entry not found')
      return { id: 'ct_1', created: true, skippedFields: [] }
    },
  }
  const { ghlProvider } = loadSource('lib/crm/provider.ts', { '../ghl': ghl, '../ghl-agency': { GhlAgencyError } })
  const warn = console.warn
  console.warn = () => {}
  try {
    const res = await ghlProvider.upsertContactByEmail(['GHL Genisys Token', 'GHL Agency Key'], { email: 'a@b.co' })
    assert.deepEqual(calls, ['GHL Genisys Token', 'GHL Agency Key'])
    assert.equal(res.credential, 'GHL Agency Key')
    // First entry working means the fallback is never tried.
    calls.length = 0
    ghl.upsertContactByEmail = async (entry) => (calls.push(entry), { id: 'ct_2', created: false, skippedFields: [] })
    const ok = await ghlProvider.upsertContactByEmail(['GHL Genisys Token', 'GHL Agency Key'], { email: 'a@b.co' })
    assert.equal(ok.credential, 'GHL Genisys Token')
    assert.deepEqual(calls, ['GHL Genisys Token'])
    // All failing rethrows the last error.
    ghl.upsertContactByEmail = async () => { throw new Error('nope') }
    await assert.rejects(ghlProvider.upsertContactByEmail(['a', 'b'], { email: 'a@b.co' }), /nope/)
  } finally {
    console.warn = warn
  }
  assert.equal(ghlProvider.isPermissionError(new GhlAgencyError('x', 403)), true)
  assert.equal(ghlProvider.isPermissionError(new GhlAgencyError('x', 500)), false)
})
