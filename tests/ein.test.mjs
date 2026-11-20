import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// An EIN that can't be real is caught before a toll-free filing waits days in
// Twilio's review only to come back "Business Registration Number Is Missing
// or Invalid" (a client in Nov 2026 typed one starting with 09).

function loadSource(path) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const m = { exports: {} }
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename: path })(() => {
    throw new Error('no dependencies expected')
  }, m, m.exports)
  return m.exports
}

const e = loadSource('lib/ein.ts')

test('an EIN the IRS could have issued passes, and a blank one files as a sole proprietor', () => {
  assert.equal(e.einProblem('12-3456789'), null)
  assert.equal(e.einProblem('123456789'), null)
  assert.equal(e.einProblem(' 33-1234567 '), null)
  assert.equal(e.einProblem(''), null)
  assert.equal(e.einProblem(null), null)
  assert.equal(e.einProblem('N/A'), null)
})

test('a prefix the IRS never issues, or the wrong number of digits, is caught before filing', () => {
  assert.equal(e.einProblem('09-1234567'), 'the EIN on file (09-1234567) can’t be real: the IRS never issues EINs starting with 09')
  for (const p of ['00', '07', '08', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97']) assert.ok(e.einProblem(`${p}-1234567`), p)
  assert.equal(e.einProblem('12-345678'), 'the EIN on file (12-345678) has 8 digits; an EIN has 9')
  assert.equal(e.einProblem('5'), 'the EIN on file (5) has 1 digit; an EIN has 9')
})
