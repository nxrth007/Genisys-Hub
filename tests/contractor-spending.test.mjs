import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'
import { NextResponse } from 'next/server.js'

// Alex, 2026-11-16: a contractor's own login must never buy a number or a domain with Genisys's
// money. It never could (their menu has no Settings, the page gate turns them back, and every route
// that spends is Genisys-only); these tests keep it that way. They run the real guards and routes
// with an in-memory database: nothing here reaches Twilio, Porkbun or a real account.

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function loadSource(path, dependencies = {}) {
  const source = readFileSync(join(SRC, path), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const compiledModule = { exports: {} }
  const load = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    return new Proxy({}, { get(_t, prop) { throw new Error(`Unexpected dependency: ${name}.${String(prop)}`) } })
  }
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename: path })(load, compiledModule, compiledModule.exports)
  return compiledModule.exports
}

const access = loadSource('lib/hl/access.ts', { '@/lib/payments-access': loadSource('lib/payments-access.ts') })
const memberAccess = loadSource('lib/hl/member-access.ts')

/** The real guards for whoever is signed in, and a record of every spending call that was reached. */
function world(user) {
  const reached = []
  // A module whose every function records that it was reached (and, for a search, answers).
  const spending = (name, answers = {}) =>
    new Proxy({}, { get: (_t, fn) => async (...args) => { reached.push(`${name}.${String(fn)}`); return typeof answers[fn] === 'function' ? answers[fn](...args) : answers[fn] } })
  const prisma = {
    hlAccount: { findUnique: async ({ where }) => (where.id === 'account-a' ? { id: 'account-a', name: 'Acme Roofing', profile: {} } : null) },
    // The contractor really is on account-a: the refusal isn't about whose sub-account it is.
    hlMember: { findFirst: async ({ where }) => (where.accountId === 'account-a' && where.userId === 'contractor' ? { id: 'membership-a' } : null), findMany: async () => [{ accountId: 'account-a' }] },
    hlPhoneNumber: { findMany: async () => [] },
  }
  const http = loadSource('lib/hl/http.ts', { 'next/server': { NextResponse }, '@/auth': { auth: async () => (user ? { user } : null) }, '@/lib/prisma': { prisma }, './access': access, './member-access': memberAccess })
  const common = { 'next/server': { NextResponse }, '@/lib/prisma': { prisma }, '@/lib/hl/http': http }
  const routes = {
    numbers: loadSource('app/api/hl/accounts/[id]/numbers/route.ts', { ...common, '@/lib/hl/twilio': spending('twilio', { searchNumbers: () => [{ number: '+18445550100' }], buyNumber: () => ({ number: '+18445550100' }) }), '@/lib/hl/a2p': spending('a2p') }),
    domains: loadSource('app/api/hl/accounts/[id]/domains/route.ts', { ...common, '@/lib/hl/accounts': spending('accounts'), '@/lib/hl/domains': spending('domains'), '@/lib/hl/porkbun': spending('porkbun') }),
    a2p: loadSource('app/api/hl/accounts/[id]/a2p/route.ts', { ...common, '@/lib/hl/a2p': spending('a2p') }),
    email: loadSource('app/api/hl/accounts/[id]/email/route.ts', { ...common, '@/lib/hl/accounts': spending('accounts'), '@/lib/hl/email': spending('email'), '@/lib/hl/mailgun': spending('mailgun') }),
  }
  const call = (route, method, { query = '', body } = {}) =>
    routes[route][method](
      new Request(`https://hub.example/api/hl/accounts/account-a/${route}${query}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }),
      { params: Promise.resolve({ id: 'account-a' }) },
    )
  return { reached, call, http }
}

const contractor = { id: 'contractor', email: 'owner@acmeroofing.com', role: 'hl_user' }

const SPENDS = [
  ['see the numbers for sale', 'numbers', 'GET', { query: '?search=1&kind=toll_free' }],
  ['buy a toll-free number', 'numbers', 'POST', { body: { number: '+18445550100', kind: 'toll_free' } }],
  ['buy a local number', 'numbers', 'POST', { body: { number: '+15125550100', kind: 'local' } }],
  ['see the domains page’s data', 'domains', 'GET', {}],
  ['buy a domain', 'domains', 'POST', { body: { action: 'buy', name: 'acmeroofing.com' } }],
  ['transfer a domain in', 'domains', 'POST', { body: { action: 'transfer', name: 'acmeroofing.com', authCode: 'x' } }],
  ['file a paid A2P registration', 'a2p', 'POST', { body: { action: 'file' } }],
  ['set up email on a domain', 'email', 'POST', { body: { domain: 'acmeroofing.com' } }],
]

for (const [what, route, method, req] of SPENDS) {
  test(`a contractor's login can't ${what}`, async () => {
    const w = world(contractor)
    const res = await w.call(route, method, req)
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { error: 'forbidden' })
    assert.deepEqual(w.reached, [], 'nothing that spends was reached')
  })

  test(`nobody signed out can ${what}`, async () => {
    const w = world(null)
    assert.equal((await w.call(route, method, req)).status, 401)
    assert.deepEqual(w.reached, [])
  })
}

test('the same contractor still gets into their own sub-account’s day-to-day routes', async () => {
  const w = world(contractor)
  assert.deepEqual(await w.http.hlAccountGuard('account-a'), { email: 'owner@acmeroofing.com', userId: 'contractor', admin: false })
  assert.equal((await w.http.hlAccountGuard('account-b')).status, 404, 'and nobody else’s')
})

test('Genisys staff can still search and buy (the guard is what stops a contractor, not a broken route)', async () => {
  const w = world({ id: 'alex', email: 'alex@leadgenisys.com', role: 'admin' })
  const search = await w.call('numbers', 'GET', { query: '?search=1&kind=toll_free' })
  assert.equal(search.status, 200)
  assert.deepEqual(await search.json(), { available: [{ number: '+18445550100' }] })
  const buy = await w.call('numbers', 'POST', { body: { number: '+18445550100', kind: 'toll_free' } })
  assert.equal(buy.status, 200)
  assert.deepEqual(w.reached, ['twilio.searchNumbers', 'twilio.buyNumber'])
})

test('a contractor’s login opens only the day-to-day screens: never Settings, the Launchpad or the agency view', () => {
  for (const [path, tab] of [
    ['/genisys-os/account-a/settings', 'phone-numbers'],
    ['/genisys-os/account-a/settings', 'domains'],
    ['/genisys-os/account-a/settings', null],
    ['/genisys-os/account-a/launchpad', null],
    ['/genisys-os/account-a/automation', null],
    ['/genisys-os/account-a/sites', null],
    ['/genisys-os/agency/settings', null],
  ]) {
    assert.equal(memberAccess.memberPagePath(path, tab).ok, false, `${path}${tab ? `?tab=${tab}` : ''}`)
  }
  for (const path of ['/genisys-os', '/genisys-os/account-a/dashboard', '/genisys-os/account-a/opportunities', '/genisys-os/account-a/conversations']) {
    assert.equal(memberAccess.memberPagePath(path, null).ok, true, path)
  }
})

// --- Every route in the Hub that can spend, whoever adds one later ---------------------------------

/** Server functions that spend Genisys's money (Twilio, Porkbun, Lovable credits, Claude) or commit it to. */
const SPENDING = [
  'buyNumber', 'buyNumberNow', 'decideClientNumber', 'fileA2p',
  'buyDomain', 'buyDomainNow', 'startTransferIn', 'registerDomain', 'decideClientDomain',
  'buildSiteNow', 'decideClientSite', 'queueWidgetSwaps', 'resumeWidgetSwaps',
]
/** Guards a contractor's login passes. */
const CONTRACTOR_GUARDS = /\b(hlAccountGuard|hlViewer)\(/
/** Guards only Genisys passes. */
const GENISYS_GUARDS = /\b(hlGuard|requireAdmin|requireStaff)\(/

function routeFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? routeFiles(p) : name === 'route.ts' ? [p] : []
  })
}

test('every handler that can spend money is Genisys-only', () => {
  const calls = new RegExp(`\\b(${SPENDING.join('|')})\\(`)
  const found = []
  for (const file of routeFiles(join(SRC, 'app/api'))) {
    const parts = readFileSync(file, 'utf8').split(/export (?:async )?function (GET|POST|PATCH|PUT|DELETE)\b/)
    for (let i = 1; i < parts.length; i += 2) {
      const [method, body] = [parts[i], parts[i + 1]]
      if (!calls.test(body)) continue
      const where = `${method} ${file.slice(SRC.length).replace(/\\/g, '/')}`
      found.push(where)
      assert.ok(GENISYS_GUARDS.test(body), `${where} spends money without a Genisys-only guard`)
      assert.ok(!CONTRACTOR_GUARDS.test(body), `${where} spends money behind a guard a contractor's login passes`)
    }
  }
  // The ones known today: if this list shrinks, the scan above stopped seeing them.
  for (const expected of ['POST app/api/hl/accounts/[id]/numbers/route.ts', 'POST app/api/hl/accounts/[id]/domains/route.ts', 'POST app/api/hl/accounts/[id]/a2p/route.ts', 'POST app/api/clients/[id]/hl-number/route.ts', 'POST app/api/clients/[id]/hl-domain/route.ts', 'POST app/api/office/approvals/route.ts']) {
    assert.ok(found.includes(expected), `expected to find ${expected}; found ${found.join(', ')}`)
  }
})

test('outside Genisys OS’s own routes, a contractor’s login reaches no API at all', () => {
  const middleware = readFileSync(join(SRC, 'middleware.ts'), 'utf8')
  const list = /const HL_MEMBER_ALLOWED_PREFIXES = \[([^\]]*)\]/.exec(middleware)?.[1] ?? ''
  const prefixes = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(prefixes, ['/api/auth', '/api/hl', '/genisys-os'])
})
