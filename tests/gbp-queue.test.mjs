import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// The Google profile setup pages' queue (src/lib/gbp-setup.ts) against a database in memory: each page goes
// out once, in daytime where the owner is, whoever presses what. Nothing here reaches GHL, Gmail or Google.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.NODE_ENV = 'production'
const DAY = new Date('2026-11-24T18:00:00Z') // 1 PM Eastern
const NIGHT = new Date('2026-11-24T06:00:00Z') // 1 AM Eastern

/** A fake database with the few calls gbp-setup makes; updateMany and deleteMany match on the exact value, as Postgres does. */
function makeDb() {
  const settings = new Map()
  const clients = new Map()
  const match = (row, w = {}) => {
    if (w.OR && !w.OR.some((o) => match(row, o))) return false
    if (w.NOT && match(row, w.NOT)) return false
    if (typeof w.key === 'string' && row.key !== w.key) return false
    if (w.key && typeof w.key === 'object' && !row.key.startsWith(w.key.startsWith)) return false
    if (typeof w.value === 'string' && row.value !== w.value) return false
    if (w.value && typeof w.value === 'object' && !row.value.includes(w.value.contains)) return false
    return true
  }
  const rows = (where) => [...settings].map(([key, value]) => ({ key, value })).filter((r) => match(r, where))
  const tick = () => new Promise((r) => setImmediate(r))
  const keep = (c, w = {}) => (!('archivedAt' in w) || !c.archivedAt) && !(w.lifecycle?.notIn ?? []).includes(c.lifecycle)
  const prisma = {
    appSetting: {
      findUnique: async ({ where }) => (await tick(), settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      findMany: async ({ where }) => (await tick(), rows(where)),
      create: async ({ data }) => {
        await tick()
        if (settings.has(data.key)) throw Object.assign(new Error('unique'), { code: 'P2002' })
        settings.set(data.key, data.value)
      },
      upsert: async ({ where, create, update }) => (await tick(), settings.set(where.key, settings.has(where.key) ? update.value : create.value)),
      updateMany: async ({ where, data }) => {
        await tick()
        const hit = rows(where)
        hit.forEach((r) => settings.set(r.key, data.value))
        return { count: hit.length }
      },
      deleteMany: async ({ where }) => {
        await tick()
        const hit = rows(where)
        hit.forEach((r) => settings.delete(r.key))
        return { count: hit.length }
      },
    },
    client: {
      findUnique: async ({ where }) => clients.get(where.id) ?? null,
      findFirst: async ({ where }) => [...clients.values()].find((c) => c.id === where.id && keep(c, where)) ?? null,
      findMany: async ({ where }) => [...clients.values()].filter((c) => keep(c, where) && (!where?.id || where.id.in.includes(c.id))),
    },
    hlAccount: { findMany: async ({ where }) => [...clients.values()].filter((c) => where.clientId.in.includes(c.id) && c.hlAccount).map((c) => ({ clientId: c.id, timezone: c.hlAccount.timezone })) },
    remindersConfig: { findUnique: async () => ({ senderPhone: '+16035550100' }) },
  }
  return { prisma, settings, clients }
}

/** One Hub process: gbp-setup.ts with its own module state, on the given database. */
function hub(db, o = {}) {
  const sms = []
  const mail = []
  const searches = []
  const cache = new Map()
  const stubs = {
    '@/lib/prisma': { prisma: db.prisma },
    '@/lib/ghl': {
      sendSmsToPhone: async (_entry, p) => {
        if (o.smsFails?.(p)) throw new Error(o.smsError ?? 'GHL API error 400: no')
        await o.whileTexting?.(p)
        sms.push(p)
      },
    },
    '@/lib/gmail': {
      sendEmail: async (p) => {
        if (o.mailFails) throw new Error('Gmail said no')
        mail.push(p)
      },
    },
    '@/lib/drive': { getWriterAccountEmail: async () => 'hub@example.com' },
    '@/lib/hub-alerts': { hubAlert: async () => {}, hubLink: (p) => `https://hub.example${p}` },
    '@/lib/places-key': { placesApiKey: async () => 'key', PLACES_KEY_ENTRY: 'Places API (New)' },
    '@/lib/ghl-automation-values': { setClientCustomValue: async () => ({ ok: true, detail: '' }) },
    '@/lib/hl/accounts': { readProfile: (v) => v ?? {}, setHlGoogleProfile: async () => true, setHlReviewLink: async () => true },
    '@/lib/seo/client-facts': { markTeamEdits: () => ({}), readMeta: () => ({}) },
    '@/lib/team-sms': { TEAM_ALERT_PHONES: [{ name: 'Alex', phone: '+16035550111' }], textTeam: async () => [] },
  }
  function loadTs(absPath) {
    if (cache.has(absPath)) return cache.get(absPath)
    const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    })
    const m = { exports: {} }
    cache.set(absPath, m.exports)
    const localRequire = createRequire(pathToFileURL(absPath))
    const req = (id) => {
      if (stubs[id]) return stubs[id]
      const path = id.startsWith('@/') ? join(root, 'src', `${id.slice(2)}.ts`) : id.startsWith('.') ? join(dirname(absPath), id.endsWith('.ts') ? id : `${id}.ts`) : null
      return path && existsSync(path) ? loadTs(path) : localRequire(id)
    }
    const fetchStub = async (_url, init) => {
      const body = JSON.parse(init.body)
      searches.push(body)
      if (o.mapsFails) return { ok: false, status: 403, json: async () => ({ error: { message: 'denied' } }) }
      return { ok: true, status: 200, json: async () => ({ places: o.places ?? [] }) }
    }
    new Function('module', 'exports', 'require', 'fetch', 'console', outputText)(m, m.exports, req, fetchStub, { log() {}, warn() {}, error() {} })
    return m.exports
  }
  return { ...loadTs(join(root, 'src/lib/gbp-setup.ts')), sms, mail, searches }
}

