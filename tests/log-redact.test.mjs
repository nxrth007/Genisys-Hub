import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const src = readFileSync(new URL('../src/lib/log-redact.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const m = { exports: {} }
new Function('module', 'exports', outputText)(m, m.exports)
const { redactSecrets } = m.exports

test('redacts bearer tokens and known prefixes', () => {
  const out = redactSecrets('[whop-webhook] auth Bearer abcdefghijklmnop key rnd_ABCDEF123456 ghub_0123456789abcdef')
  assert.ok(!out.includes('abcdefghijklmnop'))
  assert.ok(!out.includes('rnd_ABCDEF123456'))
  assert.ok(!out.includes('ghub_0123456789abcdef'))
  assert.ok(out.startsWith('[whop-webhook]'))
})

test('redacts key=value secrets but keeps the label', () => {
  const out = redactSecrets('api_key=supersecretvalue token: "zzzzzzzzzz"')
  assert.ok(!out.includes('supersecretvalue'))
  assert.ok(!out.includes('zzzzzzzzzz'))
  assert.match(out, /api_key=\[REDACTED\]/)
})

test('leaves ordinary lines alone', () => {
  const line = '[whop-webhook] payment.succeeded mem_123 processed in 42ms'
  assert.equal(redactSecrets(line), line)
})
