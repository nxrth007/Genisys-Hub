import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// Google's verdict on a client's site (src/lib/seo/google-verdict.ts), with real records from 2026-11-24.

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
    return localRequire(id)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  cache.set(absPath, m.exports)
  return m.exports
}

const v = loadTs(join(root, 'src/lib/seo/google-verdict.ts'))

const NOW = new Date('2026-11-24T12:00:00Z')
const DAY = 86_400_000
const ago = (n) => new Date(NOW.getTime() - n * DAY).toISOString()
const insp = (url, verdict, coverageState, googleCanonical = null, userCanonical = null, lastCrawlTime = '2026-11-23T00:00:00Z') => ({ url, verdict, coverageState, googleCanonical, userCanonical, lastCrawlTime })
const health = (home, over = {}) => JSON.stringify({ checkedAt: '2026-11-24T05:18:09Z', sites: [{ siteId: 's1', property: 'https://acme.org/', home, ...over }] })
const stored = (json) => v.storedSites(json).get('s1') ?? null
const verdict = (over = {}) =>
  v.googleVerdict({
    liveUrl: 'https://acme.org',
    property: 'https://acme.org/',
    stored: stored(over.healthJson === undefined ? health(null) : over.healthJson),
    connectWhy: over.connectJson ? (v.connectReasons(over.connectJson).get('s1') ?? null) : null,
    connectedAt: ago(10),
    now: NOW,
    ...(({ healthJson, connectJson, ...rest }) => rest)(over),
  })

test('indexed: the homepage is on Google at its own address', () => {
  const r = verdict({ healthJson: health(insp('https://acme.org/', 'PASS', 'Submitted and indexed', 'https://acme.org/', 'https://acme.org/')) })
  assert.equal(r.state, 'indexed')
  assert.equal(r.tone, 'good')
  assert.equal(r.flagged, false)
  assert.equal(r.lastLooked, '2026-11-23T00:00:00Z')
  assert.equal(r.checkedAt, '2026-11-24T05:18:09Z')
})

test('Google filing the homepage under the www spelling is settling, never flagged', () => {
  for (const [google, user, state] of [
    ['https://www.acme.org/', null, 'Duplicate without user-selected canonical'],
    ['https://www.acme.org/', 'https://acme.org/', 'Duplicate, Google chose different canonical than user'],
    ['https://www.acme.org/', 'https://acme.com/', 'Alternate page with proper canonical tag'],
  ]) {
    const r = verdict({ healthJson: health(insp('https://acme.org/', 'NEUTRAL', state, google, user)), connectedAt: ago(45) })
    assert.equal(r.state, 'settling', state)
    assert.equal(r.flagged, false, state)
    assert.match(r.text, /www\.acme\.org/)
  }
  // Protech's record: Google's address is ours, its status still says duplicate.
  const r = verdict({ healthJson: health(insp('https://acme.org/', 'NEUTRAL', 'Duplicate, Google chose different canonical than user', 'https://acme.org/', 'https://acme.org/')), connectedAt: ago(45) })
  assert.equal(r.state, 'settling')
})

test('not indexed yet: flagged from day 7, not before', () => {
  const home = insp('https://acme.org/', 'NEUTRAL', 'Discovered - currently not indexed')
  const on = (n) => verdict({ healthJson: health(home), connectedAt: ago(n) })
  assert.equal(on(6).state, 'not_yet')
  assert.equal(on(6).flagged, false)
  assert.equal(on(7).flagged, true)
  assert.equal(on(7).tone, 'bad')
  assert.equal(on(6).tone, 'wait')
})

test('blocked and filed on another domain are flagged too', () => {
  const blocked = verdict({ healthJson: health(insp('https://acme.org/', 'NEUTRAL', 'Excluded by ‘noindex’ tag')) })
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.tone, 'bad')
  assert.equal(blocked.flagged, true)
  assert.equal(verdict({ healthJson: health(insp('https://acme.org/', 'FAIL', 'Server error (5xx)')) }).state, 'blocked')
  assert.equal(verdict({ healthJson: health(insp('https://acme.org/', 'NEUTRAL', 'Blocked by robots.txt')) }).state, 'blocked')
  const other = verdict({ healthJson: health(insp('https://acme.org/', 'NEUTRAL', 'Duplicate', 'https://other.com/')) })
  assert.equal(other.state, 'elsewhere')
  assert.equal(other.flagged, true)
})