const checked = { at: new Date().toISOString(), query: 'q', candidates: [], error: null, v: 2 }
function addClient(db, id, o = {}) {
  db.clients.set(id, {
    id,
    name: o.name ?? `${id} Roofing`,
    contactName: 'Sam Smith',
    contactEmail: o.email === undefined ? `${id}@example.com` : o.email,
    contactPhone: o.phone === undefined ? '(603) 555-0142' : o.phone,
    siteUrl: 'https://acmeroof.com',
    website: null,
    geoLat: null,
    geoLng: null,
    geoLabel: null,
    archivedAt: null,
    lifecycle: o.lifecycle ?? 'active',
    seoSite: o.facts ? { id: 's', facts: o.facts } : null,
    hlAccount: { profile: {}, timezone: o.zone ?? 'America/New_York' },
    intakes: [{ fullName: 'Sam Smith', businessName: o.name ?? `${id} Roofing`, businessAddress: o.address ?? '123 Main St, Boston, MA 02108', customerPhone: null, leadEmail: null, cities: o.cities ?? 'Boston', mainServices: 'Roofing', aboutBusiness: null, whyChooseYou: null, yearStarted: null, hasGoogleProfile: o.answer ?? 'No', googleProfileLink: null }],
  })
  db.settings.set(`gbp.client.${id}`, JSON.stringify({ status: o.status === undefined ? 'needed' : o.status, values: {}, lookup: o.lookup === undefined ? checked : o.lookup, texts: [], history: [], remind: false, profileUrl: null, reviewUrl: null, ...o.state }))
}
const state = (db, id) => JSON.parse(db.settings.get(`gbp.client.${id}`))
const open = (db, id) => (db.settings.has(`gbp.send.${id}`) ? JSON.parse(db.settings.get(`gbp.send.${id}`)) : null)

let db
beforeEach(() => {
  db = makeDb()
})

test('picked clients are queued; the ones who shouldn’t get it are left out, saying why', async () => {
  const h = hub(db)
  addClient(db, 'ok')
  addClient(db, 'verified', { status: 'verified' })
  addClient(db, 'has', { status: null, answer: 'Yes' })
  addClient(db, 'sent', { state: { sentAt: '2026-11-20T15:00:00Z' } })
  addClient(db, 'noname', { name: 'No' })
  addClient(db, 'nocontact', { email: null, phone: null })
  addClient(db, 'unchecked', { lookup: { ...checked, v: undefined } })
  const r = await h.queueSetupSends(['ok', 'verified', 'has', 'sent', 'noname', 'nocontact', 'unchecked', 'ok', 'ghost'], 'alex@x')
  assert.deepEqual(r.queued, ['ok'])
  assert.deepEqual(r.left.map((l) => l.id), ['verified', 'has', 'sent', 'noname', 'nocontact', 'unchecked'])
  assert.equal(open(db, 'ok').status, 'queued')
  assert.equal(open(db, 'ok').by, 'alex@x')
  assert.equal(h.sms.length, 0, 'queuing sends nothing')
  // Pressing again doesn't queue it twice.
  assert.deepEqual((await h.queueSetupSends(['ok'], 'ethan@x')).left[0].why, 'Already on its way.')
  assert.equal(open(db, 'ok').by, 'alex@x')
})

