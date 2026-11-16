import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadTs(absPath) {
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, createRequire(pathToFileURL(absPath)))
  return m.exports
}

const plan = loadTs(join(root, 'src/lib/hl/rename-plan.ts'))
const OLD = ['Hell', 'level'].join('-')

test('saved notes read the new name and the new web path', () => {
  assert.equal(plan.renamedText(`Bought acme.com for $11.08 on Porkbun. It’s in their ${OLD} → Settings → Domains.`), 'Bought acme.com for $11.08 on Porkbun. It’s in their Genisys OS → Settings → Domains.')
  assert.equal(plan.renamedText(`Open /${OLD.toLowerCase()}/abc123/settings?tab=domains`), 'Open /genisys-os/abc123/settings?tab=domains')
  assert.equal(plan.renamedText(`${OLD}’s form and ${OLD}’s chat`), 'Genisys OS’s form and Genisys OS’s chat')
})

test('a hidden Office item keeps matching: its saved wording changes the way the question’s did', () => {
  const saved = JSON.stringify({ 'num:abc': `a|number|Buy a toll-free number for Acme “Roofing” in ${OLD}?` })
  const now = JSON.parse(plan.renamedText(saved))
  assert.equal(now['num:abc'], 'a|number|Buy a toll-free number for Acme “Roofing” in Genisys OS?')
})

test('what isn’t the name stays: code names, the calendar app, text without it', () => {
  for (const s of ['hellLevel', 'Hell Level Calendar', 'route: hl', 'Nothing to change here.']) assert.equal(plan.renamedText(s), s)
  assert.ok(`${OLD} and /${OLD.toLowerCase()}/x`.includes(plan.OLD_NAME_PART))
})
