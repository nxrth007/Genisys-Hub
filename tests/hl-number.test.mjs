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

test('ringTo: the business phone, else the owner’s, else a missed-call catcher', () => {
  assert.equal(plan.ringTo({ businessPhone: '(603) 555-0142', notifyPhone: '+16035550199' }), '+16035550142')
  assert.equal(plan.ringTo({ businessPhone: '', notifyPhone: '603-555-0199, 603-555-0100' }), '+16035550199')
  assert.equal(plan.ringTo({ businessPhone: 'call us', notifyPhone: '' }), null)
  assert.equal(plan.ringTo({}), null)
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
  assert.match(alertText.numberAlertText('approve', 'Acme Roofing', '', link), /just onboarded\. Approve their Hell-level toll-free number \(about \$2\.15\/mo, no ID check\) in the Office/)
  assert.match(alertText.numberAlertText('failed', 'Acme Roofing', 'Twilio said no.', link), /buying Acme Roofing's toll-free number failed\. Twilio said no\./)
  assert.match(alertText.numberAlertText('verify', 'Acme Roofing', 'Add the address.', link), /texting verification can't be filed yet\. Add the address\./)
  assert.match(alertText.numberAlertText('rejected', 'Acme Roofing', '30509: opt-in link not public', link), /Twilio rejected Acme Roofing's toll-free texting verification\. 30509/)
})
