import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

// GHL's toll-free registration form, filled from the client's filing (src/lib/ghl-number/register-plan.ts).
const source = readFileSync(new URL('../src/lib/ghl-number/register-plan.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const m = { exports: {} }
new Function('module', 'exports', 'require', outputText)(m, m.exports, () => ({}))
const { stateForms, categoryLabel, ghlFormFields, blankFields, labelMatches, pickOption, formRows, rowsChanged, registrationView } = m.exports

const FILING = {
  businessName: 'All Pro Painting LLC',
  doingBusinessAs: 'All Pro Painting',
  businessWebsite: 'https://allpropainting.com',
  businessType: 'PRIVATE_PROFIT',
  businessContactFirstName: 'Sam',
  businessContactLastName: 'Rivera',
  businessContactEmail: 'office@allpropainting.com',
  businessContactPhone: '+16035550142',
  businessStreetAddress: '12 Main St',
  businessCity: 'Nashua',
  businessStateProvinceRegion: 'NH',
  businessPostalCode: '03060',
  useCaseCategories: ['CUSTOMER_CARE', 'ACCOUNT_NOTIFICATIONS'],
  useCaseSummary: 'Replies to people who ask for a quote on our site.',
  productionMessageSample: 'Hi Sam, thanks for reaching out to All Pro Painting!',
  optInImageUrls: ['https://allpropainting.com/contact'],
  messageVolume: '1,000',
  privacyPolicyUrl: 'https://allpropainting.com/privacy',
  termsAndConditionsUrl: 'https://allpropainting.com/terms',
}

const field = (form, step, label) => form[step].find((f) => f.label === label)

test('states go both ways, full name first; anything else stays as written', () => {
  assert.deepEqual(stateForms('NH'), ['New Hampshire', 'NH'])
  assert.deepEqual(stateForms('ny'), ['New York', 'NY'])
  assert.deepEqual(stateForms('new york'), ['New York', 'NY'])
  assert.deepEqual(stateForms(' Ontario '), ['Ontario'])
})

test("Twilio's use case codes read as GHL's words", () => {
  assert.equal(categoryLabel('CUSTOMER_CARE'), 'Customer Care')
  assert.equal(categoryLabel('ACCOUNT_NOTIFICATIONS'), 'Account Notifications')
})

test('the form is filled from the filing, step by step', () => {
  const f = ghlFormFields(FILING)
  assert.deepEqual(field(f, 'step1', 'Legal Entity Name').value, ['All Pro Painting LLC'])
  assert.deepEqual(field(f, 'step1', 'Legal entity type').value, ['Private Profit'])
  assert.equal(field(f, 'step1', 'Legal entity type').kind, 'select')
  // GHL has its own +1 box, so the phone is the 10 digits.
  assert.deepEqual(field(f, 'step1', 'Phone Number').value, ['6035550142'])
  assert.equal(field(f, 'step1', 'Business DBA').optional, true)
  assert.deepEqual(field(f, 'step2', 'Country').value, ['United States', 'US'])
  assert.deepEqual(field(f, 'step2', 'State').value, ['New Hampshire', 'NH'])
  assert.deepEqual(field(f, 'step2', 'Postal').value, ['03060'])
  assert.deepEqual(field(f, 'step3', 'Use Case Category').value, ['Customer Care', 'Account Notifications'])
  assert.equal(field(f, 'step3', 'Use Case Category').kind, 'multi')
  assert.deepEqual(field(f, 'step3', 'Estimated Monthly Volume').value, ['1,000'])
  assert.deepEqual(field(f, 'step3', 'Opt-In Workflow Image URL').value, ['https://allpropainting.com/contact'])
  assert.deepEqual(field(f, 'step3', 'Terms').value, ['https://allpropainting.com/terms'])
  // A sole proprietor, no opt-in picture (the site itself shows the form).
  const sole = ghlFormFields({ ...FILING, businessType: 'SOLE_PROPRIETOR', optInImageUrls: [] })
  assert.deepEqual(field(sole, 'step1', 'Legal entity type').value, ['Sole Proprietor'])
  assert.deepEqual(field(sole, 'step3', 'Opt-In Workflow Image URL').value, ['https://allpropainting.com'])
})

test('blank fields are named (the worker stops instead of sending half a form); a blank DBA is fine', () => {
  assert.deepEqual(blankFields(ghlFormFields(FILING)), [])
  const bare = ghlFormFields({ ...FILING, doingBusinessAs: undefined, businessContactFirstName: undefined, businessContactLastName: ' ', businessContactPhone: undefined })
  assert.deepEqual(blankFields(bare), ['First Name', 'Last Name', 'Phone Number'])
})

test("labels match GHL's by their start, ignoring case, punctuation and what follows", () => {
  assert.equal(labelMatches('State, province, or region *', 'State'), true)
  assert.equal(labelMatches('Terms & Conditions URL', 'Terms'), true)
  assert.equal(labelMatches('Postal/ZIP code', 'Postal'), true)
  assert.equal(labelMatches('Business DBA (Doing Business As) name', 'Business DBA'), true)
  assert.equal(labelMatches('Email', 'email'), true)
  assert.equal(labelMatches('Statement', 'State'), false)
  assert.equal(labelMatches('Legal Entity Name', 'Legal entity type'), false)
  assert.equal(labelMatches('Anything', ''), false)
})

test('options: exact first, then the same digits, then one starting with it; nothing that merely contains it', () => {
  assert.equal(pickOption(['Sole Proprietor', 'Private Profit', 'Public Profit'], ['Private Profit']), 'Private Profit')
  assert.equal(pickOption(['10', '100', '1000', '10,000'], ['1,000']), '1000')
  assert.equal(pickOption(['New Jersey', 'New York'], ['New York', 'NY']), 'New York')
  assert.equal(pickOption(['NJ', 'NY'], ['New York', 'NY']), 'NY')
  assert.equal(pickOption(['Customer Care (support)', 'Marketing'], ['Customer Care']), 'Customer Care (support)')
  assert.equal(pickOption(['Account Notifications'], ['Notifications']), null)
  assert.equal(pickOption(['Alabama'], ['New York', 'NY']), null)
  assert.equal(pickOption([], ['Web Form']), null)
})

test('the rows a person checks: every filled field, in order, with GHL’s fuller words', () => {
  const rows = formRows(ghlFormFields(FILING))
  assert.deepEqual(rows.slice(0, 3), [
    { step: 1, label: 'Legal Entity Name', value: 'All Pro Painting LLC' },
    { step: 1, label: 'Website URL', value: 'https://allpropainting.com' },
    { step: 1, label: 'Business DBA name', value: 'All Pro Painting' },
  ])
  assert.deepEqual(rows.find((r) => r.label === 'State'), { step: 2, label: 'State', value: 'New Hampshire' })
  assert.deepEqual(rows.find((r) => r.label === 'Use Case Category'), { step: 3, label: 'Use Case Category', value: 'Customer Care, Account Notifications' })
  assert.ok(rows.some((r) => r.label === 'Terms & Conditions URL'))
  assert.ok(rows.some((r) => r.label === 'Postal/ZIP code'))
  // A blank optional field isn't listed.
  assert.ok(!formRows(ghlFormFields({ ...FILING, doingBusinessAs: undefined })).some((r) => r.label === 'Business DBA name'))
})

test('Send sends only what a person saw: a changed detail, or nothing saved, counts as changed', () => {
  const form = ghlFormFields(FILING)
  // Saved as JSON (Postgres reorders keys).
  const saved = JSON.parse(JSON.stringify(formRows(form).map(({ value, label, step }) => ({ value, step, label }))))
  assert.equal(rowsChanged(saved, form), false)
  assert.equal(rowsChanged(saved, ghlFormFields({ ...FILING, businessStreetAddress: '14 Main St' })), true)
  assert.equal(rowsChanged(saved.slice(1), form), true)
  assert.equal(rowsChanged(null, form), true)
  assert.equal(rowsChanged({}, form), true)
})

test("the client's folder shows the latest run's pictures, oldest first, and only good rows", () => {
  const at = (min) => new Date(Date.UTC(2026, 10, 13, 12, min))
  const v = registrationView({
    id: 'job1',
    status: 'running',
    phase: 'register',
    registration: 'review',
    regDetail: 'Filled it.',
    regAt: at(30),
    regFields: [{ step: 1, label: 'Legal Entity Name', value: 'All Pro Painting LLC' }, { label: 7 }, null],
    // Newest first, as the query reads them.
    shots: [
      { id: 's8', step: 'toll-free form ready to send', createdAt: at(29) },
      { id: 's7', step: 'toll-free form step 3 filled', createdAt: at(28) },
      { id: 's6', step: 'toll-free form step 2 filled', createdAt: at(27) },
      { id: 's5', step: 'toll-free form step 1 filled', createdAt: at(26) },
      { id: 's4', step: 'toll-free form ready to send', createdAt: at(10) },
      { id: 's3', step: 'number bought', createdAt: at(5) },
    ],
  })
  assert.equal(v.jobId, 'job1')
  assert.equal(v.running, true)
  assert.deepEqual(v.rows, [{ step: 1, label: 'Legal Entity Name', value: 'All Pro Painting LLC' }])
  assert.deepEqual(v.shots.map((s) => s.id), ['s5', 's6', 's7', 's8'])
  assert.equal(registrationView({ id: 'j', status: 'succeeded', phase: 'number', registration: 'none', regDetail: null, regAt: null, regFields: null, shots: [] }).running, false)
})
