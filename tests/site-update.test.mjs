import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// "Send Site Update" in a client's Sites folder (src/lib/hl/site-update-plan.ts, site-update.ts):
// when the button shows, who the text goes to, what it says, and what the press does.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shared = new Map()

/** A src module, with stand-ins for the imports named in `stubs`; the rest load for real (pure modules). */
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

const plan = loadTs(join(root, 'src/lib/hl/site-update-plan.ts'))

// ---- when the button shows ----

test('the button shows once the site is live on their own domain', () => {
  assert.equal(plan.siteUpdateReady({ siteUrl: 'https://a1mconstruction.org/' }).ready, true)
  assert.equal(plan.siteUpdateReady({ siteUrl: 'acmeroofing.com' }).ready, true)
  assert.equal(plan.siteUpdateReady({ siteUrl: 'https://www.acmeroofing.com' }).ready, true)
  for (const [url, why] of [
    [null, /isn’t live yet/],
    ['  ', /isn’t live yet/],
    ['https://acme-roofing.lovable.app', /Lovable address/],
    ['https://id-preview--abc.lovableproject.com/', /Lovable address/],
    ['https://genisys-hub.onrender.com/hl/w/x', /Lovable address/],
    ['not a url at all /', /Lovable address/],
  ]) {
    const r = plan.siteUpdateReady({ siteUrl: url })
    assert.equal(r.ready, false, String(url))
    assert.match(r.why, why, String(url))
  }
  assert.match(plan.siteUpdateReady({ siteUrl: 'acme.com', archivedAt: new Date() }).why, /archived/)
  assert.equal(plan.ownDomain('https://www.acmeroofing.com/about'), 'acmeroofing.com')
  assert.equal(plan.ownDomain('acme.lovable.app'), null)
})

// ---- who it goes to ----

const PROFILE = { ownerFirstName: 'Chris', notifyPhone: '(719) 974-4712, +18665550100', notifyEmail: 'alerts@leadgenisys.com, chris@example.com' }

test('the owner is where their alerts go, then Clients, then the onboarding form; never us, their toll-free line, or a company name', () => {
  const r = plan.ownerContact({ profile: PROFILE, contactName: 'Christopher A Wood', contactPhone: '(555) 200-3000', contactEmail: 'office@example.com', intake: null, notOwner: ['+16035550199', '+18665550100'] })
  assert.deepEqual(r, { phone: '7199744712', email: 'chris@example.com', firstName: 'Chris' })
  // Their alert phone is Alex's (the team gets the alerts for them): the contact on Clients is next.
  const ours = plan.ownerContact({ profile: { notifyPhone: '+16035550199' }, contactName: 'CHRISTOPHER WOOD', contactPhone: '(555) 200-3000', contactEmail: null, intake: { fullName: null, customerPhone: '5551112222', leadEmail: 'Lead@Example.com' }, notOwner: ['+16035550199'] })
  assert.deepEqual(ours, { phone: '5552003000', email: 'lead@example.com', firstName: 'Christopher' })
  const form = plan.ownerContact({ profile: {}, contactName: 'A1M Construction LLC', contactPhone: null, contactEmail: null, intake: { fullName: 'maria lopez', customerPhone: '(555) 111-2222', leadEmail: null }, notOwner: [] })
  assert.deepEqual(form, { phone: '5551112222', email: null, firstName: 'Maria' })
  const nobody = plan.ownerContact({ profile: {}, contactName: null, contactPhone: '800-555-0199', contactEmail: 'x@peakfinitylabs.com', intake: null, notOwner: [] })
  assert.deepEqual(nobody, { phone: null, email: null, firstName: '' })
})

// ---- what it says ----

test('the text is Alex’s words, the site link on its own line, and the login when one goes with it', () => {
  const login = { link: 'https://hub.example/login/password?u=1&t=abc', email: 'chris@example.com', signInUrl: 'https://hub.example/login' }
  const t = plan.siteUpdateText({ firstName: 'Chris', siteUrl: 'https://a1mconstruction.org', login })
  const lines = t.split('\n')
  assert.equal(lines[0], "Hey Chris. We've got the first draft of your website ready for you to preview here:")
  assert.equal(lines[1], 'https://a1mconstruction.org')
  assert.ok(t.includes("The forms on the website won't work for a few days. It's still a work in progress, so let us know what changes you'd like to make!"))
  assert.ok(t.includes('We are working on your SEO (which will drive leads to your site) and will keep you updated.'))
  assert.ok(t.includes('Please text us all changes, questions, and concerns. Thanks!'))
  assert.ok(t.includes('Your Genisys OS login'))
  assert.ok(lines.includes(login.link))
  assert.ok(t.endsWith('Then sign in any time at https://hub.example/login with chris@example.com'))
  const plain = plan.siteUpdateText({ firstName: '', siteUrl: 'https://acme.com', login: null })
  assert.ok(plain.startsWith('Hey there. '))
  assert.ok(!plain.includes('login'))
  assert.ok(plain.endsWith('Thanks!'))
})

