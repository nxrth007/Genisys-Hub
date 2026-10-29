import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// Transpile a src module with its requires replaced by the given stubs.
function load(path, stubs) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const m = { exports: {} }
  const req = (name) => {
    if (name in stubs) return stubs[name]
    // Anything else must never be touched while paused.
    return new Proxy({}, { get: (_t, k) => (k === '__esModule' ? false : () => { throw new Error(`called ${name}.${String(k)} while paused`) }) })
  }
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename: path })(req, m, m.exports)
  return m.exports
}

const { envFlagOn } = load('lib/seo/pause-env.ts', {})

test('SEO_PAUSED parsing: on values', () => {
  for (const v of ['1', 'true', 'TRUE', ' on ', 'Yes', 'enabled']) assert.equal(envFlagOn(v), true, v)
})

test('SEO_PAUSED parsing: off values', () => {
  for (const v of [undefined, null, '', '0', 'false', 'off', 'no', 'paused?']) assert.equal(envFlagOn(v), false, String(v))
})

class SeoPausedError extends Error {}
const pausedStub = (paused) => ({ seoPaused: async () => paused, SeoPausedError })

test('runSeoTick short-circuits when paused (no DB, LLM or GitHub calls)', async () => {
  delete globalThis.__seoTickInFlight
  const engine = load('lib/seo/engine.ts', { './pause': pausedStub(true) })
  assert.deepEqual(await engine.runSeoTick(), { enqueued: 0, advanced: 0, failed: 0 })
})

test('enqueueManualRun rejects with SeoPausedError when paused', async () => {
  const engine = load('lib/seo/engine.ts', { './pause': pausedStub(true) })
  await assert.rejects(engine.enqueueManualRun('site1', 'weekly'), SeoPausedError)
})

test('not paused: the tick goes on to the real work', async () => {
  delete globalThis.__seoTickInFlight
  const engine = load('lib/seo/engine.ts', { './pause': pausedStub(false) })
  await assert.rejects(engine.runSeoTick(), /called .* while paused/)
})
