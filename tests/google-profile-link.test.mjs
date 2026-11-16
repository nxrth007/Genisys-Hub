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

const link = loadTs(join(root, 'src/lib/hl/google-profile-link.ts'))
const types = loadTs(join(root, 'src/lib/hl/types.ts'))

test('the links Google gives for a profile are taken, tidied', () => {
  for (const [typed, saved] of [
    ['https://maps.app.goo.gl/AbC123xyz', 'https://maps.app.goo.gl/AbC123xyz'],
    ['maps.app.goo.gl/AbC123xyz', 'https://maps.app.goo.gl/AbC123xyz'],
    ['  https://g.page/acme-roofing  ', 'https://g.page/acme-roofing'],
    ['http://g.co/kgs/9aBcD', 'https://g.co/kgs/9aBcD'],
    ['https://share.google/XyZ12', 'https://share.google/XyZ12'],
    ['https://www.google.com/maps/place/Acme+Roofing/@30.26,-97.74,17z/data=!3m1!4b1', 'https://www.google.com/maps/place/Acme+Roofing/@30.26,-97.74,17z/data=!3m1!4b1'],
    ['https://maps.google.com/?cid=1234567890', 'https://maps.google.com/?cid=1234567890'],
    ['https://www.google.co.uk/maps/place/Acme', 'https://www.google.co.uk/maps/place/Acme'],
    ['https://business.google.com/n/123/profile', 'https://business.google.com/n/123/profile'],
  ]) {
    assert.deepEqual(link.checkGoogleProfileLink(typed), { ok: true, url: saved }, typed)
  }
  // The box is optional.
  assert.deepEqual(link.checkGoogleProfileLink(''), { ok: true, url: '' })
  assert.deepEqual(link.checkGoogleProfileLink(null), { ok: true, url: '' })
})

test('what isn’t a Google profile link is turned back, saying why', () => {
  for (const typed of ['yes', 'Acme Roofing on Google', 'https://www.facebook.com/acmeroofing', 'acmeroofing.com', 'https://notgoogle.com/maps', 'https://google.com.evil.example/maps']) {
    const r = link.checkGoogleProfileLink(typed)
    assert.equal(r.ok, false, typed)
    assert.match(r.error, /doesn’t look like a Google link/, typed)
  }
  // Their review link has its own box.
  for (const typed of ['https://g.page/r/CabcDEF123/review', 'https://search.google.com/local/writereview?placeid=ChIJ123']) {
    const r = link.checkGoogleProfileLink(typed)
    assert.equal(r.ok, false, typed)
    assert.match(r.error, /review link/, typed)
  }
})

test('the link already known for a client: the board’s, else their onboarding answer when it’s a Google link', () => {
  assert.equal(link.knownGoogleProfileLink({ board: 'https://maps.app.goo.gl/board', intake: 'https://g.page/intake' }), 'https://maps.app.goo.gl/board')
  assert.equal(link.knownGoogleProfileLink({ board: null, intake: 'g.page/acme-roofing' }), 'https://g.page/acme-roofing')
  // People answer the form's question with "yes", or paste their website.
  assert.equal(link.knownGoogleProfileLink({ board: '', intake: 'Yes' }), '')
  assert.equal(link.knownGoogleProfileLink({ board: null, intake: 'https://acmeroofing.com' }), '')
  assert.equal(link.knownGoogleProfileLink({ board: 'https://acmeroofing.com', intake: 'https://share.google/abc' }), 'https://share.google/abc')
  assert.equal(link.knownGoogleProfileLink({ board: null, intake: null }), '')
})

test('the Business Profile has the box, right after the review link, with its own merge field', () => {
  const keys = types.PROFILE_FIELDS.map((f) => f.key)
  assert.equal(keys[keys.indexOf('reviewLink') + 1], 'googleProfileUrl')
  const f = types.PROFILE_FIELDS.find((x) => x.key === 'googleProfileUrl')
  assert.deepEqual([f.label, f.merge], ['Google Business Profile link', 'account.google_profile_url'])
})
