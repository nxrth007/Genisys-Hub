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

const plan = loadTs(join(root, 'src/lib/hl/membership-plan.ts'))

const d = (s) => new Date(s)
const base = {
  signupStep: null,
  subAccountStep: null,
  firstIntakeAt: null,
  trackerStart: null,
  clientAddedAt: null,
  ghlProvision: { status: null, at: null },
  ghlLocationAddedAt: null,
  accountCreatedAt: d('2026-11-13T15:00:00Z'),
  ghlLocationId: null,
  copiedFromGhl: false,
  siteLiveAt: null,
  siteUrl: null,
  numbers: [],
  domains: [],
  logins: [],
  archivedAt: null,
  lifecycle: 'active',
}

test('tracker dates: US, ISO and written out; anything else is no date', () => {
  assert.equal(plan.parseSheetDate('10/14/2026')?.toISOString().slice(0, 10), '2026-10-14')
  assert.equal(plan.parseSheetDate('2026-10-14')?.toISOString().slice(0, 10), '2026-10-14')
  assert.equal(plan.parseSheetDate('Oct 14, 2026')?.toISOString().slice(0, 10), '2026-10-14')
  assert.equal(plan.parseSheetDate('10/14/26')?.toISOString().slice(0, 10), '2026-10-14')
  assert.equal(plan.parseSheetDate('ASAP'), null)
  assert.equal(plan.parseSheetDate(''), null)
  assert.equal(plan.parseSheetDate('13/45/2026'), null)
  assert.equal(plan.parseSheetDate('1/1/1999'), null)
})

test('registered: a new client is the onboarding form, not the Hub adding them a moment earlier', () => {
  const r = plan.registeredFrom({ ...base, clientAddedAt: d('2026-11-13T14:59:59.900Z'), firstIntakeAt: d('2026-11-13T15:00:00Z') })
  assert.equal(r.how, 'Sent the onboarding form')
  assert.equal(r.at.toISOString(), '2026-11-13T15:00:00.000Z')
})

test('registered: Whop’s sign-up counts, the intake’s implied one doesn’t', () => {
  const whop = plan.registeredFrom({ ...base, signupStep: { note: 'Whop membership mem_123', completedAt: d('2026-10-01T12:00:00Z') }, firstIntakeAt: d('2026-10-03T12:00:00Z') })
  assert.deepEqual([whop.how, whop.at.toISOString().slice(0, 10)], ['Signed up on Whop', '2026-10-01'])
  const implied = plan.registeredFrom({ ...base, signupStep: { note: 'Implied by intake form', completedAt: d('2026-10-03T12:00:00Z') }, firstIntakeAt: d('2026-10-03T12:00:00Z') })
  assert.equal(implied.how, 'Sent the onboarding form')
})

test('registered: an older client is the earliest record, else when the Hub added them', () => {
  const r = plan.registeredFrom({ ...base, trackerStart: '9/2/2026', clientAddedAt: d('2026-09-10T00:00:00Z'), firstIntakeAt: d('2026-09-20T00:00:00Z') })
  assert.deepEqual([r.how, r.at.toISOString().slice(0, 10)], ['Start date on the onboarding tracker', '2026-09-02'])
  assert.equal(plan.registeredFrom({ ...base, clientAddedAt: d('2026-08-20T00:00:00Z') }).how, 'Added to the Hub')
  assert.equal(plan.registeredFrom(base), null)
})

