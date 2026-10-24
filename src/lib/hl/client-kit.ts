import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { CHAT_FIELDS, CHAT_SETTINGS, QUOTE_FORM_FIELDS, QUOTE_FORM_SETTINGS } from './templates'
import type { HlField, HlFormSettings, HlStage, HlStep, HlTrigger } from './types'

/**
 * The automations every client sub-account gets: GoHighLevel's "Client
 * Workflows" from the agency snapshot, as D&D Rustics' sub-account had them
 * on 2026-10-24, workflow for workflow. Same three folders, names, triggers,
 * waits, branches, settings and wording, all switched on.
 *
 * What GHL types in per client (owner, business, phone, website, the
 * owner's email and cell for alerts) is a merge field here, filled from the
 * sub-account's Business Profile, which onboarding fills in. Where the
 * snapshot still carried another business (A Plus Fence's name in the review
 * texts; a review survey and Google link from another sub-account), each
 * client gets its own: its own review survey and its own Google review link.
 * Two A2P workflows listen to a pipeline GHL's client sub-accounts don't have,
 * so they never run there; here those triggers are kept, switched off.
 */

export const KIT_VERSION = 1

const ROOT = 'Client Workflows'
/** Folder paths ("/" separates levels; the "/" in GHL's "Review / Referral Workflows" is a look-alike so it stays one level). */
export const KIT_FOLDERS = { root: ROOT, a2p: `${ROOT}/A2P Compliance`, leads: `${ROOT}/Incoming Lead Workflows`, reviews: `${ROOT}/Review ∕ Referral Workflows` }

export const CUSTOMER_PIPELINE = 'Customer Pipeline'
export const CUSTOMER_STAGES: HlStage[] = [
  { id: 'missed_call_lead', name: 'Missed Call Lead' },
  { id: 'new_lead', name: 'New Lead' },
  { id: 'lead_reply', name: 'Lead Reply' },
  { id: 'quote_given', name: 'Quote Given' },
  { id: 'job_booked', name: 'Job Booked' },
  { id: 'job_completed', name: 'Job Completed' },
  { id: 'lost', name: 'Lost' },
]

/** Filled in by the business owner, for a customer they want a review from. */
export const REVIEW_REQUEST_FORM = '5 Star Review Request Form'
export const REVIEW_REQUEST_FIELDS: HlField[] = [
  { key: 'first_name', label: 'Customer First Name', type: 'text', required: true },
  { key: 'phone', label: 'Customer Phone Number (include area code)', type: 'phone', required: true },
  { key: 'email', label: 'Email', type: 'email' },
]
export const REVIEW_REQUEST_SETTINGS: HlFormSettings = {
  heading: '5 Star Review Request',
  submitLabel: 'Send review request',
  thankYou: 'Review Requested! Thank you for taking the time to complete this form.',
  // The owner is the one filling it in, so the box is their word that the customer agreed to the text.
  consents: [{ kind: 'sms', text: 'The customer agreed to get a text from {{business}} asking for a review.', required: true }],
  color: '#155EEF',
  showLegalLinks: false,
}

export const REVIEW_SURVEY = 'Review Survey'
export const REVIEW_SURVEY_FIELDS: HlField[] = [
  { key: 'rate_us', label: 'Rate Us', type: 'select', required: true, options: ['⭐⭐⭐⭐⭐ (5 Stars)', '⭐⭐⭐⭐ (4 Stars)', '⭐⭐⭐ (3 Stars)', '⭐⭐ (2 Stars)', '⭐ (1 Star)'] },
  { key: 'full_name', label: 'Name (optional)', type: 'text' },
  { key: 'email', label: 'Email (optional)', type: 'email' },
  { key: 'your_feedback', label: 'Your Feedback (Please let us know what can we do to improve?)', type: 'textarea', required: true },
]
export const REVIEW_SURVEY_SETTINGS: HlFormSettings = {
  heading: 'How did we do?',
  thankYou: 'Thank you for taking the time to complete this survey.',
  reviewThreshold: 4,
  consents: [],
  color: '#155EEF',
  showLegalLinks: false,
}

export type KitIds = { quote: string; chat: string; reviewRequest: string; survey: string; pipeline: string }
export type KitWorkflow = { key: string; name: string; folder: string; allowReentry: boolean; stopOnResponse: boolean; triggers: HlTrigger[]; steps: HlStep[] }

