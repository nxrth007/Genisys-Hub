import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

// The snapshot's site form made a client's own (src/lib/ghl-form/plan.ts).
const source = readFileSync(new URL('../src/lib/ghl-form/plan.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const m = { exports: {} }
new Function('module', 'exports', 'require', outputText)(m, m.exports, () => ({}))
const plan = m.exports

const OPT1 =
  'By checking this box, I agree to receive SMS text messages from A Plus Fence & Construction about my inquiry, estimates, appointments, and project updates. Msg frequency varies, typically 4-8 msgs/month. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. See our Privacy Policy and Terms.'
const OPT2 =
  'By checking this box, I also agree to receive occasional marketing and promotional SMS text messages from A Plus Fence & Construction, such as seasonal specials and discounts. Typically 1-2 msgs/month. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase.'

test("the consent options get the client's name, and only the template's name changes", () => {
  const [a, b] = plan.renamedOptions([OPT1, OPT2], 'Clogbusters Plumbing and General Building')
  assert.equal(a, OPT1.replace('A Plus Fence & Construction', 'Clogbusters Plumbing and General Building'))
  assert.match(b, /from Clogbusters Plumbing and General Building, such as seasonal specials/)
  assert.ok(!plan.mentionsTemplate(a) && !plan.mentionsTemplate(b))
  // Written another way, it still counts.
  assert.equal(plan.renameConsent('from A Plus Fence and Construction about', 'K&P Remodeling LLC'), 'from K&P Remodeling LLC about')
  assert.equal(plan.renameConsent('from A Plus  Fence & Construction about', ' Royal   Driveway '), 'from Royal Driveway about')
})

test('nothing to change: already renamed, or no name to put in', () => {
  const renamed = plan.renamedOptions([OPT1, OPT2], 'Royal Driveway Cleaning LLC')
  assert.equal(plan.renamedOptions(renamed, 'Royal Driveway Cleaning LLC'), null)
  assert.equal(plan.renamedOptions([OPT1], '  '), null)
  assert.equal(plan.renamedOptions(['Some other checkbox'], 'Royal Driveway Cleaning LLC'), null)
})

test('the consent name: the business name from onboarding, else the client', () => {
  assert.equal(plan.consentName({ businessName: ' Royal  Driveway Cleaning ', clientName: 'Royal Driveway Cleaning LLC' }), 'Royal Driveway Cleaning')
  assert.equal(plan.consentName({ businessName: '', clientName: 'Royal Driveway Cleaning LLC' }), 'Royal Driveway Cleaning LLC')
  assert.equal(plan.consentName({ clientName: 'Royal Driveway Cleaning LLC' }), 'Royal Driveway Cleaning LLC')
})

test("the public form is the client's only with their name and none of A Plus's logo, name or links", () => {
  const text = (o) => `Get Your Free Estimate Full Name * Phone * ${o.join(' ')} SEND`
  const old = { text: text([OPT1, OPT2]), images: 1, links: ['https://aplusconstruction.org/privacy-policy', 'https://aplusconstruction.org/terms-of-service-534985'] }
  assert.deepEqual(plan.builderWork(old), { logo: true, links: true })
  assert.deepEqual(plan.formProblems(old, 'Royal Driveway Cleaning LLC'), [
    'it still says A Plus Fence & Construction',
    'it still shows the A Plus logo',
    'it still links to A Plus’s privacy policy and terms',
  ])
  // Snapshot v2: no logo or links, only the name left to change.
  const v2 = { text: text([OPT1, OPT2]), images: 0, links: [] }
  assert.deepEqual(plan.builderWork(v2), { logo: false, links: false })
  assert.deepEqual(plan.formProblems(v2, 'Royal Driveway Cleaning LLC'), ['it still says A Plus Fence & Construction'])
  const done = { text: text(plan.renamedOptions([OPT1, OPT2], 'Royal Driveway Cleaning LLC')), images: 0, links: [] }
  assert.deepEqual(plan.formProblems(done, 'Royal Driveway Cleaning LLC'), [])
  assert.deepEqual(plan.formProblems(done, 'Someone Else LLC'), ["its consent doesn't name Someone Else LLC"])
  assert.deepEqual(plan.formProblems({ text: 'Get Your Free Estimate SEND', images: 0, links: [] }, 'X'), ['its consent checkboxes are missing', "its consent doesn't name X"])
  assert.equal(plan.publicFormUrl('MjFjsUTjl07QuTFvli6f'), 'https://api.leadconnectorhq.com/widget/form/MjFjsUTjl07QuTFvli6f')
})