test('not in Search Console after a week is flagged, with why', () => {
  const r = verdict({ property: null, healthJson: null, connectJson: JSON.stringify({ s1: { status: 'needs_person', detail: 'No GitHub repo is linked.' } }), connectedAt: ago(8) })
  assert.equal(r.state, 'not_added')
  assert.match(r.text, /No GitHub repo is linked/)
  assert.equal(r.flagged, true)
  assert.equal(verdict({ property: null, healthJson: null, connectedAt: ago(2) }).flagged, false)
  // A site that connected has no "why".
  assert.equal(v.connectReasons(JSON.stringify({ s1: { status: 'connected', detail: 'x' } })).get('s1'), undefined)
})

test('not on its own domain, or no live site: never flagged', () => {
  for (const liveUrl of [null, '', 'https://acme.lovable.app', 'acme.lovableproject.com']) {
    const r = verdict({ liveUrl, connectedAt: ago(60) })
    assert.equal(r.state, 'no_domain', String(liveUrl))
    assert.equal(r.flagged, false)
  }
})

test('a check of an earlier address, or none yet, reads as not checked', () => {
  assert.equal(verdict({ healthJson: health(insp('https://old.lovable.app/', 'PASS', 'Submitted and indexed')) }).state, 'unchecked')
  assert.equal(verdict({ healthJson: health(null) }).state, 'unchecked')
  assert.equal(verdict({ healthJson: '{broken' }).state, 'unchecked')
  // www vs no-www of the same domain is the same address.
  assert.equal(verdict({ liveUrl: 'https://www.acme.org', healthJson: health(insp('https://acme.org/', 'PASS', 'Submitted and indexed', 'https://acme.org/')) }).state, 'indexed')
})

test('when the domain was connected: the guard, then Forge, then the first link', () => {
  assert.equal(v.connectedAt({ originSince: 'a', domainAt: 'b', siteLiveAt: 'c' }), 'a')
  assert.equal(v.connectedAt({ originSince: null, domainAt: 'b', siteLiveAt: 'c' }), 'b')
  assert.equal(v.connectedAt({ siteLiveAt: 'c' }), 'c')
  assert.equal(v.connectedAt({}), null)
  // Nothing known: never flagged.
  assert.equal(verdict({ connectedAt: null, healthJson: health(insp('https://acme.org/', 'NEUTRAL', 'URL is unknown to Google')) }).flagged, false)
})

test('the day a domain was connected: first look, or the address moving', () => {
  const now = NOW.toISOString()
  assert.equal(v.originSince(undefined, 'https://acme.org', now), now)
  // Published to lovable.app first, then the domain: the domain's day counts.
  assert.equal(v.originSince({ servedOrigin: 'https://acme.lovable.app', originSince: ago(9) }, 'https://acme.org', now), now)
  // Same address (www or not): kept.
  assert.equal(v.originSince({ servedOrigin: 'https://acme.org', originSince: ago(9) }, 'https://www.acme.org', now), ago(9))
  // A state from before this was tracked stays blank.
  assert.equal(v.originSince({ servedOrigin: 'https://acme.org' }, 'https://acme.org', now), null)
  assert.equal(v.originSince({ servedOrigin: 'https://acme.org', originSince: ago(3) }, null, now), ago(3))
})

test('a single-site refresh is newer than the daily run', () => {
  const r = verdict({ healthJson: health(insp('https://acme.org/', 'PASS', 'Submitted and indexed', 'https://acme.org/'), { checkedAt: '2026-11-24T11:00:00Z' }) })
  assert.equal(r.checkedAt, '2026-11-24T11:00:00Z')
})