test('a queued page goes out once: text, email, reminders on, and nothing left open', async () => {
  const h = hub(db)
  addClient(db, 'a')
  await h.queueSetupSends(['a'], 'alex@x')
  assert.equal(await h.maybeSendQueuedSetups(DAY), 1)
  assert.equal(h.sms.length, 1)
  assert.equal(h.sms[0].phone, '+16035550142')
  assert.equal(h.sms[0].fromNumber, '+16035550100', 'from the line the team’s texts use')
  assert.match(h.sms[0].message, /^Hi Sam, it's Genisys\. Next step for a Roofing: getting you on Google Maps/)
  assert.match(h.sms[0].message, /https:\/\/hub\.example\/gbp-setup\//)
  assert.equal(h.mail.length, 1)
  assert.equal(h.mail[0].to, 'a@example.com')
  assert.equal(open(db, 'a'), null)
  const s = state(db, 'a')
  assert.equal(s.status, 'verifying')
  assert.equal(s.remind, true)
  assert.ok(s.sentAt)
  assert.equal(await h.maybeSendQueuedSetups(DAY), 0)
  assert.equal(h.sms.length, 1)
})

test('two Hub processes at once (a deploy) send each page once between them', async () => {
  const one = hub(db)
  const two = hub(db)
  for (let i = 0; i < 6; i++) addClient(db, `c${i}`)
  await one.queueSetupSends([...db.clients.keys()], 'alex@x')
  for (let i = 0; i < 4; i++) await Promise.all([one.maybeSendQueuedSetups(DAY), two.maybeSendQueuedSetups(DAY)])
  const to = [...one.mail, ...two.mail].map((m) => m.to).sort()
  assert.deepEqual(to, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'].map((c) => `${c}@example.com`))
  assert.equal(one.sms.length + two.sms.length, 6)
})

test('never at night: it waits for 9 AM where the owner is', async () => {
  const h = hub(db)
  addClient(db, 'ny')
  addClient(db, 'la', { address: '12 Elm St, Fresno, ca 93701', cities: 'Fresno' })
  await h.queueSetupSends(['ny', 'la'], null)
  assert.equal(await h.maybeSendQueuedSetups(NIGHT), 0)
  // 9:30 AM Eastern is 6:30 AM Pacific.
  assert.equal(await h.maybeSendQueuedSetups(new Date('2026-11-24T14:30:00Z')), 1)
  assert.equal(h.mail[0].to, 'ny@example.com')
  assert.equal(open(db, 'la').status, 'queued')
  assert.equal(await h.maybeSendQueuedSetups(new Date('2026-11-24T17:05:00Z')), 1)
  assert.equal(h.mail[1].to, 'la@example.com')
})

test('neither text nor email went: it says so and isn’t tried again until a person asks', async () => {
  const h = hub(db, { smsFails: () => true, mailFails: true })
  addClient(db, 'a')
  await h.queueSetupSends(['a'], 'alex@x')
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(open(db, 'a').status, 'failed')
  assert.match(open(db, 'a').detail, /GHL API error 400.*Gmail said no/)
  assert.equal(state(db, 'a').sentAt ?? null, null)
  assert.equal(state(db, 'a').status, 'needed')
  assert.equal(await h.maybeSendQueuedSetups(DAY), 0)
  const items = await h.gbpOfficeItems(DAY)
  assert.deepEqual(items.map((i) => [i.clientId, i.status]), [['a', 'failed']])
  const again = hub(db)
  assert.deepEqual((await again.queueSetupSends(['a'], 'alex@x')).queued, ['a'])
  assert.equal(await again.maybeSendQueuedSetups(DAY), 1)
  assert.equal(open(db, 'a'), null)
})

test('a send cut off by a restart is called failed, never sent again on its own', async () => {
  const h = hub(db)
  addClient(db, 'a')
  db.settings.set('gbp.send.a', JSON.stringify({ status: 'sending', at: new Date(DAY.getTime() - 5 * 60_000).toISOString(), by: 'alex@x', detail: null }))
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(open(db, 'a').status, 'sending', 'still within ten minutes')
  await h.maybeSendQueuedSetups(new Date(DAY.getTime() + 6 * 60_000))
  assert.equal(open(db, 'a').status, 'failed')
  assert.match(open(db, 'a').detail, /may have gone out/)
  assert.equal(h.sms.length + h.mail.length, 0)
})

test('the sender number refused: the account’s default number is tried; one way to reach them is enough', async () => {
  const h = hub(db, { smsFails: (p) => !!p.fromNumber, mailFails: true })
  addClient(db, 'a')
  await h.queueSetupSends(['a'], null)
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(h.sms.length, 1)
  assert.equal(h.sms[0].fromNumber, undefined)
  assert.equal(open(db, 'a'), null, 'the text went, so it counts as sent')
})

test('the Office question: yes queues it, a second yes is refused, no drops it', async () => {
  const h = hub(db)
  addClient(db, 'a')
  addClient(db, 'b')
  for (const id of ['a', 'b']) db.settings.set(`gbp.send.${id}`, JSON.stringify({ status: 'ask', at: NIGHT.toISOString(), by: null, detail: null }))
  assert.deepEqual((await h.gbpOfficeItems(DAY)).map((i) => i.clientId).sort(), ['a', 'b'])
  const [first, second] = await Promise.all([h.decideGbpAsk('a', 'send', 'Alex'), h.decideGbpAsk('a', 'send', 'Ethan')])
  assert.equal([first, second].filter((r) => r.ok).length, 1, 'only one answer counts')
  assert.equal(open(db, 'a').status, 'queued')
  const no = await h.decideGbpAsk('b', 'no', 'Alex')
  assert.equal(no.ok, true)
  assert.equal(open(db, 'b'), null)
  assert.ok(state(db, 'b').skippedAt)
  assert.equal((await h.decideGbpAsk('b', 'send', 'Alex')).ok, false)
  // Not now isn't forever: a person can still pick them on Google Profiles.
  assert.deepEqual((await h.queueSetupSends(['b'], 'alex@x')).queued, ['b'])
})

test('a question that can’t be answered yes yet stays, saying what to fix', async () => {
  const h = hub(db)
  addClient(db, 'a', { name: 'No' })
  db.settings.set('gbp.send.a', JSON.stringify({ status: 'ask', at: NIGHT.toISOString(), by: null, detail: null }))
  const r = await h.decideGbpAsk('a', 'send', 'Alex')
  assert.equal(r.ok, false)
  assert.match(r.reason, /isn’t a business name/)
  assert.equal(open(db, 'a').status, 'ask')
  assert.match((await h.gbpOfficeItems(DAY))[0].block, /isn’t a business name/)
})

test('a new client who says No: Maps is checked, Scout asks, nothing is sent', async () => {
  const h = hub(db, { places: [{ id: 'p1', displayName: { text: 'New Roofing' }, formattedAddress: 'Boston, MA 02108, USA', nationalPhoneNumber: '(603) 555-0142', googleMapsUri: 'https://maps.google.com/?cid=1', businessStatus: 'OPERATIONAL' }] })
  addClient(db, 'new', { status: null, lookup: null })
  addClient(db, 'yes', { status: null, lookup: null, answer: 'Yes' })
  await h.startGbpForNewIntake('new')
  await h.startGbpForNewIntake('yes')
  assert.equal(open(db, 'new').status, 'ask')
  assert.equal(open(db, 'yes'), null)
  assert.equal(state(db, 'new').status, 'existing', 'their phone is on a listing: claim it')
  assert.equal((await h.gbpOfficeItems(DAY))[0].listing, 'claim')
  // The form sent twice doesn't ask twice, nor after a Not now.
  await h.startGbpForNewIntake('new')
  await h.decideGbpAsk('new', 'no', 'Alex')
  await h.startGbpForNewIntake('new')
  assert.equal(open(db, 'new'), null)
  assert.equal(h.sms.length + h.mail.length, 0)
  assert.ok(h.searches.every((b) => b.includePureServiceAreaBusinesses === true && b.regionCode === 'US'))
  assert.ok(h.searches.some((b) => b.textQuery === '+1 6035550142'))
})

test('the text says claim when Google lists them', async () => {
  const h = hub(db)
  addClient(db, 'a', { status: 'existing', lookup: { ...checked, candidates: [{ placeId: 'p', name: 'A Roofing', address: 'Boston, MA 02108, USA', phone: null, website: null, mapsUrl: 'https://maps.google.com/?cid=1', status: 'OPERATIONAL', matches: ['same phone'], related: true }] } })
  await h.queueSetupSends(['a'], null)
  await h.maybeSendQueuedSetups(DAY)
  assert.match(h.sms[0].message, /Google already lists you, so you just claim it/)
  assert.match(h.mail[0].subject, /^Claim your Google listing/)
  const page = await h.publicSetup(state(db, 'a').publicToken)
  assert.equal(page.mode, 'claim')
  assert.deepEqual(page.listings, [{ name: 'A Roofing', address: 'Boston, MA 02108', mapsUrl: 'https://maps.google.com/?cid=1' }])
  assert.equal(page.done, false)
})

test('a stale check is done again right before the page goes out', async () => {
  const h = hub(db, { places: [] })
  addClient(db, 'a', { lookup: { ...checked, at: '2026-09-01T00:00:00Z' } })
  await h.queueSetupSends(['a'], null)
  await h.maybeSendQueuedSetups(DAY)
  assert.ok(h.searches.length >= 1)
  assert.notEqual(state(db, 'a').lookup.at, '2026-09-01T00:00:00Z')
  // Google not answering doesn't hold it up, or lose the earlier check.
  const down = hub(db, { mapsFails: true })
  addClient(db, 'b', { lookup: { ...checked, at: '2026-09-01T00:00:00Z' } })
  await down.queueSetupSends(['b'], null)
  assert.equal(await down.maybeSendQueuedSetups(DAY), 1)
  assert.equal(state(db, 'b').lookup.at, '2026-09-01T00:00:00Z')
  assert.equal(down.sms.length, 1)
})

test('a Maps search says nothing about a client whose form says they have a profile, or doesn’t say', async () => {
  const h = hub(db)
  addClient(db, 'yes', { status: null, answer: 'Yes', lookup: null })
  addClient(db, 'blank', { status: null, lookup: null })
  db.clients.get('blank').intakes[0].hasGoogleProfile = null
  addClient(db, 'no', { status: null, lookup: null })
  for (const id of ['yes', 'blank', 'no']) await h.lookupExistingListing(id)
  assert.equal(state(db, 'yes').status, null)
  assert.equal(state(db, 'blank').status, null)
  assert.equal(state(db, 'no').status, 'needed')
  // One already marked as needing a profile, though the form says yes, isn't a one-tap send.
  addClient(db, 'mixed', { answer: 'Yes' })
  assert.match((await h.queueSetupSends(['mixed'], null)).left[0].why, /The form says they already have a profile/)
})

test('the owner finishing while the email is still going out isn’t overwritten', async () => {
  const h = hub(db)
  addClient(db, 'a')
  await h.queueSetupSends(['a'], null)
  // The owner is quick: the page's Done lands between the text and the save.
  const realPush = h.mail.push.bind(h.mail)
  h.mail.push = (m) => {
    const s = state(db, 'a')
    db.settings.set('gbp.client.a', JSON.stringify({ ...s, clientDoneAt: '2026-11-24T18:00:05Z', status: 'created', profileUrl: 'https://maps.app.goo.gl/x', remind: false }))
    return realPush(m)
  }
  await h.maybeSendQueuedSetups(DAY)
  const s = state(db, 'a')
  assert.equal(s.status, 'created')
  assert.equal(s.profileUrl, 'https://maps.app.goo.gl/x')
  assert.equal(s.remind, false)
  assert.ok(s.sentAt)
})

test('the Maps re-check: only clients who need a profile, a few at a time until none is left, sending nothing', async () => {
  const h = hub(db)
  for (let i = 0; i < 6; i++) addClient(db, `need${i}`, { lookup: i % 2 ? null : { ...checked, v: undefined, error: 'denied' } })
  addClient(db, 'done', { status: 'verified', lookup: null })
  addClient(db, 'has', { status: null, answer: 'Yes', lookup: null })
  addClient(db, 'fresh')
  addClient(db, 'churned', { lifecycle: 'churned', lookup: null })
  let at = DAY.getTime()
  assert.equal(await h.maybeCheckListings(at), 4)
  assert.equal(await h.maybeCheckListings(at + 1000), 0, 'at most once a minute')
  assert.equal(await h.maybeCheckListings((at += 61_000)), 2)
  assert.equal(await h.maybeCheckListings((at += 61_000)), 0)
  for (let i = 0; i < 6; i++) assert.equal(state(db, `need${i}`).lookup.v, 2)
  assert.equal(state(db, 'done').lookup, null)
  assert.equal(state(db, 'churned').lookup, null)
  assert.equal(h.sms.length + h.mail.length, 0)
  assert.equal([...db.settings.keys()].some((k) => k.startsWith('gbp.send.')), false, 'no Office question for the ones already on the board')
})

test('the board’s Send: now in daytime, queued at night, never alongside one going out', async () => {
  const hourIn = (zone) => Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
  const zones = ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'Europe/London', 'Asia/Dubai', 'Australia/Sydney']
  const day = zones.find((z) => hourIn(z) >= 9 && hourIn(z) < 19)
  const night = zones.find((z) => hourIn(z) < 9 || hourIn(z) >= 19)
  const h = hub(db)
  addClient(db, 'day', { zone: day })
  addClient(db, 'night', { zone: night })
  addClient(db, 'busy', { zone: day })
  db.settings.set('gbp.send.day', JSON.stringify({ status: 'ask', at: NIGHT.toISOString(), by: null, detail: null }))
  db.settings.set('gbp.send.busy', JSON.stringify({ status: 'sending', at: new Date().toISOString(), by: null, detail: null }))
  const now = await h.sendNowOrQueue('day', 'alex@x')
  assert.equal(now.ok, true)
  assert.equal(now.queuedFor, null)
  assert.equal(open(db, 'day'), null, 'the question is answered')
  const later = await h.sendNowOrQueue('night', 'alex@x')
  assert.match(later.queuedFor, /^9 AM /)
  assert.equal(open(db, 'night').status, 'queued')
  assert.equal((await h.sendNowOrQueue('busy', 'alex@x')).ok, false)
  assert.equal(h.sms.length, 1)
})

test('queued overnight: someone who finished since gets nothing, and changed details stop it', async () => {
  const h = hub(db)
  addClient(db, 'finished')
  addClient(db, 'verified')
  addClient(db, 'broken')
  await h.queueSetupSends(['finished', 'verified', 'broken'], 'alex@x')
  const set = (id, o) => db.settings.set(`gbp.client.${id}`, JSON.stringify({ ...state(db, id), ...o }))
  set('finished', { clientDoneAt: '2026-11-24T12:00:00Z', status: 'created' })
  set('verified', { status: 'verified' })
  set('broken', { values: { ownerPhone: '', ownerEmail: '' } })
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(h.sms.length + h.mail.length, 0)
  assert.equal(open(db, 'finished'), null)
  assert.equal(open(db, 'verified'), null)
  assert.equal(open(db, 'broken').status, 'failed')
  assert.match(open(db, 'broken').detail, /No owner cell or email/)
})

test('the board’s “Text it now” never texts at night', async () => {
  const hourIn = (zone) => Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
  const zones = ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'Europe/London', 'Asia/Dubai', 'Australia/Sydney']
  const h = hub(db)
  addClient(db, 'night', { zone: zones.find((z) => hourIn(z) < 9 || hourIn(z) >= 19) })
  addClient(db, 'day', { zone: zones.find((z) => hourIn(z) >= 9 && hourIn(z) < 19) })
  const no = await h.sendVerificationChecklist('night', 'alex@x')
  assert.equal(no.ok, false)
  assert.match(no.detail, /9 AM to 7 PM where they are/)
  assert.equal(h.sms.length, 0)
  assert.equal((await h.sendVerificationChecklist('day', 'alex@x')).ok, true)
  assert.equal(h.sms.length, 1)
})

test('an archived client leaves the queue, and Not now takes one out of it', async () => {
  const h = hub(db)
  addClient(db, 'gone')
  addClient(db, 'a')
  await h.queueSetupSends(['gone', 'a'], null)
  db.clients.get('gone').archivedAt = new Date()
  assert.deepEqual(await h.skipSetupSends(['a'], 'alex@x'), ['a'])
  assert.equal(await h.maybeSendQueuedSetups(DAY), 0)
  assert.equal(open(db, 'gone'), null)
  assert.equal(open(db, 'a'), null)
  assert.equal(h.sms.length, 0)
})

test('the Google Profiles rows say where each client stands', async () => {
  const h = hub(db)
  addClient(db, 'a')
  addClient(db, 'b', { state: { sentAt: '2026-11-20T15:00:00Z', remind: true, status: 'verifying', texts: [{ at: '2026-11-20T15:00:00Z', kind: 'checklist', to: '+1', ok: true, detail: null }, { at: '2026-11-23T15:00:00Z', kind: 'reminder', to: '+1', ok: true, detail: null }] } })
  addClient(db, 'c', { name: 'No' })
  await h.queueSetupSends(['a'], null)
  const rows = await h.gbpRows(NIGHT)
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(by.a.page, 'queued')
  assert.equal(by.a.later, '9 AM Eastern today')
  assert.equal(by.b.page, 'sent')
  assert.equal(by.b.reminders, 1)
  assert.equal(by.b.reminding, true)
  assert.match(by.c.block, /isn’t a business name/)
  assert.equal(by.a.owner.first, 'Sam')
  assert.equal(by.a.listing, 'create')
})

test('only the live Hub sends', async () => {
  process.env.NODE_ENV = 'development'
  try {
    const h = hub(db)
    addClient(db, 'a')
    await h.queueSetupSends(['a'], null)
    assert.equal(await h.maybeSendQueuedSetups(DAY), 0)
    assert.equal(await h.maybeCheckListings(DAY.getTime()), 0)
    assert.equal(h.sms.length, 0)
  } finally {
    process.env.NODE_ENV = 'production'
  }
})

// ---- what the cold review found (2026-11-24): each was a real way to text someone wrongly ----

const zones = ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'Europe/London', 'Asia/Dubai', 'Australia/Sydney']
const hourNow = (zone) => Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
/** A zone where it's daytime (10 to 19, the reminders' window) right now, and one where it isn't. New York would be read as "unset". */
const dayZone = () => zones.slice(1).find((z) => hourNow(z) >= 10 && hourNow(z) < 19)
const nightZone = () => zones.slice(1).find((z) => hourNow(z) < 9 || hourNow(z) >= 19)
const put = (id, o) => db.settings.set(`gbp.client.${id}`, JSON.stringify({ ...state(db, id), ...o }))
const ask = (id) => db.settings.set(`gbp.send.${id}`, JSON.stringify({ status: 'ask', at: NIGHT.toISOString(), by: null, detail: null }))

