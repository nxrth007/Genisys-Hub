import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// Google Business Profile setup: which Maps listings are theirs, when the setup page may go out, what the
// owner's page says, and Scout's question in the Office (src/lib/gbp-plan.ts, gbp-kit.ts, office/mapping.ts).
// The names are from the live board on 2026-11-24; phones and emails are made up.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()

function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  cache.set(absPath, m.exports)
  const localRequire = createRequire(pathToFileURL(absPath))
  const req = (id) => {
    const path = id.startsWith('@/') ? join(root, 'src', `${id.slice(2)}.ts`) : id.startsWith('.') ? join(dirname(absPath), id.endsWith('.ts') ? id : `${id}.ts`) : null
    return path && existsSync(path) ? loadTs(path) : localRequire(id)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  return m.exports
}

const plan = loadTs(join(root, 'src/lib/gbp-plan.ts'))
const kit = loadTs(join(root, 'src/lib/gbp-kit.ts'))
const { deriveOffice, emptyInput } = loadTs(join(root, 'src/lib/office/mapping.ts'))
const setupSource = readFileSync(join(root, 'src/lib/gbp-setup.ts'), 'utf8')

const NOW = Date.parse('2026-11-24T18:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const HOUR = 3_600_000
const place = (name, address, o = {}) => ({ placeId: name, name, address, phone: null, website: null, mapsUrl: 'https://maps.google.com/?cid=1', status: 'OPERATIONAL', ...o })
const wanted = (businessName, address = '', o = {}) => plan.wantedListing({ businessName, address, serviceAreas: '', phone: '', ownerPhone: '(603) 555-0142', website: '', ...o })
const lookup = (candidates, o = {}) => ({ at: ago(HOUR), query: 'q', candidates, error: null, v: plan.LOOKUP_VERSION, ...o })

test('a shared name: the same words count, a shared trade word alone never does', () => {
  const same = [
    ['Protech decks', 'Pro Tech Decks LLC'],
    ['Rojas junk removal services', 'Rojas Junk Removal'],
    ['K&P Remodeling LLC', 'K & P Remodeling'],
    ['J r painting', 'J.R. Painting'],
    ['Carlos concrete', "Carlos' Concrete & Masonry"],
    ['BNB Contractors', 'BNB Contracting Inc.'],
    ['Clogbusters Plumbing and General Building', 'Clogbusters Plumbing And General Building'],
    ['Concrete masonry llc', 'Concrete Masonry'],
  ]
  for (const [a, b] of same) assert.equal(plan.sameName(a, b), true, `${a} = ${b}`)
  const different = [
    ['Built by KJ LLC', 'Life Built Homes'],
    ['Built by KJ LLC', 'Brooks Built Homes'],
    ['IJ Switchgear LLC', 'Switchgear Solutions, An IPS Company'],
    ['K&P Remodeling LLC', 'KDO Kitchens & Remodeling'],
    ['K&P Remodeling LLC', 'Kitchen Design Studio & Remodeling of Atlanta'],
    ['Concrete masonry llc', 'Smith Concrete & Masonry'],
    ['Carlos concrete', 'Carlos Painting'],
    ['', 'Anything'],
  ]
  for (const [a, b] of different) assert.equal(plan.sameName(a, b), false, `${a} ≠ ${b}`)
})

test('a name in another state is someone else, unless the phone or website is theirs', () => {
  const w = wanted('Rojas junk removal services', '123 Main St, Bakersfield, CA 93301')
  assert.deepEqual(w.states, ['CA'])
  assert.deepEqual(plan.listingMatches(place('Rojas Junk Removal', 'Raleigh, NC 27603, USA'), w), [])
  assert.deepEqual(plan.listingMatches(place('Rojas Junk Removal', 'Bakersfield, CA 93301, USA'), w), ['same name'])
  // Google shows no address for a business that goes to its customers.
  assert.deepEqual(plan.listingMatches(place('Rojas Junk Removal', ''), w), ['same name'])
  assert.deepEqual(plan.listingMatches(place('Rojas Junk Removal', 'Raleigh, NC 27603, USA', { phone: '(603) 555-0142' }), w), ['same phone', 'same name'])
  // They said they work in several states.
  const many = wanted('IJ Switchgear', '', { serviceAreas: 'AZ NV CO CA' })
  assert.deepEqual(many.states.sort(), ['AZ', 'CA', 'CO', 'NV'])
  assert.deepEqual(plan.listingMatches(place('IJ Switchgear', 'Reno, NV 89502, USA'), many), ['same name'])
  assert.deepEqual(plan.listingMatches(place('IJ Switchgear', 'Tampa, FL 33601, USA'), many), [])
  // However they typed it, and from whatever else says where they are.
  assert.deepEqual(wanted('Acme', 'Tyler, tx').states, ['TX'])
  assert.deepEqual(wanted('Acme', '', { serviceAreas: 'tampa fl\nOrlando' }).states, ['FL'])
  assert.deepEqual(plan.wantedListing({ businessName: 'Acme', address: '', serviceAreas: 'Greater Seattle Area', phone: '', ownerPhone: '', website: '' }, ['Seattle, WA, USA']).states, ['WA'])
})

test('a website match needs their own site: a shared Facebook or Yelp page says nothing', () => {
  const w = wanted('Acme Roofing', 'Tyler, TX 75701', { website: 'https://www.acmeroof.com/contact' })
  assert.deepEqual(plan.listingMatches(place('Totally Else', 'Tyler, TX 75701, USA', { website: 'http://acmeroof.com/' }), w), ['same website'])
  const fb = wanted('Acme Roofing', 'Tyler, TX 75701', { website: 'https://facebook.com/acmeroof' })
  assert.equal(fb.website, '')
  assert.deepEqual(plan.listingMatches(place('Totally Else', 'Tyler, TX 75701, USA', { website: 'https://facebook.com/other' }), fb), [])
  for (const shared of ['https://web.facebook.com/x', 'book.housecallpro.com/x', 'https://clienthub.getjobber.com/y', 'https://linktr.ee/z']) assert.equal(plan.ownHost(shared), '', shared)
  assert.equal(plan.ownHost('https://notfacebook.com'), 'notfacebook.com')
})

test('claim what is theirs, ask about a shared name or number, else create; a closed listing is not one to claim', () => {
  const c = (name, matches, o = {}) => ({ ...place(name, 'Plano, TX 75074, USA'), matches, related: true, ...o })
  assert.equal(plan.listingVerdict(lookup([c('A', ['same name']), c('B', ['same phone'])])).kind, 'claim')
  assert.deepEqual(plan.listingVerdict(lookup([c('A', ['same name']), c('B', ['same phone'])])).listings.map((l) => l.name), ['B'])
  assert.equal(plan.listingVerdict(lookup([c('A', ['same name'])])).kind, 'maybe')
  assert.equal(plan.listingVerdict(lookup([])).kind, 'create')
  assert.equal(plan.listingVerdict(lookup([c('B', ['same phone'], { status: 'CLOSED_PERMANENTLY' })])).kind, 'create')
  // A reused number: a dentist's listing carrying the painter's phone is asked about, never called theirs.
  assert.equal(plan.listingVerdict(lookup([c('Bright Smiles Dental', ['same phone'], { related: false })])).kind, 'maybe')
  assert.equal(plan.relatedNames('Acme Roofing', 'Acme Exteriors'), true)
  assert.equal(plan.relatedNames('Apexcoat painting llc', 'Bright Smiles Dental'), false)
  assert.equal(plan.relatedNames('Concrete masonry llc', 'Smith Concrete & Masonry'), false)
  assert.equal(plan.relatedNames('Concrete masonry llc', 'Concrete Masonry'), true)
  // Not looked, Google didn't answer, or looked the old way (which left out businesses without an address).
  for (const l of [null, undefined, lookup([], { error: 'denied' }), lookup([], { v: undefined }), lookup([], { v: 1 })]) assert.equal(plan.listingVerdict(l).kind, 'unchecked')
})

test('checks: the old way once more, a failure every 6 hours then daily, a good one never', () => {
  assert.equal(plan.lookupDue(null, NOW), true)
  assert.equal(plan.lookupDue(lookup([], { v: undefined, error: 'denied', at: ago(30 * 24 * HOUR) }), NOW), true)
  assert.equal(plan.lookupDue(lookup([], { v: undefined }), NOW), true)
  assert.equal(plan.lookupDue(lookup([]), NOW), false)
  assert.equal(plan.lookupDue(lookup([], { error: 'x', tries: 1, at: ago(HOUR) }), NOW), false)
  assert.equal(plan.lookupDue(lookup([], { error: 'x', tries: 1, at: ago(7 * HOUR) }), NOW), true)
  assert.equal(plan.lookupDue(lookup([], { error: 'x', tries: plan.MAX_LOOKUP_TRIES, at: ago(7 * HOUR) }), NOW), false)
  assert.equal(plan.lookupDue(lookup([], { error: 'x', tries: 50, at: ago(25 * HOUR) }), NOW), true)
})

test('Google not answering never throws away a good check, and failures are counted', () => {
  const good = lookup([place('A', 'x')])
  const bad = lookup([], { error: 'down' })
  assert.equal(plan.nextLookup(good, bad), good)
  const one = plan.nextLookup(null, bad)
  assert.equal(one.tries, 1)
  assert.equal(plan.nextLookup(one, bad).tries, 2)
  // An old-way result isn't good enough to keep, but what it found still shows.
  const old = lookup([place('A', 'x')], { v: undefined })
  assert.equal(plan.nextLookup(old, bad).error, 'down')
  assert.equal(plan.nextLookup(old, bad).candidates.length, 1)
  assert.equal(plan.nextLookup(one, good), good)
})

test('the search asks Google for businesses without an address, and by phone', () => {
  assert.match(setupSource, /includePureServiceAreaBusinesses: true/)
  assert.match(setupSource, /wanted\.phones\.slice\(0, 2\)\.map\(\(d\) => searchText\(key, `\+1 \$\{d\}`\)\)/)
  assert.equal(plan.listingQuery({ businessName: 'K&P Remodeling', address: '', serviceAreas: '50 Mile Radius Around Senoia' }), 'K&P Remodeling Senoia')
  assert.equal(plan.listingQuery({ businessName: 'Acme', address: '123 Main St, Tyler, TX 75701', serviceAreas: 'Frankston' }), 'Acme Tyler, TX')
  assert.equal(plan.listingQuery({ businessName: 'Acme', address: '', serviceAreas: '30 Minute Radius Of Macon' }), 'Acme Macon')
  assert.equal(plan.listingQuery({ businessName: 'Acme', address: '', serviceAreas: '30 miles around 75039' }), 'Acme 75039')
})

test('what stops a one-tap send: no real name, no way to reach them, or Google Maps not checked', () => {
  const ok = { businessName: 'Acme Roofing', ownerFirstName: 'Sam', ownerPhone: '(603) 555-0142', ownerEmail: 'sam@acme.com', category: 'Roofing contractor', siteLive: true, listing: 'create', says: 'no', autoChecked: true }
  assert.deepEqual(plan.sendCheck(ok), { content: null, hold: null, block: null, notes: [] })
  for (const businessName of ['No', 'none', '', 'Post office box 82', '123 Main St', '(603) 555-0142', 'AB', 'acme.com', 'sam@acme.com']) {
    assert.match(plan.sendCheck({ ...ok, businessName }).content ?? '', /isn’t a business name/, businessName)
    assert.equal(plan.sendCheck({ ...ok, businessName }).block, plan.sendCheck({ ...ok, businessName }).content)
  }
  for (const businessName of ['1st Choice Roofing', '3 Brothers Roofing', '24/7 Plumbing', 'A1M Construction', '2 Guys Painting LLC']) assert.equal(plan.sendCheck({ ...ok, businessName }).block, null, businessName)
  assert.match(plan.sendCheck({ ...ok, ownerPhone: '', ownerEmail: '' }).content, /No owner cell or email/)
  // These stop one tap, not a person sending it from the client's own board.
  for (const o of [{ says: 'yes' }, { listing: 'unchecked' }]) assert.equal(plan.sendCheck({ ...ok, ...o }).content, null)
  // Maps not checked clears itself; the form saying yes doesn't, checked or not.
  assert.equal(plan.sendCheck({ ...ok, listing: 'unchecked' }).hold, null)
  assert.match(plan.sendCheck({ ...ok, says: 'yes', listing: 'unchecked' }).hold, /already have a profile/)
  assert.match(plan.sendCheck({ ...ok, listing: 'unchecked' }).block, /Google Maps isn’t checked.*on its own within minutes/)
  assert.doesNotMatch(plan.sendCheck({ ...ok, listing: 'unchecked', autoChecked: false }).block, /on its own/)
  for (const listing of ['claim', 'maybe']) assert.equal(plan.sendCheck({ ...ok, listing }).block, null)
  assert.match(plan.sendCheck({ ...ok, says: 'yes' }).block, /The form says they already have a profile/)
  assert.deepEqual(plan.sendCheck({ ...ok, says: null }), { content: null, hold: null, block: null, notes: ['the form doesn’t say if they have one'] })
  // One way to reach them is enough, and worth a glance.
  assert.deepEqual(plan.sendCheck({ ...ok, ownerEmail: 'not an email', category: '', siteLive: false, ownerFirstName: '' }), {
    content: null,
    hold: null,
    block: null,
    notes: ['no email, so text only', 'no first name (“Hi there”)', 'no category', 'website not live yet'],
  })
})

test('owners are texted 9 AM to 7 PM where they are, the next morning otherwise', () => {
  const at = (s) => new Date(s)
  const z = (zone, from = 9) => ({ zone, from })
  // 18:00 UTC in November: 1 PM Eastern, 10 AM Pacific, 8 AM Hawaii.
  assert.equal(plan.daytime(z('America/New_York'), at('2026-11-24T18:00:00Z')), true)
  assert.equal(plan.daytime(z('America/Los_Angeles'), at('2026-11-24T18:00:00Z')), true)
  assert.equal(plan.daytime(z('Pacific/Honolulu'), at('2026-11-24T18:00:00Z')), false)
  // 15:00 UTC: 10 AM Eastern is 7 AM Pacific (the old Eastern-only window texted them then).
  assert.equal(plan.daytime(z('America/Los_Angeles'), at('2026-11-24T15:00:00Z'), 10), false)
  assert.equal(plan.daytime(z('America/New_York'), at('2026-11-24T15:00:00Z'), 10), true)
  // 1 AM Eastern: 9 AM Eastern the same day; 9 AM Central an hour after that.
  assert.equal(plan.nextDaytime(z('America/New_York'), at('2026-11-24T06:10:00Z')).toISOString(), '2026-11-24T14:00:00.000Z')
  assert.equal(plan.nextDaytime(z('America/Chicago'), at('2026-11-24T06:10:00Z')).toISOString(), '2026-11-24T15:00:00.000Z')
  // 8 PM Eastern: tomorrow. And across the spring clock change.
  assert.equal(plan.nextDaytime(z('America/New_York'), at('2026-11-25T01:00:00Z')).toISOString(), '2026-11-25T14:00:00.000Z')
  assert.equal(plan.nextDaytime(z('America/New_York'), at('2027-03-14T05:30:00Z')).toISOString(), '2027-03-14T13:00:00.000Z')
  assert.equal(plan.goesOutAt(z('America/New_York'), at('2026-11-24T18:00:00Z')), null)
  assert.equal(plan.goesOutAt(z('America/Chicago'), at('2026-11-24T06:10:00Z')), '9 AM Central today')
  assert.equal(plan.goesOutAt(z('America/New_York'), at('2026-11-25T01:00:00Z')), '9 AM Eastern tomorrow')
})

test('whose zone: New York on an account only means nobody changed it', () => {
  const NY = 'America/New_York'
  // A Fresno owner with no account, or one left at New York, is on Pacific time.
  assert.deepEqual(plan.ownerZone(null, ['123 Main St Fresno ca 93701']), { zone: 'America/Los_Angeles', from: 9 })
  assert.deepEqual(plan.ownerZone(NY, ['', null, 'Fresno, CA, USA']), { zone: 'America/Los_Angeles', from: 9 })
  assert.deepEqual(plan.ownerZone(NY, ['', 'Texas']), { zone: 'America/Chicago', from: 9 })
  assert.deepEqual(plan.ownerZone(NY, ['Boston, MA 02108']), { zone: NY, from: 9 })
  // Set to something else: someone or the form said so.
  assert.deepEqual(plan.ownerZone('America/Denver', ['Boston, MA']), { zone: 'America/Denver', from: 9 })
  assert.deepEqual(plan.ownerZone('Not/AZone', ['Tyler, TX']), { zone: 'America/Chicago', from: 9 })
  // Nothing says: noon Eastern, 9 AM Pacific.
  const unknown = plan.ownerZone(NY, ['Greater Metro Area', null])
  assert.deepEqual(unknown, { zone: NY, from: 12 })
  assert.equal(plan.daytime(unknown, new Date('2026-11-24T15:00:00Z')), false)
  assert.equal(plan.daytime(unknown, new Date('2026-11-24T17:00:00Z')), true)
  assert.equal(plan.goesOutAt(unknown, new Date('2026-11-24T06:10:00Z')), 'noon Eastern today')
})

test('the first name in the greeting', () => {
  assert.equal(plan.firstName('JOSE RAMIREZ'), 'Jose')
  assert.equal(plan.firstName('kelvin'), 'Kelvin')
  assert.equal(plan.firstName("D'Andre Smith"), "D'Andre")
  assert.equal(plan.firstName('LaToya'), 'LaToya')
  assert.equal(plan.firstName('JR Smith'), 'JR')
  assert.equal(plan.firstName('Mr. Sam Smith'), 'Sam')
  assert.equal(plan.firstName('Sam, '), 'Sam')
  // Not a person's name: "Hi there" instead.
  for (const bad of [null, '', 'J.r. Smith', 'Mr.', 'sam@acme.com', '13982 Sheldon rd', 'Acme Roofing LLC', 'J']) assert.equal(plan.firstName(bad), '', String(bad))
})

test('the setup page column', () => {
  const open = (status) => ({ status, at: ago(0), by: null, detail: null })
  const st = (o) => plan.pageState({ open: null, sentAt: null, skippedAt: null, done: false, ...o })
  assert.equal(st({}), 'not_sent')
  assert.equal(st({ skippedAt: ago(0) }), 'skipped')
  assert.equal(st({ sentAt: ago(0) }), 'sent')
  assert.equal(st({ open: open('ask') }), 'asked')
  for (const s of ['queued', 'sending', 'failed']) assert.equal(st({ open: open(s), sentAt: ago(0) }), s)
  assert.equal(st({ open: open('queued'), done: true }), 'done')
  assert.equal(plan.readOpenSend('{broken'), null)
  assert.equal(plan.readOpenSend(JSON.stringify({ status: 'bogus', at: ago(0) })), null)
  assert.deepEqual(plan.readOpenSend(JSON.stringify({ status: 'queued', at: 'x', by: 'a@b.c' })), { status: 'queued', at: 'x', by: 'a@b.c', detail: null })
})

// ---- what the board fills in ----

const source = (o = {}) => ({
  name: 'Jake’s property maintenance LLC',
  contactName: 'jake smith',
  contactEmail: null,
  contactPhone: null,
  siteUrl: null,
  website: null,
  intake: { fullName: 'JAKE SMITH', businessName: 'Post office box 82', businessAddress: 'Jake’s property maintenance LLC', customerPhone: null, leadEmail: null, cities: 'Tyler, Central Time Zone', mainServices: '- **Epoxy Flooring:** Garage floors', aboutBusiness: null, whyChooseYou: null, yearStarted: null },
  facts: null,
  ...o,
})

test('crossed answers, a shouted name and a missing email are filled in right', () => {
  const x = kit.gbpPrefill({ ...source(), hl: { ownerFirstName: 'Jake', phone: '+16035550142', email: 'jake@example.com', serviceArea: null } })
  assert.equal(x.businessName, 'Jake’s property maintenance LLC')
  assert.equal(x.ownerFirstName, 'Jake')
  assert.equal(x.ownerEmail, 'jake@example.com')
  assert.equal(x.ownerPhone, '(603) 555-0142')
  assert.equal(x.serviceAreas, 'Tyler')
  // Their own answers win over the Genisys OS profile's.
  const own = kit.gbpPrefill({ ...source({ contactEmail: 'owner@acme.com', contactPhone: '603-555-0199' }), hl: { phone: '+16035550142', email: 'jake@example.com' } })
  assert.equal(own.ownerEmail, 'owner@acme.com')
  assert.equal(own.ownerPhone, '(603) 555-0199')
})

test('junk answers never reach the owner: no website yet, a PO box as the shop, an address as the owner', () => {
  const fill = (o) => kit.gbpPrefill(source({ intake: { ...source().intake, businessName: 'Acme Roofing LLC', ...o.intake }, ...o }))
  for (const website of ['no website yet', 'no', 'https://www.facebook.com/acme']) assert.equal(fill({ website }).website, '', website)
  assert.equal(fill({ siteUrl: 'http://www.acmeroof.com/contact' }).website, 'https://www.acmeroof.com')
  const x = fill({ intake: { fullName: '13982 Sheldon rd', customerPhone: 'jake@x.com', businessAddress: 'PO Box 82, Tyler, TX 75701' } })
  assert.equal(x.phone, '')
  assert.doesNotMatch(x.description, /Sheldon/)
  assert.equal(x.ownerFirstName, '')
  assert.equal(kit.ownerFields(x).find((f) => f.id === 'address'), undefined)
  // Name and address crossed: each goes back where it belongs.
  const crossed = fill({ intake: { businessName: '123 Main St, Tyler, TX 75701', businessAddress: 'Acme Roofing LLC' } })
  assert.equal(crossed.address, '123 Main St, Tyler, TX 75701')
  assert.equal(crossed.businessName, 'Jake’s property maintenance LLC')
  assert.equal(fill({ intake: { businessName: '3 Brothers Roofing' } }).businessName, '3 Brothers Roofing')
})

// ---- the owner's page ----

const inputs = (o = {}) => ({
  businessName: 'Acme Roofing',
  primaryCategory: 'Roofing contractor',
  extraCategories: '',
  locationMode: 'address',
  address: '123 Main St, Tyler, TX 75701',
  serviceAreas: 'Tyler\nFrankston',
  phone: '(603) 555-0142',
  website: 'https://acmeroof.com',
  hours: '',
  services: '- **Epoxy Flooring:** Garage floors\nRepairs',
  description: 'Acme Roofing is a roofing contractor.',
  ownerFirstName: 'Sam',
  ownerEmail: 'sam@acme.com',
  ownerPhone: '(603) 555-0142',
  ...o,
})
const field = (x, id, o) => kit.ownerFields(x, o).find((f) => f.id === id)

test('the owner never sees a blank, and a home address is never published by default', () => {
  const all = kit.ownerFields(inputs({ primaryCategory: '', website: '', serviceAreas: '', description: '', services: '', phone: '', address: '' }))
  assert.ok(all.every((f) => !/⟦|\[/.test(f.text) && f.text.trim()), JSON.stringify(all))
  assert.deepEqual(all.map((f) => f.id), ['name', 'category', 'areas', 'website', 'hours'])
  for (const id of ['category', 'areas', 'website', 'hours']) assert.equal(all.find((f) => f.id === id).guide, true, id)
  // Going to customers comes first; the address is only for a shop, and says it shows on the map.
  const ids = kit.ownerFields(inputs()).map((f) => f.id)
  assert.ok(ids.indexOf('areas') < ids.indexOf('address'))
  assert.match(field(inputs(), 'areas').note, /choose No/)
  assert.match(field(inputs(), 'address').label, /Only if customers come/)
  assert.match(field(inputs(), 'address').note, /shows on Google Maps/)
  // No street, or kept private on the site: no address at all.
  assert.equal(field(inputs({ address: 'Tyler, TX' }), 'address'), undefined)
  assert.equal(field(inputs({ locationMode: 'service_area' }), 'address'), undefined)
  // Nothing of ours in it, and no markdown.
  assert.equal(field(inputs(), 'owner'), undefined)
  assert.equal(field(inputs(), 'services').text, 'Epoxy Flooring: Garage floors\nRepairs')
  // Making a new one: if Google already shows them, pick it.
  assert.match(field(inputs(), 'name').note, /pick it: that claims the one it has/)
  assert.doesNotMatch(field(inputs(), 'name', { claim: true }).note, /pick it/)
  // Claiming: the listing exists, so it's Edit profile, not Google's questions.
  assert.match(field(inputs(), 'areas', { claim: true }).note, /^Under Edit profile, then Location: hide your address/)
  assert.match(field(inputs({ serviceAreas: '' }), 'areas', { claim: true }).text, /hide your address/)
  assert.match(field(inputs(), 'address', { claim: true }).note, /^Then show this address instead/)
})

test('the text and email say claim when Google already lists them, in plain characters', () => {
  const link = 'https://genisys-hub.onrender.com/gbp-setup/abc'
  const create = kit.instructionsText(inputs(), link)
  const claim = kit.instructionsText(inputs(), link, 'claim')
  assert.match(create, /getting you on Google Maps/)
  assert.match(claim, /Google already lists you, so you just claim it/)
  assert.equal(kit.instructionsText(inputs(), link, 'maybe'), create)
  for (const t of [create, claim]) {
    assert.ok(t.endsWith(link))
    assert.match(t, /^[\x00-\x7F]*$/, 'GSM characters only')
  }
  assert.match(kit.instructionsEmail(inputs(), link, 'claim').subject, /^Claim your Google listing/)
  assert.match(kit.instructionsEmail(inputs(), link, 'claim').body, /Claim this business/)
  assert.match(kit.instructionsEmail(inputs(), link).subject, /^Set up your Google Business Profile/)
  assert.doesNotMatch(kit.instructionsEmail(inputs(), link).body, /Claim this business/)
})

// ---- the Office ----

const office = (gbp, o = {}) => {
  const input = emptyInput()
  input.approvals = [{ id: 'client-1', kind: 'gbp', clientName: 'Acme Roofing', at: new Date(NOW - HOUR), stage: 'ask', reviewLink: '/clients/client-1/gbp', gbp: { listing: 'create', listingName: null, siteLive: true, text: true, email: true, later: null, ...gbp }, ...o }]
  return deriveOffice(input, new Date(NOW))
}

test('Scout asks in the Office, says what Google Maps shows, and Echo stays out of it', () => {
  const s = office({})
  const a = s.approvals[0]
  assert.equal(a.question, 'Send Acme Roofing their Google profile page?')
  assert.equal(a.botId, 'scout')
  assert.equal(a.reviewLink, '/clients/client-1/gbp')
  assert.match(a.note, /Google Maps shows nothing for them/)
  assert.match(a.note, /Texts and emails the owner/)
  assert.equal(s.bots.find((b) => b.id === 'scout').status, 'needs_you')
  assert.equal(s.bots.find((b) => b.id === 'echo').status, 'idle')
  assert.match(office({ listing: 'claim', listingName: 'Acme Roofing Co' }).approvals[0].note, /already lists them \(“Acme Roofing Co”\), so the page has them claim that one/)
  assert.match(office({ listing: 'maybe', listingName: 'Acme' }).approvals[0].note, /asks them whether it’s theirs/)
  assert.match(office({ siteLive: false }).approvals[0].note, /website isn’t live yet/)
  assert.match(office({ email: false }).approvals[0].note, /Texts the owner a page/)
  assert.match(office({ later: '9 AM Central tomorrow' }).approvals[0].note, /Goes out 9 AM Central tomorrow\.$/)
})

test('a page that did not go out shows as an error for two weeks', () => {
  const input = emptyInput()
  input.gbpFailed = [{ clientId: 'c1', clientName: 'Acme', detail: 'Text failed: DND. Email skipped.', at: new Date(NOW - HOUR) }]
  const s = deriveOffice(input, new Date(NOW))
  assert.equal(s.bots.find((b) => b.id === 'scout').status, 'error')
  assert.equal(s.requests[0].kind, 'error')
  assert.equal(s.requests[0].link, '/clients/c1/gbp')
  input.gbpFailed[0].at = new Date(NOW - 15 * 24 * HOUR)
  assert.equal(deriveOffice(input, new Date(NOW)).requests.length, 0)
})
