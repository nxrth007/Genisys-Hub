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

const plan = loadTs(join(root, 'src/lib/hl/number-plan.ts'))
const alertText = loadTs(join(root, 'src/lib/ghl-subaccount-worker/alert-text.ts'))

const SINCE = new Date('2026-11-13T00:00:00Z')
const base = {
  archived: false,
  accountId: 'acc1',
  accountCreatedAt: new Date('2026-11-14T00:00:00Z'),
  hasTollFree: false,
  request: null,
  since: SINCE,
  trigger: 'onboarding',
}

test('prettyPhone: (855) 676-2067 from any US form, anything else unchanged', () => {
  assert.equal(plan.prettyPhone('+18556762067'), '(855) 676-2067')
  assert.equal(plan.prettyPhone('8556762067'), '(855) 676-2067')
  assert.equal(plan.prettyPhone('+44 7915 918658'), '+44 7915 918658')
  assert.equal(plan.prettyPhone(null), '')
})

test('askDecision: Echo asks once, right after onboarding made the sub-account', () => {
  assert.deepEqual(plan.askDecision(base), { ask: true, reason: 'its sub-account is ready' })
  assert.equal(plan.askDecision({ ...base, archived: true }).ask, false)
  assert.equal(plan.askDecision({ ...base, accountId: null }).reason, 'no Hell-level sub-account yet')
  assert.equal(plan.askDecision({ ...base, hasTollFree: true }).reason, 'its sub-account already has a toll-free number')
  // The sweep skips sub-accounts from before the question existed (the 31 already on file): those are asked about by hand.
  assert.equal(plan.askDecision({ ...base, trigger: 'sweep' }).ask, true)
  assert.equal(plan.askDecision({ ...base, trigger: 'sweep', accountCreatedAt: new Date('2026-10-24T00:00:00Z') }).reason, 'its sub-account is older than the number question')
  assert.equal(plan.askDecision({ ...base, trigger: 'sweep', accountCreatedAt: null }).ask, false)
  // Onboarding just made the sub-account, even if "since" was first recorded a moment later.
  assert.equal(plan.askDecision({ ...base, accountCreatedAt: new Date(SINCE.getTime() - 50) }).ask, true)
})

test('askDecision: never twice by itself; by hand after a No or a failure', () => {
  for (const status of ['awaiting_approval', 'buying', 'bought']) {
    assert.equal(plan.askDecision({ ...base, request: { status } }).ask, false, status)
    assert.equal(plan.askDecision({ ...base, trigger: 'manual', request: { status } }).ask, false, `manual ${status}`)
  }
  assert.equal(plan.askDecision({ ...base, request: { status: 'declined' } }).reason, 'someone answered No')
  assert.equal(plan.askDecision({ ...base, request: { status: 'failed' } }).ask, false)
  assert.equal(plan.askDecision({ ...base, trigger: 'manual', request: { status: 'declined' } }).ask, true)
  assert.equal(plan.askDecision({ ...base, trigger: 'manual', request: { status: 'failed' } }).ask, true)
  // By hand works for an older sub-account too.
  assert.equal(plan.askDecision({ ...base, trigger: 'manual', accountCreatedAt: new Date('2026-10-24T00:00:00Z') }).ask, true)
})

test("askDecision: a GHL sub-account that already has a number is never asked about (Alex's rule)", () => {
  for (const trigger of ['onboarding', 'sweep', 'manual']) {
    assert.equal(plan.askDecision({ ...base, trigger, ghlNumbers: 'has' }).reason, 'its GHL sub-account already has a number', trigger)
  }
  // None in GHL, or no phone system there (a Hell-level number works without it): asked as before.
  assert.equal(plan.askDecision({ ...base, ghlNumbers: 'none' }).ask, true)
  assert.equal(plan.askDecision({ ...base, trigger: 'manual', ghlNumbers: 'none' }).ask, true)
  assert.equal(plan.askDecision({ ...base, trigger: 'manual', ghlNumbers: 'unavailable' }).ask, true)
  // By hand a person decides, GHL read or not (the daily read is paused); a brand-new client has no GHL sub-account to read.
  assert.equal(plan.askDecision({ ...base, trigger: 'manual', ghlNumbers: 'unchecked' }).ask, true)
  assert.equal(plan.askDecision({ ...base, ghlNumbers: 'unchecked' }).ask, true)
  // The sweep (a sub-account linked rather than made by the worker) waits for GHL's numbers too.
  assert.equal(plan.askDecision({ ...base, trigger: 'sweep', ghlNumbers: 'unchecked' }).reason, plan.UNREAD_GHL)
  assert.equal(plan.askDecision({ ...base, trigger: 'sweep', ghlNumbers: 'none' }).ask, true)
  // No linked GHL sub-account: only Hell-level applies, as before.
  assert.equal(plan.askDecision({ ...base, trigger: 'manual', ghlNumbers: null }).ask, true)
  // Forte: its Hell-level number answers first.
  assert.equal(plan.askDecision({ ...base, hasTollFree: true, ghlNumbers: 'unavailable' }).reason, 'its sub-account already has a toll-free number')
})