test('two people pressing Send on the same board: one text, one email', async () => {
  const one = hub(db)
  const two = hub(db)
  addClient(db, 'a', { zone: dayZone() })
  const r = await Promise.all([one.sendNowOrQueue('a', 'alex@x'), two.sendNowOrQueue('a', 'ethan@x')])
  assert.equal(r.filter((x) => x.ok).length, 1)
  assert.equal(one.sms.length + two.sms.length, 1)
  assert.equal(one.mail.length + two.mail.length, 1)
  assert.equal(open(db, 'a'), null)
})

test('picked on Google Profiles while the board is sending it: still once', async () => {
  let picked
  const h = hub(db, { whileTexting: async () => (picked ??= await h.queueSetupSends(['a'], 'ethan@x')) })
  addClient(db, 'a', { zone: dayZone() })
  await h.sendNowOrQueue('a', 'alex@x')
  assert.deepEqual(picked.queued, [])
  assert.match((await h.queueSetupSends(['a'], 'ethan@x')).left[0].why, /already went out/)
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(h.sms.length, 1)
})

test('queued, then sent from the board before its turn: the queued one is dropped', async () => {
  const h = hub(db)
  addClient(db, 'a')
  await h.queueSetupSends(['a'], 'alex@x')
  put('a', { sentAt: new Date(Date.now() + 60_000).toISOString(), status: 'verifying' })
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(open(db, 'a'), null)
  assert.equal(h.sms.length, 0)
})

