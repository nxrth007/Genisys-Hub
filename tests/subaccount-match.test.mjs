import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/crm/subaccount-match.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const m = { exports: {} }
runInThisContext(`(function(require, module, exports) {${outputText}\n})`)(() => { throw new Error('no deps') }, m, m.exports)
const { normalizeText, parseLocationName, normalizePhone, isDeniedName, scorePair, matchSubaccounts } = m.exports

test('normalizes &, punctuation, suffixes, case and trailing spaces', () => {
  assert.equal(normalizeText('J&R Painting'), 'j and r painting')
  assert.equal(normalizeText('J & R Painting'), 'j and r painting')
  assert.equal(normalizeText('Robert Paul Contracting '), 'robert paul contracting')
  assert.equal(normalizeText('SUMMIT ROOFING, LLC'), 'summit roofing')
  assert.equal(normalizeText('Acme Pools Inc.'), 'acme pools')
  assert.deepEqual(parseLocationName('Randy: J & R Painting'), { firstName: 'randy', business: 'j and r painting' })
  assert.deepEqual(parseLocationName('Blue Diamond Construction'), { firstName: null, business: 'blue diamond construction' })
  assert.equal(normalizePhone('(555) 123-4567'), '+15551234567')
  assert.equal(normalizePhone('+1 555 123 4567'), '+15551234567')
})

test("'Randy: J & R Painting' vs intake 'J&R Painting'", () => {
  const client = { id: 'c1', name: 'J&R Painting', intakeName: 'Randy Jones', phones: ['555-123-4567'] }
  const loc = { id: 'L1', name: 'Randy: J & R Painting', phone: '+15551234567' }
  assert.equal(scorePair(client, loc).score, 100)
  const r = matchSubaccounts([client], [loc, { id: 'L2', name: 'Mike: Other Roofing' }])
  assert.deepEqual(r.autoLinks.map((a) => a.locationId), ['L1'])
  // Name only (75) is never auto-linked.
  const r2 = matchSubaccounts([{ ...client, phones: [] }], [loc])
  assert.equal(r2.autoLinks.length, 0)
  assert.equal(r2.needsReview[0].locationId, 'L1')
})

test('trailing space, ALL CAPS and LLC/INC suffixes still match exactly', () => {
  const r = matchSubaccounts(
    [
      { id: 'a', name: 'Robert Paul Contracting', contactName: 'Robert Paul', emails: ['rp@x.com'] },
      { id: 'b', name: 'Summit Roofing LLC', contactName: 'Dana', phones: ['5550001111'] },
      { id: 'c', name: 'Acme Pools', contactName: 'Tom', emails: ['TOM@ACME.COM'] },
    ],
    [
      { id: 'L1', name: 'Robert: Robert Paul Contracting ', email: 'RP@x.com' },
      { id: 'L2', name: 'DANA: SUMMIT ROOFING', phone: '(555) 000-1111' },
      { id: 'L3', name: 'Tom: Acme Pools, INC.', email: 'tom@acme.com' },
    ],
  )
  assert.deepEqual(r.autoLinks.map((a) => `${a.clientId}>${a.locationId}`).sort(), ['a>L1', 'b>L2', 'c>L3'])
  assert.ok(r.autoLinks.every((a) => a.score === 100))
})

test('duplicate-named Henry locations are needs-review, never auto-linked', () => {
  const client = { id: 'h', name: 'Bexar Pressure Washing & Landscaping', contactName: 'Henry', phones: ['2105550000'] }
  const r = matchSubaccounts([client], [
    { id: 'H1', name: 'Henry: Bexar Pressure Washing and Landscaping', phone: '210-555-0000' },
    { id: 'H2', name: 'Henry: Bexar Pressure Washing and Landscaping' },
  ])
  assert.equal(r.autoLinks.length, 0)
  assert.ok(r.needsReview.some((n) => n.locationId === 'H1'))
})

test('internal accounts are denied', () => {
  for (const n of ['Lead Genisys', 'Lead Genisys: SMS Sub Acc', 'Lead Genisys: Test Sub Acc', 'Master Snapshot', 'Trustware', 'Out the Vault']) {
    assert.ok(isDeniedName(n), n)
  }
  const r = matchSubaccounts([{ id: 'x', name: 'Trustware', phones: ['5551112222'] }, { id: 'y', name: 'SMS Sub Acc' }], [
    { id: 'T', name: 'Trustware', phone: '5551112222' },
    { id: 'S', name: 'Lead Genisys: SMS Sub Acc' },
  ])
  assert.equal(r.autoLinks.length, 0)
  assert.equal(r.needsReview.length, 0)
  assert.equal(r.skipped.denied.length, 2)
})

test("no-first-name 'Blue Diamond Construction'", () => {
  const client = { id: 'bd', name: 'Blue Diamond Construction', contactName: 'Luis', emails: ['luis@bluediamond.com'] }
  const loc = { id: 'B', name: 'Blue Diamond Construction', email: 'luis@bluediamond.com' }
  assert.equal(scorePair(client, loc).score, 85)
  assert.equal(matchSubaccounts([client], [loc]).autoLinks[0].locationId, 'B')
})

test('close runner-up, already-linked and rejected pairs are not auto-linked', () => {
  const client = { id: 'c', name: 'Apex Roofing', phones: ['5550002222'], emails: ['ops@apex.com'] }
  const locs = [
    { id: 'A1', name: 'Apex Roofing', phone: '5550002222' },
    { id: 'A2', name: 'Apex Roofing Pros', phone: '5550002222', email: 'ops@apex.com' },
  ]
  const r = matchSubaccounts([client], locs)
  assert.equal(r.autoLinks.length, 0)
  assert.equal(r.needsReview[0].locationId, 'A1')
  assert.equal(matchSubaccounts([{ ...client, ghlLocationId: 'Z' }], locs).needsReview.length, 0)
  assert.equal(matchSubaccounts([client], locs, { linkedLocationIds: ['A2'] }).autoLinks[0].locationId, 'A1')
  assert.equal(matchSubaccounts([client], locs, { rejected: ['c:A2'] }).autoLinks[0].locationId, 'A1')
})
