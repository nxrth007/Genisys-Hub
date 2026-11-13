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

const plan = loadTs(join(root, 'src/lib/hl/review-link-plan.ts'))
const c = (o) => ({ placeId: 'P1', name: 'Acme Painting', address: '1 Main St, Dothan, AL', status: 'OPERATIONAL', matches: ['same name'], mapsUrl: null, ...o })

test("review link: Google's write-a-review page for the listing", () => {
  assert.equal(plan.reviewLinkForPlace('ChIJ123-abc_'), 'https://search.google.com/local/writereview?placeid=ChIJ123-abc_')
})

test('review link: only a listing with the same phone or website, and only one', () => {
  const phone = plan.pickReviewListing([c({ matches: ['same phone', 'same name'] })], 'Acme Painting Dothan')
  assert.equal(phone.placeId, 'P1')
  assert.equal(phone.why, 'its Google Maps listing has the same phone')
  assert.equal(plan.pickReviewListing([c({ matches: ['same website'] })], 'q').placeId, 'P1')
  // The same listing found twice is still one listing.
  const both = plan.pickReviewListing([c({ matches: ['same phone'] }), c({ matches: ['same website'] })], 'q')
  assert.equal(both.placeId, 'P1')
  assert.equal(both.why, 'its Google Maps listing has the same phone and website')
  // Two different listings with the business's phone: a person picks.
  const two = plan.pickReviewListing([c({ matches: ['same phone'] }), c({ placeId: 'P2', matches: ['same phone'] })], 'q')
  assert.equal(two.placeId, null)
  assert.match(two.why, /more than one/)
})

test('review link: a name alone, a closed listing, or nothing found is left for a person', () => {
  const name = plan.pickReviewListing([c()], 'Acme Painting Dothan')
  assert.equal(name.placeId, null)
  assert.equal(name.best.placeId, 'P1')
  assert.match(name.why, /only a name matches/)
  assert.equal(plan.pickReviewListing([c({ matches: ['same phone'], status: 'CLOSED_PERMANENTLY' })], 'q').placeId, null)
  const none = plan.pickReviewListing([], 'Acme Painting Dothan')
  assert.equal(none.best, null)
  assert.match(none.why, /no Google Maps listing found/)
  // A temporarily closed business still has its reviews.
  assert.equal(plan.pickReviewListing([c({ matches: ['same phone'], status: 'CLOSED_TEMPORARILY' })], 'q').placeId, 'P1')
})
