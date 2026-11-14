import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// What Forge does when Lovable pauses a website build (src/lib/hl/site-pause.ts):
// what it may answer from the brief, what waits for a person, and Lovable's own
// message after a copy (Cnc transportation, 2026-11-14).

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/lib/hl/site-pause.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const m = { exports: {} }
new Function('module', 'exports', 'require', outputText)(m, m.exports, () => {
  throw new Error('site-pause.ts must stay import-free')
})
const p = m.exports
const NOW = new Date('2026-11-14T18:00:00.000Z')

// Lovable's question card, as a JSON schema: one radio question with described options.
const nextStep = {
  event_id: 'evt_1',
  tool_id: 'ask_questions',
  input_schema: {
    type: 'object',
    required: ['next'],
    properties: {
      next: {
        type: 'string',
        title: 'Which should I tackle next?',
        oneOf: [
          { const: 'Set the live domain', description: 'Give me the real web address' },
          { const: 'Clear out leftovers', description: 'Delete unused photos' },
        ],
      },
    },
  },
}

test('questionsOf: options from enum, oneOf or a questions list; several picks from an array', () => {
  const q = p.questionsOf(nextStep.input_schema, null)
  assert.equal(q.length, 1)
  assert.equal(q[0].key, 'next')
  assert.equal(q[0].text, 'Which should I tackle next?')
  assert.deepEqual(q[0].options.map((o) => o.label), ['Set the live domain', 'Clear out leftovers'])
  assert.equal(q[0].options[0].description, 'Give me the real web address')
  assert.equal(q[0].required, true)
  assert.equal(q[0].multi, false)
  const multi = p.questionsOf({ properties: { pages: { type: 'array', description: 'Which pages?', items: { enum: ['Home', 'About'] } } } }, null)
  assert.equal(multi[0].multi, true)
  assert.deepEqual(multi[0].options.map((o) => o.label), ['Home', 'About'])
  const typed = p.questionsOf({ properties: { name: { type: 'string', description: 'Business name?' } } }, null)
  assert.equal(typed[0].typed, true)
  assert.equal(typed[0].options.length, 0)
  const fromParams = p.questionsOf({}, { questions: [{ question: 'Keep the gallery?', options: [{ label: 'Yes' }, { label: 'No' }] }] })
  assert.equal(fromParams[0].text, 'Keep the gallery?')
  assert.deepEqual(fromParams[0].options.map((o) => o.label), ['Yes', 'No'])
})

test('readPause: questions, a tool, and what only Lovable’s editor can answer', () => {
  assert.equal(p.readPause(nextStep, 'All done.', NOW).kind, 'questions')
  assert.equal(p.readPause({ event_id: 'e', tool_id: 'run_migration', params: { sql: 'x' } }, null, NOW).kind, 'tool')
  const secret = p.readPause({ event_id: 'e', tool_id: 'add_secret', requires_secure_form: true }, null, NOW)
  assert.equal(secret.kind, 'editor')
  assert.match(secret.editorWhy, /secret/)
  assert.equal(p.readPause({ event_id: 'e', tool_id: 'credit_checkin' }, null, NOW).kind, 'editor')
  assert.equal(p.readPause(null, null, NOW).kind, 'editor')
  assert.equal(p.pauseAnswerableInHub(p.readPause(nextStep, null, NOW)), true)
  assert.equal(p.pauseAnswerableInHub(secret), false)
  assert.equal(p.pauseAnswerableInHub(null), false)
})

