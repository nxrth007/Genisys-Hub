import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()

function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const source = readFileSync(absPath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  const localRequire = createRequire(pathToFileURL(absPath))
  const req = (id) => {
    if (id.startsWith('.')) return loadTs(join(dirname(absPath), id.endsWith('.ts') ? id : `${id}.ts`))
    if (id.startsWith('@/')) {
      const rel = id.slice(2)
      return loadTs(join(root, 'src', rel.endsWith('.ts') ? rel : `${rel}.ts`))
    }
    return localRequire(id)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  cache.set(absPath, m.exports)
  return m.exports
}

const dir = join(root, 'src/lib/ghl-customize')
const copy = loadTs(join(dir, 'copy.ts'))
const verify = loadTs(join(dir, 'verify.ts'))
const eligibility = loadTs(join(dir, 'eligibility.ts'))
const alertText = loadTs(join(root, 'src/lib/ghl-subaccount-worker/alert-text.ts'))

const INPUTS = {
  businessName: 'Always There Lawn Care',
  ownerFirstName: 'Richard',
  ownerFullName: 'Richard Bush',
  quoteLink: 'https://alwaystherelawncare.org/',
  phone: '(727) 557-6403',
  notifyEmail: 'owner@example.com',
}

const task = (id) => copy.customizeTasks(INPUTS).tasks.find((t) => t.id === id)

/** A workflow payload shaped like a GHL builder save: steps with names and attributes. */
function payload(missed, overrides = {}) {
  const [sms, email, internalSms] = missed.actions
  return {
    id: 'af77a08b-47c0-4de0-be82-df486073ebbe',
    name: 'Auto Missed Call Text-Back',
    workflowData: {
      templates: [
        { id: 't1', name: 'Slight Delay (so SMS doesn\'t feel like a bot)', type: 'wait', attributes: { seconds: 12 } },
        { id: 't2', name: 'Text Back the Caller', type: 'sms', attributes: { body: overrides.sms ?? sms.text } },
        {
          id: 't3',
          name: 'Push Notification to Assigned User',
          type: 'internal_notification',
          attributes: {
            type: 'email',
            toUserType: 'custom_email',
            email: overrides.email ?? email.email,
            subject: 'Missed Call Lead',
            html: overrides.html ?? email.text.split('\n\n').map((p) => `<p>${p.replace(/'/g, '&#39;')}</p>`).join(''),
          },
        },
        {
          id: 't4',
          name: 'Internal SMS to Assigned User',
          type: 'internal_notification',
          attributes: { type: 'sms', toUserType: 'custom_number', phone: overrides.phone ?? '+17275576403', body: internalSms.text },
        },
        { id: 't5', name: 'Wait 2 Minutes', type: 'wait', attributes: { minutes: 2 } },
      ],
    },
    // A canvas tile carries only the name: it must not count as "the step has no message".
    nodes: [{ id: 'n2', data: { label: 'Text Back the Caller' } }],
  }
}

test('the three Incoming Lead workflows, with every step the prompts name', () => {
  const { tasks, blanks } = copy.customizeTasks(INPUTS)
  assert.deepEqual(blanks, [])
  assert.deepEqual(tasks.map((t) => t.id), ['missed-call', 'chat-widget', 'quote-form'])
  assert.deepEqual(tasks.map((t) => t.name), ['Auto Missed Call Text-Back', 'Website Chat Widget Form Submitted', 'Website Quote Form Submitted'])
  for (const t of tasks) {
    assert.equal(t.actions.length, 3, t.name)
    assert.match(t.prompt, new RegExp(`Update the "${t.name}" workflow`))
    for (const a of t.actions) assert.ok(t.prompt.includes(a.text), `${t.name}: the prompt carries "${a.name}"'s copy`)
  }
  const missed = task('missed-call')
  assert.deepEqual(missed.actions.map((a) => [a.name, a.email ?? null, a.phone ?? null]), [
    ['Text Back the Caller', null, null],
    ['Push Notification to Assigned User', 'owner@example.com', null],
    ['Internal SMS to Assigned User', null, '(727) 557-6403'],
  ])
  assert.match(missed.actions[0].text, /free quote https:\/\/alwaystherelawncare\.org\/\n\n- Richard from Always There Lawn Care$/)
})

test('a missing or unusable detail holds the job, named in plain words', () => {
  const { blanks } = copy.customizeTasks({ ...INPUTS, quoteLink: '', notifyEmail: '' })
  assert.deepEqual(blanks.sort(), ['NOTIFICATION EMAIL', 'WEBSITE LINK'])
  // Filled in but unusable: a 7-digit phone, an address without a domain, "N/A" turned into a link.
  assert.deepEqual(copy.customizeTasks({ ...INPUTS, phone: '555-0123' }).blanks, ['BUSINESS PHONE'])
  assert.deepEqual(copy.customizeTasks({ ...INPUTS, notifyEmail: 'owner@gmail' }).blanks, ['NOTIFICATION EMAIL'])
  assert.deepEqual(copy.customizeTasks({ ...INPUTS, quoteLink: 'https://n/A' }).blanks, ['WEBSITE LINK'])
  assert.deepEqual(copy.customizeTasks({ ...INPUTS, phone: '+1 727-557-6403', quoteLink: 'https://site.co/quote?x=1' }).blanks, [])
  assert.equal(copy.fullUsNumber('(727) 557-6403'), true)
  assert.equal(copy.fullUsNumber('27275576403'), false)
  assert.equal(copy.blankNames(['WEBSITE LINK']), 'website link')
  assert.equal(copy.blankNames(['WEBSITE LINK', 'NOTIFICATION EMAIL', 'BUSINESS PHONE']), 'website link, notification email and business phone')
})

test('the site we built wins the free-quote link, unless the board points deeper into the same site', () => {
  assert.equal(copy.quoteLinkFor('alwaystherelawncare.org', 'https://old-site.com/'), 'https://alwaystherelawncare.org/')
  assert.equal(copy.quoteLinkFor('https://www.alwaystherelawncare.org', 'https://alwaystherelawncare.org/quote'), 'https://alwaystherelawncare.org/quote')
  assert.equal(copy.quoteLinkFor(null, 'https://old-site.com/'), 'https://old-site.com/')
  assert.equal(copy.quoteLinkFor('', ''), '')
  assert.equal(copy.sameSiteLink('https://a.com/', 'a.com'), true)
  assert.equal(copy.sameSiteLink('https://a.com/', 'https://b.com/'), false)
})

test('a save whose steps carry the exact copy and recipients passes', () => {
  const missed = task('missed-call')
  const check = verify.verifyWorkflowJson(payload(missed), missed.actions)
  assert.equal(check.found, true)
  assert.equal(check.ok, true, check.summary)
  assert.match(check.summary, /all 3 steps match/)
})

test('one changed word, a wrong recipient, or a missing step blocks the save', () => {
  const missed = task('missed-call')
  const reworded = verify.verifyWorkflowJson(payload(missed, { sms: missed.actions[0].text.replace('asap', 'soon') }), missed.actions)
  assert.equal(reworded.ok, false)
  assert.match(reworded.summary, /"Text Back the Caller": the message isn't the Hub's copy/)

  const wrongEmail = verify.verifyWorkflowJson(payload(missed, { email: 'someone@else.com' }), missed.actions)
  assert.equal(wrongEmail.ok, false)
  assert.match(wrongEmail.summary, /doesn't send to owner@example\.com/)

  const wrongPhone = verify.verifyWorkflowJson(payload(missed, { phone: '+15125550123' }), missed.actions)
  assert.equal(wrongPhone.ok, false)
  assert.match(wrongPhone.summary, /doesn't send to \(727\) 557-6403/)

  const json = payload(missed)
  json.workflowData.templates = json.workflowData.templates.filter((t) => t.name !== 'Internal SMS to Assigned User')
  const missing = verify.verifyWorkflowJson(json, missed.actions)
  assert.equal(missing.ok, false)
  assert.equal(missing.checks.find((c) => c.name === 'Internal SMS to Assigned User').problem, 'the step is not in the workflow')

  const unrelated = verify.verifyWorkflowJson({ workflows: [{ name: 'Something else' }] }, missed.actions)
  assert.equal(unrelated.found, false)
  assert.equal(unrelated.ok, false)
})

test('spacing, HTML paragraphs, entities, curly quotes and merge-field spacing do not count; words do', () => {
  assert.equal(verify.normalizeText('<p>Hey, Sam!</p><p>You just missed a call from</p><p>{{ contact.phone }} ( {{contact.name}} ).</p>'), 'Hey, Sam! You just missed a call from {{contact.phone}} ( {{contact.name}} ).')
  assert.equal(verify.normalizeText('I’ll get back&nbsp;to you'), "I'll get back to you")
  assert.equal(verify.normalizeText('Hey, Sam!\n\nYou'), 'Hey, Sam! You')
  assert.notEqual(verify.normalizeText('{{contact.full_name}}'), verify.normalizeText('{{contact.name}}'))
  const missed = task('missed-call')
  const html = '<p>Hey, Richard!</p><p></p><p>You just missed a call from</p><p></p><p>{{contact.phone}} ( {{contact.name}} ).</p><p></p><p>Please get back to them ASAP before lead gets cold.</p>'
  assert.equal(verify.verifyWorkflowJson(payload(missed, { html }), missed.actions).ok, true)
})

test('a failed check logs how GHL stores the step, so its format can be learned', () => {
  const missed = task('missed-call')
  const json = payload(missed, { sms: 'Hey, this is Todd from A Plus Fence and Construction!' })
  const check = verify.verifyWorkflowJson(json, missed.actions)
  const sample = verify.failureSamples(json, check)
  assert.match(sample, /^"Text Back the Caller" in GHL's data: \{"id":"t2","name":"Text Back the Caller","type":"sms","attributes":\{"body":"Hey, this is Todd/)
  assert.equal(verify.stepSample(json, 'Nope'), 'no object named "Nope"')
  assert.ok(verify.stepSample(json, 'Push Notification to Assigned User', 50).endsWith('…'))
})

test('a step that shows up twice must carry the copy both times', () => {
  const missed = task('missed-call')
  const json = payload(missed)
  json.workflowData.templates.push({ id: 't9', name: 'Text Back the Caller', type: 'sms', attributes: { body: 'Hey, this is Todd from A Plus Fence and Construction!' } })
  const check = verify.verifyWorkflowJson(json, missed.actions)
  assert.equal(check.ok, false)
  assert.match(check.summary, /Text Back the Caller/)
})

test('steps added or removed between two loads are noticed', () => {
  const missed = task('missed-call')
  const before = payload(missed)
  const after = payload(missed)
  after.workflowData.templates.push({ id: 't6', name: 'Add Tag', type: 'add_tag', attributes: { tags: ['x'] } })
  after.workflowData.templates = after.workflowData.templates.filter((t) => t.name !== 'Wait 2 Minutes')
  const changes = verify.stepNameChanges(before, after)
  assert.deepEqual(changes.added, ['add tag'])
  assert.deepEqual(changes.removed, ['wait 2 minutes'])
  assert.deepEqual(verify.stepNameChanges(before, payload(missed)), { added: [], removed: [] })
})

test('only sub-accounts the worker created, with the site link in, are customized by themselves', () => {
  const base = {
    archived: false,
    siteUrl: 'https://alwaystherelawncare.org/',
    locationId: 'loc1',
    subaccountJob: { status: 'succeeded', locationId: 'loc1', detail: 'GHL opened the new sub-account (loc1). Snapshot load completed.' },
    copyDone: false,
    job: null,
  }
  const d = eligibility.autoCustomizeDecision
  assert.deepEqual(d(base), { queue: true, reason: 'the site link is in' })
  assert.equal(d({ ...base, siteUrl: null }).queue, false)
  assert.equal(d({ ...base, siteUrl: '  ' }).reason, 'no site link yet')
  assert.equal(d({ ...base, locationId: null }).reason, 'no GHL sub-account yet')
  assert.equal(d({ ...base, archived: true }).queue, false)
  assert.equal(d({ ...base, subaccountJob: null }).queue, false)
  assert.equal(d({ ...base, subaccountJob: { ...base.subaccountJob, status: 'needs_human' } }).queue, false)
  assert.equal(d({ ...base, subaccountJob: { ...base.subaccountJob, locationId: 'other' } }).queue, false)
  assert.equal(d({ ...base, subaccountJob: { ...base.subaccountJob, detail: 'Linked the existing sub-account "Sam: Acme".' } }).reason, 'the sub-account was made by hand')
  assert.equal(d({ ...base, subaccountJob: { ...base.subaccountJob, detail: 'The client was already linked to a sub-account.' } }).queue, false)
  assert.equal(d({ ...base, copyDone: true }).reason, 'marked done on the Automation Copy board')
  assert.equal(d({ ...base, job: { status: 'queued', siteUrl: base.siteUrl } }).queue, false)
  assert.equal(d({ ...base, job: { status: 'held', siteUrl: base.siteUrl } }).queue, false)
  assert.equal(d({ ...base, job: { status: 'succeeded', siteUrl: 'alwaystherelawncare.org' } }).reason, 'already done for this site link')
  assert.deepEqual(d({ ...base, job: { status: 'succeeded', siteUrl: 'https://old.example.com/' } }), { queue: true, reason: 'the site link changed' })
  assert.equal(d({ ...base, job: { status: 'needs_human', siteUrl: base.siteUrl } }).reason, 'waiting for a person')
  assert.equal(d({ ...base, job: { status: 'failed', siteUrl: 'https://old.example.com/' } }).queue, true)
  // The job marks the board done itself; a changed link still runs it again (the job did that work).
  assert.equal(d({ ...base, copyDone: true, job: { status: 'succeeded', siteUrl: 'https://old.example.com/' } }).queue, true)
})

test("Workflow AI's answer when it couldn't do it", () => {
  assert.equal(eligibility.aiDeclined('I couldn\'t find an action named "Text Back the Caller" in this workflow.'), true)
  assert.equal(eligibility.aiDeclined('The action "Send Email To Staff" does not exist here. Could you clarify which step?'), true)
  assert.equal(eligibility.aiDeclined('Updated the three messages and both internal notification recipients.'), false)
  assert.equal(eligibility.inFlight('running'), true)
  assert.equal(eligibility.inFlight('held'), false)
})

test('customize problems text the team in plain words', () => {
  const link = 'https://genisys-hub.onrender.com/automation-copy/c1'
  const held = alertText.customizeAlertText('held', 'Always There Lawn Care', 'website link and notification email', link)
  assert.match(held, /^Genisys Hub: Always There Lawn Care's site link is in, but their GHL lead workflow copy is missing the website link and notification email\./)
  assert.match(alertText.customizeAlertText('needs_human', 'Acme', 'Two tries, nothing saved.', link), /Acme's GHL lead workflows need a person\. Two tries, nothing saved\. Open:/)
  assert.match(alertText.customizeAlertText('code', 'Acme', '', link), /sign-in code to update Acme's lead workflows/)
  assert.match(alertText.customizeAlertText('failed', 'Acme', 'x', link), /failed\. x Open:/)
  for (const kind of ['needs_human', 'failed', 'code', 'held', 'stuck', 'waiting']) {
    const text = alertText.customizeAlertText(kind, 'D & L Property Services LLC', 'A fairly long reason that goes on for a while to see that the text stays short enough to send as one or two segments.', link)
    assert.ok(text.length <= 340, `${kind}: ${text.length}`)
  }
})
