import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'
import { NextResponse } from 'next/server.js'

// Execute the real route, guards and cancellation service with an in-memory
// database. No production credentials, database or outbound integrations.
function loadSource(path, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const compiledModule = { exports: {} }
  const load = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    // Unused workflow integrations must not be called by cancellation.
    return new Proxy({}, { get() { throw new Error(`Unexpected dependency: ${name}`) } })
  }
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename: path })(load, compiledModule, compiledModule.exports)
  return compiledModule.exports
}

const access = loadSource('lib/hl/access.ts', {
  '@/lib/payments-access': loadSource('lib/payments-access.ts'),
})
const memberAccess = loadSource('lib/hl/member-access.ts')

function fixture(user) {
  const runs = [
    { id: 'run-a', accountId: 'account-a', contactId: 'contact-a', status: 'waiting' },
    { id: 'run-a-other', accountId: 'account-a', contactId: 'contact-a-other', status: 'running' },
    { id: 'run-b', accountId: 'account-b', contactId: 'contact-b', status: 'running' },
    { id: 'run-done', accountId: 'account-a', contactId: 'contact-a', status: 'done' },
  ].map((run) => ({ ...run, lockedAt: 'original-lock', nextRunAt: 'original-schedule' }))
  const contacts = [
    { id: 'contact-a', accountId: 'account-a' },
    { id: 'contact-a-other', accountId: 'account-a' },
    { id: 'contact-b', accountId: 'account-b' },
  ]
  const matches = (row, where) => Object.entries(where).every(([key, value]) =>
    value && typeof value === 'object' && 'in' in value ? value.in.includes(row[key]) : row[key] === value,
  )
  const prisma = {
    hlContact: { findUnique: async ({ where }) => contacts.find((row) => matches(row, where)) ?? null },
    hlMember: {
      findFirst: async ({ where }) => where.accountId === 'account-a' && where.userId === 'contractor' ? { id: 'membership-a' } : null,
      findMany: async () => [{ accountId: 'account-a' }],
    },
    hlWorkflowRun: {
      updateMany: async ({ where, data }) => {
        const selected = runs.filter((row) => matches(row, where))
        selected.forEach((row) => Object.assign(row, data))
        return { count: selected.length }
      },
    },
  }
  const guards = loadSource('lib/hl/http.ts', {
    'next/server': { NextResponse },
    '@/auth': { auth: async () => user ? { user } : null },
    '@/lib/prisma': { prisma },
    './access': access,
    './member-access': memberAccess,
  })
  const automation = loadSource('lib/hl/automation.ts', { '@/lib/prisma': { prisma } })
  const route = loadSource('app/api/hl/accounts/[id]/contacts/[contactId]/route.ts', {
    'next/server': { NextResponse },
    '@/lib/prisma': { prisma },
    '@/lib/hl/http': guards,
    '@/lib/hl/automation': automation,
  })
  return {
    runs,
    guards,
    cancel: (accountId, contactId, runId) => route.PATCH(new Request('https://hub.example/api/hl/contact', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancelRun: runId }),
    }), { params: Promise.resolve({ id: accountId, contactId }) }),
  }
}

const contractor = { id: 'contractor', email: 'contractor@example.com', role: 'hl_user' }

for (const [email, role] of [['alex@leadgenisys.com', 'admin'], ['ethan@leadgenisys.com', 'member']]) {
  test(`${email} retains all-account visibility and can cancel in either account`, async () => {
    const f = fixture({ id: email, email, role })
    const viewer = await f.guards.hlViewer()
    assert.equal(viewer.admin, true)
    assert.equal(viewer.accountIds, null)
    for (const suffix of ['a', 'b']) {
      const response = await f.cancel(`account-${suffix}`, `contact-${suffix}`, `run-${suffix}`)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
      const run = f.runs.find((row) => row.id === `run-${suffix}`)
      assert.equal(run.status, 'cancelled')
      assert.equal(run.lockedAt, null)
      assert.equal(run.nextRunAt, null)
    }
  })
}

test('a contractor can cancel their own contact run', async () => {
  const f = fixture(contractor)
  const before = structuredClone(f.runs.slice(1))
  assert.equal((await f.cancel('account-a', 'contact-a', 'run-a')).status, 200)
  assert.equal(f.runs[0].status, 'cancelled')
  assert.deepEqual(f.runs.slice(1), before)
})

for (const [name, accountId, contactId, runId] of [
  ['another account run through an owned contact', 'account-a', 'contact-a', 'run-b'],
  ['another contact run within the same account', 'account-a', 'contact-a', 'run-a-other'],
  ['another account URL', 'account-b', 'contact-b', 'run-b'],
  ['a contact that does not belong to the URL account', 'account-a', 'contact-b', 'run-b'],
  ['an unknown run', 'account-a', 'contact-a', 'missing'],
  ['a finished run', 'account-a', 'contact-a', 'run-done'],
]) {
  test(`rejects ${name} without changing any runs`, async () => {
    const f = fixture(contractor)
    const before = structuredClone(f.runs)
    assert.equal((await f.cancel(accountId, contactId, runId)).status, 404)
    assert.deepEqual(f.runs, before)
  })
}

test('staff also cannot accidentally cancel a run through the wrong contact', async () => {
  const f = fixture({ id: 'alex', email: 'alex@leadgenisys.com', role: 'admin' })
  const before = structuredClone(f.runs)
  assert.equal((await f.cancel('account-a', 'contact-a', 'run-b')).status, 404)
  assert.deepEqual(f.runs, before)
})

test('an unauthenticated caller cannot cancel runs', async () => {
  const f = fixture(null)
  const before = structuredClone(f.runs)
  assert.equal((await f.cancel('account-a', 'contact-a', 'run-a')).status, 401)
  assert.deepEqual(f.runs, before)
})