test('forgeResponse: only what the brief settles, an offered extra declined, everything else to a person', () => {
  const pause = p.readPause(nextStep, 'Done with the brief.', NOW)
  assert.equal(p.forgeMayAnswer(pause), true)
  // Extra work offered once the brief is done: no, that's all.
  const done = p.forgeResponse(pause, { verdict: 'brief_done', answers: {}, briefLine: '', why: 'x' })
  assert.equal(done.decision, 'rejected')
  // The brief settles it: an option Lovable offered, quoted from the brief.
  const settled = p.forgeResponse(pause, { verdict: 'brief_settles', answers: { next: 'Clear out leftovers' }, briefLine: 'keep what the template already has', why: 'x' })
  assert.deepEqual(settled, { decision: 'approved', userInput: { next: 'Clear out leftovers' } })
  // No brief line, an option it didn't offer, or a person's verdict: no answer from Forge.
  assert.equal(p.forgeResponse(pause, { verdict: 'brief_settles', answers: { next: 'Clear out leftovers' }, briefLine: ' ', why: 'x' }), null)
  assert.equal(p.forgeResponse(pause, { verdict: 'brief_settles', answers: { next: 'Buy credits' }, briefLine: 'b', why: 'x' }), null)
  assert.equal(p.forgeResponse(pause, { verdict: 'person', answers: { next: 'Clear out leftovers' }, briefLine: 'b', why: 'x' }), null)
  // A required question left unanswered: a person.
  assert.equal(p.forgeResponse(pause, { verdict: 'brief_settles', answers: {}, briefLine: 'b', why: 'x' }), null)
  // Forge never answers a tool approval or an editor-only pause.
  const tool = p.readPause({ event_id: 'e', tool_id: 'run_migration' }, null, NOW)
  assert.equal(p.forgeMayAnswer(tool), false)
  assert.equal(p.forgeResponse(tool, { verdict: 'brief_done', answers: {}, briefLine: '', why: 'x' }), null)
})

test('personResponse: a person’s answer from the folder, checked against the questions', () => {
  const pause = p.readPause(nextStep, null, NOW)
  assert.deepEqual(p.personResponse(pause, { decision: 'answer', answers: { next: 'Set the live domain' } }), { decision: 'approved', userInput: { next: 'Set the live domain' } })
  // A person may write their own answer, as Lovable's card allows (Forge never does).
  assert.deepEqual(p.personResponse(pause, { decision: 'answer', answers: { next: 'Nothing for now' } }), { decision: 'approved', userInput: { next: 'Nothing for now' } })
  assert.equal(p.personResponse(pause, { decision: 'answer', answers: {} }), null)
  assert.equal(p.personResponse(pause, { decision: 'answer', answers: { next: ['a', 'b'] } }), null)
  assert.equal(p.personResponse(pause, { decision: 'skip' }).decision, 'rejected')
  // Approve is for a tool only; an editor-only pause can't be answered from the Hub.
  assert.equal(p.personResponse(pause, { decision: 'approve' }), null)
  const tool = p.readPause({ event_id: 'e', tool_id: 'run_migration' }, null, NOW)
  assert.deepEqual(p.personResponse(tool, { decision: 'approve' }), { decision: 'approved' })
  assert.equal(p.personResponse(tool, { decision: 'decline' }).decision, 'rejected')
  assert.equal(p.personResponse(p.readPause(null, null, NOW), { decision: 'skip' }), null)
})

test('isCopyChatTurn: Lovable’s own message in a fresh copy, just before the one-shot', () => {
  // Cnc: the copy's "I've successfully remixed this project…" at 17:44:32, Forge's one-shot at 17:44:36.
  const oneShot = { id: 'umsg_01m7djjg8sfxkvt97c28ebhfwx', createdAt: '2026-11-14T17:44:36Z' }
  const copyChat = { id: 'main:user#00000000000001#usr:MJDC4QKZ', role: 'user', createdAt: '2026-11-14T17:44:32Z' }
  assert.equal(p.isCopyChatTurn(copyChat, oneShot), true)
  // Not the one-shot itself, not Lovable's reply, not one from after it or long before it.
  assert.equal(p.isCopyChatTurn({ ...copyChat, id: oneShot.id }, oneShot), false)
  assert.equal(p.isCopyChatTurn({ ...copyChat, role: 'assistant' }, oneShot), false)
  assert.equal(p.isCopyChatTurn({ ...copyChat, createdAt: '2026-11-14T17:50:00Z' }, oneShot), false)
  assert.equal(p.isCopyChatTurn({ ...copyChat, createdAt: '2026-11-14T16:00:00Z' }, oneShot), false)
  assert.equal(p.isCopyChatTurn({ ...copyChat, createdAt: null }, oneShot), false)
})

test('pauseSummary and answerWords: the question and the answer in words', () => {
  const pause = p.readPause(nextStep, null, NOW)
  assert.equal(p.pauseSummary(pause), 'Which should I tackle next?')
  assert.equal(p.answerWords(pause, { next: 'Clear out leftovers' }), 'Clear out leftovers')
  assert.match(p.pauseSummary(p.readPause({ event_id: 'e', tool_id: 'run_migration' }, null, NOW)), /run_migration/)
})
