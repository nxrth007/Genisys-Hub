import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'

// Load the pure helper module (no Hub deps) by transpiling it in place.
const source = readFileSync(new URL('../src/lib/whop-webhook.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const mod = { exports: {} }
new Function('module', 'exports', 'require', outputText)(mod, mod.exports, createRequire(import.meta.url))
const { verifyWhopSignature, signWhopPayload, extractWhopSignup, payloadShape } = mod.exports

const secret = 'ws_test_0123456789abcdef'
const body = JSON.stringify({ type: 'membership.activated', data: { id: 'mem_1' } })
const ts0 = '1786381404'
const sig = `v1,${signWhopPayload(secret, 'msg_1', ts0, body)}`
const base = { secret, body, id: 'msg_1', timestamp: ts0, signature: sig, nowSeconds: Number(ts0) }

test('accepts a valid signature, including among several', () => {
  assert.deepEqual(verifyWhopSignature(base), { ok: true })
  assert.deepEqual(verifyWhopSignature({ ...base, signature: `v1,bogus ${sig}` }), { ok: true })
})

test('rejects tampering, wrong secret, missing headers, stale timestamps', () => {
  assert.equal(verifyWhopSignature({ ...base, body: body + ' ' }).ok, false)
  assert.equal(verifyWhopSignature({ ...base, secret: 'ws_other' }).ok, false)
  assert.equal(verifyWhopSignature({ ...base, signature: null }).reason, 'missing_headers')
  assert.equal(verifyWhopSignature({ ...base, nowSeconds: Number(ts0) + 301 }).reason, 'timestamp_out_of_range')
  assert.equal(verifyWhopSignature({ ...base, signature: sig.replace('v1,', 'v2,') }).ok, false)
})

test('matches the Standard Webhooks key derivation used by @whop/sdk', async () => {
  // @whop/sdk: new Webhook(btoa(utf8(secret))) → key = utf8 bytes of the ws_ secret.
  const { createHmac } = await import('node:crypto')
  const expected = createHmac('sha256', Buffer.from(Buffer.from(secret).toString('base64'), 'base64')).update(`msg_1.${ts0}.${body}`).digest('base64')
  assert.equal(sig, `v1,${expected}`)
})

test('extracts a membership.activated payload with custom field answers', () => {
  const r = extractWhopSignup({
    id: 'mem_abc',
    user: { id: 'user_1', username: 'jdoe', name: null, email: 'JD@Example.com' },
    product: { title: 'Genisys Growth' },
    custom_field_responses: [
      { question: 'Full Name', answer: 'Jane Doe' },
      { question: 'Phone number', answer: '(555) 123-4567' },
      { question: 'Business Name', answer: 'Doe Solar' },
    ],
  })
  assert.deepEqual(r, { membershipId: 'mem_abc', userId: 'user_1', email: 'jd@example.com', name: 'Jane Doe', username: 'jdoe', phone: '(555) 123-4567', businessName: 'Doe Solar', productTitle: 'Genisys Growth' })
})

test('tolerates missing / odd shapes', () => {
  const r = extractWhopSignup({ membership_id: 'mem_x', member: { user: { id: 'u', email: 'a@b.co' } }, custom_fields: { 'Company name': 'Acme' } })
  assert.equal(r.membershipId, 'mem_x')
  assert.equal(r.email, 'a@b.co')
  assert.equal(r.businessName, 'Acme')
  assert.equal(extractWhopSignup(null).email, null)
  assert.deepEqual(payloadShape({ a: 'secret', b: [{ c: 1 }] }), { a: 'string', b: [{ c: 'number' }] })
})
