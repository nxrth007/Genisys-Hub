import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// The real modules with stand-ins for what they import: no database, Twilio or network.
function loadSource(path, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const compiledModule = { exports: {} }
  const load = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    return new Proxy({}, { get(_t, prop) { throw new Error(`Unexpected dependency: ${name}.${String(prop)}`) } })
  }
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename: path })(load, compiledModule, compiledModule.exports)
  return compiledModule.exports
}

const kit = loadSource('lib/hl/review-kit.ts')

// The Review Request Campaign as sub-accounts had it before 2026-11-16 (the parts the update reads).
const v1 = () => ({
  triggers: [{ id: 'kit_review_form', name: '5 Star Review Request Form Submitted', type: 'form_submitted', formIds: ['form1'] }],
  steps: [
    { id: 'rr_wait', type: 'wait', name: 'Wait 20min', config: { amount: 20, unit: 'minutes' }, next: 'rr_opp' },
    { id: 'rr_opp', type: 'create_opportunity', config: { pipelineId: 'pipe1', stageId: 'job_completed' }, next: 'rr_sms1' },
    { id: 'rr_sms1', type: 'send_sms', config: { body: 'Hey {{contact.first_name}} - {{trigger_link.review}}' }, next: 'rr_wait1' },
    { id: 'rr_wait1', type: 'wait', config: { amount: 1, unit: 'days' }, next: null },
  ],
  meta: { kit: 1, stopOnResponse: true },
})

test('Review Request Campaign: Job Completed starts it too, and nothing a run remembers moves', () => {
  const before = v1()
  const p = kit.patchReviewRequest(before, 'pipe1')
  assert.equal(p.changed, true)
  assert.deepEqual(p.value.triggers.map((t) => t.id), ['kit_review_form', 'kit_review_stage'])
  assert.deepEqual(p.value.triggers[1], { id: 'kit_review_stage', name: 'Job moved to Job Completed', type: 'opportunity_stage', pipelineId: 'pipe1', stageId: 'job_completed' })
  // A run under way keeps its place by position: every earlier step is where it was, the new ones are last.
  assert.deepEqual(p.value.steps.map((s) => s.id), ['rr_wait', 'rr_opp', 'rr_sms1', 'rr_wait1', 'rr_how', 'rr_moved'])
  assert.equal(p.value.steps[0].next, 'rr_how')
  assert.equal(p.value.meta.oneAtATime, true)
  assert.equal(p.value.meta.stopOnResponse, true)
  // The input isn't changed in place.
  assert.equal(before.steps[0].next, 'rr_opp')
  // Run again: nothing more to do.
  assert.deepEqual([kit.patchReviewRequest(p.value, 'pipe1').changed, kit.patchReviewRequest(p.value, 'pipe1').note], [false, 'already up to date'])
})

test('Review Request Campaign: the gate asks from the form at once, from the stage only while the job is still there', () => {
  const how = kit.REVIEW_GATE_STEPS.find((s) => s.id === 'rr_how')
  assert.deepEqual(how.branches.map((b) => [b.next, b.segments[0].conditions[0]]), [
    ['rr_opp', { type: 'trigger', operator: '!=', value: 'kit_review_stage' }],
    ['rr_sms1', { type: 'opportunities', subType: 'triggerStage', operator: '==', value: ['job_completed'] }],
  ])
  assert.equal(how.elseNext, 'rr_moved')
  assert.equal(kit.REVIEW_GATE_STEPS.find((s) => s.id === 'rr_moved').type, 'remove_from_workflow')
})

test('Review Request Campaign: wording a person changed stays, and one rebuilt by hand is left alone', () => {
  const edited = v1()
  edited.steps[2].config.body = 'Our own wording {{trigger_link.review}}'
  assert.equal(kit.patchReviewRequest(edited, 'pipe1').value.steps[2].config.body, 'Our own wording {{trigger_link.review}}')

  const rewired = v1()
  rewired.steps[0].next = 'rr_sms1'
  assert.deepEqual([kit.patchReviewRequest(rewired, 'pipe1').changed, kit.patchReviewRequest(rewired, 'pipe1').note], [false, 'its first steps were changed by hand: left as it is'])

  // The older starter workflow ("Google Review Request", started by its own stage trigger) isn't this campaign.
  const starter = { triggers: [{ type: 'opportunity_stage', stageId: 'complete' }], steps: [{ id: 'a', type: 'wait', config: {} }], meta: {} }
  assert.equal(kit.patchReviewRequest(starter, 'pipe1').changed, false)
  assert.equal(kit.patchReviewRequest(v1(), null).changed, false, 'no pipeline to listen to')
})

test('reactivation campaign: the gift-card draw goes, wording without it stays', () => {
  const old = [
    { id: 'rra_sms', type: 'send_sms', config: { body: 'Each person that leaves a 5-star review… will be entered to win a 100 dollar gift card!' } },
    { id: 'rra_email1', type: 'send_email', config: { subject: "{{contact.first_name}} we've never done anything like this", body: 'entered to win a $100 gift card!' } },
    { id: 'rra_wait1', type: 'wait', config: { amount: 1, unit: 'days' } },
    { id: 'rra_email2', type: 'send_email', config: { subject: 'Our own subject', body: 'A message someone rewrote, with no offer in it.' } },
    { id: 'rra_email3', type: 'send_email', config: { subject: 'Uh-Oh...', body: 'to be entered twice on our $100 gift card contest?' } },
  ]
  const p = kit.patchReactivation(old)
  assert.equal(p.changed, true)
  assert.equal(p.value[3], old[3], 'the rewritten message is untouched')
  assert.equal(p.value[2], old[2])
  const text = JSON.stringify(p.value.filter((s) => s.id !== 'rra_email2'))
  assert.ok(!/gift|contest|entered to win|5-star|five-star/i.test(text), text)
  assert.equal(p.value[1].config.subject, '{{contact.first_name}}, could you help us out?')
  assert.ok(p.value[0].config.body.includes('{{trigger_link.review}}'))
  assert.equal(kit.patchReactivation(p.value).changed, false)
})

