import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// The kit's opt-out workflow (src/lib/hl/optout-kit.ts): texting goes off only on a plain opt-out reply,
// never because "no" or "stop" appears in an ordinary one (Alex, 2026-11-24).

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

const { replyMatches } = loadTs(join(root, 'src/lib/hl/reply-match.ts'))
const { OPTOUT_REPLIES, OPTOUT_TRIGGER_ID, optoutReplyTrigger, patchOptoutTriggers } = loadTs(join(root, 'src/lib/hl/optout-kit.ts'))

const trigger = optoutReplyTrigger()
const optsOut = (text) => replyMatches(text, trigger.keywords, trigger.match)
const snapshot = { id: OPTOUT_TRIGGER_ID, name: 'Customer Replied', type: 'inbound_sms', keywords: ['not interested', 'no', 'stop'], match: 'contains' }
const stageTrigger = { id: 'kit_optout_stage', name: 'Opportunity Changed', type: 'opportunity_stage', active: false }

test('ordinary replies with "no" or "stop" in them leave texting on', () => {
  for (const reply of ['No problem, see you Tuesday', 'Yes, no rush', 'No, Thursday works better', 'Can you stop by Thursday?', 'I know', 'no worries!', 'Not interested in the deck, just the fence'])
    assert.equal(optsOut(reply), false, reply)
})

test('a plain opt-out still switches texting off', () => {
  for (const reply of ['No', 'no.', 'NO!!', 'Nope', 'No thanks', 'no, thank you', 'Not interested.', '"STOP"', 'stop'])
    assert.equal(optsOut(reply), true, reply)
})

test('the snapshot rule caught "No problem": the bug this fixes', () => {
  assert.equal(replyMatches('No problem, see you Tuesday', snapshot.keywords, snapshot.match), true)
  assert.equal(replyMatches('Can you stop by Thursday?', snapshot.keywords, snapshot.match), true)
})

test('an existing workflow: the snapshot trigger is replaced, the stage trigger kept', () => {
  const p = patchOptoutTriggers([stageTrigger, snapshot])
  assert.equal(p.changed, true)
  assert.deepEqual(p.value[0], stageTrigger)
  assert.equal(p.value[1].id, OPTOUT_TRIGGER_ID)
  assert.equal(p.value[1].match, 'exact')
  assert.deepEqual(p.value[1].keywords, OPTOUT_REPLIES)
  assert.equal(p.value[1].active, undefined)
})

test('a switched-off reply trigger stays switched off; an updated one is left alone', () => {
  assert.equal(patchOptoutTriggers([stageTrigger, { ...snapshot, active: false }]).value[1].active, false)
  const again = patchOptoutTriggers(patchOptoutTriggers([stageTrigger, snapshot]).value)
  assert.equal(again.changed, false)
  assert.equal(again.note, 'already up to date')
})

test('words someone changed by hand, or a rebuilt workflow, are left as they are', () => {
  const custom = patchOptoutTriggers([stageTrigger, { ...snapshot, keywords: ['no', 'stop', 'unsubscribe'] }])
  assert.equal(custom.changed, false)
  assert.match(custom.note, /changed by hand/)
  assert.equal(patchOptoutTriggers([stageTrigger]).changed, false)
})
