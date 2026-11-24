import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// The business number as the owner's interface (src/lib/hl/owner-text-plan.ts, owner-text.ts,
// image-bytes.ts): what a text from the owner's phone means, what's done, and what they're told.
// The cases marked "review" came from a cold review on 2026-11-24: each was a real way to text the wrong person.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shared = new Map()

/** A src module, with stand-ins for the imports named in `stubs`; the rest load for real (pure modules). Each handler case gets its own cache. */
function loadTs(absPath, stubs = {}, cache = shared) {
  if (cache.has(absPath)) return cache.get(absPath)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  cache.set(absPath, m.exports)
  const localRequire = createRequire(pathToFileURL(absPath))
  const req = (id) => {
    if (Object.hasOwn(stubs, id)) return stubs[id]
    const path = id.startsWith('@/') ? join(root, 'src', `${id.slice(2)}.ts`) : id.startsWith('.') ? join(dirname(absPath), `${id}.ts`) : null
    return path ? loadTs(path, stubs, cache) : localRequire(id)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  return m.exports
}

const plan = loadTs(join(root, 'src/lib/hl/owner-text-plan.ts'))
const bytes = loadTs(join(root, 'src/lib/hl/image-bytes.ts'))
const ascii = (s) => /^[\x00-\x7F]*$/.test(s)
const NOW = new Date('2026-11-24T18:00:00Z')
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()

// ---- what a text means ----

test('DONE and a number, however typed, is a finished job for that customer', () => {
  for (const [body, phone, first, last] of [
    ['DONE 555-123-4567 Jane', '+15551234567', 'Jane', null],
    ['done (555) 123-4567', '+15551234567', null, null],
    ['Done: jane doe 5551234567', '+15551234567', 'Jane', 'Doe'],
    ['Job done! +1 555 123 4567 for Mike', '+15551234567', 'Mike', null],
    ['finished - 555.123.4567 JANE', '+15551234567', 'Jane', null],
    ['Completed 5551234567', '+15551234567', null, null],
    ['DONE Jane Smith 555-123-4567', '+15551234567', 'Jane', 'Smith'],
    ['DONE Mrs. Jane 555-123-4567', '+15551234567', 'Jane', null],
  ]) {
    const r = plan.readOwnerText(body, 0)
    assert.equal(r.kind, 'done', body)
    assert.equal(r.phone, phone, body)
    assert.equal(r.firstName, first, body)
    assert.equal(r.lastName, last, body)
  }
  assert.deepEqual(plan.readOwnerText('done', 0), { kind: 'done', phone: null, firstName: null, lastName: null })
  assert.deepEqual(plan.readOwnerText('Done Jane', 0), { kind: 'done', phone: null, firstName: 'Jane', lastName: null })
})

test('review: a sentence that starts with done, finished or oops is an answer to a lead, not a command', () => {
  for (const body of [
    'Done, call Jane at 555-123-4567 to schedule the walkthrough',
    'Finished up at 123 Main; call Mike at 555-123-4567',
    'Done with the quote, call me',
    'Job completed at the Smiths, invoice sent',
    'Completed. Heading to the next job',
    'DONE 555-123-4567 Jane Smith 12 Elm St',
    'Oops, I meant 3pm',
    "Never mind the ladder, we'll bring ours",
    'Help is on the way',
    'Info: we start Monday',
  ]) {
    const r = plan.readOwnerText(body, 0)
    assert.equal(r.kind, 'reply', body)
    assert.equal(r.text, body, body)
  }
})

test('a photo, with its caption; UNDO; help', () => {
  assert.deepEqual(plan.readOwnerText('', 1), { kind: 'photo', caption: '' })
  assert.deepEqual(plan.readOwnerText('New roof in Tyler', 2), { kind: 'photo', caption: 'New roof in Tyler' })
  assert.deepEqual(plan.readOwnerText('photo: Finished patio ', 1), { kind: 'photo', caption: 'Finished patio' })
  assert.deepEqual(plan.readOwnerText('here you go', 1), { kind: 'photo', caption: '' })
  // "Done" with a photo and no number is the photo, captioned with what they wrote.
  assert.deepEqual(plan.readOwnerText('Done!', 1), { kind: 'photo', caption: '' })
  assert.deepEqual(plan.readOwnerText('done, new deck', 1), { kind: 'photo', caption: 'new deck' })
  assert.deepEqual(plan.readOwnerText('Finished the deck', 1), { kind: 'photo', caption: 'Finished the deck' })
  assert.equal(plan.readOwnerText('x'.repeat(200), 1).caption.length <= 140, true)
  for (const u of ['UNDO', 'undo!', 'Never mind', 'oops', 'nevermind.']) assert.equal(plan.readOwnerText(u, 0).kind, 'undo', u)
  for (const h of ['help', '?', 'HELP!', 'commands']) assert.equal(plan.readOwnerText(h, 0).kind, 'help', h)
  assert.deepEqual(plan.readOwnerText('  On my way, 20 min  ', 0), { kind: 'reply', text: 'On my way, 20 min' })
  assert.deepEqual(plan.readOwnerText('Yes!', 0), { kind: 'reply', text: 'Yes!' })
  assert.deepEqual(plan.readOwnerText('   ', 0), { kind: 'empty' })
  for (const a of ['ok', 'Okay!', 'thanks', 'Thank you.', '👍', 'got it', 'Sounds good']) assert.equal(plan.isAck(a), true, a)
  assert.equal(plan.isAck('ok see you at 3'), false)
})

test('who an answer goes to: a number put first, else the lead they were last told about, if recent', () => {
  const alert = { contactId: 'c1', at: ago(8 * 3_600_000) }
  assert.deepEqual(plan.pickReplyTarget(alert, 'On my way', NOW), { contactId: 'c1', text: 'On my way' })
  assert.deepEqual(plan.pickReplyTarget(alert, '555-123-4567: see you at 3', NOW), { byPhone: '+15551234567', text: 'see you at 3' })
  assert.deepEqual(plan.pickReplyTarget(null, 'to (555) 123-4567 running late', NOW), { byPhone: '+15551234567', text: 'running late' })
  assert.equal(plan.pickReplyTarget({ contactId: 'c1', at: ago(4 * 86_400_000) }, 'On my way', NOW), null)
  assert.equal(plan.pickReplyTarget(null, 'On my way', NOW), null)
  // A number alone, with nothing to say, isn't an answer.
  assert.equal(plan.pickReplyTarget(null, '5551234567', NOW), null)
  // review: "ok" right after the Hub's own "Sent to Pat." is for the Hub; minutes later it's an answer.
  assert.deepEqual(plan.pickReplyTarget({ ...alert, confirmedAt: ago(30_000) }, 'ok', NOW), { ack: true })
  assert.deepEqual(plan.pickReplyTarget({ ...alert, confirmedAt: ago(10 * 60_000) }, 'ok', NOW), { contactId: 'c1', text: 'ok' })
  // review: two leads in quick succession: the owner says which.
  const two = { contactId: 'c2', at: ago(60_000), prev: { contactId: 'c1', at: ago(4 * 60_000) } }
  assert.deepEqual(plan.pickReplyTarget(two, 'On my way', NOW), { which: ['c2', 'c1'] })
  assert.deepEqual(plan.pickReplyTarget({ ...two, prev: { contactId: 'c1', at: ago(3_600_000) } }, 'On my way', NOW), { contactId: 'c2', text: 'On my way' })
  assert.deepEqual(plan.pickReplyTarget(two, '555-123-4567: On my way', NOW), { byPhone: '+15551234567', text: 'On my way' })
})

test('what the owner is told is short and plain ASCII', () => {
  const texts = [
    plan.doneReply({ name: 'Jane', phone: '+15551234567', business: 'Acme Roofing', started: true, inIt: false, ready: true }),
    plan.doneReply({ name: null, phone: '+15551234567', business: 'Acme', started: false, inIt: false, ready: false }),
    plan.doneReply({ name: 'Jane', phone: null, business: 'Acme', started: false, inIt: true, ready: true }),
    plan.doneReply({ name: 'Jane', phone: null, business: 'Acme', started: false, inIt: false, ready: true }),
    plan.undoReply({ undone: true, name: 'Jane', phone: null }),
    plan.undoReply({ undone: false, name: null, phone: null }),
    plan.photoReply({ added: 1, skipped: 0, failed: 0, link: 'https://x/hl/w/a', onSite: false }),
    plan.photoReply({ added: 2, skipped: 1, failed: 1, link: 'https://x/hl/w/a', onSite: true }),
    plan.photoReply({ added: 0, skipped: 1, failed: 0, link: 'https://x/hl/w/a', onSite: false }),
    plan.photoReply({ added: 0, skipped: 0, failed: 1, link: 'https://x/hl/w/a', onSite: false }),
    plan.relayReply('Jane', null),
    plan.relayCannot({ name: null, phone: '+15551234567', reason: 'x', notApproved: true }),
    plan.relayCannot({ name: 'Jane', phone: null, reason: 'The contact texted STOP', notApproved: false }),
    plan.whichLead({ name: 'Pat', phone: '+15559990001' }, { name: null, phone: '+15559990002' }),
    plan.helpText('Acme'),
    plan.DONE_NEEDS_PHONE,
    plan.DONE_OWN_NUMBER,
    plan.NO_LEAD_TO_ANSWER,
    plan.NO_SUCH_LEAD,
    plan.WHICH_BUSINESS,
    plan.PHOTO_WITH_DONE,
  ]
  for (const t of texts) {
    assert.ok(ascii(t), t)
    assert.ok(t.length <= 320, t)
  }
  assert.match(texts[0], /^Got it\. Jane gets Acme Roofing's review request in about 20 minutes/)
  assert.match(texts[1], /\(555\) 123-4567 is marked as a finished job, but Acme's number isn't approved for texting yet, so no review request goes out/)
  assert.equal(texts[2], "Jane is already getting Acme's review request.")
  assert.match(texts[3], /couldn't start on our side/)
  assert.equal(texts[6], 'Got it. Your photo is in your Recent Work: https://x/hl/w/a')
  assert.equal(texts[7], "Got it. 2 photos are on your website now: https://x/hl/w/a (1 file skipped: photos only; 1 didn't come through, send it again.)")
  assert.match(texts[9], /didn't come through on our side/)
  assert.match(texts[11], /Reply to \(555\) 123-4567 directly at \(555\) 123-4567/)
  assert.equal(texts[13], 'Two leads just now: Pat (555) 999-0001 and (555) 999-0002. Put their number first so I know who, like: 555-123-4567: on my way')
})

// ---- a photo's bytes ----

/** A JPEG skeleton: SOI, APP0, APP1 (EXIF), DQT, SOS + data, EOI. */
function jpeg(withExif = true, fill = false) {
  const seg = (marker, body) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]
  const parts = [[0xff, 0xd8], seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]), ...(fill ? [[0xff]] : []), ...(withExif ? [seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 9, 9, 9, 9])] : []), seg(0xdb, [0, 1, 2, 3]), seg(0xda, [1, 2]), [0xaa, 0xbb, 0xcc, 0xff, 0xd9]]
  return new Uint8Array(parts.flat())
}