test('ringTo: the business phone, else the owner’s, else a missed-call catcher', () => {
  assert.equal(plan.ringTo({ businessPhone: '(603) 555-0142', notifyPhone: '+16035550199' }), '+16035550142')
  assert.equal(plan.ringTo({ businessPhone: '', notifyPhone: '603-555-0199, 603-555-0100' }), '+16035550199')
  assert.equal(plan.ringTo({ businessPhone: 'call us', notifyPhone: '' }), null)
  assert.equal(plan.ringTo({}), null)
})

test('nextNumberState: Hell-level, GHL, Identification complete or No, each only where it fits', () => {
  assert.equal(plan.nextNumberState('awaiting_approval', 'hl'), 'buying')
  assert.equal(plan.nextNumberState('awaiting_approval', 'ghl'), 'awaiting_identity')
  assert.equal(plan.nextNumberState('awaiting_approval', 'no'), 'declined')
  // Identification complete only after GHL was chosen.
  assert.equal(plan.nextNumberState('awaiting_approval', 'identified'), null)
  assert.equal(plan.nextNumberState('awaiting_identity', 'identified'), 'ghl_working')
  // A change of mind while waiting on the ID check.
  assert.equal(plan.nextNumberState('awaiting_identity', 'hl'), 'buying')
  assert.equal(plan.nextNumberState('awaiting_identity', 'no'), 'declined')
  assert.equal(plan.nextNumberState('awaiting_identity', 'ghl'), null)
  // Anything already settled takes no more answers.
  for (const s of ['buying', 'ghl_working', 'bought', 'declined', 'failed']) {
    for (const c of ['hl', 'ghl', 'identified', 'no']) assert.equal(plan.nextNumberState(s, c), null, `${s} ${c}`)
  }
})

test('textsTo: forwarded texts go to the phone from the onboarding form (a cell), else the business phone', () => {
  assert.equal(plan.textsTo({ businessPhone: '(603) 555-0142', notifyPhone: '603-555-0199, 603-555-0100' }), '+16035550199')
  assert.equal(plan.textsTo({ businessPhone: '(603) 555-0142', notifyPhone: '' }), '+16035550142')
  assert.equal(plan.textsTo({}), null)
})

test('ownerPhones: the owner’s own phones are never treated as a lead', () => {
  const owners = plan.ownerPhones({ forwardTo: '+16035550142', forwardTextsTo: '+16035550199' }, { businessPhone: '(603) 555-0142', notifyPhone: '603-555-0199, (603) 555-0100' })
  assert.deepEqual([...owners].sort(), ['+16035550100', '+16035550142', '+16035550199'])
  assert.equal(plan.ownerPhones({}, {}).size, 0)
  assert.ok(!owners.has('+16175550000'))
})

