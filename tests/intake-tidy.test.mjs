import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Transpile a src module; relative imports load the neighbouring .ts file (type-only imports vanish).
const cache = new Map()
function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  cache.set(absPath, m.exports)
  const req = (name) => {
    if (name.startsWith('./')) return loadTs(join(dirname(absPath), `${name.slice(2)}.ts`))
    throw new Error(`Unexpected dependency: ${name}`)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  cache.set(absPath, m.exports)
  return m.exports
}

const plan = loadTs(join(root, 'src/lib/intake-tidy-plan.ts'))

const ai = (over = {}) => ({
  businessName: '',
  ownerName: '',
  ownerPhone: '',
  customerPhone: '',
  email: '',
  website: '',
  street: '',
  city: '',
  state: '',
  zip: '',
  townGuesses: [],
  serviceCities: [],
  timeZone: '',
  ein: '',
  areaCode: '',
  notes: [],
  doubts: [],
  ...over,
})

test('formats: phones, EIN, email, website, names', () => {
  assert.equal(plan.formatPhone('216-333-5885'), '(216) 333-5885')
  assert.equal(plan.formatPhone('+1 (216) 333 5885'), '(216) 333-5885')
  assert.equal(plan.formatPhone('333-5885'), '')
  assert.equal(plan.formatPhone('(116) 333-5885'), '')
  assert.deepEqual(plan.phonesIn('571-555-0101 and 301-555-0199'), ['5715550101', '3015550199'])
  assert.equal(plan.formatEin('931876544'), '93-1876544')
  assert.equal(plan.formatEin('93-1876544'), '93-1876544')
  // A Social Security number isn't an EIN.
  assert.equal(plan.formatEin('123-45-6789'), '')
  assert.equal(plan.formatEin('12345'), '')
  assert.equal(plan.cleanEmail(' CMEconcrete@Outlook.com '), 'cmeconcrete@outlook.com')
  assert.equal(plan.cleanEmail('john at gmail'), '')
  assert.equal(plan.cleanWebsite('concretemasonryllc.org'), 'https://concretemasonryllc.org')
  assert.equal(plan.cleanWebsite('http://www.abc.com/'), 'https://www.abc.com')
  assert.equal(plan.cleanWebsite('https://facebook.com/acme'), '')
  assert.equal(plan.cleanWebsite('https://maps.app.goo.gl/xyz'), '')
  assert.equal(plan.cleanWebsite('me@abc.com'), '')
  assert.equal(plan.isPersonName('John Morris'), true)
  assert.equal(plan.isPersonName('John and Mary Smith'), false)
  assert.equal(plan.isPersonName('Morris Concrete LLC'), false)
  assert.equal(plan.isPersonName('John'), false)
  assert.equal(plan.isBusinessName('Concrete Masonry LLC'), true)
  assert.equal(plan.isBusinessName('1 Way Construction'), true)
  assert.equal(plan.isBusinessName('13982 Sheldon rd'), false)
  assert.equal(plan.isBusinessName('(216) 333-5885'), false)
  assert.equal(plan.isBusinessName('john@abc.com'), false)
  assert.equal(plan.isBusinessName('N/A'), false)
})

test('streets, towns and the Census map’s answers', () => {
  assert.equal(plan.houseNumber('13982 Sheldon rd'), '13982')
  assert.equal(plan.sameHouse('13982 SHELDON RD', '13982 Sheldon rd'), true)
  assert.equal(plan.sameHouse('13982 Sheldon Road', '13982 Sheldon rd'), true)
  assert.equal(plan.sameHouse('13980 Sheldon rd', '13982 Sheldon rd'), false)
  assert.equal(plan.sameHouse('13982 Bagley rd', '13982 Sheldon rd'), false)
  assert.equal(plan.sameHouse('25 W Main St', '25 Main St'), true)
  assert.deepEqual(plan.parseCensusMatch('13982 SHELDON RD, BROOK PARK, OH, 44142'), { street: '13982 SHELDON RD', city: 'Brook Park', state: 'OH', zip: '44142' })
  assert.equal(plan.parseCensusMatch('BROOK PARK, OH'), null)
  assert.deepEqual(plan.parseTown('Brook Park, OH'), { city: 'Brook Park', state: 'OH' })
  assert.deepEqual(plan.parseTown('Austin TX'), { city: 'Austin', state: 'TX' })
  assert.deepEqual(plan.parseTown('Cuyahoga County, Ohio'), { city: 'Cuyahoga County', state: 'OH' })
  assert.equal(plan.parseTown('Austin'), null)
  assert.equal(plan.stateCode('ohio'), 'OH')
  assert.equal(plan.stateCode('Oh'), 'OH')
  assert.equal(plan.stateCode('Xx'), '')
  assert.equal(plan.oneLineAddress({ street: '13982 Sheldon Rd', city: 'Brook Park', state: 'OH', zip: '44142' }), '13982 Sheldon Rd, Brook Park, OH 44142')
  assert.equal(plan.tidyStreet('13982 sheldon rd'), '13982 Sheldon Rd')
  assert.equal(plan.tidyStreet('25 McDonald Ave'), '25 McDonald Ave')
})