test('GHL answering oddly isn’t tried from the second number, and says it may have gone out', async () => {
  for (const smsError of ['GHL API error 502: bad gateway', 'fetch failed', 'Unexpected end of JSON input', 'GHL API error 408: timeout']) {
    db = makeDb()
    let tries = 0
    const h = hub(db, { smsFails: () => (tries++, true), smsError, mailFails: true })
    addClient(db, 'a')
    await h.queueSetupSends(['a'], null)
    await h.maybeSendQueuedSetups(DAY)
    assert.equal(tries, 1, smsError)
    assert.match(open(db, 'a').detail, /may have gone out/, smsError)
  }
})

test('no name, a PO box or a blank never goes out, whoever presses, day or night', async () => {
  const h = hub(db)
  addClient(db, 'no', { name: 'No', zone: dayZone() })
  addClient(db, 'box', { name: 'Post office box 82', zone: dayZone() })
  addClient(db, 'blank', { zone: dayZone(), state: { values: { businessName: '   ' } } })
  addClient(db, 'late', { name: 'No', zone: nightZone() })
  for (const id of ['no', 'box', 'blank', 'late']) {
    const r = await h.sendNowOrQueue(id, 'alex@x')
    assert.equal(r.ok, false, id)
    assert.match(r.sms, /isn’t a business name/, id)
    assert.equal(open(db, id), null, id)
    assert.equal((await h.sendVerificationChecklist(id, 'alex@x')).ok, false, id)
  }
  assert.equal(h.sms.length + h.mail.length, 0)
})

