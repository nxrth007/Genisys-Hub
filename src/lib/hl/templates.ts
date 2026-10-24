import type { HlField, HlFormSettings, HlStage, HlStep, HlTrigger } from './types'

/**
 * The starter kit every sub-account gets: a lead pipeline, the website quote
 * form and chat widget, and the automations the $297 package promises
 * (missed-call text-back, instant replies to form and chat leads, review
 * requests). The copy is A Plus Fence & Construction's GHL snapshot copy
 * (see src/lib/automation-copy.ts), with every business detail a
 * {{account.*}} merge field, so no client ever sends another client's name.
 * Straight apostrophes on purpose: a curly one makes a text Unicode and
 * halves the characters per segment.
 */

export const LEAD_STAGES: HlStage[] = [
  { id: 'new', name: 'New Lead' },
  { id: 'contacted', name: 'Contacted' },
  { id: 'quote', name: 'Quote Sent' },
  { id: 'scheduled', name: 'Job Scheduled' },
  { id: 'complete', name: 'Job Complete' },
]

export const QUOTE_FORM_FIELDS: HlField[] = [
  { key: 'full_name', label: 'Full name', type: 'text', required: true },
  { key: 'phone', label: 'Phone', type: 'phone', required: true },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'service', label: 'Service needed', type: 'text' },
  { key: 'message', label: 'Project details', type: 'textarea', placeholder: 'Tell us a little about the job' },
]

export const CHAT_FIELDS: HlField[] = [
  { key: 'full_name', label: 'Name', type: 'text', required: true },
  { key: 'phone', label: 'Mobile phone', type: 'phone', required: true },
  { key: 'message', label: 'How can we help?', type: 'textarea', required: true },
]

/** Consent wording for the checkbox; {{business}} is filled when the form renders. */
export const CONSENT_TEXT =
  'I agree to receive text messages from {{business}} about my request. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.'

export const QUOTE_FORM_SETTINGS: HlFormSettings = {
  heading: 'Get your free quote',
  submitLabel: 'Get my free quote',
  thankYou: "Thanks! We got your request and we'll be in touch shortly.",
  consentText: CONSENT_TEXT,
  color: '#155EEF',
}

export const CHAT_SETTINGS: HlFormSettings = {
  heading: 'Hi there! Have a question? Text us here.',
  submitLabel: 'Send',
  thankYou: "Thanks! We'll text you back shortly.",
  consentText: CONSENT_TEXT,
  color: '#155EEF',
}

const STAFF_SMS =
  "New lead from website!\n\nInfo:\n- Name: {{contact.full_name}}\n- Email: {{contact.email}}\n- Phone: {{contact.phone}}\n\nWe've let them know you'll be in touch soon!"

const customerSms = (what: string) =>
  `Hey {{contact.first_name}}! Just got your ${what}.\n\nI'll be in touch with you shortly. Please feel free to reach out to us directly at {{account.business_phone}}\n\n- {{account.owner_name}} at {{account.business_name}}`

let n = 0
const id = () => `s${++n}`

export type WorkflowTemplate = {
  key: 'missed_call' | 'chat_widget' | 'quote_form' | 'review_request'
  name: string
  folder: string
  description: string
  /** Live straight away (the lead workflows), or left as a draft to switch on (reviews). */
  publish: boolean
  trigger: HlTrigger
  steps: HlStep[]
}

