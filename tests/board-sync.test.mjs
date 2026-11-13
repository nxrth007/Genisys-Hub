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

const sync = loadTs(join(root, 'src/lib/hl/board-sync.ts'))
const board = { businessName: 'All Pro Painting', ownerFirstName: 'Torrence', ownerFullName: 'Torrence Surles', quoteLink: 'https://allpro.example', phone: '(334) 322-7792', notifyEmail: 'owner@allpro.example' }

test('board → Hell-level: only what the save changed', () => {
  assert.deepEqual(sync.boardProfileChanges(board, board), {})
  assert.deepEqual(sync.boardProfileChanges(board, { ...board, phone: '(334) 555-0100' }), { businessPhone: '(334) 555-0100' })
  assert.deepEqual(sync.boardProfileChanges(board, { ...board, ownerFirstName: 'Terry', ownerFullName: 'Terry Surles' }), { ownerFirstName: 'Terry', ownerName: 'Terry Surles' })
  assert.deepEqual(sync.boardProfileChanges(board, { ...board, quoteLink: 'https://allpropainting.org/quote' }), { website: 'https://allpropainting.org/quote' })
  // Spacing alone isn't a change.
  assert.deepEqual(sync.boardProfileChanges(board, { ...board, businessName: '  All Pro  Painting ' }), {})
})

test('board → Hell-level: a cleared detail or one turned down leaves Hell-level alone', () => {
  assert.deepEqual(sync.boardProfileChanges(board, { ...board, phone: '' }), {})
  assert.deepEqual(sync.boardProfileChanges(board, { ...board, phone: undefined }), {})
  const ok = (key, value) => key !== 'notifyEmail' || value.includes('@')
  assert.deepEqual(sync.boardProfileChanges(board, { ...board, notifyEmail: 'not an email' }, ok), {})
  assert.deepEqual(sync.boardProfileChanges(board, { ...board, notifyEmail: 'new@allpro.example' }, ok), { notifyEmail: 'new@allpro.example' })
  // A board never saved before starts from what onboarding filled in.
  assert.deepEqual(sync.boardProfileChanges({}, { phone: '(334) 322-7792' }), { businessPhone: '(334) 322-7792' })
})