// Straight apostrophes on purpose: a curly one makes a text Unicode and halves the characters per segment.
const STAFF_TEXT = "New lead from website!\n\nInfo:\n- Name: {{contact.full_name}}\n- Email: {{contact.email}}\n- Phone: {{contact.phone}}\n\nWe've let them know you'll be in touch soon!"
const toCustomer = (what: string) =>
  `Hey {{contact.first_name}}! Just got your ${what}.\n\nI'll be in touch with you shortly. Please feel free to reach out to us directly at {{account.business_phone}}\n\n- {{account.owner_name}} at {{account.business_name}}`
const tagHas = (tag: string) => ({ type: 'contact_detail', subType: 'tags', operator: 'index-of-true', value: [tag] })
const CLICKED = 'review link clicked by customer'

/** The client workflows, pointing at this sub-account's forms and pipeline. */
export function clientKitWorkflows(ids: KitIds): KitWorkflow[] {
  const P = ids.pipeline
  return [
    // --- A2P Compliance --------------------------------------------------------------------
    {
      key: 'a2p_optin',
      name: 'Customer Replied: Help, Start, Info -> Handle Optin',
      folder: KIT_FOLDERS.a2p,
      allowReentry: true,
      stopOnResponse: false,
      triggers: [
        { id: 'kit_help', name: 'Customer Replied help', type: 'inbound_sms', keywords: ['help'], match: 'exact' },
        { id: 'kit_join', name: 'Customer Replied Join', type: 'inbound_sms', keywords: ['join'], match: 'exact' },
        { id: 'kit_start', name: 'Customer Replied start', type: 'inbound_sms', keywords: ['start'], match: 'exact' },
        { id: 'kit_info', name: 'Customer Replied info', type: 'inbound_sms', keywords: ['info'], match: 'exact' },
      ],
      steps: [
        {
          id: 'optin_check',
          type: 'if_else',
          name: 'Customer Replied:',
          config: {},
          next: null,
          branches: [
            { id: 'b_start', name: 'Hard Optin: "Start"', segments: [{ operator: 'and', conditions: [{ type: 'trigger', subType: 'trigger', operator: '==', value: 'kit_start' }] }], next: 'optin_wait' },
            { id: 'b_join', name: 'Soft Optin: "Join"', segments: [{ operator: 'and', conditions: [{ type: 'trigger', subType: 'trigger', operator: '==', value: 'kit_join' }] }], next: 'goto_join' },
            { id: 'b_help', name: 'Soft Optin: "Help"', segments: [{ operator: 'and', conditions: [{ type: 'trigger', subType: 'trigger', operator: '==', value: 'kit_help' }] }], next: 'goto_help' },
            { id: 'b_info', name: 'Soft Optin: "Info"', segments: [{ operator: 'and', conditions: [{ type: 'trigger', subType: 'trigger', operator: '==', value: 'kit_info' }] }], next: 'goto_info' },
          ],
          elseNext: null,
          elseName: 'None',
        },
        { id: 'optin_wait', type: 'wait', name: 'Wait 3 seconds', config: { amount: 0.05, unit: 'minutes' }, next: 'optin_date' },
        { id: 'optin_date', type: 'update_field', name: 'Update SMS Optin Date', config: { fields: [{ key: 'sms_optin_date', label: 'SMS Optin Date', value: '{{today}}' }] }, next: 'optin_dnd' },
        { id: 'optin_dnd', type: 'dnd', name: 'Disable contact DND: SMS', config: { dnd: false }, next: null },
        { id: 'goto_join', type: 'goto', name: 'Go To', config: { target: 'optin_wait' } },
        { id: 'goto_help', type: 'goto', name: 'Go To', config: { target: 'optin_wait' } },
        { id: 'goto_info', type: 'goto', name: 'Go To', config: { target: 'optin_wait' } },
      ],
    },
    {
      key: 'a2p_invalid_number',
      name: 'Invalid number -> Enable SMS DND',
      folder: KIT_FOLDERS.a2p,
      allowReentry: false,
      stopOnResponse: false,
      triggers: [{ id: 'kit_invalid', name: 'Twilio Validation Error', type: 'sms_error' }],
      steps: [{ id: 'invalid_dnd', type: 'dnd', name: 'Enable/Disable DND', config: { dnd: true }, next: null }],
    },
    {
      key: 'a2p_remove_interested',
      name: 'Remove Interested Opportunity After 7 Days',
      folder: KIT_FOLDERS.a2p,
      allowReentry: false,
      stopOnResponse: false,
      // GHL's trigger watches an "Interested" pipeline client sub-accounts don't have, so it never runs there.
      triggers: [{ id: 'kit_interested', name: 'Opportunity Created', type: 'opportunity_created', active: false }],
      steps: [
        { id: 'interested_wait', type: 'wait', name: 'Wait 7 Days', config: { amount: 7, unit: 'days' }, next: 'interested_check' },
        {
          id: 'interested_check',
          type: 'if_else',
          name: 'Condition',
          config: {},
          next: null,
          branches: [{ id: 'b_moved', name: 'Branch', segments: [{ operator: 'and', conditions: [{ type: 'opportunities', subType: 'pipelineStageId', operator: '!=', value: [] }] }], next: 'interested_remove' }],
          elseNext: null,
          elseName: 'None',
        },
        { id: 'interested_remove', type: 'remove_opportunity', name: 'Remove Opportunity', config: {}, next: null },
      ],
    },
    {
      key: 'a2p_byebye',
      name: 'SMS Byebye DND Setup',
      folder: KIT_FOLDERS.a2p,
      allowReentry: false,
      stopOnResponse: false,
      triggers: [{ id: 'kit_byebye', name: "Contact SMS Reply: Exact 'byebye'", type: 'inbound_sms', keywords: ['byebye'], match: 'exact' }],
      steps: [
        { id: 'byebye_remove', type: 'remove_from_workflow', name: 'Remove From All Workflows', config: { all: true, workflowIds: [] }, next: 'byebye_dnd' },
        { id: 'byebye_dnd', type: 'dnd', name: 'Set DND for Contact', config: { dnd: true }, next: null },
      ],
    },
    {
      key: 'a2p_hard_optout',
      name: 'SMS Hard Opt Out -> Update Date - DND',
      folder: KIT_FOLDERS.a2p,
      allowReentry: true,
      stopOnResponse: false,
      triggers: [
        // Like "Remove Interested Opportunity", GHL's stage trigger here watches a pipeline clients don't have.
        { id: 'kit_optout_stage', name: 'Opportunity Changed', type: 'opportunity_stage', active: false },
        { id: 'kit_optout_reply', name: 'Customer Replied', type: 'inbound_sms', keywords: ['not interested', 'no', 'stop'], match: 'contains' },
      ],
      steps: [
        {
          id: 'optout_note',
          type: 'add_note',
          name: 'System Added Note',
          config: { body: 'System Added Note: SMS Hard Opt Out -> Update Date - DND\n\nFirst:\n{{contact.first_name}}\nLast:\n{{contact.last_name}}\nEmail:\n{{contact.email}}\nPhone:\n{{contact.phone}}' },
          next: 'optout_dnd',
        },
        { id: 'optout_dnd', type: 'dnd', name: 'Set contact DND: SMS', config: { dnd: true }, next: null },
      ],
    },

    // --- Incoming Lead Workflows -------------------------------------------------------------
    {
      key: 'missed_call',
      name: 'Auto Missed Call Text-Back',
      folder: KIT_FOLDERS.leads,
      allowReentry: true,
      stopOnResponse: true,
      triggers: [{ id: 'kit_missed', name: 'Incoming call missed, busy or voicemail', type: 'missed_call' }],
      steps: [
        { id: 'missed_delay', type: 'wait', name: "Slight Delay (so SMS doesn't feel like a bot)", config: { amount: 0.2, unit: 'minutes' }, next: 'missed_opp' },
        { id: 'missed_opp', type: 'create_opportunity', name: 'Create or Update Opportunity', config: { pipelineId: P, stageId: 'missed_call_lead', oppName: '{{contact.phone}}', source: 'missed call' }, next: 'missed_text' },
        {
          id: 'missed_text',
          type: 'send_sms',
          name: 'Text Back the Caller',
          config: {
            body: "Hey, sorry I missed your call! I'll get back to you asap.\n\nIf you want to give me a few details about the job that would be great. You can click this link for a free quote {{account.website}}\n\n- {{account.owner_first_name}} from {{account.business_name}}",
          },
          next: 'missed_email',
        },
        {
          id: 'missed_email',
          type: 'internal_email',
          name: 'Push Notification to Assigned User',
          config: { subject: 'Missed Call Lead', body: 'Hey, {{account.owner_first_name}}!\nYou just missed a call from\n{{contact.phone}} ( {{contact.name}} ).\nPlease get back to them ASAP before lead gets cold.' },
          next: 'missed_owner_text',
        },
        {
          id: 'missed_owner_text',
          type: 'internal_sms',
          name: 'Internal SMS to Assigned User',
          config: { body: 'Hey, {{account.owner_first_name}}!\n\nYou just missed a call from\n\n{{contact.phone}} ({{contact.full_name}}). Please get back to them ASAP before lead gets cold.' },
          next: 'missed_wait',
        },
        { id: 'missed_wait', type: 'wait', name: 'Wait 2 Minutes', config: { amount: 2, unit: 'minutes' }, next: 'missed_follow' },
        { id: 'missed_follow', type: 'send_sms', name: 'SMS', config: { body: 'Look forward to hearing from you. Any questions I can answer here for ya?' }, next: null },
      ],
    },
    {
      key: 'chat_widget',
      name: 'Website Chat Widget Form Submitted',
      folder: KIT_FOLDERS.leads,
      allowReentry: true,
      stopOnResponse: true,
      triggers: [{ id: 'kit_chat', name: 'Chat Widget Submission', type: 'chat_submitted', formIds: [ids.chat] }],
      steps: [
        { id: 'chat_tag', type: 'add_tag', name: 'Add Contact Tag', config: { tags: ['quote requested'] }, next: 'chat_opp' },
        { id: 'chat_opp', type: 'create_opportunity', name: 'Create or Update Opportunity in Client Pipeline', config: { pipelineId: P, stageId: 'new_lead', oppName: '{{contact.name}}', source: 'Quote Requested' }, next: 'chat_wait' },
        { id: 'chat_wait', type: 'wait', name: 'Wait 30 Seconds', config: { amount: 0.5, unit: 'minutes' }, next: 'chat_email' },
        {
          id: 'chat_email',
          type: 'internal_email',
          name: 'Send email to staff',
          config: {
            subject: 'You have a new quote request!',
            body: "Hey {{account.owner_first_name}},\nSomeone requested a quote for service:\nHere's their info:\nName: {{contact.name}}\nEmail: {{contact.email}}\nPhone: {{contact.phone}}\nProject Details: {{form.message}}\nWe've let them know you'll be in touch.\nCall them back ASAP to book their quote!",
          },
          next: 'chat_staff_text',
        },
        { id: 'chat_staff_text', type: 'internal_sms', name: 'Send text to staff', config: { body: STAFF_TEXT }, next: 'chat_confirm' },
        { id: 'chat_confirm', type: 'send_sms', name: 'Chat Widget Submission Confirmation SMS (To Customer)', config: { body: toCustomer('chat submission') }, next: null },
      ],
    },
    {
      key: 'quote_form',
      name: 'Website Quote Form Submitted',
      folder: KIT_FOLDERS.leads,
      allowReentry: true,
      stopOnResponse: true,
      triggers: [{ id: 'kit_quote', name: 'Form Submitted', type: 'form_submitted', formIds: [ids.quote] }],
      steps: [
        { id: 'quote_tag', type: 'add_tag', name: 'Add Contact Tag', config: { tags: ['quote requested'] }, next: 'quote_opp' },
        { id: 'quote_opp', type: 'create_opportunity', name: 'Create or Update Opportunity in Client Pipeline', config: { pipelineId: P, stageId: 'new_lead', oppName: '{{contact.name}}', source: 'Form Submitted' }, next: 'quote_wait' },
        { id: 'quote_wait', type: 'wait', name: 'Wait 30 Seconds', config: { amount: 0.5, unit: 'minutes' }, next: 'quote_staff_text' },
        { id: 'quote_staff_text', type: 'internal_sms', name: 'Send text to staff', config: { body: STAFF_TEXT }, next: 'quote_email' },
        {
          id: 'quote_email',
          type: 'internal_email',
          name: 'Send Email To Staff',
          config: {
            subject: 'You have a new quote request!',
            body: "Hey {{account.owner_first_name}},\nSomeone requested a quote for service:\nHere's their info:\nName: {{contact.name}}\nEmail: {{contact.email}}\nPhone: {{contact.phone}}\nService Needed: {{form.service}}\nProject Details: {{form.message}}\nCall them back ASAP to book their quote!",
          },
          next: 'quote_confirm',
        },
        { id: 'quote_confirm', type: 'send_sms', name: 'Quote Form Confirmation SMS (To Customer)', config: { body: toCustomer('quote form') }, next: null },
      ],
    },

    // --- Review / Referral Workflows ---------------------------------------------------------
    {
      key: 'db_reactivation',
      name: 'Database Reactivation',
      folder: KIT_FOLDERS.reviews,
      allowReentry: true,
      stopOnResponse: false,
      triggers: [{ id: 'kit_reactivation', name: 'Contact Tag', type: 'tag_added', tag: 'database reactivation' }],
      steps: [
        {
          id: 'react_offer',
          type: 'send_sms',
          name: '$100 Off Offer',
          config: {
            body: "Hi {{contact.first_name}}, just wanted to reach out to let you know about the $100 Discount we're currently offering on all of our services!   Do you have any projects that you'd like completed this year that we can put this $100 toward?",
          },
          next: 'react_wait',
        },
        { id: 'react_wait', type: 'wait_reply', name: 'Wait Until Reply (Or 1 Hour)', config: { amount: 60, unit: 'minutes' }, next: 'react_replied' },
        {
          id: 'react_replied',
          type: 'if_else',
          name: 'Did they reply within an hour?',
          config: {},
          next: null,
          branches: [{ id: 'b_replied', name: 'Branch', segments: [{ operator: 'and', conditions: [{ type: 'contact_reply', subType: 'contact_replied', operator: 'is', value: 'true' }] }], next: 'react_positive' }],
          elseNext: 'react_second',
          elseName: 'None',
        },
        {
          id: 'react_positive',
          type: 'if_else',
          name: 'Was reply positive?',
          config: {},
          next: null,
          branches: [{ id: 'b_positive', name: 'Branch', segments: [{ operator: 'and', conditions: [{ type: 'contact_reply', subType: 'matches_intent', operator: '==', value: 'schedule-yes' }] }], next: 'react_next_steps' }],
          elseNext: null,
          elseName: 'None',
        },
        {
          id: 'react_next_steps',
          type: 'send_sms',
          name: 'Positive Reply - Next Steps',
          config: {
            body: "Great! I've got a form all set up for you to fill out that'll help us get your job scheduled as soon as you're ready:  {{account.website}}\n\nOf course, if you would rather call or text or keep the convo here, we're cool with that, too! Just let me know a good time to talk about what you'd like done and we'll connect then\n\n- {{user.name}}, {{location.name}}",
          },
          next: null,
        },
        {
          id: 'react_second',
          type: 'send_sms',
          name: '2nd Attempt',
          config: { body: "Hey {{contact.first_name}}, just checking back to see if you'd be interested in saving $100 the next time we come out. Should I put one of the discount vouchers aside for you?" },
          next: 'react_wait_again',
        },
        { id: 'react_wait_again', type: 'wait_reply', name: 'Wait for reply', config: { amount: 0, unit: 'minutes' }, next: 'react_positive_again' },
        {
          id: 'react_positive_again',
          type: 'if_else',
          name: 'Was reply positive?',
          config: {},
          next: null,
          branches: [{ id: 'b_positive_again', name: 'Branch', segments: [{ operator: 'and', conditions: [{ type: 'contact_reply', subType: 'matches_intent', operator: '==', value: 'schedule-yes' }] }], next: 'react_next_steps_again' }],
          elseNext: null,
          elseName: 'None',
        },
        { id: 'react_next_steps_again', type: 'send_sms', name: 'Positive Reply - Next Steps', config: { body: "Great! Just let me know a good time to talk about what you'd like done and we'll connect then" }, next: null },
      ],
    },
    {
      key: 'negative_feedback',
      name: 'Negative Feedback Received',
      folder: KIT_FOLDERS.reviews,
      allowReentry: true,
      stopOnResponse: false,
      triggers: [{ id: 'kit_survey', name: 'Survey Submitted', type: 'form_submitted', formIds: [ids.survey] }],
      steps: [
        { id: 'neg_tag', type: 'add_tag', name: 'add contact tag: Negative Feedback', config: { tags: ['negative feedback'] }, next: 'neg_alert' },
        {
          id: 'neg_alert',
          type: 'internal_email',
          name: 'Internal Notification To Client',
          config: {
            subject: 'Negative Feedback Form Submitted - {{contact.name}}',
            body: "{{contact.rate_us}} {{contact.name}}'s just provided some negative feedback on their experience.\nReach out to them as soon as possible to remedy the experience! \nPhone: {{contact.phone}}\nEmail: {{contact.email}}",
          },
          next: 'neg_thanks',
        },
        {
          id: 'neg_thanks',
          type: 'send_email',
          name: 'Email Thanking Them For Feedback',
          config: {
            subject: "We're Reviewing Your Feedback",
            body: '{{contact.first_name}},\nThank you for sharing your experience with us. Our management team is reviewing your feedback so we can ensure that neither you, nor any of our other valued customers, have this same experience again. We value feedback like this because it helps us grow in our ability to provide excellent service.\nPlease let me know if there is anything else I can do.\nThanks!',
          },
          next: 'neg_end',
        },
        { id: 'neg_end', type: 'remove_from_workflow', name: 'remove from workflow', config: { workflowIds: [] }, next: null },
      ],
    },
    {
      key: 'review_request',
      name: 'Review Request Campaign',
      folder: KIT_FOLDERS.reviews,
      allowReentry: true,
      stopOnResponse: true,
      triggers: [{ id: 'kit_review_form', name: '5 Star Review Request Form Submitted', type: 'form_submitted', formIds: [ids.reviewRequest] }],
      steps: [
        { id: 'rr_wait', type: 'wait', name: 'Wait 20min', config: { amount: 20, unit: 'minutes' }, next: 'rr_opp' },
        { id: 'rr_opp', type: 'create_opportunity', name: 'Create or update opportunity', config: { pipelineId: P, stageId: 'job_completed', oppName: 'Job Completed' }, next: 'rr_sms1' },
        {
          id: 'rr_sms1',
          type: 'send_sms',
          name: 'SMS 1',
          config: {
            body: "Hey {{contact.first_name}} 🙂 We appreciate your business and loved having you as a customer! It would mean the world to us if you could leave a few sentence review online for us!⭐️\n\nIt'll take less than 30 seconds and seriously has a huge impact for us - {{trigger_link.review}}\n\n- {{account.owner_first_name}} at {{account.business_name}}",
          },
          next: 'rr_email1',
        },
        {
          id: 'rr_email1',
          type: 'send_email',
          name: 'Email 1',
          config: {
            subject: 'We appreciate you {{contact.first_name}} ⭐️',
            body: 'Hey {{contact.first_name}}!\nWe appreciate your business and loved having you as a customer! \nIt would mean the world to us if you could leave a few sentence review online for us!\nCan you please leave review for my business here? {{trigger_link.review}} It takes less than 30 seconds and makes a huge impact on our business.\nThank you!',
          },
          next: 'rr_wait1',
        },
        { id: 'rr_wait1', type: 'wait', name: 'Wait 1 day', config: { amount: 1, unit: 'days' }, next: 'rr_check1' },
        {
          id: 'rr_check1',
          type: 'if_else',
          name: 'Check Contact Tag with Review Link Clicked',
          config: {},
          next: null,
          branches: [{ id: 'b_clicked1', name: 'Branch', segments: [{ operator: 'and', conditions: [tagHas(CLICKED)] }], next: 'rr_end1' }],
          elseNext: 'rr_sms2',
          elseName: 'None',
        },
        { id: 'rr_end1', type: 'remove_from_workflow', name: 'remove from workflow', config: { workflowIds: [] }, next: null },
        {
          id: 'rr_sms2',
          type: 'send_sms',
          name: 'SMS 2',
          config: { body: "Hey not sure if you saw this but It'll take less than 30 seconds and seriously has a huge impact for us - {{trigger_link.review}}\n\nNo worries if not 🙂 just wanted to make sure my text went through." },
          next: 'rr_wait2',
        },
        { id: 'rr_wait2', type: 'wait', name: 'Wait 7 Days', config: { amount: 7, unit: 'days' }, next: 'rr_check2' },
        {
          id: 'rr_check2',
          type: 'if_else',
          name: 'Check Contact Tag with Review Link Clicked',
          config: {},
          next: null,
          branches: [{ id: 'b_clicked2', name: 'Branch', segments: [{ operator: 'and', conditions: [tagHas(CLICKED)] }], next: 'rr_end2' }],
          elseNext: 'rr_sms3',
          elseName: 'None',
        },
        { id: 'rr_end2', type: 'remove_from_workflow', name: 'remove from workflow', config: { workflowIds: [] }, next: null },
        { id: 'rr_sms3', type: 'send_sms', name: 'SMS 3', config: { body: "Hey we'd really appreciate it if you left us a review! - {{trigger_link.review}}" }, next: 'rr_end3' },
        // As in GHL: this ends the run, so the last check and SMS 4 after it are never reached.
        { id: 'rr_end3', type: 'remove_from_workflow', name: 'remove from workflow', config: { workflowIds: [] }, next: 'rr_wait3' },
        { id: 'rr_wait3', type: 'wait', name: 'Wait 7 Days', config: { amount: 7, unit: 'days' }, next: 'rr_check3' },
        {
          id: 'rr_check3',
          type: 'if_else',
          name: 'Check Contact Tag with Review Link Clicked',
          config: {},
          next: null,
          branches: [{ id: 'b_clicked3', name: 'Branch', segments: [{ operator: 'and', conditions: [tagHas(CLICKED)] }], next: 'rr_end4' }],
          elseNext: 'rr_sms4',
          elseName: 'None',
        },
        { id: 'rr_end4', type: 'remove_from_workflow', name: 'remove from workflow', config: { workflowIds: [] }, next: null },
        { id: 'rr_sms4', type: 'send_sms', name: 'SMS 4', config: { body: "Don't want to be a pest but we'd really appreciate it if you left us a review! - {{trigger_link.review}}" }, next: 'rr_end5' },
        { id: 'rr_end5', type: 'remove_from_workflow', name: 'remove from workflow', config: { workflowIds: [] }, next: null },
      ],
    },
    {
      key: 'review_reactivation',
      name: 'Review Request Reactivation Campaign',
      folder: KIT_FOLDERS.reviews,
      allowReentry: true,
      stopOnResponse: true,
      triggers: [{ id: 'kit_review_reactivation', name: 'Review campaign tag added', type: 'tag_added', tag: 'review request reactivation' }],
      steps: [
        {
          id: 'rra_sms',
          type: 'send_sms',
          name: 'SMS 1',
          config: {
            body: '{{contact.first_name}}, we could use your help! All of us at {{account.business_name}} appreciate your business. We would love to hear your feedback about our company and earn a few reviews on social media.\n\nEach person that leaves a 5-star review with a message within the next 7 days, will be entered to win a 100 dollar gift card! Thank you!\n\nGoogle Link: {{trigger_link.review}}',
          },
          next: 'rra_email1',
        },
        {
          id: 'rra_email1',
          type: 'send_email',
          name: 'Email',
          config: {
            subject: "{{contact.first_name}} we've never done anything like this",
            body: '{{contact.first_name}}, we could use your help! \nAll of us at {{account.business_name}} appreciate your business. We would love to earn a few reviews on social media.\nEach person that leaves a 5-star review with a message (even one sentence) within the next 7 days, will be entered to win a $100 gift card! \nWe will choose 1 winner at random in a week from now and send them the gift card, let us know if you have any questions! 🎁 Thank you!\nGoogle Link: {{trigger_link.review}}',
          },
          next: 'rra_wait1',
        },
        { id: 'rra_wait1', type: 'wait', name: 'Wait 1 Day', config: { amount: 1, unit: 'days' }, next: 'rra_email2' },
        {
          id: 'rra_email2',
          type: 'send_email',
          name: 'Email',
          config: {
            subject: "RE: We've never done anything like this",
            body: "Hi {{contact.first_name}},\nDid you get our email from yesterday?\nThere's only a few days left, so we wanted to send the email again, here it is from yesterday:\nAll of us at {{account.business_name}} appreciate your business. We would love to hear your feedback about our company and earn a few reviews on social media.\nIt only takes 2 minutes to leave a quick review!\nEach person that leaves a 5-star review with a message (even one sentence) will be entered to win a $100 gift card!\nWe will choose 1 winner at random in a week from now and send them the gift card, let us know if you have any questions! 🎁 Thank you!\nGoogle Link: {{trigger_link.review}}",
          },
          next: 'rra_wait2',
        },
        { id: 'rra_wait2', type: 'wait', name: 'Wait 2 more days', config: { amount: 2, unit: 'days' }, next: 'rra_email3' },
        {
          id: 'rra_email3',
          type: 'send_email',
          name: 'Email',
          config: {
            subject: 'Uh-Oh...',
            body: "Hi {{contact.first_name}},\nWe're still a few reviews away from reaching our goal!\nIf you haven't had a chance yet would you mind leaving us a super quick review on Google & Facebook to be entered twice on our $100 gift card contest?\nEven one short sentence would help us out so much!\nGoogle Link: {{trigger_link.review}}\nThanks!",
          },
          next: null,
        },
      ],
    },
    {
      key: 'review_link_click',
      name: 'Tag on Review Link Click',
      folder: KIT_FOLDERS.reviews,
      allowReentry: true,
      stopOnResponse: false,
      triggers: [{ id: 'kit_link', name: 'Review Link Clicked', type: 'link_clicked', link: 'review' }],
      steps: [{ id: 'link_tag', type: 'add_tag', name: 'Add Tag: Review Link Clicked', config: { tags: [CLICKED] }, next: null }],
    },
  ]
}