test('pressed on their own board at night, it goes out in the morning as it would by day', async () => {
  const h = hub(db)
  addClient(db, 'yes', { answer: 'Yes', status: null, zone: nightZone() })
  assert.ok((await h.sendNowOrQueue('yes', 'alex@x')).queuedFor)
  assert.equal(open(db, 'yes').own, true)
  db.clients.get('yes').hlAccount.timezone = 'America/Chicago'
  assert.equal(await h.maybeSendQueuedSetups(DAY), 1)
  assert.equal(h.sms.length, 1)
})

test('a profile we’re already making or waiting on is never told to make one', async () => {
  const h = hub(db)
  for (const [id, o] of [['created', { status: 'created' }], ['verifying', { status: 'verifying' }], ['sent', { sentAt: '2026-11-23T00:00:00Z' }]]) {
    addClient(db, id)
    ask(id)
    put(id, o)
    assert.equal((await h.gbpOfficeItems(DAY)).some((i) => i.clientId === id), false, `${id}: not asked about`)
    const r = await h.decideGbpAsk(id, 'send', 'Alex')
    assert.equal(r.ok, false, id)
    assert.equal(open(db, id), null, `${id}: the question is dropped`)
    assert.deepEqual((await h.queueSetupSends([id], null)).queued, [], id)
  }
  // Queued first, then made by us: dropped at its turn. The same for a question nobody answered.
  addClient(db, 'later')
  await h.queueSetupSends(['later'], null)
  put('later', { status: 'created' })
  addClient(db, 'asked')
  ask('asked')
  put('asked', { status: 'verifying' })
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(open(db, 'later'), null)
  assert.equal(open(db, 'asked'), null)
  assert.equal(h.sms.length + h.mail.length, 0)
})

