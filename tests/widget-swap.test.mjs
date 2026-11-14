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

const plan = loadTs(join(root, 'src/lib/hl/widget-swap-plan.ts'))

test('the 13 clients verified on GoHighLevel are never swapped', () => {
  for (const name of [
    'Aplus Fence & Construction',
    'A Plus Fence & Construction LLC',
    'A1M Construction',
    'Blue Diamond Construction',
    'C&J Concrete Coatings',
    'Esparza Solutions',
    'Esparaza Solutions',
    'Gary Shining Cleaning Services',
    'Robert Paul Contracting',
    'Variety Pros',
    'Roof Rejuvenate of Southeast Georgia',
    'Royal Driveway Cleaning',
    'Ventura Project Solutions',
    'Skystone Homes',
    'LMS Pest Solutions',
  ]) {
    assert.equal(plan.staysOnGhl(name), true, name)
  }
  for (const name of ['Concrete masonry llc', 'Carlos concrete llc', 'Roof Doc', 'Clogbusters Plumbing', 'Safe Fence Co', 'No', '', null, undefined]) {
    assert.equal(plan.staysOnGhl(name), false, String(name))
  }
})

test('the message carries both embed codes and asks for nothing else', () => {
  const m = plan.widgetSwapMessage({ form: '<iframe src="https://hub/hl/f/form123"></iframe>', chat: '<script src="https://hub/hl/widget.js" data-form="chat456" async></script>' })
  assert.ok(m.includes('<iframe src="https://hub/hl/f/form123"></iframe>'))
  assert.ok(m.includes('data-form="chat456"'))
  assert.match(m, /Change nothing else/)
  assert.match(m, /booking calendar as it is/)
  assert.match(m, /exactly one chat bubble/)
})

const hit = (path, text, line = 1) => ({ path, line, text })

test('GoHighLevel in the code: forms and chat count, a booking calendar and notes don’t', () => {
  const g = plan.ghlInCode([
    hit('src/components/Hero.tsx', '<iframe src="https://api.leadconnectorhq.com/widget/form/abc123" style="width:100%"', 12),
    hit('src/components/Contact.tsx', 'src="https://link.msgsndr.com/widget/survey/xyz"', 40),
    hit('index.html', '<script src="https://widgets.leadconnectorhq.com/loader.js" data-resources-url="https://widgets.leadconnectorhq.com/chat-widget/loader.js" data-widget-id="w1"></script>', 20),
    // The same line found by two searches counts once.
    hit('index.html', '<script src="https://widgets.leadconnectorhq.com/loader.js" data-resources-url="https://widgets.leadconnectorhq.com/chat-widget/loader.js" data-widget-id="w1"></script>', 20),
    hit('src/components/Booking.tsx', 'src="https://api.leadconnectorhq.com/widget/booking/cal1"', 5),
    hit('index.html', '<script src="https://link.msgsndr.com/js/form_embed.js"></script>', 21),
    hit('README.md', 'The form came from https://api.leadconnectorhq.com/widget/form/abc123', 3),
    hit('.lovable/plan.md', 'Remove the chat-widget', 9),
    hit('src/pages/About.tsx', '// LeadConnector by leadconnectorhq', 2),
  ])
  assert.deepEqual(
    g.form.map((h) => `${h.path}:${h.line}`),
    ['src/components/Hero.tsx:12', 'src/components/Contact.tsx:40'],
  )
  assert.deepEqual(
    g.chat.map((h) => `${h.path}:${h.line}`),
    ['index.html:20'],
  )
  // The old <chat-widget> tag, on its own line.
  assert.equal(plan.ghlInCode([hit('index.html', '<chat-widget location-id="loc1"></chat-widget>')]).chat.length, 1)
})

test('Hell-level in the code: the form id, and the widget script with the chat id', () => {
  const f = [hit('src/components/QuoteForm.tsx', 'const FORM = "form123"')]
  const w = [hit('index.html', '<script src="https://hub/hl/widget.js" data-form="chat456" async></script>')]
  assert.deepEqual(plan.hlInCode({ formHits: f, widgetHits: w, chatHits: w }), { form: true, chat: true })
  assert.deepEqual(plan.hlInCode({ formHits: [], widgetHits: w, chatHits: [] }), { form: false, chat: false })
  // Only in Lovable's notes: not in the site.
  assert.deepEqual(plan.hlInCode({ formHits: [hit('.lovable/plan.md', 'form123')], widgetHits: [hit('docs/notes.md', 'hl/widget.js')], chatHits: w }), { form: false, chat: false })
})

test('what’s left in the code, said with where it is', () => {
  assert.deepEqual(plan.codeGaps({ ghl: { form: [], chat: [] }, hl: { form: true, chat: true } }), [])
  const gaps = plan.codeGaps({ ghl: { form: [hit('src/components/Hero.tsx', 'x', 12)], chat: [] }, hl: { form: true, chat: false } })
  assert.equal(gaps.length, 2)
  assert.match(gaps[0], /GoHighLevel’s form is still in the code \(src\/components\/Hero\.tsx line 12\)/)
  assert.match(gaps[1], /chat script/)
  const msg = plan.followUpMessage(gaps)
  assert.match(msg, /^Almost there/)
  assert.ok(msg.includes(`- ${gaps[0]}`))
})

test('the live site: swapped when our chat is on it and GoHighLevel’s form and chat aren’t', () => {
  const ids = { formId: 'form123', chatId: 'chat456' }
  const ours = '<script src="https://hub/hl/widget.js" data-form="chat456" async></script><iframe src="https://hub/hl/f/form123"></iframe>'
  const s = plan.liveState(ours, ids)
  assert.deepEqual(s, { ghlForm: false, ghlChat: false, hlForm: true, hlChat: true })
  assert.equal(plan.liveSwapped(s), true)
  assert.equal(plan.liveGaps(s), null)
  // The form on a page the home page doesn't load still counts: the code check proved it.
  assert.equal(plan.liveSwapped(plan.liveState('<script src="https://hub/hl/widget.js" data-form="chat456"></script>', ids)), true)
  // Another sub-account's chat isn't theirs.
  assert.equal(plan.liveState('<script src="https://hub/hl/widget.js" data-form="other"></script>', ids).hlChat, false)
  const old = plan.liveState(
    '<iframe src="https://api.leadconnectorhq.com/widget/form/abc"></iframe><script src="https://widgets.leadconnectorhq.com/loader.js" data-widget-id="w1"></script>',
    ids,
  )
  assert.deepEqual(old, { ghlForm: true, ghlChat: true, hlForm: false, hlChat: false })
  assert.equal(plan.liveSwapped(old), false)
  assert.equal(plan.liveGaps(old), 'Hell-level’s chat bubble isn’t on it; GoHighLevel’s form is still on it; GoHighLevel’s chat is still on it.')
  // A GoHighLevel booking calendar on the live site isn't a form.
  assert.equal(plan.liveState('src="https://api.leadconnectorhq.com/widget/booking/cal1"', ids).ghlForm, false)
})