/** formIds: the starter quote form and chat widget, so the triggers point at them. */
export function workflowTemplates(formIds: { quote?: string; chat?: string } = {}): WorkflowTemplate[] {
  n = 0
  return [
    {
      key: 'missed_call',
      name: 'Auto Missed Call Text-Back',
      folder: 'Incoming Lead Workflows',
      description: 'Texts back anyone whose call goes unanswered, and tells the owner right away.',
      publish: true,
      trigger: { type: 'missed_call' },
      steps: [
        { id: id(), type: 'create_opportunity', name: 'Create Opportunity', config: { stageId: 'new' } },
        {
          id: id(),
          type: 'send_sms',
          name: 'Text Back the Caller',
          config: {
            body: "Hey, sorry I missed your call! I'll get back to you asap.\n\nIf you want to give me a few details about the job that would be great. You can click this link for a free quote {{account.website}}\n\n- {{account.owner_first_name}} from {{account.business_name}}",
          },
        },
        {
          id: id(),
          type: 'internal_email',
          name: 'Email the Owner',
          config: {
            subject: 'Missed call from {{contact.phone}}',
            body: 'Hey, {{account.owner_first_name}}!\n\nYou just missed a call from\n\n{{contact.phone}} ({{contact.full_name}}).\n\nPlease get back to them ASAP before the lead gets cold.',
          },
        },
        {
          id: id(),
          type: 'internal_sms',
          name: 'Text the Owner',
          config: {
            body: 'Hey, {{account.owner_first_name}}!\n\nYou just missed a call from\n\n{{contact.phone}} ({{contact.full_name}}). Please get back to them ASAP before the lead gets cold.',
          },
        },
      ],
    },
    {
      key: 'chat_widget',
      name: 'Website Chat Widget Submitted',
      folder: 'Incoming Lead Workflows',
      description: 'Replies to chat-bubble messages in seconds and sends the owner the lead.',
      publish: true,
      trigger: { type: 'chat_submitted', formId: formIds.chat },
      steps: [
        { id: id(), type: 'add_tag', name: 'Tag: chat widget', config: { tag: 'chat widget' } },
        { id: id(), type: 'create_opportunity', name: 'Create Opportunity', config: { stageId: 'new' } },
        {
          id: id(),
          type: 'internal_email',
          name: 'Send email to staff',
          config: {
            subject: 'New chat lead: {{contact.full_name}}',
            body: "Hey {{account.owner_first_name}},\n\nSomeone requested a quote for service:\n\nHere's their info:\nName: {{contact.full_name}}\nEmail: {{contact.email}}\nPhone: {{contact.phone}}\nProject Details: {{form.message}}\n\nWe've let them know you'll be in touch.\nCall them back ASAP to book their quote!",
          },
        },
        { id: id(), type: 'internal_sms', name: 'Send text to staff', config: { body: STAFF_SMS } },
        { id: id(), type: 'send_sms', name: 'Chat Confirmation SMS (To Customer)', config: { body: customerSms('chat submission') } },
      ],
    },
    {
      key: 'quote_form',
      name: 'Website Quote Form Submitted',
      folder: 'Incoming Lead Workflows',
      description: 'Confirms quote requests by text and sends the owner the details.',
      publish: true,
      trigger: { type: 'form_submitted', formId: formIds.quote },
      steps: [
        { id: id(), type: 'add_tag', name: 'Tag: quote form', config: { tag: 'quote form' } },
        { id: id(), type: 'create_opportunity', name: 'Create Opportunity', config: { stageId: 'new' } },
        { id: id(), type: 'internal_sms', name: 'Send text to staff', config: { body: STAFF_SMS } },
        {
          id: id(),
          type: 'internal_email',
          name: 'Send Email To Staff',
          config: {
            subject: 'New quote request: {{contact.full_name}}',
            body: "Hey {{account.owner_first_name}},\n\nSomeone requested a quote for service:\n\nHere's their info:\nName: {{contact.full_name}}\nEmail: {{contact.email}}\nPhone: {{contact.phone}}\nService Needed: {{form.service}}\nProject Details: {{form.message}}\n\nCall them back ASAP to book their quote!",
          },
        },
        { id: id(), type: 'send_sms', name: 'Quote Form Confirmation SMS (To Customer)', config: { body: customerSms('quote form') } },
      ],
    },
    {
      key: 'review_request',
      name: 'Google Review Request',
      folder: 'Review / Referral Workflows',
      description: 'Asks for a Google review a couple of hours after a job is marked complete.',
      publish: false,
      trigger: { type: 'opportunity_stage', stageId: 'complete' },
      steps: [
        { id: id(), type: 'wait', name: 'Wait 2 hours', config: { amount: 2, unit: 'hours' } },
        {
          id: id(),
          type: 'send_sms',
          name: 'Review Request SMS',
          config: {
            body: "Hi {{contact.first_name}}, thanks for choosing {{account.business_name}}! If you were happy with the work, would you leave us a quick Google review? It really helps a small business like ours: {{account.review_link}}\n\n- {{account.owner_first_name}}",
          },
        },
      ],
    },
  ]
}