test('sub-account: Hell-level’s own date; GoHighLevel’s for a client from there, Hell-level’s second', () => {
  assert.deepEqual(plan.subAccountFrom(base), { at: base.accountCreatedAt, how: 'Hell-level sub-account made', hellLevel: null })
  const ghl = { ...base, ghlLocationId: 'loc1', accountCreatedAt: d('2026-10-20T00:00:00Z') }
  const unknown = plan.subAccountFrom(ghl)
  assert.equal(unknown.at, null)
  assert.deepEqual([unknown.hellLevel.how, unknown.hellLevel.at.toISOString().slice(0, 10)], ['Hell-level sub-account made', '2026-10-20'])
  assert.equal(plan.subAccountFrom({ ...ghl, copiedFromGhl: true }).hellLevel.how, 'Copied into Hell-level')
  assert.equal(plan.subAccountFrom({ ...ghl, ghlLocationAddedAt: d('2026-08-30T00:00:00Z') }).at.toISOString().slice(0, 10), '2026-08-30')
  // The Hub made it in GoHighLevel: its own record; a link to one made by hand isn't a date it was made.
  assert.equal(plan.subAccountFrom({ ...ghl, ghlProvision: { status: 'created', at: d('2026-10-05T00:00:00Z') } }).at.toISOString().slice(0, 10), '2026-10-05')
  assert.equal(plan.subAccountFrom({ ...ghl, ghlProvision: { status: 'linked', at: d('2026-10-05T00:00:00Z') } }).at, null)
  assert.equal(plan.subAccountFrom({ ...ghl, subAccountStep: { note: 'Created sub-account abc', completedAt: d('2026-10-06T00:00:00Z') } }).at.toISOString().slice(0, 10), '2026-10-06')
  assert.equal(plan.subAccountFrom({ ...ghl, subAccountStep: { note: 'Linked by hand to GHL location abc', completedAt: d('2026-10-06T00:00:00Z') } }).at, null)
})

test('the card: timeline in order, what’s still to come, and how long they’ve been a client', () => {
  const m = plan.membershipOf(
    {
      ...base,
      firstIntakeAt: d('2026-11-13T14:00:00Z'),
      clientAddedAt: d('2026-11-13T14:00:00Z'),
      numbers: [{ number: '+18556090482', kind: 'toll_free', createdAt: d('2026-11-13T21:04:00Z'), verificationStatus: 'pending', verificationAt: null }],
      logins: [{ who: 'Jane Roe', invitedAt: d('2026-11-14T10:00:00Z'), lastLoginAt: null }],
    },
    d('2026-12-14T15:00:00Z'),
  )
  assert.deepEqual(m.registered, { at: '2026-11-13T14:00:00.000Z', how: 'Sent the onboarding form' })
  assert.deepEqual(m.subAccount, { at: '2026-11-13T15:00:00.000Z', how: 'Hell-level sub-account made' })
  assert.equal(m.daysAsClient, 31)
  assert.deepEqual(
    m.timeline.map((t) => t.label),
    ['Sent the onboarding form', 'Got their Hell-level sub-account', 'Toll-free number (855) 609-0482', 'Hell-level login sent to Jane Roe'],
  )
  assert.deepEqual(m.next, ['Website live', 'Texting approved (carrier verification)'])
  assert.equal(m.ended, null)
})

test('a client from GoHighLevel isn’t asked for a Hell-level number; an archived one has nothing to come', () => {
  const ghl = { ...base, ghlLocationId: 'loc1', siteUrl: 'https://acme.com', siteLiveAt: d('2026-10-01T00:00:00Z'), ghlLocationAddedAt: d('2026-09-01T00:00:00Z') }
  assert.deepEqual(plan.membershipOf(ghl).next, [])
  const labels = plan.membershipOf(ghl).timeline.map((t) => t.label)
  assert.deepEqual(labels, ['Got their GoHighLevel sub-account', 'Website live at acme.com', 'Hell-level sub-account made'])
  assert.ok(plan.membershipOf({ ...ghl, copiedFromGhl: true }).timeline.some((t) => t.label === 'Copied into Hell-level from GoHighLevel'))
  const gone = plan.membershipOf({ ...base, archivedAt: d('2026-11-01T00:00:00Z') })
  assert.deepEqual(gone.next, [])
  assert.equal(gone.ended, 'Archived 2026-11-01')
})
