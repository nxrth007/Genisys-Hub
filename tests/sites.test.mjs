import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/lib/site-status.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const m = { exports: {} }
new Function('module', 'exports', 'require', outputText)(m, m.exports, () => {
  throw new Error('site-status.ts must stay import-free')
})
const s = m.exports

test('siteStatus: ✓ once the Clients page has the site link; otherwise the website stage decides', () => {
  assert.equal(s.siteStatus({ siteUrl: 'https://acmeroofing.com', websiteStage: 'in_progress' }), 'live')
  assert.equal(s.siteStatus({ siteUrl: null, websiteStage: 'in_progress' }), 'building')
  assert.equal(s.siteStatus({ siteUrl: '', websiteStage: 'blocked' }), 'blocked')
  assert.equal(s.siteStatus({ siteUrl: '  ', websiteStage: 'done' }), 'needs_site')
  assert.equal(s.siteStatus({ siteUrl: null }), 'needs_site')
  assert.equal(s.SITE_STATUS_LABEL.needs_site, 'Needs a site')
})

test('siteHost and siteHref', () => {
  assert.equal(s.siteHost('https://www.acmeroofing.com/'), 'acmeroofing.com')
  assert.equal(s.siteHost('acmeroofing.com/about'), 'acmeroofing.com')
  assert.equal(s.siteHost(null), '')
  assert.equal(s.siteHref('acmeroofing.com'), 'https://acmeroofing.com')
  assert.equal(s.siteHref('http://acmeroofing.com'), 'http://acmeroofing.com')
})

test('sortFolders: the ones that need a site come first, by name; live ones last', () => {
  const rows = [
    { name: 'Zed Live', status: 'live' },
    { name: 'Beta Needs', status: 'needs_site' },
    { name: 'Alpha Live', status: 'live' },
    { name: 'Gamma Building', status: 'building' },
    { name: 'Delta Blocked', status: 'blocked' },
    { name: 'Alpha Needs', status: 'needs_site' },
  ]
  assert.deepEqual(
    s.sortFolders(rows).map((r) => r.name),
    ['Delta Blocked', 'Alpha Needs', 'Beta Needs', 'Gamma Building', 'Alpha Live', 'Zed Live'],
  )
})

test('stageView: what the Hub knows beats a missing journey row; no row and no fact says "none"', () => {
  const none = { status: 'pending', note: null, updatedAt: null }
  const facts = { siteLive: true, ghlLinked: true, hasIntake: true, texting: 'approved' }
  // Forte: no journey rows at all, but a live site, a GHL sub-account, a form and an approved number.
  assert.deepEqual(s.stageView('website', none, facts), { status: 'done', note: 'Site link is on the Clients page' })
  assert.deepEqual(s.stageView('a2p', none, facts), { status: 'done', note: 'Toll-free texting approved' })
  assert.deepEqual(s.stageView('subaccount', none, facts), { status: 'done', note: 'GHL sub-account linked' })
  assert.deepEqual(s.stageView('intake', none, facts), { status: 'done', note: 'Onboarding form received' })
  assert.deepEqual(s.stageView('signup', none, facts), { status: 'none', note: null })
  assert.deepEqual(s.stageView('qa', none, facts), { status: 'none', note: null })

  const bare = { siteLive: false, ghlLinked: false, hasIntake: false, texting: null }
  // A real row stays as it is.
  const building = { status: 'in_progress', note: 'Lovable build started', updatedAt: '2026-11-12T10:00:00.000Z' }
  assert.deepEqual(s.stageView('website', building, bare), { status: 'in_progress', note: 'Lovable build started' })
  assert.deepEqual(s.stageView('website', { status: 'pending', note: null, updatedAt: '2026-11-12T10:00:00.000Z' }, bare), { status: 'pending', note: null })
  // A done row keeps its own note when the site is live.
  assert.deepEqual(s.stageView('website', { status: 'done', note: 'Shipped', updatedAt: '2026-11-12T10:00:00.000Z' }, facts), { status: 'done', note: 'Shipped' })
  // Texting follows the number: filed → in progress; rejected → blocked; not filed → the row.
  assert.equal(s.stageView('a2p', none, { ...bare, texting: 'in_review' }).status, 'in_progress')
  assert.equal(s.stageView('a2p', none, { ...bare, texting: 'rejected' }).status, 'blocked')
  assert.equal(s.stageView('a2p', none, { ...bare, texting: 'none' }).status, 'none')
})

test('Hell-level sub-account: its own row; the GHL row isn’t waiting on anyone for a Hell-level-only client', () => {
  // Cnc transportation (2026-11-14): Hell-level made at onboarding, no GHL, and the old "create it in GHL" row.
  const ghlRow = { status: 'in_progress', note: 'Automatic creation is off — create the sub-account in GHL and link it.', updatedAt: '2026-11-13T15:00:00.000Z' }
  const hellLevel = { createdAt: '2026-11-13T15:00:00.000Z', archived: false }
  const facts = { siteLive: false, ghlLinked: false, hellLevel, hasIntake: true, texting: null }
  assert.deepEqual(s.stageView('subaccount', ghlRow, facts), { status: 'not_needed', note: 'Hell-level only: no GHL sub-account' })
  // A linked GHL sub-account still says so; an archived Hell-level one, or none, leaves the row alone.
  assert.deepEqual(s.stageView('subaccount', ghlRow, { ...facts, ghlLinked: true }), { status: 'done', note: 'GHL sub-account linked' })
  assert.deepEqual(s.stageView('subaccount', ghlRow, { ...facts, hellLevel: { ...hellLevel, archived: true } }), { status: 'in_progress', note: ghlRow.note })
  assert.deepEqual(s.stageView('subaccount', ghlRow, { ...facts, hellLevel: null }), { status: 'in_progress', note: ghlRow.note })
  // The Hell-level row itself.
  assert.deepEqual(s.hellLevelStage(hellLevel), { status: 'done', note: 'Set up Nov 13, 2026' })
  assert.deepEqual(s.hellLevelStage({ ...hellLevel, archived: true }), { status: 'none', note: 'Archived in Hell-level' })
  assert.deepEqual(s.hellLevelStage(null), { status: 'none', note: null })
})

test('textingLine: what the number can do, in a sentence', () => {
  assert.match(s.textingLine({ verificationStatus: 'approved', siteLive: true }), /^Texting approved/)
  assert.match(s.textingLine({ verificationStatus: 'in_review', siteLive: true }), /Twilio is reviewing it/)
  assert.match(s.textingLine({ verificationStatus: 'rejected', verificationNote: '30509', siteLive: true }), /rejected: 30509\. Fix it/)
  assert.match(s.textingLine({ verificationStatus: 'none', siteLive: false }), /once the site link is in/)
  assert.match(s.textingLine({ verificationStatus: 'none', siteLive: true }), /within minutes of the site link/)
})
