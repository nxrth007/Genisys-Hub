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

test('textingLine: what the number can do, in a sentence', () => {
  assert.match(s.textingLine({ verificationStatus: 'approved', siteLive: true }), /^Texting approved/)
  assert.match(s.textingLine({ verificationStatus: 'in_review', siteLive: true }), /Twilio is reviewing it/)
  assert.match(s.textingLine({ verificationStatus: 'rejected', verificationNote: '30509', siteLive: true }), /rejected: 30509\. Fix it/)
  assert.match(s.textingLine({ verificationStatus: 'none', siteLive: false }), /once the site link is in/)
  assert.match(s.textingLine({ verificationStatus: 'none', siteLive: true }), /within minutes of the site link/)
})
