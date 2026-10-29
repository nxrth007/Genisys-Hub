import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// Transpile a src module; only relative office deps are resolved (type-only imports vanish).
const cache = {}
function load(path) {
  if (cache[path]) return cache[path]
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const m = { exports: {} }
  const req = (name) => {
    if (name.startsWith('./')) return load(`lib/office/${name.slice(2)}.ts`)
    throw new Error(`Unexpected dependency: ${name}`)
  }
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename: path })(req, m, m.exports)
  cache[path] = m.exports
  return m.exports
}

const mapping = load('lib/office/mapping.ts')
const path = load('lib/office/path.ts')
const layout = load('lib/office/layout.ts')
const { deriveOffice, emptyInput, deriveHandoffs, ROSTER } = mapping

const NOW = new Date('2026-10-28T20:00:00Z')
const ago = (min) => new Date(NOW.getTime() - min * 60_000)
const bot = (s, id) => s.bots.find((b) => b.id === id)
const ev = (id, clientId, stage, toStatus, min, extra = {}) => ({ id, clientId, clientName: `Client ${clientId}`, stage, fromStatus: null, toStatus, note: null, actor: 'system', createdAt: ago(min), ...extra })

test('no data: every bot idle at home, honest empty feed', () => {
  const s = deriveOffice(emptyInput(), NOW)
  assert.equal(s.bots.length, ROSTER.length)
  assert.ok(s.bots.every((b) => b.status === 'idle' && b.icon === null))
  assert.deepEqual(s.activity, [])
  assert.deepEqual(s.handoffs, [])
  assert.equal(s.demo, false)
  assert.equal(s.counts.idle, ROSTER.length)
})

test('journey events map to stage bots with statuses and feed lines', () => {
  const input = emptyInput()
  input.journeyEvents = [ev('e1', 'a', 'subaccount', 'in_progress', 5), ev('e2', 'b', 'website', 'in_progress', 60 * 5)]
  const s = deriveOffice(input, NOW)
  assert.equal(bot(s, 'atlas').status, 'browsing')
  assert.match(bot(s, 'atlas').task, /Client a/)
  assert.equal(bot(s, 'forge').status, 'idle', 'old in_progress event is not live work')
  assert.equal(s.activity.length, 2)
  assert.equal(s.activity[0].botId, 'atlas', 'newest first')
  assert.match(s.activity[0].text, /started GHL sub-account for Client a/)
})

test('blocked stage and match suggestions -> Needs you', () => {
  const input = emptyInput()
  input.openStages = [{ clientId: 'a', clientName: 'Acme', stage: 'website', status: 'blocked', note: 'no domain', updatedAt: ago(300) }]
  input.matchSuggestions = [{ id: 'm1', clientName: 'Beta', locationName: 'Beta LLC', score: 80, status: 'needs_review', createdAt: ago(90), updatedAt: ago(90) }]
  const s = deriveOffice(input, NOW)
  assert.equal(bot(s, 'forge').status, 'needs_you')
  assert.match(bot(s, 'forge').task, /no domain/)
  assert.equal(bot(s, 'atlas').status, 'needs_you')
  assert.equal(bot(s, 'alfred').status, 'thinking')
  assert.match(bot(s, 'alfred').task, /Triaging 2/)
})

test('SEO runs: running -> coding/terminal, failed or blocked -> error', () => {
  const run = (o) => ({ id: 'r', siteName: 'x.com', status: 'running', stage: 'write', error: null, startedAt: ago(3), finishedAt: null, createdAt: ago(3), updatedAt: ago(1), ...o })
  let input = emptyInput()
  input.seoRuns = [run({})]
  assert.equal(bot(deriveOffice(input, NOW), 'scout').status, 'coding')
  input.seoRuns = [run({ stage: 'ship' })]
  assert.equal(bot(deriveOffice(input, NOW), 'scout').status, 'terminal')
  input.seoRuns = [run({ id: 'r2', status: 'done', stage: 'research', error: 'blocked: LLM key missing', finishedAt: ago(30), updatedAt: ago(30) })]
  const s = deriveOffice(input, NOW)
  assert.equal(bot(s, 'scout').status, 'error')
  assert.equal(s.activity[0].tone, 'error')
  // Error outranks a concurrent running run.
  input.seoRuns = [run({}), run({ id: 'r3', status: 'failed', finishedAt: ago(10), updatedAt: ago(10) })]
  assert.equal(bot(deriveOffice(input, NOW), 'scout').status, 'error')
})

test('intakes, whop claims, a2p and render monitor', () => {
  const input = emptyInput()
  input.intakes = [{ id: 'i', receivedAt: ago(2), status: 'new', name: 'Gamma' }]
  input.whopClaims = [{ membershipId: 'mem_1', source: 'webhook', claimedAt: ago(4) }]
  input.a2p = [{ id: 'a', accountName: 'Delta', stage: 'brand_pending', note: null, updatedAt: ago(1) }]
  input.render = { enabled: true, heartbeatFailures: 2, openProblems: 0, lastDigestAt: null }
  const s = deriveOffice(input, NOW)
  assert.equal(bot(s, 'ivy').status, 'coding')
  assert.equal(bot(s, 'ivy').icon, 'folder')
  assert.equal(bot(s, 'wren').status, 'browsing')
  assert.equal(bot(s, 'echo').status, 'terminal')
  assert.equal(bot(s, 'sentinel').status, 'error')
  input.render = { enabled: false, heartbeatFailures: 0, openProblems: 0, lastDigestAt: null }
  assert.equal(bot(deriveOffice(input, NOW), 'sentinel').status, 'idle')
})

