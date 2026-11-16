/**
 * The review workflows' pieces that changed on 2026-11-16 (Alex: "fix them"), in one place so a new
 * sub-account's kit (./client-kit.ts) and the one-time update of existing ones (./review-fixes.ts)
 * can't drift apart. Pure (tests load it).
 *
 * 1. Moving a job to "Job Completed" starts the Review Request Campaign (before, only the owner's
 *    "5 Star Review Request Form" did, which a contractor's login can't open). A customer is in it
 *    once at a time, and a job dragged back out within the 20-minute wait isn't asked.
 * 2. The reactivation campaign no longer offers a gift-card draw for 5-star reviews: Google bans
 *    incentives for reviews, and the FTC's review rule (16 CFR 465) bans ones tied to a good rating.
 * 3. The $100-off texts are promotions: they go only to people who ticked the promotions box.
 */
import type { HlStep, HlTrigger } from './types'

export const REVIEW_FORM_TRIGGER_ID = 'kit_review_form'
export const REVIEW_STAGE_TRIGGER_ID = 'kit_review_stage'
export const JOB_COMPLETED_STAGE = 'job_completed'

/** The campaign's second way in: the job is dragged to Job Completed. */
export function reviewStageTrigger(pipelineId: string): HlTrigger {
  return { id: REVIEW_STAGE_TRIGGER_ID, name: 'Job moved to Job Completed', type: 'opportunity_stage', pipelineId, stageId: JOB_COMPLETED_STAGE }
}

/**
 * After the 20-minute wait. From the form (or started by hand): make the Job Completed opportunity
 * and ask, as before. From the stage: ask only if the job is still in Job Completed.
 */
export const REVIEW_GATE_STEPS: HlStep[] = [
  {
    id: 'rr_how',
    type: 'if_else',
    name: 'How did this start?',
    config: {},
    next: null,
    branches: [
      { id: 'b_from_form', name: 'From the review request form', segments: [{ operator: 'and', conditions: [{ type: 'trigger', operator: '!=', value: REVIEW_STAGE_TRIGGER_ID }] }], next: 'rr_opp' },
      {
        id: 'b_still_completed',
        name: 'Job is still in Job Completed',
        segments: [{ operator: 'and', conditions: [{ type: 'opportunities', subType: 'triggerStage', operator: '==', value: [JOB_COMPLETED_STAGE] }] }],
        next: 'rr_sms1',
      },
    ],
    elseNext: 'rr_moved',
    elseName: 'Job was moved back',
  },
  { id: 'rr_moved', type: 'remove_from_workflow', name: 'Job moved back: no review request', config: { workflowIds: [] }, next: null },
]

/** The reactivation campaign's messages, asking for an honest review with nothing offered for it. */
export const REACTIVATION_COPY: Record<string, { subject?: string; body: string }> = {
  rra_sms: {
    body: '{{contact.first_name}}, we could use your help! All of us at {{account.business_name}} appreciate your business, and we would love to hear how we did. Could you take a minute to leave us an honest review? Thank you!\n\nGoogle Link: {{trigger_link.review}}',
  },
  rra_email1: {
    subject: '{{contact.first_name}}, could you help us out?',
    body: '{{contact.first_name}}, we could use your help! \nAll of us at {{account.business_name}} appreciate your business. We would love to hear how we did.\nCould you take a minute to leave us an honest review? Even one sentence helps a small business like ours. \nLet us know if you have any questions. Thank you!\nGoogle Link: {{trigger_link.review}}',
  },
  rra_email2: {
    subject: 'RE: Could you help us out?',
    body: 'Hi {{contact.first_name}},\nDid you get our email from yesterday?\nHere it is again in case it got buried:\nAll of us at {{account.business_name}} appreciate your business. We would love to hear your feedback about our company.\nIt only takes 2 minutes to leave a quick review, and even one sentence helps.\nThank you!\nGoogle Link: {{trigger_link.review}}',
  },
  rra_email3: {
    subject: 'One last ask',
    body: "Hi {{contact.first_name}},\nIf you haven't had a chance yet, would you mind leaving us a quick review?\nEven one short sentence would help us out so much!\nGoogle Link: {{trigger_link.review}}\nThanks!",
  },
}

