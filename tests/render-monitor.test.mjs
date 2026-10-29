import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/render-monitor.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const m = { exports: {} }
const req = createRequire(import.meta.url)
runInThisContext(`(function(require, module, exports) {${outputText}\n})`)((id) => { if (id === 'node:crypto') return req(id); throw new Error('no deps') }, m, m.exports)
const { runRenderMonitor, normalizeMessage, fingerprint, HOUR, MAX_TEXTS_PER_HOUR } = m.exports

const SVC = { id: 'srv-1', name: 'genisys-hub', ownerId: 'tea-1', suspended: 'not_suspended' }
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

function harness({ deploys = [], logs = [], healthOk = true, services = [{ service: SVC }] } = {}) {
  let t = Date.parse('2026-10-28T12:00:00Z')
  let state = null
  const texts = []
  const calls = []
  const r = { deploys, logs, healthOk, services }
  const deps = {
    apiKey: 'test-key', serviceName: 'genisys-hub', healthUrl: 'https://hub.test/api/health', windowMinutes: 10,
    now: () => t,
    fetch: async (url) => {
      calls.push(url)
      if (url === deps.healthUrl) { if (!r.healthOk) throw new Error('down'); return json({ ok: true }) }
      const u = new URL(url)
      if (u.pathname === '/v1/services') return json(r.services)
      if (u.pathname === '/v1/services/srv-1/deploys') return json(r.deploys)
      if (u.pathname === '/v1/logs') { assert.equal(u.searchParams.get('level'), 'error'); assert.equal(u.searchParams.get('resource'), 'srv-1'); return json({ logs: r.logs }) }
      return json({}, 404)
    },
    loadState: async () => (state ? JSON.parse(JSON.stringify(state)) : null),
    saveState: async (s) => { state = s },
    sendText: async (x) => { texts.push(x); return true },
  }
  return { deps, texts, calls, r, advance: (ms) => { t += ms }, iso: () => new Date(t).toISOString() }
}

test('normalizes away numbers and ids so repeats share a fingerprint', () => {
  assert.equal(normalizeMessage('Timeout after 3012ms for client cmabc123def456ghi789jkl0'), normalizeMessage('Timeout after 15ms for client cmzzz999yyy888xxx777www6'))
  assert.equal(fingerprint('log', 'a 1'), fingerprint('log', 'a 2'))
  assert.notEqual(fingerprint('log', 'a'), fingerprint('deploy', 'a'))
})

test('healthy service: no texts', async () => {
  const h = harness()
  const r = await runRenderMonitor(h.deps)
  assert.equal(r.problems.length, 0)
  assert.equal(h.texts.length, 0)
})

test('failed deploy alerts once, not again next run', async () => {
  const h = harness({ deploys: [{ deploy: { id: 'dep-1', status: 'build_failed', createdAt: '2026-10-28T11:55:00Z', finishedAt: '2026-10-28T11:58:00Z', commit: { id: 'abcdef123', message: 'Break it' } } }] })
  await runRenderMonitor(h.deps)
  assert.equal(h.texts.length, 1)
  assert.match(h.texts[0], /build failed.*abcdef1/)
  h.advance(5 * 60_000)
  await runRenderMonitor(h.deps)
  assert.equal(h.texts.length, 1)
})

test('same error repeated: one alert per hour, then an hourly digest with the count', async () => {
  const h = harness({ logs: [{ message: 'TypeError at row 1', timestamp: '2026-10-28T11:59:00Z' }, { message: 'TypeError at row 2', timestamp: '2026-10-28T11:59:30Z' }] })
  await runRenderMonitor(h.deps)
  assert.equal(h.texts.length, 1, 'two lines, same fingerprint → one alert')
  for (let i = 0; i < 3; i++) { h.advance(5 * 60_000); await runRenderMonitor(h.deps) }
  assert.equal(h.texts.length, 2, 'first held repeat triggers the first digest')
  assert.match(h.texts[1], /digest.*×1/)
  for (let i = 0; i < 4; i++) { h.advance(5 * 60_000); await runRenderMonitor(h.deps) }
  assert.equal(h.texts.length, 2, 'no more texts within the hour')
  h.advance(HOUR)
  await runRenderMonitor(h.deps)
  assert.ok(h.texts.some((t, i) => i >= 2 && /alert/.test(t)), 're-alerts after an hour')
})

test('distinct errors in one run are batched into one text', async () => {
  const h = harness({ logs: [{ message: 'DB down', timestamp: '2026-10-28T11:59:00Z' }, { message: 'Slack failed', timestamp: '2026-10-28T11:59:00Z' }] })
  const r = await runRenderMonitor(h.deps)
  assert.equal(r.problems.length, 2)
  assert.equal(h.texts.length, 1)
  assert.match(h.texts[0], /DB down[\s\S]*Slack failed/)
})

test('heartbeat: alerts only after two misses in a row', async () => {
  const h = harness({ healthOk: false })
  await runRenderMonitor(h.deps)
  assert.equal(h.texts.length, 0)
  h.advance(5 * 60_000)
  await runRenderMonitor(h.deps)
  assert.equal(h.texts.length, 1)
  assert.match(h.texts[0], /health check failing/)
})

test('dry run sends and saves nothing', async () => {
  const h = harness({ logs: [{ message: 'boom', timestamp: '2026-10-28T11:59:00Z' }] })
  const r = await runRenderMonitor(h.deps, { dryRun: true })
  assert.equal(r.texts.length, 1)
  assert.equal(h.texts.length, 0)
  const again = await runRenderMonitor(h.deps, { dryRun: true })
  assert.equal(again.texts.length, 1, 'state was not saved')
})

test('Render API errors become one throttled monitor alert, never a throw', async () => {
  const h = harness()
  h.deps.fetch = async (url) => (url === h.deps.healthUrl ? json({ ok: true }) : json({}, 401))
  const r = await runRenderMonitor(h.deps)
  assert.equal(r.problems[0].kind, 'monitor')
  assert.doesNotMatch(h.texts[0], /test-key/)
})

test('global cap on texts per hour', async () => {
  const h = harness()
  let n = 0
  h.deps.fetch = async (url) => {
    if (url === h.deps.healthUrl) return json({ ok: true })
    const u = new URL(url)
    if (u.pathname === '/v1/services') return json([{ service: SVC }])
    if (u.pathname === '/v1/logs') return json({ logs: [{ message: `unique error ${'x'.repeat(++n)}`, timestamp: '2026-10-28T11:59:00Z' }] })
    return json([])
  }
  for (let i = 0; i < 12; i++) { await runRenderMonitor(h.deps); h.advance(60_000) }
  assert.equal(h.texts.length, MAX_TEXTS_PER_HOUR)
})

test('suspended service and missing service are reported', async () => {
  const h = harness({ services: [{ service: { ...SVC, suspended: 'suspended' } }] })
  assert.ok((await runRenderMonitor(h.deps)).problems.some((p) => p.kind === 'service'))
  const h2 = harness({ services: [] })
  assert.ok((await runRenderMonitor(h2.deps)).problems.some((p) => /not found/.test(p.summary)))
})