test('nothing the kit sends offers anything for a review, or asks for a rating', () => {
  const copy = JSON.stringify(kit.REACTIVATION_COPY)
  assert.ok(!/gift|contest|entered to win|prize|discount|\$\d|5[- ]star|five[- ]star/i.test(copy), copy)
  const source = readFileSync(new URL('../src/lib/hl/client-kit.ts', import.meta.url), 'utf8')
  assert.ok(!/gift card|contest|entered to win/i.test(source), 'client-kit.ts still offers something for a review')
  for (const id of ['rra_sms', 'rra_email1', 'rra_email2', 'rra_email3']) assert.ok(kit.REACTIVATION_COPY[id].body.includes('{{trigger_link.review}}'), id)
})

test('the $100-off texts are promotions; the replies to someone who answered are not', () => {
  const steps = [
    { id: 'react_offer', type: 'send_sms', config: { body: '$100 off' } },
    { id: 'react_wait', type: 'wait_reply', config: { amount: 60, unit: 'minutes' } },
    { id: 'react_next_steps', type: 'send_sms', config: { body: 'Great!' } },
    { id: 'react_second', type: 'send_sms', config: { body: 'saving $100' } },
  ]
  const p = kit.patchPromotions(steps)
  assert.deepEqual(p.value.map((s) => s.config.marketing === true), [true, false, false, true])
  assert.equal(kit.patchPromotions(p.value).changed, false)
})

test('survey: any rating can go on to Google; an older page’s answers still mean what they did', () => {
  const survey = loadSource('lib/hl/review-survey.ts')
  assert.equal(survey.surveyAction({ action: 'google' }), 'google')
  assert.equal(survey.surveyAction({ action: 'feedback', feedback: '' }), 'feedback')
  // A page opened before the choice existed: feedback text means feedback, a bare rating means Google.
  assert.equal(survey.surveyAction({ feedback: 'The crew was late.' }), 'feedback')
  assert.equal(survey.surveyAction({}), 'google')
  assert.equal(survey.surveyAction({ action: 'something else', feedback: '  ' }), 'google')
})

// --- The engine and the texting gate, with an in-memory database --------------------------------

const REACHED = 'reached the next step'

test('a promotion is refused without a yes to promotions; other texts aren’t held by it', async () => {
  const contact = { id: 'c1', accountId: 'a1', phone: '+15125550123', dnd: false, smsConsent: true, marketingConsent: false }
  const prisma = {
    hlContact: { findUnique: async () => contact },
    hlPhoneNumber: { findFirst: async () => { throw new Error(REACHED) } },
  }
  const messages = loadSource('lib/hl/messages.ts', { '@/lib/prisma': { prisma } })
  const promo = await messages.sendSmsToContact({ accountId: 'a1', contactId: 'c1', body: '$100 off', by: 'automation', marketing: true })
  assert.equal(promo.ok, false)
  assert.match(promo.detail, /promotion/)
  assert.equal(promo.refused, 'promotion', 'the engine ends the run on this, so later steps don’t answer an offer that never went')
  // The same contact, a text about their job: the promotions box isn't asked for.
  await assert.rejects(messages.sendSmsToContact({ accountId: 'a1', contactId: 'c1', body: 'Your estimate', by: 'automation' }), { message: REACHED })
  // And once they've said yes to promotions, the promotion goes on too.
  contact.marketingConsent = true
  await assert.rejects(messages.sendSmsToContact({ accountId: 'a1', contactId: 'c1', body: '$100 off', by: 'automation', marketing: true }), { message: REACHED })
})

test('a workflow set to one run at a time isn’t started again while the contact is still in it', async () => {
  const stage = kit.reviewStageTrigger('pipe1')
  const workflow = (meta) => ({ id: 'w1', accountId: 'a1', status: 'published', allowReentry: true, trigger: stage, triggers: [stage], steps: [], meta })
  let workflows = [workflow({ oneAtATime: true })]
  let active = 1
  const prisma = {
    hlWorkflow: { findMany: async () => workflows },
    hlWorkflowRun: {
      // An earlier run from long ago, so the "same trigger twice in a minute" rule isn't what stops it.
      findFirst: async () => ({ createdAt: new Date(Date.now() - 3_600_000), status: 'waiting' }),
      count: async () => active,
      create: async () => { throw new Error(REACHED) },
    },
  }
  const engine = loadSource('lib/hl/automation.ts', { '@/lib/prisma': { prisma } })
  const moved = { type: 'opportunity_stage', stageId: 'job_completed', pipelineId: 'pipe1' }
  assert.equal(await engine.fireTrigger('a1', 'c1', moved), 0, 'still in the campaign: not started again')
  active = 0
  await assert.rejects(engine.fireTrigger('a1', 'c1', moved), { message: REACHED }, 'not in it: it starts')
  // Other stages and pipelines don't start it; a workflow without the setting isn't held back.
  assert.equal(await engine.fireTrigger('a1', 'c1', { ...moved, stageId: 'new_lead' }), 0)
  assert.equal(await engine.fireTrigger('a1', 'c1', { ...moved, pipelineId: 'another' }), 0)
  active = 1
  workflows = [workflow({})]
  await assert.rejects(engine.fireTrigger('a1', 'c1', moved), { message: REACHED })
})