/** Workflows the earlier starter kit put in that the client kit doesn't have; removed when never used. */
const RETIRED_STARTERS = ['appointment_reminders']

export type KitResult = { created: string[]; updated: string[]; kept: string[]; retired: string[] }

/**
 * Give a sub-account the client kit. Safe to run again: forms, the pipeline
 * and folders are added only when missing, and a kit workflow is rewritten
 * only while nobody has gone through it yet (or with `force`), so one a
 * client is using keeps whatever was changed in it.
 */
export async function applyClientKit(accountId: string, o: { force?: boolean } = {}): Promise<KitResult> {
  const json = (v: unknown) => v as Prisma.InputJsonValue
  // The pipeline: the starter "Leads" one becomes it while it's empty.
  const pipelines = await prisma.hlPipeline.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { opportunities: true } } } })
  let pipeline = pipelines.find((p) => p.name === CUSTOMER_PIPELINE)
  if (!pipeline) {
    const starter = pipelines.find((p) => p.name === 'Leads' && !p.ghlId && p._count.opportunities === 0)
    pipeline = starter
      ? await prisma.hlPipeline.update({ where: { id: starter.id }, data: { name: CUSTOMER_PIPELINE, stages: json(CUSTOMER_STAGES) }, include: { _count: { select: { opportunities: true } } } })
      : await prisma.hlPipeline.create({ data: { accountId, name: CUSTOMER_PIPELINE, stages: json(CUSTOMER_STAGES) }, include: { _count: { select: { opportunities: true } } } })
  }

  // The forms: the website quote form and chat widget, the review request form and the review survey.
  const forms = await prisma.hlForm.findMany({ where: { accountId, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, name: true } })
  const form = async (pick: (f: (typeof forms)[number]) => boolean, data: { name: string; kind: string; fields: HlField[]; settings: HlFormSettings }) =>
    forms.find(pick)?.id ?? (await prisma.hlForm.create({ data: { accountId, name: data.name, kind: data.kind, fields: json(data.fields), settings: json(data.settings) }, select: { id: true } })).id
  const ids: KitIds = {
    pipeline: pipeline.id,
    quote: await form((f) => f.kind === 'form' && f.name !== REVIEW_REQUEST_FORM, { name: 'Website Quote Form', kind: 'form', fields: QUOTE_FORM_FIELDS, settings: QUOTE_FORM_SETTINGS }),
    chat: await form((f) => f.kind === 'chat', { name: 'Website Chat Widget', kind: 'chat', fields: CHAT_FIELDS, settings: CHAT_SETTINGS }),
    reviewRequest: await form((f) => f.kind === 'form' && f.name === REVIEW_REQUEST_FORM, { name: REVIEW_REQUEST_FORM, kind: 'form', fields: REVIEW_REQUEST_FIELDS, settings: REVIEW_REQUEST_SETTINGS }),
    survey: await form((f) => f.kind === 'survey', { name: REVIEW_SURVEY, kind: 'survey', fields: REVIEW_SURVEY_FIELDS, settings: REVIEW_SURVEY_SETTINGS }),
  }

  // The folders, empty ones too.
  for (const name of Object.values(KIT_FOLDERS)) {
    const exists = await prisma.hlRecord.findFirst({ where: { accountId, kind: 'workflow_folder', name }, select: { id: true } })
    if (!exists) await prisma.hlRecord.create({ data: { accountId, kind: 'workflow_folder', name } })
  }

  const result: KitResult = { created: [], updated: [], kept: [], retired: [] }
  const existing = await prisma.hlWorkflow.findMany({ where: { accountId, deletedAt: null, template: { not: null } }, select: { id: true, template: true, meta: true, _count: { select: { runs: true } } } })
  for (const k of clientKitWorkflows(ids)) {
    const data = {
      name: k.name,
      folder: k.folder,
      status: 'published',
      trigger: json(k.triggers[0]),
      triggers: json(k.triggers),
      steps: json(k.steps),
      allowReentry: k.allowReentry,
    }
    const have = existing.find((w) => w.template === k.key)
    if (!have) {
      await prisma.hlWorkflow.create({ data: { ...data, accountId, template: k.key, publishedAt: new Date(), meta: json({ kit: KIT_VERSION, stopOnResponse: k.stopOnResponse }) } })
      result.created.push(k.name)
    } else if (o.force || have._count.runs === 0) {
      const meta = { ...((have.meta as Record<string, unknown>) ?? {}), kit: KIT_VERSION, stopOnResponse: k.stopOnResponse }
      await prisma.hlWorkflow.update({ where: { id: have.id }, data: { ...data, publishedAt: new Date(), meta: json(meta) } })
      result.updated.push(k.name)
    } else {
      result.kept.push(k.name)
    }
  }
  for (const w of existing.filter((x) => RETIRED_STARTERS.includes(x.template ?? '') && x._count.runs === 0)) {
    await prisma.hlWorkflow.update({ where: { id: w.id }, data: { deletedAt: new Date(), status: 'draft' } })
    result.retired.push(w.template!)
  }
  return result
}