test('the street the client typed: the address box, the name box when swapped, or inside other text', () => {
  assert.equal(plan.typedStreet({ businessAddress: '13982 Sheldon rd' }), '13982 Sheldon rd')
  assert.equal(plan.typedStreet({ businessName: '17434 Copeland ln', businessAddress: 'Calvins construction' }), '17434 Copeland ln')
  assert.equal(plan.typedStreet({ businessName: '1 Way Construction', businessAddress: '' }), '')
  assert.equal(plan.typedStreet({ businessAddress: 'Austin', businessContact: 'Jason, (929) 668-8790, 25 Woodlawn Ave, Albany NY 12208' }), '25 Woodlawn Ave')
  assert.equal(plan.typedStreet({ businessAddress: 'PO Box 12, Austin TX 78701' }), '')
})

test('where to look a street up: the typed town first, then Claude’s guesses and where they work', () => {
  const p = plan.placesToTry(
    { businessAddress: '13982 Sheldon rd' },
    ai({ townGuesses: ['Brook Park, OH', 'Middleburg Heights, OH', 'nowhere'], serviceCities: ['Cuyahoga County OH', 'Lorain County OH'] }),
    [{ city: null, state: 'OH' }],
  )
  assert.deepEqual(p.towns, ['Brook Park, OH', 'Middleburg Heights, OH'])
  assert.deepEqual(p.states, ['OH'])
  assert.equal(p.typed, null)
  const typed = plan.placesToTry({ businessAddress: '25 Woodlawn ave, Albany NY' }, null, [])
  assert.equal(typed.typed, 'Albany, NY')
  assert.deepEqual(typed.towns, ['Albany, NY'])
})

const concreteMasonry = {
  businessName: 'Concrete masonry llc',
  fullName: 'John morris',
  businessContact: '216-333-5885',
  businessAddress: '13982 Sheldon rd',
  customerPhone: '2163335885',
  leadEmail: 'CMEconcrete@outlook.com',
  cities: 'Cuyahoga, Lorain, Medina',
  website: 'concretemasonryllc.org',
  ein: '931876544',
  timeZone: 'EST',
}

test('Concrete masonry: the street the map placed becomes the whole address, and the rest is formatted', () => {
  const r = plan.applyTidy(
    concreteMasonry,
    ai({
      businessName: 'Concrete Masonry LLC',
      ownerName: 'John Morris',
      ownerPhone: '2163335885',
      customerPhone: '2163335885',
      email: 'cmeconcrete@outlook.com',
      website: 'https://concretemasonryllc.org',
      street: '13982 Sheldon Rd',
      townGuesses: ['Brook Park, OH'],
      serviceCities: ['Cuyahoga County OH', 'Lorain County OH', 'Medina County OH'],
      timeZone: 'Eastern',
      ein: '93-1876544',
    }),
    { street: '13982 Sheldon Rd', city: 'Brook Park', state: 'OH', zip: '44142', how: 'the US Census address map finds that address only in Brook Park, OH' },
  )
  assert.equal(r.addressWhole, true)
  assert.deepEqual(r.updates, {
    businessName: 'Concrete Masonry LLC',
    fullName: 'John Morris',
    businessContact: '(216) 333-5885',
    businessAddress: '13982 Sheldon Rd, Brook Park, OH 44142',
    customerPhone: '(216) 333-5885',
    timeZone: 'Eastern',
    leadEmail: 'cmeconcrete@outlook.com',
    cities: 'Cuyahoga County OH, Lorain County OH, Medina County OH',
    website: 'https://concretemasonryllc.org',
    ein: '93-1876544',
  })
  assert.ok(r.notes.some((n) => n.includes('13982 Sheldon Rd, Brook Park, OH 44142')))
  assert.deepEqual(r.doubts, [])
  assert.ok(r.changes.some((c) => c.field === 'businessAddress' && c.from === '13982 Sheldon rd'))
})

