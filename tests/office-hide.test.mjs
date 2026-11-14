import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { outputText } = ts.transpileModule(readFileSync(join(root, 'src/lib/office/hide-plan.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const m = { exports: {} }
new Function('module', 'exports', 'require', outputText)(m, m.exports, () => {
  throw new Error('hide-plan.ts must stay import-free')
})
const h = m.exports

const NOW = new Date('2026-11-14T20:00:00Z')
const req = { id: 'sb:1:records', text: 'Acme: acme.com needs Lovable’s code.' }
const ask = { id: 'sr1', stage: 'publish', question: 'Publish Acme’s website?' }

test('hiding is per item and only while it says the same thing', () => {
  const hidden = h.nextHidden({}, { id: req.id, sig: h.requestSig(req), hidden: true }, NOW)
  assert.equal(h.isHidden(hidden, req.id, h.requestSig(req)), true)
  // The bot raises it again with something new: it shows again.
  assert.equal(h.isHidden(hidden, req.id, h.requestSig({ text: 'Acme: connecting acme.com didn’t finish.' })), false)
  // A question at its next step (the same id) shows again.
  const asked = h.nextHidden({}, { id: ask.id, sig: h.approvalSig(ask), hidden: true }, NOW)
  assert.equal(h.isHidden(asked, ask.id, h.approvalSig({ ...ask, stage: 'domain', question: 'Connect acme.com to Acme’s website?' })), false)
})

test('show again removes it; old entries drop off', () => {
  let hidden = h.nextHidden({}, { id: req.id, sig: h.requestSig(req), hidden: true }, NOW)
  hidden = h.nextHidden(hidden, { id: req.id, sig: h.requestSig(req), hidden: false }, NOW)
  assert.deepEqual(hidden, {})
  const old = { gone: { sig: 'r|x', at: '2026-08-01T00:00:00Z' }, recent: { sig: 'r|y', at: '2026-11-10T00:00:00Z' } }
  const next = h.nextHidden(old, { id: ask.id, sig: h.approvalSig(ask), hidden: true }, NOW)
  assert.deepEqual(Object.keys(next).sort(), ['recent', 'sr1'])
})

test('splitHidden keeps order; what’s stored is read safely', () => {
  const hidden = h.nextHidden({}, { id: 'b', sig: 'r|B', hidden: true }, NOW)
  const out = h.splitHidden([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], hidden, h.requestSig)
  assert.deepEqual(out.shown.map((x) => x.id), ['a', 'c'])
  assert.deepEqual(out.hidden.map((x) => x.id), ['b'])
  assert.deepEqual(h.readHiddenMap('not json'), {})
  assert.deepEqual(h.readHiddenMap('[1,2]'), {})
  assert.deepEqual(h.readHiddenMap(JSON.stringify({ a: { sig: 'r|A', at: '2026-11-14T00:00:00Z' }, b: { sig: 3 }, c: { sig: 'r|C', at: 'never' } })), { a: { sig: 'r|A', at: '2026-11-14T00:00:00Z' } })
  assert.deepEqual(h.readHiddenMap(null), {})
})