/** The Database Reactivation steps that are promotions (the $100 offer and its second try). */
export const PROMO_STEP_IDS = ['react_offer', 'react_second']

type Flow = { triggers: HlTrigger[]; steps: HlStep[]; meta: Record<string, unknown> }
export type Patch<T> = { changed: boolean; value: T; note: string }

/**
 * An existing Review Request Campaign brought up to date. New steps go at the END of the list: a
 * run under way remembers its place by position, so nothing before it may move. A campaign someone
 * rebuilt (its form trigger or first steps are gone) is left alone.
 */
export function patchReviewRequest(w: Flow, pipelineId: string | null): Patch<Flow> {
  const byId = new Map(w.steps.map((s) => [s.id, s]))
  const formTrigger = w.triggers.some((t) => t.id === REVIEW_FORM_TRIGGER_ID)
  const wait = byId.get('rr_wait')
  if (!formTrigger || !wait || !byId.has('rr_opp') || !byId.has('rr_sms1')) return { changed: false, value: w, note: 'rebuilt by hand: left as it is' }
  let changed = false
  let triggers = w.triggers
  if (!triggers.some((t) => t.id === REVIEW_STAGE_TRIGGER_ID)) {
    if (!pipelineId) return { changed: false, value: w, note: 'no Customer Pipeline to listen to: left as it is' }
    triggers = [...triggers, reviewStageTrigger(pipelineId)]
    changed = true
  }
  let steps = w.steps
  if (!byId.has('rr_how')) {
    // Only when the wait still leads straight to the opportunity step: the path the kit made.
    if (wait.next !== 'rr_opp') return { changed: false, value: w, note: 'its first steps were changed by hand: left as it is' }
    steps = [...steps.map((s) => (s.id === 'rr_wait' ? { ...s, next: 'rr_how' } : s)), ...REVIEW_GATE_STEPS.filter((g) => !byId.has(g.id))]
    changed = true
  }
  const meta = w.meta.oneAtATime === true ? w.meta : { ...w.meta, oneAtATime: true }
  if (meta !== w.meta) changed = true
  return { changed, value: { triggers, steps, meta }, note: changed ? 'Job Completed now starts it' : 'already up to date' }
}

/** The gift-card draw taken out of a reactivation campaign: only messages that still offer it are rewritten. */
export function patchReactivation(steps: HlStep[]): Patch<HlStep[]> {
  let n = 0
  const out = steps.map((s) => {
    const copy = REACTIVATION_COPY[s.id]
    if (!copy || !/gift\s*card|contest|entered to win/i.test(`${s.config?.subject ?? ''}\n${s.config?.body ?? ''}`)) return s
    n++
    return { ...s, config: { ...s.config, body: copy.body, ...(copy.subject && s.config?.subject !== undefined ? { subject: copy.subject } : {}) } }
  })
  return { changed: n > 0, value: n ? out : steps, note: n ? `${n} message${n === 1 ? '' : 's'} no longer offer the gift-card draw` : 'no gift-card offer in it' }
}

/** The $100-off texts marked as promotions, so they go only to people who agreed to promotions. */
export function patchPromotions(steps: HlStep[]): Patch<HlStep[]> {
  let n = 0
  const out = steps.map((s) => {
    if (!PROMO_STEP_IDS.includes(s.id) || s.type !== 'send_sms' || s.config?.marketing === true) return s
    n++
    return { ...s, config: { ...s.config, marketing: true } }
  })
  return { changed: n > 0, value: n ? out : steps, note: n ? `${n} offer text${n === 1 ? '' : 's'} marked as promotions` : 'already marked' }
}