test('queued, and then the form says they have one: not sent, Maps checked or not', async () => {
  const h = hub(db, { mapsFails: true })
  addClient(db, 'a')
  await h.queueSetupSends(['a'], 'alex@x')
  db.clients.get('a').intakes[0].hasGoogleProfile = 'Yes'
  put('a', { lookup: null })
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(h.sms.length + h.mail.length, 0)
  assert.match(open(db, 'a').detail, /already have a profile/)
})

test('a listing that already shows the site we built isn’t a one-tap send', async () => {
  const h = hub(db)
  const listing = { placeId: 'p', name: 'A Roofing', address: 'Boston, MA 02108, USA', phone: '(603) 555-0142', website: 'https://www.acmeroof.com/', mapsUrl: 'https://maps.google.com/?cid=1', status: 'OPERATIONAL', matches: ['same phone', 'same website', 'same name'], related: true }
  addClient(db, 'a', { status: 'existing', lookup: { ...checked, candidates: [listing] } })
  assert.match((await h.queueSetupSends(['a'], null)).left[0].why, /already shows their website/)
  const row = (await h.gbpRows(DAY))[0]
  assert.equal(row.managed, true)
  assert.match(row.block, /someone looks after it/)
})

test('reminders: once between two processes, never to a gone client, and not while it’s night there', async () => {
  const one = hub(db)
  const two = hub(db)
  const due = { status: 'verifying', remind: true, sentAt: '2026-11-01T15:00:00Z', texts: [{ at: '2026-11-01T15:00:00Z', kind: 'checklist', to: '+1', ok: true, detail: null }] }
  for (let i = 0; i < 5; i++) addClient(db, `r${i}`, { zone: dayZone(), state: due })
  addClient(db, 'churned', { zone: dayZone(), lifecycle: 'churned', state: due })
  addClient(db, 'archived', { zone: dayZone(), state: due })
  db.clients.get('archived').archivedAt = new Date()
  addClient(db, 'night', { zone: nightZone(), state: due })
  addClient(db, 'nocell', { zone: dayZone(), phone: null, state: due })
  addClient(db, 'finished', { zone: dayZone(), state: { ...due, clientDoneAt: '2026-11-02T00:00:00Z' } })
  addClient(db, 'recent', { zone: dayZone(), state: { ...due, remindedAt: new Date().toISOString() } })
  await Promise.all([one.maybeSendGbpReminders(), two.maybeSendGbpReminders()])
  assert.equal(one.sms.length + two.sms.length, 5)
  for (let i = 0; i < 5; i++) assert.equal(state(db, `r${i}`).texts.filter((t) => t.kind === 'reminder').length, 1)
  for (const id of ['churned', 'archived', 'night', 'nocell', 'finished', 'recent']) assert.equal(state(db, id).texts.length, 1, id)
})