test('handoffs come from consecutive stages of the same client', () => {
  const events = [
    ev('1', 'a', 'intake', 'done', 5),
    ev('2', 'a', 'subaccount', 'in_progress', 5),
    ev('3', 'b', 'intake', 'done', 4), // different client, no next stage yet
    ev('4', 'c', 'signup', 'done', 200), // too old
    ev('5', 'c', 'intake', 'in_progress', 199),
  ]
  const hs = deriveHandoffs(events, NOW)
  assert.equal(hs.length, 1)
  assert.equal(hs[0].from, 'ivy')
  assert.equal(hs[0].to, 'atlas')
  const s = deriveOffice({ ...emptyInput(), journeyEvents: events }, NOW)
  assert.equal(bot(s, 'alfred').status, 'browsing')
  assert.match(bot(s, 'alfred').task, /Ivy → Atlas/)
  assert.ok(s.activity.some((a) => a.botId === 'alfred' && /Handed Client a from Ivy to Atlas/.test(a.text)))
})

test('mapping is deterministic', () => {
  const input = emptyInput()
  input.journeyEvents = [ev('1', 'a', 'intake', 'done', 5), ev('2', 'a', 'subaccount', 'in_progress', 5)]
  assert.deepEqual(deriveOffice(input, NOW), deriveOffice(input, NOW))
})

test('demo state is labelled as sample data', () => {
  const demo = (() => {
    const source = readFileSync(new URL('../src/lib/office/demo.ts', import.meta.url), 'utf8')
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    const m = { exports: {} }
    runInThisContext(`(function(require, module, exports) {${outputText}\n})`)((n) => (n === './mapping' ? mapping : null), m, m.exports)
    return m.exports
  })()
  const s = demo.demoState(NOW)
  assert.equal(s.demo, true)
  assert.ok(s.activity.length > 0)
})

// ---------- pathfinding ----------

const open = (w, h, walls = []) => ({ width: w, height: h, blocked: (x, y) => walls.some((c) => c.x === x && c.y === y) })
const axisAligned = (p) => p.every((c, i) => i === 0 || Math.abs(c.x - p[i - 1].x) + Math.abs(c.y - p[i - 1].y) === 1)

test('findPath: shortest, axis-aligned, avoids walls', () => {
  const g = open(5, 5, [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }])
  const p = path.findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 })
  assert.ok(p)
  assert.ok(axisAligned(p))
  assert.equal(p.length - 1, 12)
  assert.ok(!p.some((c) => g.blocked(c.x, c.y)))
})

test('findPath: unreachable -> null, same cell -> [start]', () => {
  const g = open(3, 3, [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }])
  assert.equal(path.findPath(g, { x: 0, y: 0 }, { x: 2, y: 2 }), null)
  assert.deepEqual(path.findPath(g, { x: 0, y: 0 }, { x: 0, y: 0 }), [{ x: 0, y: 0 }])
})

test('findPath prefers few turns; corners() keeps only turns', () => {
  const p = path.findPath(open(6, 6), { x: 0, y: 0 }, { x: 5, y: 5 })
  const c = path.corners(p)
  assert.equal(c.length, 3, 'one 90-degree turn')
  assert.equal(path.pathLength(c), 10)
  assert.deepEqual(path.pointAlong(c, 0), { x: 0, y: 0 })
  assert.deepEqual(path.pointAlong(c, 10), { x: 5, y: 5 })
  const mid = path.pointAlong(c, 7.5)
  assert.ok(mid.x === 5 || mid.y === 0 || mid.x === 0 || mid.y === 5)
})

test('office layout: every seat and spot is walkable and mutually reachable', () => {
  const spots = [...layout.DESKS.map((d) => d.seat), ...layout.IDLE_SPOTS, layout.COS_VISIT, ...layout.MEETING_SPOTS]
  for (const s of spots) assert.ok(!layout.GRID.blocked(s.x, s.y), `spot ${s.x},${s.y} is blocked`)
  for (const a of spots) for (const b of spots) assert.ok(path.findPath(layout.GRID, a, b), `no path ${a.x},${a.y} -> ${b.x},${b.y}`)
  assert.equal(layout.DESKS.length, 10)
  assert.ok(layout.DESKS.length >= ROSTER.length)
})

test('botDepth: seated bots sort after desks in front, before desks behind', () => {
  const { DESKS, botDepth, itemDepth } = layout
  for (const d of DESKS) {
    const pos = { x: d.seat.x + 0.5, y: d.seat.y + 0.5 }
    const front = d.seat.y >= d.item.y + d.item.d
    if (front) assert.ok(botDepth(pos) > itemDepth(d.item), `${d.id}: bot in front must draw after desk`)
    else assert.ok(botDepth(pos) < itemDepth(d.item), `${d.id}: bot behind must draw before desk (head is overlaid)`)
  }
})

test('botDepth helper: plain depth away from desks, lifted just past a desk behind it', () => {
  const { botDepth, itemDepth, DESKS } = layout
  const pos = { x: 3.5, y: 12.5 }
  assert.equal(botDepth(pos), 3.5 + 12.5 - 1 + 0.1)
  const cos = DESKS.find((d) => d.id === 'desk-cos')
  assert.equal(botDepth({ x: 2.5, y: 2.5 }), itemDepth(cos.item) + 0.01)
  assert.equal(botDepth({ x: 2.5, y: 2.5 }, []), 2.5 + 2.5 - 1 + 0.1)
})