test('a town or ZIP Claude came up with is never taken on its word', () => {
  const r = plan.applyTidy({ businessName: 'Woodlawn Builders', businessAddress: '25 Woodlawn ave' }, ai({ street: '25 Woodlawn Ave', city: 'Albany', state: 'NY', zip: '12208' }), null)
  assert.equal(r.addressWhole, false)
  assert.equal(r.updates.businessAddress, undefined)
  assert.ok(r.doubts.some((d) => /no city, state or ZIP/.test(d)))
  // A town and ZIP the client typed are theirs to keep, written the Hub's way.
  const typed = plan.applyTidy({ businessAddress: '123 main st austin tx 78701' }, ai({ street: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' }), null)
  assert.equal(typed.updates.businessAddress, '123 Main St, Austin, TX 78701')
  assert.equal(typed.addressWhole, true)
  // The map's answer for another house number isn't theirs.
  const other = plan.applyTidy({ businessAddress: '13982 Sheldon rd' }, null, { street: '13980 Sheldon Rd', city: 'Brook Park', state: 'OH', zip: '44142', how: 'x' })
  assert.equal(other.addressWhole, false)
})

test('swapped name and address boxes go back where they belong', () => {
  const r = plan.applyTidy(
    { businessName: '17434 Copeland ln', businessAddress: 'Calvins construction', fullName: 'Calvin Reed' },
    ai({ businessName: 'Calvins Construction', street: '17434 Copeland Ln', notes: ['The business name and address boxes were swapped.'] }),
    null,
  )
  assert.equal(r.updates.businessName, 'Calvins Construction')
  // The street moves to the address box even before the map has placed it.
  assert.equal(r.updates.businessAddress, '17434 Copeland Ln')
  assert.equal(r.addressWhole, false)
  assert.ok(r.notes.includes('The business name and address boxes were swapped.'))
})

test('Claude can’t add a phone, email or website the client never typed, or blank an answer', () => {
  const r = plan.applyTidy(
    { businessName: 'Acme Roofing', customerPhone: '512-555-0123', leadEmail: 'owner@acme.com', website: 'acme.com', businessAddress: '1 Main St, Austin, TX 78701' },
    ai({ businessName: '', customerPhone: '5125559999', ownerPhone: '5125559999', email: 'someone@else.com', website: 'https://other.com' }),
    null,
  )
  assert.equal(r.updates.businessName, undefined)
  assert.equal(r.updates.customerPhone, '(512) 555-0123')
  assert.equal(r.updates.businessContact, undefined)
  assert.equal(r.updates.leadEmail, undefined)
  assert.equal(r.updates.website, 'https://acme.com')
  assert.equal(r.addressWhole, true)
})

test('without Claude: formatting only, and a street with no town is left for a person', () => {
  const r = plan.applyTidy({ ...concreteMasonry }, null, null)
  assert.equal(r.updates.customerPhone, '(216) 333-5885')
  assert.equal(r.updates.businessContact, '(216) 333-5885')
  assert.equal(r.updates.ein, '93-1876544')
  assert.equal(r.updates.website, 'https://concretemasonryllc.org')
  assert.equal(r.updates.leadEmail, 'cmeconcrete@outlook.com')
  assert.equal(r.updates.businessName, undefined)
  assert.equal(r.updates.businessAddress, undefined)
  assert.equal(r.addressWhole, false)
  assert.equal(r.doubts.length, 1)
})

test('Claude’s answer is read defensively, and the Slack line says only what matters', () => {
  assert.equal(plan.readAiTidy(null), null)
  assert.equal(plan.readAiTidy([]), null)
  const half = plan.readAiTidy({ businessName: '  Acme  LLC ', townGuesses: ['A, TX', 3, ''], notes: 'x' })
  assert.equal(half.businessName, 'Acme LLC')
  assert.deepEqual(half.townGuesses, ['A, TX'])
  assert.deepEqual(half.notes, [])
  assert.equal(half.zip, '')
  assert.equal(plan.tidySummary('Acme', { notes: [], doubts: [] }), null)
  const line = plan.tidySummary('Acme', { notes: ['The boxes were swapped.'], doubts: ['Ask for the ZIP.'] })
  assert.match(line, /Onboarding answers tidied\* — \*Acme\*\. The boxes were swapped\. \*Check:\* Ask for the ZIP\./)
  assert.match(plan.tidyMessage(concreteMasonry), /Business Address: 13982 Sheldon rd/)
  assert.match(plan.tidyMessage(concreteMasonry), /Website: concretemasonryllc\.org/)
})
