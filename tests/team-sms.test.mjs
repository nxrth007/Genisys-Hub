import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

/**
 * The team's text alerts (src/lib/team-sms.ts): the wording of the two
 * onboarding alarms added on 2026-11-19, and the throttle that keeps a
 * misbehaving sender from texting Alex and Ethan every few seconds.
 *
 * The real module is loaded with a fake GHL sender and a fake database, so
 * the test sees exactly what would have been sent.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadTs(relPath, stubs) {
  const absPath = join(root, relPath)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const real = createRequire(pathToFileURL(absPath))
  const require = (spec) => (spec in stubs ? stubs[spec] : real(spec))
  const m = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, require)
  return m.exports
}

/** Loads team-sms.ts with a GHL that records every text and a database with one sender number. */
function load() {
  const sent = []
  const slack = []
  const sms = loadTs('src/lib/team-sms.ts', {
    '@/lib/prisma': {
      prisma: {
        remindersConfig: { findUnique: async () => ({ senderPhone: '+16038034828' }) },
        appSetting: { findUnique: async () => null, upsert: async () => ({}) },
      },
    },
    '@/lib/ghl': {
      sendSmsToPhone: async (entry, p) => {
        sent.push({ entry, phone: p.phone, message: p.message, from: p.fromNumber ?? null })
        return { contactId: 'c', messageId: 'm', normalizedPhone: p.phone, rawResponse: {} }
      },
    },
    '@/lib/hub-alerts': { hubAlertThrottled: async (key, ms, text) => { slack.push(text) } },
  })
  return { sms, sent, slack }
}

// One SMS encoding: every character printable ASCII, so GHL sends it as one cheap segment per 160 chars.
const PLAIN = /^[\x20-\x7E]+$/

test('a submission stored without a client texts what happened, why, and where to look', () => {
  const { sms } = load()
  const text = sms.onboardingNoClientText({
    business: 'an unnamed business',
    why: 'Usually the business name was blank',
    link: 'https://hub.example/clients/onboarding',
  })
  assert.match(text, /^Genisys: an unnamed business finished the onboarding form, but the Hub could not make a client/)
  assert.match(text, /Usually the business name was blank\./)
  assert.match(text, /Clients > Onboarding answers: https:\/\/hub\.example\/clients\/onboarding$/)
  assert.match(text, PLAIN)
})

test('a refused webhook post names the business when the answers carried one, and says the sheet still has it', () => {
  const { sms } = load()
  const link = 'https://hub.example/clients'
  const secret = sms.onboardingRejectedText({ reason: 'invalid_secret', business: 'Acme Fence', link })
  assert.match(secret, /^Genisys: the onboarding form sent a submission for Acme Fence but the Hub turned it away: its webhook secret does not match the Vault\./)
  assert.match(secret, /onboarding sheet within 15 minutes/)
  assert.match(secret, /INTAKE_WEBHOOK_SECRET/)
  assert.ok(secret.endsWith(link))

  const json = sms.onboardingRejectedText({ reason: 'invalid_json', business: null, link })
  assert.match(json, /^Genisys: the onboarding form sent a submission but the Hub turned it away: the Hub could not read it \(not valid JSON\)/)

  const empty = sms.onboardingRejectedText({ reason: 'empty_payload', business: null, link })
  assert.match(empty, /turned it away: it carried no answers\./)

  for (const t of [secret, json, empty]) {
    assert.match(t, PLAIN)
    assert.ok(t.length <= 320, `fits two SMS segments: ${t.length}`)
  }
})

test('a text goes to Alex and Ethan from the reminders line, and the log records both', async () => {
  const { sms, sent } = load()
  const results = await sms.textTeam('Genisys: test', 'Test')
  assert.deepEqual(sent.map((s) => s.phone), ['+16034185315', '+16035026226'])
  assert.ok(sent.every((s) => s.entry === 'GHL Genisys Token' && s.from === '+16038034828'))
  assert.deepEqual(results.map((r) => [r.name, r.ok, r.from]), [['Alex', true, '+16038034828'], ['Ethan', true, '+16038034828']])
})

test('the throttle sends the first alarm, swallows repeats inside the window, and keeps keys apart', async () => {
  const { sms, sent } = load()
  const first = await sms.textTeamThrottled('onboarding:invalid_secret', 30 * 60_000, 'Genisys: first', 'Onboarding form')
  assert.equal(first.length, 2)
  assert.equal(sent.length, 2)

  const repeat = await sms.textTeamThrottled('onboarding:invalid_secret', 30 * 60_000, 'Genisys: again', 'Onboarding form')
  assert.equal(repeat, null)
  assert.equal(sent.length, 2, 'nothing more was sent')

  const other = await sms.textTeamThrottled('onboarding:empty_payload', 30 * 60_000, 'Genisys: other', 'Onboarding form')
  assert.equal(other.length, 2)
  assert.equal(sent.length, 4)
  assert.ok(sent.slice(2).every((s) => s.message === 'Genisys: other'))
})

test('when nobody gets the text, the failure is posted rather than lost', async () => {
  const { sms, slack } = (() => {
    const slack = []
    const sms = loadTs('src/lib/team-sms.ts', {
      '@/lib/prisma': {
        prisma: {
          remindersConfig: { findUnique: async () => ({ senderPhone: null }) },
          appSetting: { findUnique: async () => null, upsert: async () => ({}) },
        },
      },
      '@/lib/ghl': { sendSmsToPhone: async () => { throw new Error('GHL 401') } },
      '@/lib/hub-alerts': { hubAlertThrottled: async (key, ms, text) => { slack.push(text) } },
    })
    return { sms, slack }
  })()
  const quiet = console.error // the module logs each failed attempt; the test expects them
  console.error = () => {}
  let results
  try {
    results = await sms.textTeam('Genisys: test', 'Test')
  } finally {
    console.error = quiet
  }
  assert.ok(results.every((r) => !r.ok && /GHL 401/.test(r.error)))
  assert.equal(slack.length, 1)
  assert.match(slack[0], /Team text didn't send\* \(Test\): Alex: .*GHL 401/)
})