test('a JPEG loses its EXIF and nothing else; what can’t be walked is refused, never passed through', () => {
  const stripped = bytes.stripJpegMetadata(jpeg(true))
  assert.deepEqual([...stripped], [...jpeg(false)])
  assert.equal(bytes.imageKind(stripped), 'jpeg')
  // review: a fill byte before a marker is fine; a file cut off mid-segment is not.
  assert.deepEqual([...bytes.stripJpegMetadata(jpeg(true, true))], [...jpeg(false)])
  assert.equal(bytes.stripJpegMetadata(jpeg(true).subarray(0, 9)), null)
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1])
  assert.equal(bytes.imageKind(png), 'png')
  assert.equal(bytes.stripJpegMetadata(png), null)
  assert.equal(bytes.imageKind(new Uint8Array([1, 2, 3])), null)
})

// ---- what's done: the handler against stand-ins ----

function handler(o = {}) {
  const calls = { contacts: [], triggers: [], sent: [], internal: [], photos: [], twilio: [], confirmed: 0 }
  const db = {
    pipelines: o.pipelines ?? [{ id: 'pipe', name: 'Customer Pipeline', stages: [{ id: 'new_lead' }, { id: 'job_booked' }, { id: 'job_completed' }, { id: 'lost' }] }],
    numbers: o.numbers ?? [{ number: '+18665550100', forwardTo: '+16035550142', forwardTextsTo: '+16035550142' }],
    opportunities: o.opportunities ?? [],
    records: o.records ?? [],
    contacts: o.contacts ?? [],
    runs: o.runs ?? [],
  }
  let nextId = 1
  const recKey = (w) => w.accountId_kind_ghlId
  const prisma = {
    hlPipeline: { findMany: async () => db.pipelines },
    hlPhoneNumber: { findMany: async () => db.numbers },
    hlWorkflowRun: { findFirst: async ({ where }) => db.runs.find((r) => r.contactId === where.contactId) ?? null },
    hlOpportunity: {
      findFirst: async ({ where, orderBy }) => {
        const hits = db.opportunities.filter((x) => Object.entries(where).every(([k, v]) => x[k] === v))
        if (orderBy?.position) return hits.sort((a, b) => b.position - a.position)[0] ?? null
        return hits[0] ?? null
      },
      findUnique: async ({ where }) => {
        const opp = db.opportunities.find((x) => x.id === where.id)
        if (!opp) return null
        const pipeline = db.pipelines.find((p) => p.id === opp.pipelineId)
        const contact = db.contacts.find((c) => c.id === opp.contactId) ?? { firstName: null, phone: null }
        return { ...opp, pipeline: { stages: pipeline.stages }, contact: { firstName: contact.firstName, phone: contact.phone } }
      },
      update: async ({ where, data }) => Object.assign(db.opportunities.find((x) => x.id === where.id), data),
      create: async ({ data }) => {
        const row = { id: `opp${nextId++}`, status: 'open', ...data }
        db.opportunities.push(row)
        return { id: row.id }
      },
    },
    hlRecord: {
      findUnique: async ({ where }) => {
        const k = recKey(where)
        return db.records.find((r) => r.accountId === k.accountId && r.kind === k.kind && r.ghlId === k.ghlId) ?? null
      },
      upsert: async ({ where, create, update }) => {
        const k = recKey(where)
        const row = db.records.find((r) => r.accountId === k.accountId && r.kind === k.kind && r.ghlId === k.ghlId)
        if (row) return Object.assign(row, update)
        const made = { id: `rec${nextId++}`, ...create }
        db.records.push(made)
        return made
      },
      delete: async ({ where }) => {
        const k = recKey(where)
        const i = db.records.findIndex((r) => r.accountId === k.accountId && r.kind === k.kind && r.ghlId === k.ghlId)
        if (i >= 0) db.records.splice(i, 1)
      },
    },
    hlContact: {
      findFirst: async ({ where }) => db.contacts.find((c) => c.accountId === where.accountId && c.phone === where.phone) ?? null,
      findUnique: async ({ where }) => db.contacts.find((c) => c.id === where.id) ?? null,
      findMany: async ({ where }) => db.contacts.filter((c) => where.id.in.includes(c.id) && c.accountId === where.accountId),
    },
  }
  const stubs = {
    '@/lib/prisma': { prisma },
    './accounts': { readProfile: (v) => v ?? {} },
    './automation': { fireTrigger: async (accountId, contactId, e) => (calls.triggers.push({ accountId, contactId, ...e }), o.started ?? 1) },
    './contacts': {
      upsertContact: async (accountId, input) => {
        calls.contacts.push({ accountId, ...input })
        const existing = db.contacts.find((c) => c.accountId === accountId && c.phone === input.phone)
        if (existing) return { contact: existing, created: false }
        const contact = { id: `con${nextId++}`, accountId, phone: input.phone, firstName: input.firstName, lastName: input.lastName }
        db.contacts.push(contact)
        return { contact, created: true }
      },
    },
    './genisys-sender': { clientAccountsForOwnerPhone: async () => o.owned ?? [], genisysSender: async () => ({ number: '+19785550100' }) },
    './messages': {
      sendInternalSms: async (accountId, to, body) => (calls.internal.push({ accountId, to, body }), { ok: true, detail: 'sent' }),
      sendSmsToContact: async (x) => (calls.sent.push(x), o.sendResult ?? { ok: true, detail: 'Sent' }),
      sendingNumber: async () => db.numbers[0] ?? null,
      textingReady: () => ({ ok: o.ready !== false, reason: o.ready === false ? 'Texting isn’t approved yet' : null }),
    },
    './owner-alerts': { latestOwnerAlert: async (accountId, phone) => o.alert?.(accountId, phone) ?? null, noteOwnerConfirmed: async () => calls.confirmed++ },
    './twilio': { sendTwilioSms: async (x) => (calls.twilio.push(x), { sid: 'SM1', status: 'queued' }), publicBase: () => 'https://hub.example' },
    './work-photos': {
      addWorkPhotos: async (x) => (calls.photos.push(x), o.photoResult ?? { added: x.mediaUrls.length, skipped: 0, failed: 0 }),
      siteShowsWork: async () => o.onSite ?? false,
      workPageUrl: (id) => `https://hub.example/hl/w/${id}`,
    },
  }
  const mod = loadTs(join(root, 'src/lib/hl/owner-text.ts'), stubs, new Map())
  const client = { id: 'acc1', clientId: 'cli1', name: 'Acme Roofing', profile: { businessName: 'Acme Roofing', notifyPhone: '+16035550142', businessPhone: '+16035550177' } }
  const number = { number: '+18665550100', forwardTo: '+16035550142', forwardTextsTo: '+16035550142' }
  const text = (body, media = [], from = '+16035550142', numberAccount = client, num = number) => mod.handleOwnerText({ number: num, numberAccount, from, body, media })
  const lastReply = () => calls.internal[calls.internal.length - 1]?.body ?? null
  return { text, calls, db, lastReply }
}
const GENISYS = { id: 'home', clientId: null, name: 'Lead Genisys', profile: { notifyPhone: '+16035550199' } }
const HUB_NUMBER = { number: '+19785550100', forwardTo: null, forwardTextsTo: null }