test('forwardTextBody: who wrote, what they said, and how to answer', () => {
  assert.equal(
    plan.forwardTextBody({ business: 'Acme Roofing', from: '+16175550000', name: 'Jennifer Lee', body: 'Hi, can I get a quote\nfor my roof?', media: 0 }),
    'Acme Roofing: new text from Jennifer Lee (617) 555-0000: "Hi, can I get a quote for my roof?" Reply to them at (617) 555-0000.',
  )
  assert.equal(
    plan.forwardTextBody({ business: 'Acme Roofing', from: '+16175550000', body: '', media: 2 }),
    'Acme Roofing: new text from (617) 555-0000: (+2 photos) Reply to them at (617) 555-0000.',
  )
  const long = plan.forwardTextBody({ business: 'Acme Roofing', from: '+16175550000', body: 'x'.repeat(500), media: 1 })
  assert.ok(long.length < 320, `${long.length} chars`)
  assert.match(long, /x…" \(\+1 photo\) Reply to them/)
})

test('readyToFile: texting verification waits for the site link and files once', () => {
  const n = { siteUrl: 'https://acmeroofing.com', numberActive: true, kind: 'toll_free', verificationStatus: 'none' }
  assert.deepEqual(plan.readyToFile(n), { file: true, reason: 'the site is in' })
  assert.equal(plan.readyToFile({ ...n, siteUrl: null }).reason, 'waiting for the site link')
  assert.equal(plan.readyToFile({ ...n, siteUrl: '  ' }).file, false)
  assert.equal(plan.readyToFile({ ...n, numberActive: false }).file, false)
  assert.equal(plan.readyToFile({ ...n, kind: 'local' }).file, false)
  for (const v of ['pending', 'in_review', 'approved', 'rejected']) assert.equal(plan.readyToFile({ ...n, verificationStatus: v }).file, false, v)
  assert.equal(plan.readyToFile({ ...n, verificationStatus: null }).file, true)
  assert.equal(plan.FILE_RETRY_MS, 6 * 60 * 60_000)
})

test('reconcileVerify: a rejection becomes the note once; a re-filing clears it; a blocked filing stays', () => {
  const rejected = plan.reconcileVerify({ verificationStatus: 'rejected', verificationNote: '30509: opt-in link not public', currentNote: null })
  assert.deepEqual(rejected, { note: plan.rejectionNote('30509: opt-in link not public'), text: true })
  assert.match(rejected.note, /^Twilio rejected the texting verification: 30509: opt-in link not public\. Fix it and file it again in Hell-level/)
  // Already noted: nothing to do (no second text).
  assert.equal(plan.reconcileVerify({ verificationStatus: 'rejected', verificationNote: '30509: opt-in link not public', currentNote: rejected.note }), null)
  for (const s of ['pending', 'in_review', 'approved']) {
    assert.deepEqual(plan.reconcileVerify({ verificationStatus: s, verificationNote: null, currentNote: rejected.note }), { note: null, text: false }, s)
    assert.equal(plan.reconcileVerify({ verificationStatus: s, verificationNote: null, currentNote: null }), null, `${s} without a note`)
  }
  // A filing that couldn't go in yet keeps its note until it works.
  assert.equal(plan.reconcileVerify({ verificationStatus: 'none', verificationNote: null, currentNote: 'Add the full business address.' }), null)
  assert.match(plan.rejectionNote(null), /^Twilio rejected the texting verification\. Fix it/)
})

test('number texts: plain, short, and each links to where to act', () => {
  const link = 'https://hub.example/office'
  for (const k of ['approve', 'failed', 'verify', 'rejected']) {
    const t = alertText.numberAlertText(k, 'Acme Roofing', 'Add the full business address in Settings → Business Profile.', link)
    assert.ok(t.startsWith('Genisys Hub: '), k)
    assert.ok(t.includes('Acme Roofing'), k)
    assert.ok(t.endsWith(link), k)
    assert.ok(t.length <= 320, `${k} is ${t.length} chars`)
  }
  assert.match(alertText.numberAlertText('approve', 'Acme Roofing', '', link), /Acme Roofing just onboarded\. Approve their Hell-level toll-free number \(about \$2\.15\/mo, no ID check\) in the Office/)
  assert.match(alertText.numberAlertText('failed', 'Acme Roofing', 'Twilio said no.', link), /buying Acme Roofing's toll-free number failed\. Twilio said no\./)
  assert.match(alertText.numberAlertText('verify', 'Acme Roofing', 'Add the address.', link), /texting verification can't be filed yet\. Add the address\./)
  assert.match(alertText.numberAlertText('rejected', 'Acme Roofing', '30509: opt-in link not public', link), /Twilio rejected Acme Roofing's toll-free texting verification\. 30509/)
})
