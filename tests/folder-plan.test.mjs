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

const folder = loadTs(join(root, 'src/lib/hl/folder-plan.ts'))
const site = loadTs(join(root, 'src/lib/hl/site-plan.ts'))

test('Build site: offered with a Hell-level sub-account, never while Forge works or once the site is live', () => {
  const base = { hasAccount: true, ghlLinked: false, status: null }
  assert.deepEqual(folder.folderBuild(base), { kind: 'build', overrideGhl: false, again: false, answersOffice: false })
  assert.equal(folder.folderBuild({ ...base, hasAccount: false }).kind, 'none')
  // Forge's open question in the Office is answered from the folder, not asked twice.
  assert.deepEqual(folder.folderBuild({ ...base, status: 'awaiting_approval' }), { kind: 'build', overrideGhl: false, again: false, answersOffice: true })
  for (const status of ['filling', 'copying', 'sending', 'building', 'waiting_on_lovable', 'publishing', 'connecting']) {
    assert.deepEqual(folder.folderBuild({ ...base, status }), { kind: 'none', reason: 'Forge is working on it.' }, status)
  }
  for (const status of ['published', 'connected']) assert.equal(folder.folderBuild({ ...base, status }).kind, 'none', status)
  // A copy that exists (built, Not now on publishing, failed) is made again; Not now on building isn't "again".
  for (const status of ['built', 'held', 'failed']) assert.equal(folder.folderBuild({ ...base, status }).again, true, status)
  assert.equal(folder.folderBuild({ ...base, status: 'declined' }).again, false)
  // Set up in GHL: the site gets Hell-level's form and chat, which the person agrees to.
  assert.equal(folder.folderBuild({ ...base, ghlLinked: true }).overrideGhl, true)
})

test('Buy toll-free number: Hell-level only, never over a number they have or one GHL has', () => {
  const base = { hasAccount: true, hasTollFree: false, ghlHasNumber: false, status: null }
  assert.deepEqual(folder.folderNumber(base), { kind: 'buy', answersOffice: false })
  assert.deepEqual(folder.folderNumber({ ...base, status: 'awaiting_approval' }), { kind: 'buy', answersOffice: true })
  for (const status of ['declined', 'failed']) assert.equal(folder.folderNumber({ ...base, status }).kind, 'buy', status)
  assert.equal(folder.folderNumber({ ...base, hasAccount: false }).kind, 'none')
  assert.equal(folder.folderNumber({ ...base, hasTollFree: true }).kind, 'none')
  assert.match(folder.folderNumber({ ...base, ghlHasNumber: true }).reason, /GHL sub-account already has a number/)
  for (const status of ['buying', 'bought', 'awaiting_identity', 'ghl_working']) assert.equal(folder.folderNumber({ ...base, status }).kind, 'none', status)
})

test('Domain: find Porkbun’s three, pick one; nothing over a domain they have or one being bought', () => {
  const choices = [{ name: 'acmeroofing.com', costCents: 1108, renewalCents: 1108 }]
  const base = { hasAccount: true, hasDomain: false, status: null, choices: [], buying: null }
  assert.deepEqual(folder.folderDomain(base), { kind: 'find' })
  assert.deepEqual(folder.folderDomain({ ...base, status: 'awaiting_approval', choices }), { kind: 'choose', choices })
  // An open question with nothing to pick (Porkbun had no name): find again.
  assert.deepEqual(folder.folderDomain({ ...base, status: 'awaiting_approval' }), { kind: 'find' })
  for (const status of ['declined', 'failed']) assert.deepEqual(folder.folderDomain({ ...base, status, choices }), { kind: 'find' }, status)
  assert.deepEqual(folder.folderDomain({ ...base, status: 'buying', buying: 'acmeroofing.com' }), { kind: 'none', reason: 'Buying acmeroofing.com now.' })
  assert.equal(folder.folderDomain({ ...base, hasDomain: true, status: 'awaiting_approval', choices }).kind, 'none')
  assert.equal(folder.folderDomain({ ...base, hasAccount: false }).kind, 'none')
})

test('the build confirmation says what the build would use, pointing at the folder’s own cards', () => {
  const f = { photos: 12, skipped: 1, domain: null, phoneSource: 'business', numberAsked: true, domainAsked: true, missing: [] }
  assert.equal(
    site.siteQuestionDetail(f, 'folder'),
    '12 photos from onboarding (1 other upload left out). No domain yet: the site says “this website” (pick their domain first to put it in). Their own phone goes on the site (buy their toll-free number first to use that).',
  )
  assert.match(site.siteQuestionDetail(f), /answer Forge’s domain question first/, 'the Office keeps its wording')
  assert.equal(site.siteQuestionDetail({ ...f, domain: 'acmeroofing.com', phoneSource: 'toll_free' }, 'folder'), '12 photos from onboarding (1 other upload left out). Domain acmeroofing.com. Their toll-free number goes on the site.')
  assert.match(site.siteQuestionDetail({ ...f, missing: ['email address'] }, 'folder'), /^Can’t build yet: no email address on file/)
})