test('the send log reads back what it can, and nothing from a bad row', () => {
  const rows = [{ at: '2026-11-25T15:00:00Z', to: '+17199744712', by: 'Alex', login: null, ok: true, detail: null }]
  assert.deepEqual(plan.readSentLog(JSON.stringify(rows)), rows)
  assert.deepEqual(plan.readSentLog('nope'), [])
  assert.deepEqual(plan.readSentLog(JSON.stringify([{ at: 1 }, null, rows[0]])), rows)
  assert.equal(plan.prettyPhone('+17199744712'), '(719) 974-4712')
})

// ---- the press, against stand-ins ----

function handler(o = {}) {
  const calls = { sms: [], invites: [], staff: [] }
  const settings = new Map(o.settings ?? [])
  const client = {
    id: 'cli1',
    name: 'A1M Construction',
    contactName: 'Christopher A Wood',
    contactPhone: '(719) 974-4712',
    contactEmail: 'chris@example.com',
    address: '12 Main St, Colorado Springs, CO 80903',
    siteUrl: 'https://a1mconstruction.org',
    archivedAt: null,
    intakes: [],
    hlAccount: { id: 'acc1', name: 'A1M Construction', profile: { businessName: 'A1M Construction', ownerFirstName: 'Chris' }, archivedAt: null, timezone: 'America/Denver', numbers: [{ number: '+18665550100' }], members: [] },
    ...o.client,
  }
  const prisma = {
    client: { findUnique: async () => client },
    appSetting: {
      findUnique: async ({ where }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, create }) => settings.set(where.key, create.value),
    },
    remindersConfig: { findUnique: async () => ({ senderPhone: '+16035550100' }) },
  }
  class HlInputError extends Error {}
  const stubs = {
    '@/lib/prisma': { prisma },
    '@/lib/ghl': {
      sendSmsToPhone: async (vault, params) => {
        calls.sms.push({ vault, ...params })
        if (o.smsFails) throw new Error(o.smsFails)
        return { contactId: 'c', messageId: 'm' }
      },
    },
    '@/lib/team-sms': { TEAM_ALERT_PHONES: [{ name: 'Alex', phone: '+16035550199' }] },
    './accounts': { readProfile: (v) => v ?? {} },
    './http': { HlInputError },
    './logins': {
      ownerStaffId: async (accountId, email, name, addedBy) => (calls.staff.push({ accountId, email, name, addedBy }), 'staff1'),
      inviteLogin: async (x) => {
        calls.invites.push(x)
        if (o.inviteFails) throw new HlInputError(o.inviteFails)
        return { link: 'https://hub.example/login/password?u=u1&t=tok', sent: [] }
      },
    },
    './twilio': { publicBase: () => 'https://hub.example' },
  }
  const mod = loadTs(join(root, 'src/lib/hl/site-update.ts'), stubs, new Map())
  return { mod, calls, settings, client }
}
const DAY = new Date('2026-11-25T18:00:00Z') // 11 AM in Denver
const NIGHT = new Date('2026-11-25T05:00:00Z') // 10 PM in Denver the evening before
process.env.NODE_ENV = 'production'

test('the view: ready and who it goes to (no waiting for daytime: Alex, 2026-11-27)', async () => {
  const h = handler()
  const v = await h.mod.siteUpdateView('cli1')
  assert.equal(v.ready, true)
  assert.equal(v.to, '7199744712')
  assert.equal(v.email, 'chris@example.com')
  assert.equal(v.firstName, 'Chris')
  assert.equal(v.siteUrl, 'https://a1mconstruction.org')
  assert.equal(v.canLogin, true)
  assert.equal(v.signInUrl, 'https://hub.example/login')
  assert.equal(v.last, null)
  assert.equal('goesOutAt' in v, false, 'the 9 AM to 7 PM wait is gone')
  const notYet = handler({ client: { siteUrl: 'https://a1m.lovable.app' } })
  assert.equal((await notYet.mod.siteUpdateView('cli1', DAY)).ready, false)
})

