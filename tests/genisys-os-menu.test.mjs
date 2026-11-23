import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// Genisys OS's menu after the 2026-11-23 cleanup (src/components/genisys-os/nav.ts):
// what isn't built is folded away, never deleted, and never in a contractor's way.

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

const nav = loadTs(join(root, 'src/components/genisys-os/nav.ts'))
const access = loadTs(join(root, 'src/lib/hl/member-access.ts'))
const { SECTIONS, SETTINGS_PAGES, shownTabs, laterTabs, defaultTab, activeTab, sectionOf } = nav
const keys = (tabs) => tabs.map((t) => t.key)

test('the menu: Payments, AI Agents and Marketing fold away, 13 sections stay', () => {
  assert.deepEqual(SECTIONS.filter((s) => s.later).map((s) => s.key), ['payments', 'ai-agents', 'marketing'])
  assert.equal(SECTIONS.filter((s) => !s.later).length, 13)
  // Memberships stays (Alex kept it on purpose), on its one built tab.
  assert.ok(!sectionOf('memberships').later)
  assert.deepEqual(keys(shownTabs(sectionOf('memberships').tabs, { imported: false })), ['dashboard'])
})

test('a contractor login never lands on a folded tab or section', () => {
  for (const [section, tabs] of Object.entries(access.MEMBER_SECTIONS)) {
    const s = sectionOf(section)
    assert.ok(s, section)
    assert.ok(!s.later, `${section} is folded`)
    for (const key of tabs) {
      const tab = s.tabs?.find((t) => t.key === key)
      assert.ok(tab, `${section}/${key}`)
      assert.equal(tab.fold, undefined, `${section}/${key} is folded`)
    }
  }
})

test('every section opens on a built tab', () => {
  for (const s of SECTIONS.filter((x) => x.tabs?.length && !x.later)) {
    const tab = s.tabs.find((t) => t.key === defaultTab(s))
    assert.equal(tab.fold, undefined, `${s.key} opens on ${tab.key}`)
  }
  assert.equal(defaultTab(sectionOf('sites')), 'websites')
  assert.equal(defaultTab(sectionOf('reporting')), 'call-reporting')
})

test('a folded tab still opens from its link; an unknown one falls back to the default', () => {
  assert.equal(activeTab(sectionOf('sites'), 'stores'), 'stores')
  assert.equal(activeTab(sectionOf('opportunities'), 'pipelines'), 'pipelines')
  assert.equal(activeTab(sectionOf('sites'), 'nope'), 'websites')
  assert.equal(activeTab(sectionOf('payments'), null), 'invoices')
})

test('GoHighLevel-import lists show only on an imported sub-account (Lead Genisys)', () => {
  const sites = sectionOf('sites').tabs
  assert.deepEqual(keys(shownTabs(sites, { imported: false })), ['websites', 'forms', 'chat-widget'])
  assert.deepEqual(keys(shownTabs(sites, { imported: true })), ['websites', 'funnels', 'forms', 'surveys', 'chat-widget'])
  assert.deepEqual(keys(shownTabs(sectionOf('conversations').tabs, { imported: false })), ['conversations'])
  assert.deepEqual(keys(shownTabs(sectionOf('contacts').tabs, { imported: false })), ['smart-lists', 'tasks'])
})

test('Settings: 10 pages on a client, 12 on Lead Genisys, 9 under "Not built yet"', () => {
  assert.deepEqual(keys(shownTabs(SETTINGS_PAGES, { imported: false })), [
    'business-profile',
    'my-staff',
    'pipelines',
    'email-services',
    'phone-numbers',
    'custom-values',
    'merge-fields',
    'domains',
    'integrations',
    'import',
  ])
  assert.equal(shownTabs(SETTINGS_PAGES, { imported: true }).length, 12)
  assert.equal(laterTabs(SETTINGS_PAGES).length, 9)
})

test('a folded section shows its whole GHL structure once opened', () => {
  const payments = sectionOf('payments')
  assert.equal(shownTabs(payments.tabs, { imported: false, folded: true }).length, payments.tabs.length)
  assert.equal(laterTabs(payments.tabs, { folded: true }).length, 0)
})