test('marked verified while a reminder is going out: verified stays', async () => {
  const h = hub(db, { whileTexting: async () => h.markVerified('a', { profileUrl: 'https://maps.app.goo.gl/x' }, 'ethan@x') })
  addClient(db, 'a', { zone: dayZone(), state: { status: 'verifying', remind: true, texts: [{ at: '2026-11-01T15:00:00Z', kind: 'checklist', to: '+1', ok: true, detail: null }] } })
  await h.maybeSendGbpReminders()
  const s = state(db, 'a')
  assert.equal(s.status, 'verified')
  assert.equal(s.remind, false)
  assert.equal(s.profileUrl, 'https://maps.app.goo.gl/x')
  assert.equal(s.texts.length, 2)
})

test('the scheduler’s Maps check landing first doesn’t lose a new client’s question', async () => {
  const h = hub(db)
  addClient(db, 'new', { status: null, lookup: null })
  await h.lookupExistingListing('new')
  assert.equal(state(db, 'new').status, 'needed')
  await h.startGbpForNewIntake('new')
  assert.equal(open(db, 'new').status, 'ask')
})

test('a text that went but couldn’t be recorded says so, and isn’t offered again', async () => {
  const h = hub(db)
  addClient(db, 'a')
  await h.queueSetupSends(['a'], null)
  const real = db.prisma.appSetting.updateMany
  db.prisma.appSetting.updateMany = async (q) => {
    if (q.where.key === 'gbp.client.a' && h.sms.length) throw new Error('database is down')
    return real(q)
  }
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(open(db, 'a').status, 'failed')
  assert.match(open(db, 'a').detail, /sent to .*couldn’t record it.*don’t send it again without checking/)
  db.prisma.appSetting.updateMany = real
  await h.maybeSendQueuedSetups(DAY)
  assert.equal(h.sms.length, 1)
})

test('only the live Hub: the board’s own buttons don’t text from a dev server', async () => {
  process.env.NODE_ENV = 'development'
  try {
    const h = hub(db)
    addClient(db, 'a', { zone: dayZone() })
    assert.match((await h.sendNowOrQueue('a', 'alex@x')).sms, /only the live Hub/)
    assert.match((await h.sendVerificationChecklist('a', 'alex@x')).detail, /Only the live Hub/)
    assert.equal(await h.maybeSendGbpReminders(), 0)
    assert.equal(h.sms.length + h.mail.length, 0)
  } finally {
    process.env.NODE_ENV = 'production'
  }
})

test('one odd record doesn’t break the list, and a churned client isn’t on it', async () => {
  const h = hub(db)
  addClient(db, 'odd', { facts: { businessName: 7, services: 'roofing', serviceAreas: { a: 1 }, differentiators: null, state: 'MA' } })
  addClient(db, 'ok')
  addClient(db, 'churned', { lifecycle: 'churned' })
  addClient(db, 'denied', { lifecycle: 'denied' })
  assert.deepEqual((await h.gbpRows(DAY)).map((r) => r.id), ['odd', 'ok'].sort((a, b) => a.localeCompare(b)))
  assert.deepEqual((await h.queueSetupSends(['odd', 'ok', 'churned'], null)).queued, ['odd', 'ok'])
})

test('our own numbers and toll-free lines are never taken for the owner’s cell', async () => {
  const h = hub(db)
  addClient(db, 'a', { phone: null, email: null })
  db.clients.get('a').hlAccount.profile = { notifyPhone: '+16035550111, +18885550100, (603) 555-0177', businessPhone: '+18885550100', notifyEmail: 'alex@leadgenisys.com, owner@acme.com' }
  const row = (await h.gbpRows(DAY))[0]
  assert.equal(row.owner.phone, '(603) 555-0177')
  assert.equal(row.owner.email, 'owner@acme.com')
})