test('the press texts the owner from Lead Genisys’s line, with a fresh login link, and keeps the send', async () => {
  const h = handler()
  const r = await h.mod.sendSiteUpdate('cli1', { to: '(719) 974-4712', email: 'Chris@Example.com', includeLogin: true, by: 'Alex' }, DAY)
  assert.deepEqual(r, { ok: true, to: '(719) 974-4712', login: 'chris@example.com' })
  assert.equal(h.calls.sms.length, 1)
  assert.equal(h.calls.sms[0].vault, 'GHL Genisys Token')
  assert.equal(h.calls.sms[0].phone, '+17199744712')
  assert.equal(h.calls.sms[0].fromNumber, '+16035550100')
  assert.equal(h.calls.sms[0].companyName, 'A1M Construction')
  assert.ok(h.calls.sms[0].message.startsWith("Hey Chris. We've got the first draft"))
  assert.ok(h.calls.sms[0].message.includes('\nhttps://a1mconstruction.org\n'))
  assert.ok(h.calls.sms[0].message.includes('https://hub.example/login/password?u=u1&t=tok'))
  assert.ok(h.calls.sms[0].message.endsWith('with chris@example.com'))
  assert.deepEqual(h.calls.staff[0], { accountId: 'acc1', email: 'chris@example.com', name: 'Christopher A Wood', addedBy: 'site update' })
  assert.equal(h.calls.invites[0].quiet, true)
  assert.equal(h.calls.invites[0].by, 'Alex')
  const log = JSON.parse(h.settings.get('hl.siteUpdate:cli1'))
  assert.equal(log.length, 1)
  assert.equal(log[0].to, '+17199744712')
  assert.equal(log[0].login, 'chris@example.com')
  assert.equal(log[0].ok, true)
  assert.equal((await h.mod.siteUpdateView('cli1', DAY)).last.by, 'Alex')
  // Without the login: no invite, no login lines.
  const plain = handler()
  await plain.mod.sendSiteUpdate('cli1', { to: '7199744712', email: null, includeLogin: false, by: 'Ethan' }, DAY)
  assert.equal(plain.calls.invites.length, 0)
  assert.ok(!plain.calls.sms[0].message.includes('login'))
})

test('the press goes out at night too (Alex, 2026-11-27: whoever presses decides)', async () => {
  const h = handler()
  const night = await h.mod.sendSiteUpdate('cli1', { to: '7199744712', email: null, includeLogin: false, by: 'Alex' }, NIGHT)
  assert.equal(night.ok, true)
  assert.equal(h.calls.sms.length, 1)
})

test('the press refuses a bad or our own number, a login with no email or no sub-account, and says when a text failed', async () => {
  const h = handler()
  assert.match((await h.mod.sendSiteUpdate('cli1', { to: '555-1234', email: null, includeLogin: false, by: 'Alex' }, DAY)).reason, /10-digit/)
  assert.match((await h.mod.sendSiteUpdate('cli1', { to: '603-555-0199', email: null, includeLogin: false, by: 'Alex' }, DAY)).reason, /Genisys’s own/)
  assert.match((await h.mod.sendSiteUpdate('cli1', { to: '866-555-0100', email: null, includeLogin: false, by: 'Alex' }, DAY)).reason, /Genisys’s own/)
  assert.match((await h.mod.sendSiteUpdate('cli1', { to: '7199744712', email: 'not-an-email', includeLogin: true, by: 'Alex' }, DAY)).reason, /owner’s email/)
  assert.equal(h.calls.sms.length, 0)
  const noAccount = handler({ client: { hlAccount: null } })
  assert.match((await noAccount.mod.sendSiteUpdate('cli1', { to: '7199744712', email: 'c@example.com', includeLogin: true, by: 'Alex' }, DAY)).reason, /no Genisys OS sub-account/)
  const genisysEmail = handler({ inviteFails: 'alex@leadgenisys.com is a Genisys address.' })
  assert.match((await genisysEmail.mod.sendSiteUpdate('cli1', { to: '7199744712', email: 'alex@leadgenisys.com', includeLogin: true, by: 'Alex' }, DAY)).reason, /Genisys address/)
  assert.equal(genisysEmail.calls.sms.length, 0)
  const lovable = handler({ client: { siteUrl: 'https://a1m.lovable.app' } })
  assert.match((await lovable.mod.sendSiteUpdate('cli1', { to: '7199744712', email: null, includeLogin: false, by: 'Alex' }, DAY)).reason, /Lovable address/)
  // GHL said no: the failure is kept and shown, nothing is retried.
  const failed = handler({ smsFails: 'GHL API error 400: bad request' })
  const f = await failed.mod.sendSiteUpdate('cli1', { to: '7199744712', email: null, includeLogin: false, by: 'Alex' }, DAY)
  assert.equal(f.ok, false)
  assert.match(f.reason, /didn’t go out: GHL API error 400/)
  // Refused on the team's line, so once more from the sub-account's default number.
  assert.equal(failed.calls.sms.length, 2)
  assert.equal(failed.calls.sms[1].fromNumber, undefined)
  const log = JSON.parse(failed.settings.get('hl.siteUpdate:cli1'))
  assert.equal(log[0].ok, false)
  assert.match(log[0].detail, /400/)
})
