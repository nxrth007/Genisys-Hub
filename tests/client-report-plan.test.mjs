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

const plan = loadTs(join(root, 'src/lib/hl/client-report-plan.ts'))

const flows = ['missed_call', 'quote_form', 'chat_widget', 'review_request'].map((template) => ({ template, status: 'published' }))
const ready = {
  siteLive: true,
  domain: true,
  tollFree: { verificationStatus: 'approved', forwardTo: '+15712767875' },
  siteOnHellLevel: true,
  workflows: flows,
  reviewLink: true,
  profileMissing: [],
}

test('ready only when everything the package does is working on its own', () => {
  assert.equal(plan.reportReadiness(ready).ready, true)
  const cases = [
    [{ siteLive: false }, 'site'],
    [{ domain: false }, 'domain'],
    [{ tollFree: null }, 'number'],
    [{ tollFree: { verificationStatus: 'pending', forwardTo: '+1' } }, 'texting'],
    [{ tollFree: { verificationStatus: 'approved', forwardTo: null } }, 'calls'],
    [{ siteOnHellLevel: false }, 'form'],
    [{ workflows: flows.filter((w) => w.template !== 'missed_call') }, 'automations'],
    [{ reviewLink: false }, 'reviews'],
    [{ profileMissing: ['notification email'] }, 'profile'],
  ]
  for (const [change, key] of cases) {
    const r = plan.reportReadiness({ ...ready, ...change })
    assert.equal(r.ready, false, key)
    assert.deepEqual(
      r.items.filter((i) => !i.done).map((i) => i.key),
      key === 'number' ? ['number', 'texting', 'calls'] : [key],
      key,
    )
  }
  // A draft workflow isn't on.
  assert.equal(plan.reportReadiness({ ...ready, workflows: flows.map((w) => (w.template === 'quote_form' ? { ...w, status: 'draft' } : w)) }).ready, false)
  assert.match(plan.reportReadiness({ ...ready, tollFree: { verificationStatus: 'pending', forwardTo: '+1' } }).items.find((i) => i.key === 'texting').note, /Twilio is reviewing/)
})

const numbers = { days: 30, leads: 12, forms: 9, callsAnswered: 7, callsMissed: 3, textsSent: 41, textsReceived: 18, appointments: 4, reviewRequests: 5 }
const base = {
  business: 'Acme Roofing & Gutters',
  firstName: 'Dana',
  numbers,
  site: { url: 'https://acmeroofing.com', host: 'acmeroofing.com' },
  phone: '(855) 609-0482',
  login: null,
  signInUrl: 'https://hub.example.com/login',
}

test('the email: their numbers and setup, the business name escaped, no internal names', () => {
  const e = plan.reportEmail(base)
  assert.equal(e.subject, 'Acme Roofing & Gutters: your last 30 days with Genisys')
  assert.ok(e.html.startsWith('<!DOCTYPE html>'), 'sent as HTML, not markdown')
  assert.ok(e.html.includes('Acme Roofing &amp; Gutters'))
  assert.ok(e.html.includes('Hi Dana,'))
  for (const v of ['>12<', '>41<', '>4<', '(855) 609-0482', 'acmeroofing.com']) assert.ok(e.html.includes(v), v)
  assert.ok(!/hell-?level|gohighlevel|\bGHL\b/i.test(e.html), 'the client never sees internal names')
  assert.ok(!e.html.includes('Choose my password'), 'no login block unless asked')
})

test('the email: the login block when asked, and a plain intro when nothing has come in yet', () => {
  const e = plan.reportEmail({ ...base, login: { link: 'https://hub.example.com/login/password?u=1&t=abc', email: 'dana@acme.com' } })
  assert.ok(e.html.includes('Choose my password'))
  assert.ok(e.html.includes('href="https://hub.example.com/login/password?u=1&amp;t=abc"'))
  assert.ok(e.html.includes('dana@acme.com'))
  const quiet = plan.reportEmail({ ...base, numbers: { ...numbers, leads: 0, forms: 0, callsAnswered: 0, callsMissed: 0 } })
  assert.ok(quiet.html.includes('is set up and working'))
  assert.ok(plan.reportEmail({ ...base, firstName: null }).html.includes('Hi there,'))
})
