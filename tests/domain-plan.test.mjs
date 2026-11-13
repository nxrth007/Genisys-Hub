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

const plan = loadTs(join(root, 'src/lib/hl/domain-plan.ts'))

test('domain names come from the business name, legal endings and notes dropped', () => {
  assert.equal(plan.domainSlug('Acme Roofing & Gutters, LLC'), 'acmeroofingandgutters')
  assert.equal(plan.domainSlug('RAA Limitless Solutions, LLC (but DBA is Luxury Solutions)'), 'raalimitlesssolutions')
  assert.equal(plan.domainSlug('Done Rite Appliance Repair CO'), 'doneriteappliancerepair')
  // "Co" inside a word stays.
  assert.equal(plan.domainSlug('C&J Concrete Coatings LLC'), 'candjconcretecoatings')
  assert.equal(plan.domainSlug('H McKenzie inc.'), 'hmckenzie')
})

test('candidates: the plain name in .com, then .org, then with the city, then variations', () => {
  const names = plan.domainCandidates('All Pro Painting LLC', 'Dothan, AL')
  assert.deepEqual(names.slice(0, 6), ['allpropainting.com', 'allpropainting.org', 'allpropaintingdothanal.com', 'allpropainting.net', 'getallpropainting.com', 'allpropaintingco.com'])
  assert.ok(names.includes('allpropaintingllc.com'))
  assert.ok(names.length <= 25)
  // No city: no city names; a name too short for a domain: none at all.
  assert.ok(!plan.domainCandidates('All Pro Painting', null).some((n) => n.includes('dothan')))
  assert.deepEqual(plan.domainCandidates('No', null), [])
})

const opt = (name, o = {}) => ({ name, available: true, priceCents: 1108, renewalCents: 1108, premium: false, inYourAccount: false, ...o })

test('the three suggested: available, not premium, not ours, at most $25 a year, best first', () => {
  const names = ['a.com', 'a.org', 'b.com', 'a.net', 'c.com']
  const picks = plan.pickDomainOptions(names, [
    opt('a.com', { available: false }),
    opt('a.org'),
    opt('b.com', { premium: true }),
    opt('a.net', { priceCents: 3999 }),
    opt('c.com'),
  ])
  assert.deepEqual(picks.map((p) => p.name), ['a.org', 'c.com'])
  // A cheap first year that renews high is left out too.
  assert.deepEqual(plan.pickDomainOptions(['x.co'], [opt('x.co', { priceCents: 199, renewalCents: 3500 })]), [])
  assert.deepEqual(plan.pickDomainOptions(['x.com', 'y.com', 'z.com', 'w.com'], ['x.com', 'y.com', 'z.com', 'w.com'].map((n) => opt(n))).length, 3)
  assert.deepEqual(plan.pickDomainOptions(['x.com'], [opt('x.com', { inYourAccount: true })]), [])
})

const base = { archived: false, accountId: 'acc1', bringingOwnDomain: false, hasDomain: false, siteLive: false, request: null, trigger: 'onboarding', accountCreatedAt: new Date('2026-11-14T00:00:00Z'), since: new Date('2026-11-13T00:00:00Z') }

test('Forge asks once per new client without a domain', () => {
  assert.deepEqual(plan.domainAskDecision(base), { ask: true, reason: 'no domain yet' })
  assert.equal(plan.domainAskDecision({ ...base, bringingOwnDomain: true }).ask, false)
  assert.equal(plan.domainAskDecision({ ...base, siteLive: true }).ask, false)
  assert.equal(plan.domainAskDecision({ ...base, hasDomain: true }).reason, 'its sub-account already has a domain')
  assert.equal(plan.domainAskDecision({ ...base, accountId: null }).ask, false)
  assert.equal(plan.domainAskDecision({ ...base, archived: true }).ask, false)
  for (const status of ['awaiting_approval', 'buying', 'bought']) assert.equal(plan.domainAskDecision({ ...base, request: { status } }).ask, false, status)
  assert.equal(plan.domainAskDecision({ ...base, request: { status: 'declined' } }).ask, false)
  // The sweep only asks sub-accounts made since the question started.
  assert.equal(plan.domainAskDecision({ ...base, trigger: 'sweep', accountCreatedAt: new Date('2026-11-01T00:00:00Z') }).ask, false)
  assert.equal(plan.domainAskDecision({ ...base, trigger: 'sweep' }).ask, true)
})

test('by hand: older clients, own domain or a live site, after None of these; never twice at once', () => {
  const manual = { ...base, trigger: 'manual', accountCreatedAt: new Date('2026-10-01T00:00:00Z') }
  assert.equal(plan.domainAskDecision(manual).ask, true)
  assert.equal(plan.domainAskDecision({ ...manual, bringingOwnDomain: true, siteLive: true }).ask, true)
  assert.equal(plan.domainAskDecision({ ...manual, request: { status: 'declined' } }).ask, true)
  assert.equal(plan.domainAskDecision({ ...manual, request: { status: 'awaiting_approval' } }).ask, false)
  assert.equal(plan.domainAskDecision({ ...manual, hasDomain: true }).ask, false)
})

test('saved suggestions are read back safely', () => {
  assert.deepEqual(plan.readChoices([{ name: 'a.com', costCents: 1108, renewalCents: 1108 }, { name: 'b.com', costCents: 0 }, { name: 3 }, null]), [{ name: 'a.com', costCents: 1108, renewalCents: 1108 }])
  assert.deepEqual(plan.readChoices({}), [])
  assert.equal(plan.yearly(1108), '$11.08/yr')
})