test('DONE: the customer is added with consent, put at Job Completed, and the review request starts', async () => {
  const h = handler()
  await h.text('DONE 555-123-4567 Jane')
  assert.equal(h.calls.contacts.length, 1)
  assert.equal(h.calls.contacts[0].phone, '+15551234567')
  assert.equal(h.calls.contacts[0].consent, true)
  assert.equal(h.calls.contacts[0].firstName, 'Jane')
  assert.match(h.calls.contacts[0].fields.consent_note, /Owner texted DONE/)
  assert.equal(h.db.opportunities.length, 1)
  assert.equal(h.db.opportunities[0].stageId, 'job_completed')
  assert.equal(h.db.opportunities[0].source, 'owner text')
  assert.deepEqual(h.calls.triggers[0], { accountId: 'acc1', contactId: h.db.contacts[0].id, type: 'opportunity_stage', stageId: 'job_completed', pipelineId: 'pipe', context: { opportunityId: 'opp2' } })
  assert.match(h.lastReply(), /^Got it\. Jane gets Acme Roofing's review request in about 20 minutes/)
  assert.deepEqual(h.calls.internal[0].to, ['+16035550142'])
  // The same customer again while they're in it: their open job moves (no second opportunity), and it says so.
  const again = handler({ started: 0, opportunities: [...h.db.opportunities], contacts: [...h.db.contacts], pipelines: h.db.pipelines, runs: [{ contactId: h.db.contacts[0].id }] })
  await again.text('done 5551234567')
  assert.equal(again.db.opportunities.length, 1)
  assert.equal(again.lastReply(), "Jane is already getting Acme Roofing's review request.")
  // review: nothing listening (the campaign unpublished): said plainly, not "already getting it".
  const deaf = handler({ started: 0 })
  await deaf.text('DONE 555-123-4567 Jane')
  assert.match(deaf.lastReply(), /couldn't start on our side/)
})

test('DONE without a number, or with the owner’s own, asks again; an unapproved number marks the job and starts nothing', async () => {
  const h = handler()
  await h.text('DONE')
  assert.equal(h.lastReply(), plan.DONE_NEEDS_PHONE)
  await h.text('DONE 603-555-0142')
  assert.equal(h.lastReply(), plan.DONE_OWN_NUMBER)
  await h.text('DONE 866-555-0100')
  assert.equal(h.lastReply(), plan.DONE_OWN_NUMBER)
  assert.equal(h.calls.contacts.length, 0)
  // review: a campaign on a number that can't text would only fail quietly, so it isn't started.
  const cold = handler({ ready: false })
  await cold.text('DONE 555-123-4567')
  assert.match(cold.lastReply(), /isn't approved for texting yet, so no review request goes out/)
  assert.equal(cold.db.opportunities[0].stageId, 'job_completed')
  assert.equal(cold.calls.triggers.length, 0)
})

test('a photo along with DONE is kept too', async () => {
  const h = handler()
  await h.text('DONE 555-123-4567 Jane', ['https://api.twilio.com/m1'])
  assert.equal(h.calls.contacts.length, 1)
  assert.deepEqual(h.calls.photos[0], { accountId: 'acc1', from: '+16035550142', mediaUrls: ['https://api.twilio.com/m1'], caption: '' })
  assert.match(h.lastReply(), /review request in about 20 minutes.*Your photo is in your Recent Work too\.$/)
})

test('UNDO within 20 minutes moves the job back; later there is nothing to undo', async () => {
  const h = handler()
  await h.text('DONE 555-123-4567 Jane')
  await h.text('UNDO')
  assert.equal(h.db.opportunities[0].stageId, 'job_booked')
  assert.equal(h.calls.triggers[1].stageId, 'job_booked')
  assert.equal(h.lastReply(), "Undone: Jane won't get the review request.")
  await h.text('undo')
  assert.match(h.lastReply(), /^Nothing to undo/)
  const late = handler({ records: [{ id: 'r', accountId: 'acc1', kind: 'owner_done', ghlId: 'owner_done:+16035550142', name: '+16035550142', data: { opportunityId: 'x', contactId: 'c', at: '2026-01-01T00:00:00Z' } }] })
  await late.text('UNDO')
  assert.match(late.lastReply(), /^Nothing to undo/)
})

const LEADS = [{ id: 'lead1', accountId: 'acc1', phone: '+15559990001', firstName: 'Pat' }, { id: 'lead2', accountId: 'acc1', phone: '+15559990002', firstName: null }]
const fresh = () => ({ contactId: 'lead1', at: new Date().toISOString() })

test('an answer goes to the lead they were last told about, from the business number', async () => {
  const h = handler({ contacts: LEADS, alert: fresh })
  await h.text('On my way, 20 minutes')
  assert.equal(h.calls.sent.length, 1)
  assert.equal(h.calls.sent[0].contactId, 'lead1')
  assert.equal(h.calls.sent[0].body, 'On my way, 20 minutes')
  assert.equal(h.calls.sent[0].by, 'owner:+16035550142')
  assert.equal(h.lastReply(), 'Sent to Pat.')
  assert.equal(h.calls.confirmed, 1)
  await h.text('Yes!')
  assert.equal(h.calls.sent[1].body, 'Yes!')
  // A number put first picks that lead.
  await h.text('555-999-0002: Tomorrow at 9 works')
  assert.equal(h.calls.sent[2].contactId, 'lead2')
  assert.equal(h.calls.sent[2].body, 'Tomorrow at 9 works')
  assert.equal(h.lastReply(), 'Sent to (555) 999-0002.')
  await h.text('555-999-0009: who is this')
  assert.equal(h.lastReply(), plan.NO_SUCH_LEAD)
  // review: the owner's own number put first isn't a lead.
  await h.text('603-555-0142: is my cell, text me there')
  assert.equal(h.lastReply(), plan.NO_SUCH_LEAD)
  assert.equal(h.calls.sent.length, 3)
  // Nothing recent to answer.
  const none = handler({ contacts: LEADS })
  await none.text('Hello?')
  assert.equal(none.calls.sent.length, 0)
  assert.equal(none.lastReply(), plan.NO_LEAD_TO_ANSWER)
  // The business number can't text yet: told to answer from their own phone.
  const cold = handler({ contacts: LEADS, ready: false, alert: fresh, sendResult: { ok: false, detail: 'Texting isn’t approved yet' } })
  await cold.text('On my way')
  assert.equal(cold.lastReply(), "Can't send from your business number yet (texting approval pending). Reply to Pat directly at (555) 999-0001.")
  const stop = handler({ contacts: LEADS, alert: fresh, sendResult: { ok: false, detail: 'The contact texted STOP; nothing is sent until they text START' } })
  await stop.text('Hi')
  assert.equal(stop.lastReply(), 'Not sent to Pat: The contact texted STOP; nothing is sent until they text START')
})

test('review: "ok" to the Hub’s confirmation goes nowhere; two leads at once are asked about', async () => {
  const ack = handler({ contacts: LEADS, alert: () => ({ ...fresh(), confirmedAt: new Date().toISOString() }) })
  await ack.text('ok')
  assert.equal(ack.calls.sent.length, 0)
  assert.equal(ack.calls.internal.length, 0)
  const two = handler({ contacts: LEADS, alert: () => ({ contactId: 'lead2', at: new Date().toISOString(), prev: { contactId: 'lead1', at: new Date(Date.now() - 60_000).toISOString() } }) })
  await two.text('On my way')
  assert.equal(two.calls.sent.length, 0)
  assert.equal(two.lastReply(), 'Two leads just now: (555) 999-0002 and Pat (555) 999-0001. Put their number first so I know who, like: 555-123-4567: on my way')
  await two.text('555-999-0001: On my way')
  assert.equal(two.calls.sent[0].contactId, 'lead1')
})

test('a photo is kept for the feed, with its caption, and the owner gets the link', async () => {
  const h = handler()
  await h.text('New deck in Tyler', ['https://api.twilio.com/m1', 'https://api.twilio.com/m2'])
  assert.deepEqual(h.calls.photos[0], { accountId: 'acc1', from: '+16035550142', mediaUrls: ['https://api.twilio.com/m1', 'https://api.twilio.com/m2'], caption: 'New deck in Tyler' })
  assert.equal(h.lastReply(), 'Got it. 2 photos are in your Recent Work: https://hub.example/hl/w/acc1')
  const live = handler({ onSite: true })
  await live.text('', ['https://api.twilio.com/m1'])
  assert.equal(live.lastReply(), 'Got it. Your photo is on your website now: https://hub.example/hl/w/acc1')
  const bad = handler({ photoResult: { added: 0, skipped: 1, failed: 0 } })
  await bad.text('', ['https://api.twilio.com/v1'])
  assert.match(bad.lastReply(), /^Photos only/)
  const broke = handler({ photoResult: { added: 0, skipped: 0, failed: 1 } })
  await broke.text('', ['https://api.twilio.com/m1'])
  assert.match(broke.lastReply(), /didn't come through on our side/)
})

test('review: on Genisys’s own number a client’s free text is for Genisys, never relayed; DONE, photos and a number-first answer still work', async () => {
  const one = handler({ contacts: LEADS, alert: fresh, owned: [{ id: 'acc1', clientId: 'cli1', name: 'Acme Roofing', profile: { businessName: 'Acme Roofing' } }] })
  await one.text('Hey Alex, can you swap the logo on my site?', [], '+16035550142', GENISYS, HUB_NUMBER)
  assert.equal(one.calls.sent.length, 0)
  assert.equal(one.calls.internal.length, 0, 'no reply either: as before')
  await one.text('555-999-0001: On my way', [], '+16035550142', GENISYS, HUB_NUMBER)
  assert.equal(one.calls.sent[0].contactId, 'lead1')
  await one.text('DONE 555-123-4567 Jane', [], '+16035550142', GENISYS, HUB_NUMBER)
  assert.equal(one.calls.contacts[0].accountId, 'acc1')
  assert.equal(one.calls.internal[one.calls.internal.length - 1].accountId, 'acc1')
  await one.text('help', [], '+16035550142', GENISYS, HUB_NUMBER)
  assert.match(one.lastReply(), /^Acme Roofing on Genisys: text a job photo/)
  // Nobody's phone: nothing. Two clients' phone: asked which.
  const nobody = handler({ owned: [] })
  await nobody.text('DONE 555-123-4567', [], '+16035550142', GENISYS, HUB_NUMBER)
  assert.equal(nobody.calls.internal.length + nobody.calls.twilio.length, 0)
  const two = handler({ owned: [{ id: 'a' }, { id: 'b' }] })
  await two.text('DONE 555-123-4567', [], '+16035550142', GENISYS, HUB_NUMBER)
  assert.equal(two.calls.twilio[0].body, plan.WHICH_BUSINESS)
  assert.equal(two.calls.contacts.length, 0)
  // review: Genisys's own owner on Genisys's number answers Genisys's own leads.
  const genisys = handler({ contacts: [{ id: 'g1', accountId: 'home', phone: '+15559990005', firstName: 'Sam' }], alert: () => ({ contactId: 'g1', at: new Date().toISOString() }) })
  await genisys.text('Sure, Tuesday works', [], '+16035550199', GENISYS, HUB_NUMBER)
  assert.equal(genisys.calls.sent[0].contactId, 'g1')
  assert.equal(genisys.calls.sent[0].accountId, 'home')
  // An empty text does nothing.
  const quiet = handler()
  await quiet.text('   ')
  assert.equal(quiet.calls.internal.length, 0)
})
