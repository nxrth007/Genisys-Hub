import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

// Tiny CommonJS loader for the self-contained src/lib/llm modules.
const cache = new Map()
function load(name) {
  if (cache.has(name)) return cache.get(name).exports
  const src = readFileSync(new URL(`../src/lib/llm/${name}.ts`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const m = { exports: {} }
  cache.set(name, m)
  new Function('module', 'exports', 'require', outputText)(m, m.exports, (p) => load(p.replace(/^\.\//, '')))
  return m.exports
}
const { AnthropicLlm, OpenAiCompatibleLlm, selectProvider, buildClient, LlmKeyBlockedError, isKeyBlocked, blockedReason, BASE_URLS } = {
  ...load('types'), ...load('anthropic'), ...load('openai'), ...load('select'),
}

function mockFetch(status, body) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return { ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
  }
  fn.calls = calls
  return fn
}

test('anthropic adapter: request shape and parse', async () => {
  const f = mockFetch(200, { model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 10, output_tokens: 5 } })
  const c = new AnthropicLlm('k-test', 'claude-x', 'https://api.anthropic.com', f)
  const r = await c.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, json: { schema: { type: 'object' } } })
  assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(f.calls[0].init.headers['x-api-key'], 'k-test')
  assert.equal(f.calls[0].body.system, 'sys')
  assert.deepEqual(f.calls[0].body.output_config.format.type, 'json_schema')
  assert.equal(r.text, '{"a":1}')
  assert.equal(r.stopReason, 'end')
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 })
})

test('openai-compatible adapter: xai baseUrl, system message, json schema', async () => {
  const f = mockFetch(200, { model: 'grok-4-fast', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } })
  const c = new OpenAiCompatibleLlm('xai', 'xk', 'grok-4-fast', BASE_URLS.xai, f)
  const r = await c.complete({ system: 'S', messages: [{ role: 'user', content: 'U' }], maxTokens: 50, json: { schema: { type: 'object' }, name: 'r' } })
  assert.equal(f.calls[0].url, 'https://api.x.ai/v1/chat/completions')
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer xk')
  assert.deepEqual(f.calls[0].body.messages[0], { role: 'system', content: 'S' })
  assert.equal(f.calls[0].body.response_format.type, 'json_schema')
  assert.equal(r.text, '{"ok":true}')
  assert.equal(r.stopReason, 'end')
  assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 3 })
})

test('openai adapter maps length to max_tokens', async () => {
  const f = mockFetch(200, { choices: [{ finish_reason: 'length', message: { content: 'x' } }] })
  const r = await new OpenAiCompatibleLlm('openai', 'k', 'gpt-5-mini', BASE_URLS.openai, f).complete({ system: '', messages: [], maxTokens: 1 })
  assert.equal(r.stopReason, 'max_tokens')
})

test('provider selection: nothing set keeps anthropic default', () => {
  assert.deepEqual(selectProvider({ provider: null, model: null, baseUrl: null, keys: {} }), { provider: 'anthropic', model: null, explicit: false })
  assert.equal(selectProvider({ provider: 'bogus', model: null, baseUrl: null, keys: {} }).provider, 'anthropic')
  assert.deepEqual(selectProvider({ provider: 'Grok', model: null, baseUrl: null, keys: {} }), { provider: 'xai', model: 'grok-4-fast', explicit: true })
  assert.deepEqual(selectProvider({ provider: 'openai', model: 'gpt-5', baseUrl: null, keys: {} }), { provider: 'openai', model: 'gpt-5', explicit: true })
})

test('buildClient picks adapter and fallback model; missing key is blocked', () => {
  const a = buildClient({ provider: null, model: null, baseUrl: null, keys: { anthropic: 'sk-ant-x' } }, 'claude-opus-5-5')
  assert.equal(a.provider, 'anthropic')
  assert.equal(a.model, 'claude-opus-5-5')
  const x = buildClient({ provider: 'xai', model: null, baseUrl: null, keys: { xai: 'xai-1' } }, 'claude-opus-5-5')
  assert.equal(x.provider, 'xai')
  assert.equal(x.model, 'grok-4-fast')
  assert.throws(() => buildClient({ provider: 'openai', model: null, baseUrl: null, keys: {} }, 'm'), (e) => isKeyBlocked(e) && /blocked: LLM key \(openai\)/.test(e.message))
})

test('blocked failure mode: 401/402/429-billing are blocked, plain 429/500 are not', async () => {
  for (const [status, body] of [[401, 'bad key'], [402, ''], [429, '{"error":{"code":"insufficient_quota"}}'], [400, 'Your credit balance is too low']]) {
    const c = new OpenAiCompatibleLlm('openai', 'k', 'm', BASE_URLS.openai, mockFetch(status, body))
    await assert.rejects(c.complete({ system: '', messages: [], maxTokens: 1 }), (e) => e instanceof LlmKeyBlockedError && e.message.startsWith('blocked: LLM key'))
  }
  const an = new AnthropicLlm('k', 'm', undefined, mockFetch(401, '{}'))
  await assert.rejects(an.complete({ system: '', messages: [], maxTokens: 1 }), (e) => isKeyBlocked(e))
  assert.equal(blockedReason(429, 'rate limit exceeded, slow down'), null)
  assert.equal(blockedReason(500, 'oops'), null)
  const c = new OpenAiCompatibleLlm('openai', 'k', 'm', BASE_URLS.openai, mockFetch(429, 'Rate limit reached'))
  await assert.rejects(c.complete({ system: '', messages: [], maxTokens: 1 }), (e) => !isKeyBlocked(e) && e.status === 429)
})
