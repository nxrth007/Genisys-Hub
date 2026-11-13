import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// The merge field reference (src/lib/hl/merge-fields.ts) against the code
// that fills the fields (src/lib/hl/merge.ts): every documented field, its
// other spellings and its GoHighLevel names fill the way the reference says,
// and every field the client kit's workflows use is in it.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
/** Modules the code under test imports but never calls here. */
const STUBS = { '@/lib/prisma': { prisma: {} } }

function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const source = readFileSync(absPath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  cache.set(absPath, m.exports)
  const localRequire = createRequire(pathToFileURL(absPath))
  const req = (id) => {
    if (Object.hasOwn(STUBS, id)) return STUBS[id]
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

const lib = (p) => loadTs(join(root, 'src/lib/hl', p))
const { renderTemplate, unknownTokens } = lib('merge.ts')
const ref = lib('merge-fields.ts')
const { PROFILE_FIELDS } = lib('types.ts')
const { clientKitWorkflows } = lib('client-kit.ts')
const { workflowTemplates } = lib('templates.ts')

const TODAY = '2026-11-13'
// As workflow actions do (src/lib/hl/automation.ts): {{today}} first, then the rest.
const ENGINE_TODAY = /\{\{\s*today\s*\}\}/gi

/** Every field with a value, one of each (one notification phone and email). */
const FULL = {
  contact: {
    firstName: 'Jennifer',
    lastName: 'Smith',
    phone: '+15125550123',
    email: 'jennifer@example.com',
    fields: { company_name: 'Smith Co', service: 'Roof repair', rate_us: '⭐⭐ (2 Stars)', address1: '9 Elm St' },
  },
  account: {
    businessName: 'Acme Roofing',
    ownerFirstName: 'Rick',
    ownerName: 'Rick Bush',
    businessPhone: '+17275576403',
    website: 'https://acmeroofing.com',
    notifyPhone: '+16035551234',
    notifyEmail: 'rick@acmeroofing.com',
    reviewLink: 'https://g.page/r/acme/review',
    address: '1 Main St, Tampa, FL 33601',
    ein: '12-3456789',
    legalName: 'Acme Roofing LLC',
    privacyUrl: 'https://acmeroofing.com/privacy',
    termsUrl: 'https://acmeroofing.com/terms',
    logoUrl: 'https://acmeroofing.com/logo.png',
    brandColor: '#155EEF',
  },
  form: { full_name: 'Jennifer Smith', phone: '+15125550123', service: 'Roof repair', message: 'Small leak', rate_us: '⭐⭐ (2 Stars)' },
  call: { from: '+15125550123', to: '+16035550000', why: 'no-answer' },
  appointment: {
    title: 'Jennifer Smith',
    startTime: '2026-11-03T19:00:00.000Z',
    endTime: '2026-11-03T20:00:00.000Z',
    timezone: 'America/New_York',
    calendarName: 'Free Estimate',
    location: '123 Main St',
    status: 'confirmed',
    rescheduleUrl: 'https://hub.example/hl/a/t',
    cancelUrl: 'https://hub.example/hl/a/t?cancel=1',
    bookingUrl: 'https://hub.example/hl/b/cal',
  },
  links: { review: 'https://hub.example/hl/l/token' },
  webhook: { contact: { email: 'lead@example.com' }, email: 'lead@example.com' },
  responses: { step1: { status: 200, data: { id: 'abc123' } } },
}

const render = (token, data = FULL) => renderTemplate(token.replace(ENGINE_TODAY, TODAY), data)

/** A <…> family written as a real token. */
const PLACEHOLDERS = { '<field key>': 'service', '<path>': 'contact.email', '<step>': 'step1', '<field>': 'id', '<link id>': 'Zx81kPq', '<key>': 'business_name' }
const real = (token) => token.replace(/<[^>]+>/g, (p) => PLACEHOLDERS[p] ?? assert.fail(`no sample for ${p} in ${token}`))

const fields = ref.MERGE_GROUPS.flatMap((g) => g.fields.map((f) => ({ ...f, group: g.key })))

test('every documented field fills, and none is flagged “Won’t fill”', () => {
  for (const f of fields) {
    const token = real(f.example ?? f.token)
    assert.deepEqual(unknownTokens(token), [], `${token} is flagged as unknown`)
    assert.notEqual(render(token), '', `${token} came out blank with every field set`)
    assert.ok(!/\{\{/.test(render(token)), `${token} stayed as typed`)
    for (const k of ['fills', 'from', 'blank', 'label']) assert.ok(f[k]?.trim(), `${f.token} has no ${k}`)
  }
})

test('other spellings and GoHighLevel’s names fill exactly like the field', () => {
  for (const f of fields) {
    const main = render(real(f.example ?? f.token))
    for (const alias of [...(f.also ?? []), ...f.ghl]) {
      const token = real(alias)
      assert.deepEqual(unknownTokens(token), [], `${token} (${f.token}) is flagged as unknown`)
      // A family's spellings use their own sample keys; the rest must match the field itself.
      if (f.token.includes('<')) assert.notEqual(render(token), '', `${token} came out blank`)
      else assert.equal(render(token), main, `${token} doesn’t fill like ${f.token}`)
    }
    if (f.hl) assert.equal(render(f.hl), main, `${f.token} doesn’t fill like ${f.hl}`)
  }
})

test('GoHighLevel names listed as not filling really don’t', () => {
  const notFilled = [...ref.GHL_NOT_FILLED.map((m) => m.token), ...fields.flatMap((f) => f.ghlNot ?? [])]
  for (const token of notFilled) {
    const known = !unknownTokens(token).length
    const out = render(token)
    assert.ok(out === '' || out === token, `${token} fills (“${out}”): move it into the reference`)
    const row = ref.GHL_NOT_FILLED.find((m) => m.token === token)
    if (row) assert.equal(row.becomes, known ? 'blank' : 'kept', `${token} is ${known ? 'blank' : 'kept as typed'}, not ${row.becomes}`)
    if (row?.instead) assert.notEqual(render(row.instead), '', `${row.instead} (instead of ${token}) doesn’t fill`)
  }
})

test('blank values come out blank, and greetings tidy up', () => {
  const empty = { contact: {}, account: {} }
  for (const f of fields) {
    const token = real(f.example ?? f.token)
    if (f.token === '{{trigger_link.review}}' || f.token === '{{today}}') continue
    assert.equal(render(token, empty), '', `${token} isn’t blank with nothing to fill it`)
  }
  assert.equal(render('Hey {{contact.first_name}}!', empty), 'Hey!')
  assert.equal(render('Hey, {{account.owner_first_name}}!', empty), 'Hey!')
  assert.equal(render('{{contact.first_name}}, we could use your help!', empty), ', we could use your help!')
})

test('the review link is never blank: any GHL trigger link id fills with it', () => {
  assert.equal(render('{{trigger_link.review}}'), FULL.links.review)
  assert.equal(render('{{trigger_link.Zx81kPq}}'), FULL.links.review)
})

test('GoHighLevel custom values from the Automation Copy board fill from the Business Profile', () => {
  const copy = readFileSync(join(root, 'src/lib/automation-copy.ts'), 'utf8')
  const keys = [...copy.matchAll(/\{ key: '([a-z_]+)', name: '[^']+', input: '\w+' \}/g)].map((m) => m[1])
  assert.equal(keys.length, 6, 'AUTOMATION_VALUE_DEFS changed: check the custom value names here')
  for (const k of keys) assert.notEqual(render(`{{custom_values.${k}}}`), '', `{{custom_values.${k}}} doesn’t fill`)
  assert.equal(render('{{custom_values.website_link}}'), FULL.account.website)
  assert.equal(render('{{custom_values.owner_full_name}}'), FULL.account.ownerName)
  assert.equal(render('{{custom_values.notification_email}}'), FULL.account.notifyEmail)
  // Not Business Profile fields: blank, as the reference says of values copied from GHL.
  assert.equal(render('{{custom_values.constructor}}'), '')
  assert.equal(render('{{custom_values.some_ghl_value}}'), '')
})

test('{{today}} counts as known, and workflow actions still fill it', () => {
  assert.deepEqual(unknownTokens('Opted in {{today}} / {{ Today }}'), [])
  assert.deepEqual(unknownTokens('{{today.year}}'), ['{{today.year}}'])
  const engine = readFileSync(join(root, 'src/lib/hl/automation.ts'), 'utf8')
  assert.ok(engine.includes(".replace(/\\{\\{\\s*today\\s*\\}\\}/gi, todayIn(c.timezone))"), 'automation.ts no longer fills {{today}}: update the reference')
  assert.equal(ref.fillToday('{{today}}', new Date(2026, 10, 13)), TODAY)
})

test('the Business profile group is every profile field', () => {
  const account = ref.MERGE_GROUPS.find((g) => g.key === 'account')
  assert.deepEqual(
    account.fields.map((f) => f.token),
    PROFILE_FIELDS.map((f) => `{{${f.merge}}}`),
  )
  // The EIN fills but isn't offered in the menu, as before.
  assert.ok(!ref.MERGE_FIELDS.some((m) => m.token === '{{account.ein}}'))
})

test('the Insert field menu still offers everything it did, plus the review link', () => {
  const before = [
    '{{contact.first_name}}', '{{contact.full_name}}', '{{contact.phone}}', '{{contact.email}}', '{{form.service}}', '{{form.message}}',
    '{{appointment.start_time}}', '{{appointment.only_start_date}}', '{{appointment.only_start_time}}', '{{appointment.calendar}}',
    '{{appointment.meeting_location}}', '{{appointment.reschedule_link}}', '{{appointment.cancellation_link}}',
    ...PROFILE_FIELDS.filter((f) => f.key !== 'ein').map((f) => `{{${f.merge}}}`),
  ]
  const offered = ref.MERGE_FIELDS.map((m) => m.token)
  for (const t of before) assert.ok(offered.includes(t), `${t} left the Insert field menu`)
  assert.ok(offered.includes('{{trigger_link.review}}'))
  assert.equal(new Set(offered).size, offered.length, 'a field is offered twice')
  for (const t of offered) assert.ok(!t.includes('<'), `${t} isn’t a real field`)
})

/** Every {{…}} in a workflow's messages, opportunity names and field values. */
function tokensIn(workflows) {
  const out = new Set()
  for (const w of workflows) {
    for (const s of w.steps) {
      const c = s.config ?? {}
      const texts = [c.body, c.subject, c.fromName, c.oppName, c.to, ...(c.fields ?? []).map((f) => f.value)]
      for (const t of texts) for (const m of String(t ?? '').matchAll(/\{\{\s*[^{}]+?\s*\}\}/g)) out.add(m[0])
    }
  }
  return [...out]
}

/** A documented field (or family) that covers this token. */
function documented(token) {
  const want = token.replace(/\s+/g, '').toLowerCase()
  return fields.some((f) => {
    const spellings = [f.token, f.example, ...(f.also ?? []), ...f.ghl].filter(Boolean)
    return spellings.some((s) => {
      if (!s.includes('<')) return s.toLowerCase() === want
      const pattern = s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[^>]+>/g, '[a-z0-9_.]+')
      return new RegExp(`^${pattern}$`).test(want)
    })
  })
}

test('every field the client kit and starter templates use is documented and fills', () => {
  const ids = { quote: 'f1', chat: 'f2', reviewRequest: 'f3', survey: 'f4', pipeline: 'p1' }
  const used = tokensIn([...clientKitWorkflows(ids), ...workflowTemplates({ quote: 'f1', chat: 'f2' })])
  assert.ok(used.length >= 20, `only found ${used.length} fields in the kit`)
  for (const token of used) {
    assert.ok(documented(token), `${token} is used by the kit but not in the reference`)
    assert.deepEqual(unknownTokens(token), [], `${token} is flagged as unknown`)
    assert.notEqual(render(token), '', `${token} came out blank`)
  }
  // The ones the brief named, so a rename in the kit can't slip by.
  for (const t of ['{{account.owner_first_name}}', '{{account.business_name}}', '{{account.website}}', '{{account.owner_name}}', '{{account.business_phone}}', '{{account.review_link}}', '{{trigger_link.review}}']) {
    assert.ok(used.includes(t), `the kit no longer uses ${t}`)
  }
})

test('previews fill the sample lead, and leave the booking link blank as workflows do', () => {
  const sample = ref.sampleMerge(FULL.account)
  assert.equal(renderTemplate('{{contact.first_name}} {{form.service}} {{call.why}} {{appointment.status}}', sample), 'Jennifer Roof repair no-answer confirmed')
  assert.equal(renderTemplate('{{appointment.booking_link}}', sample), '')
  assert.equal(renderTemplate('{{appointment.start_time}}', sample), 'Tuesday, November 3, 2026 at 2:00 PM EST')
})
