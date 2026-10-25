/**
 * Hell-level shapes shared by the server and the pages: the business
 * profile (the sub-account's custom values), workflow triggers and steps,
 * form fields and pipeline stages. No server imports here.
 */

/** The sub-account's business profile. Automations read it as {{account.*}}. */
export type HlProfile = {
  businessName?: string
  ownerFirstName?: string
  ownerName?: string
  /** The number leads are told to call (often the owner's cell). */
  businessPhone?: string
  website?: string
  /** Owner notifications: texts go here (comma-separate several). */
  notifyPhone?: string
  /** Owner notifications: emails go here (comma-separate several). */
  notifyEmail?: string
  /** Google review link for review requests. */
  reviewLink?: string
  address?: string
  /** EIN, for texting verification. Blank = verify as a sole proprietor. */
  ein?: string
  /** LLC, Inc… as registered, for texting verification. */
  legalName?: string
  /** The client's own privacy policy and terms pages (their website's /privacy and /terms when it has them). Blank = the pages the Hub hosts. */
  privacyUrl?: string
  termsUrl?: string
  /** The business's logo (an image link): forms show it at the top. A client's is found on their website. */
  logoUrl?: string
}

export const PROFILE_FIELDS: { key: keyof HlProfile; label: string; merge: string; hint?: string }[] = [
  { key: 'businessName', label: 'Business name', merge: 'account.business_name' },
  { key: 'ownerFirstName', label: 'Owner first name', merge: 'account.owner_first_name' },
  { key: 'ownerName', label: 'Owner full name', merge: 'account.owner_name' },
  { key: 'businessPhone', label: 'Business phone', merge: 'account.business_phone', hint: 'The number leads are told to call' },
  { key: 'website', label: 'Website', merge: 'account.website' },
  { key: 'notifyPhone', label: 'Notification phone', merge: 'account.notify_phone', hint: 'Owner texts go here. Separate several with commas' },
  { key: 'notifyEmail', label: 'Notification email', merge: 'account.notify_email', hint: 'Owner emails go here. Separate several with commas' },
  { key: 'reviewLink', label: 'Google review link', merge: 'account.review_link' },
  { key: 'address', label: 'Business address', merge: 'account.address' },
  { key: 'legalName', label: 'Legal business name', merge: 'account.legal_name', hint: 'As registered, for texting verification' },
  { key: 'ein', label: 'EIN', merge: 'account.ein', hint: 'For texting verification. Leave blank for a sole proprietor' },
  { key: 'privacyUrl', label: 'Privacy policy link', merge: 'account.privacy_url', hint: 'Forms link here. Blank = the page the Hub hosts' },
  { key: 'termsUrl', label: 'Terms link', merge: 'account.terms_url', hint: 'Forms link here. Blank = the page the Hub hosts' },
  { key: 'logoUrl', label: 'Logo', merge: 'account.logo_url', hint: 'An image link. Forms show it at the top' },
]

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export type HlTriggerType =
  | 'form_submitted'
  | 'chat_submitted'
  | 'missed_call'
  | 'inbound_sms'
  | 'contact_created'
  | 'tag_added'
  | 'opportunity_stage'
  | 'opportunity_created'
  | 'appointment_booked'
  | 'appointment_status'
  | 'sms_error'
  | 'manual'
  /** A contact opened a tracked link from a text ({{trigger_link.review}}): GHL's "Trigger link clicked". */
  | 'link_clicked'
  /** A GoHighLevel trigger Hell-level doesn't have (Facebook lead form, inbound webhook…): shown, never fires. */
  | 'ghl'

export type HlTrigger = {
  type: HlTriggerType
  /** Imported triggers keep GHL's id: "which trigger started this run" conditions use it. */
  id?: string
  /** GHL's name for it, shown on the card. */
  name?: string
  /** GHL switches each trigger on or off on its own. Absent = on. */
  active?: boolean
  /** form_submitted / chat_submitted: only this form (blank = any). */
  formId?: string
  /** form_submitted: any of these forms (GHL's "Form is"). */
  formIds?: string[]
  /** inbound_sms: only messages containing this word (blank = any). */
  keyword?: string
  /** inbound_sms: any of these phrases (GHL's "matches any of" / "contains any of"); used instead of keyword. */
  keywords?: string[]
  /** inbound_sms: "exact" = the whole reply is the keyword (GHL's exact match phrase). */
  match?: 'contains' | 'exact'
  /** tag_added: only this tag. */
  tag?: string
  /** opportunity_stage / opportunity_created: only in this pipeline. */
  pipelineId?: string
  /** opportunity_stage: only moves into this stage id. */
  stageId?: string
  /** appointment_booked / appointment_status: only this calendar (blank = any). */
  calendarId?: string
  /** appointment_status: only this status (blank = any change). */
  status?: string
  /** link_clicked: which tracked link ("review"). Blank = any. */
  link?: string
  /** GHL's own trigger as it was: the card shows it, and its filters are kept. */
  ghl?: { type: string; conditions?: unknown[] }
}

/** What "Appointment status" can listen for (GHL's statuses, plus a reschedule). */
export const APPOINTMENT_STATUSES = ['confirmed', 'cancelled', 'showed', 'noshow', 'rescheduled'] as const

export const TRIGGERS: { type: HlTriggerType; label: string; hint: string; pick?: false }[] = [
  { type: 'form_submitted', label: 'Form submitted', hint: 'Someone sends a form on the website' },
  { type: 'chat_submitted', label: 'Chat widget submitted', hint: 'Someone sends a message through the chat bubble' },
  { type: 'missed_call', label: 'Missed call', hint: 'A call to the sub-account’s number isn’t answered' },
  { type: 'inbound_sms', label: 'Customer replied', hint: 'A contact texts the sub-account’s number' },
  { type: 'contact_created', label: 'Contact created', hint: 'A new contact is added, any way' },
  { type: 'tag_added', label: 'Contact tag', hint: 'A tag is put on a contact' },
  { type: 'opportunity_stage', label: 'Pipeline stage changed', hint: 'An opportunity moves into a stage' },
  { type: 'opportunity_created', label: 'Opportunity created', hint: 'A new opportunity is added to a pipeline' },
  { type: 'appointment_booked', label: 'Customer booked appointment', hint: 'Someone books on a calendar’s booking page' },
  { type: 'appointment_status', label: 'Appointment status', hint: 'An appointment is confirmed, cancelled, rescheduled, or marked showed / no-show' },
  { type: 'sms_error', label: 'Text failed: invalid number', hint: 'A text bounces because the number can’t get texts (GHL’s Twilio validation error)' },
  { type: 'manual', label: 'Manual', hint: 'Only when someone adds a contact by hand' },
  { type: 'link_clicked', label: 'Trigger link clicked', hint: 'A contact opens a tracked link from a text, like the review link' },
  { type: 'ghl', label: 'GoHighLevel trigger', hint: 'A GoHighLevel trigger Hell-level doesn’t have yet; it never fires here', pick: false },
]

export type HlStepType =
  | 'send_sms'
  | 'send_email'
  | 'internal_sms'
  | 'internal_email'
  | 'wait'
  | 'wait_appointment'
  | 'wait_reply'
  | 'add_tag'
  | 'remove_tag'
  | 'create_opportunity'
  | 'move_opportunity'
  | 'remove_opportunity'
  | 'if_tag'
  | 'if_else'
  | 'goto'
  | 'split'
  | 'dnd'
  | 'update_field'
  | 'update_contact'
  | 'add_note'
  | 'add_to_workflow'
  | 'remove_from_workflow'
  | 'drip'
  /** A GoHighLevel action Hell-level can't run yet: shown as it was; a run stops there. */
  | 'ghl'

/** One test in an if/else branch, in GHL's terms (contact_reply, contact_detail, trigger…). */
export type HlCondition = { type: string; subType?: string; operator: string; value?: unknown }

export type HlBranch = {
  id: string
  name: string
  /** How the segments combine (GHL's AND/OR between segments). */
  operator?: 'and' | 'or'
  segments: { operator?: 'and' | 'or'; conditions: HlCondition[] }[]
  /** The first step on this branch; null = it ends there. */
  next: string | null
}

export type HlStep = {
  id: string
  type: HlStepType
  /** Shown on the builder card, like GHL's action names. */
  name?: string
  config: {
    body?: string
    subject?: string
    /** internal_sms / internal_email: override the profile's notification phone/email. */
    to?: string
    amount?: number
    unit?: 'minutes' | 'hours' | 'days'
    /** wait_appointment: that long before or after the appointment's start. */
    when?: 'before' | 'after'
    tag?: string
    /** add_tag / remove_tag: several at once (GHL's tag lists). */
    tags?: string[]
    pipelineId?: string
    stageId?: string
    /** if_tag: skip to the end when the contact does (or doesn't) have the tag. */
    has?: boolean
    /** goto: the step to jump to. */
    target?: string
    /** dnd: texting off (true) or back on (false). */
    dnd?: boolean
    /** update_field / update_contact: what to set. Values take merge fields; "{{today}}" is today's date. */
    fields?: { key: string; label?: string; value: string }[]
    /** add_to_workflow / remove_from_workflow (blank on remove = this workflow). */
    workflowIds?: string[]
    /** remove_from_workflow: every workflow the contact is in, this one too (GHL's "Remove from all workflows"). */
    all?: boolean
    /** create_opportunity: the opportunity's name (merge fields; blank = the contact's name) and lead source. */
    oppName?: string
    source?: string
    /** split: weighted random paths. */
    paths?: { id: string; name: string; percent: number; next: string | null }[]
    /** wait: only carry on inside this window (GHL's "wait for business hours"): days 0 = Sunday, times HH:MM in the sub-account's timezone. */
    window?: { days: number[]; start: string; end: string }
    /** send_email: who it's from (merge fields allowed). */
    fromName?: string
  }
  /** Linked (imported) workflows: the step after this one; null = the end. Absent = the next in the list. */
  next?: string | null
  /** if_else: tried in order; the first whose conditions hold is followed, else elseNext. */
  branches?: HlBranch[]
  elseNext?: string | null
  elseName?: string
  /** The GHL action as it was imported (what a "ghl" step shows, and the record of the rest). */
  ghl?: { type: string; attributes?: unknown }
}

export type StepGroup = 'Communication' | 'Timing' | 'Contact' | 'Pipeline' | 'Logic' | 'Workflow'

export const STEPS: { type: HlStepType; label: string; group: StepGroup; pick?: false }[] = [
  { type: 'send_sms', label: 'Send SMS', group: 'Communication' },
  { type: 'send_email', label: 'Send email', group: 'Communication' },
  { type: 'internal_sms', label: 'Internal notification (SMS)', group: 'Communication' },
  { type: 'internal_email', label: 'Internal notification (email)', group: 'Communication' },
  { type: 'wait', label: 'Wait', group: 'Timing' },
  { type: 'wait_appointment', label: 'Wait: before / after the appointment', group: 'Timing' },
  { type: 'wait_reply', label: 'Wait: for a reply', group: 'Timing' },
  { type: 'drip', label: 'Drip', group: 'Timing', pick: false },
  { type: 'add_tag', label: 'Add tag', group: 'Contact' },
  { type: 'remove_tag', label: 'Remove tag', group: 'Contact' },
  { type: 'dnd', label: 'DND: texting off / on', group: 'Contact' },
  { type: 'update_field', label: 'Update custom field', group: 'Contact' },
  { type: 'update_contact', label: 'Update contact', group: 'Contact' },
  { type: 'add_note', label: 'Add note', group: 'Contact' },
  { type: 'create_opportunity', label: 'Create opportunity', group: 'Pipeline' },
  { type: 'move_opportunity', label: 'Move opportunity', group: 'Pipeline' },
  { type: 'remove_opportunity', label: 'Remove opportunity', group: 'Pipeline' },
  { type: 'if_tag', label: 'If / else: tag', group: 'Logic' },
  { type: 'if_else', label: 'If / else', group: 'Logic', pick: false },
  { type: 'goto', label: 'Go to', group: 'Logic', pick: false },
  { type: 'split', label: 'Split', group: 'Logic', pick: false },
  { type: 'add_to_workflow', label: 'Add to workflow', group: 'Workflow' },
  { type: 'remove_from_workflow', label: 'Remove from workflow', group: 'Workflow' },
  { type: 'ghl', label: 'GoHighLevel action', group: 'Workflow', pick: false },
]

export const stepLabel = (t: HlStepType) => STEPS.find((s) => s.type === t)?.label ?? t
export const triggerLabel = (t: HlTriggerType) => TRIGGERS.find((s) => s.type === t)?.label ?? t
/** What a trigger card says: its own name (GHL names each one), else its kind. */
export const triggerTitle = (t: HlTrigger) => t.name || (t.type === 'ghl' ? `GHL: ${t.ghl?.type ?? 'trigger'}` : triggerLabel(t.type))

/** Merge fields offered in the builder. {{form.<key>}} also works for any form field. */
export const MERGE_FIELDS: { token: string; label: string }[] = [
  { token: '{{contact.first_name}}', label: 'Contact first name' },
  { token: '{{contact.full_name}}', label: 'Contact full name' },
  { token: '{{contact.phone}}', label: 'Contact phone' },
  { token: '{{contact.email}}', label: 'Contact email' },
  { token: '{{form.service}}', label: 'Form: service needed' },
  { token: '{{form.message}}', label: 'Form: project details' },
  { token: '{{appointment.start_time}}', label: 'Appointment: date and time' },
  { token: '{{appointment.only_start_date}}', label: 'Appointment: date' },
  { token: '{{appointment.only_start_time}}', label: 'Appointment: time' },
  { token: '{{appointment.calendar}}', label: 'Appointment: calendar' },
  { token: '{{appointment.meeting_location}}', label: 'Appointment: where' },
  { token: '{{appointment.reschedule_link}}', label: 'Appointment: reschedule link' },
  { token: '{{appointment.cancellation_link}}', label: 'Appointment: cancel link' },
  ...PROFILE_FIELDS.filter((f) => f.key !== 'ein').map((f) => ({ token: `{{${f.merge}}}`, label: f.label })),
]

// ---------------------------------------------------------------------------
// Forms and pipelines
// ---------------------------------------------------------------------------

export type HlFieldType = 'text' | 'phone' | 'email' | 'textarea' | 'select'

export type HlField = {
  key: string
  label: string
  type: HlFieldType
  required?: boolean
  placeholder?: string
  options?: string[]
}

/**
 * A consent checkbox under the form. `kind` says what ticking it records:
 * sms = texts about their request (contact.smsConsent), marketing =
 * promotional texts (contact.marketingConsent). {{business}} in the text
 * becomes the sub-account's business name; "Privacy Policy" and "Terms"
 * become links.
 */
export type HlConsentBox = {
  kind: 'sms' | 'marketing'
  text: string
  required?: boolean
}

export type HlFormSettings = {
  heading?: string
  submitLabel?: string
  thankYou?: string
  /** Before the two-box consent: one texting box with this wording. Read only when `consents` is missing. */
  consentText?: string
  consents?: HlConsentBox[]
  /** Button and accent colour, #rrggbb. */
  color?: string
  buttonText?: string
  /** The form's page: a colour, or 'transparent' to take the website's behind it. */
  background?: string
  /** Heading, labels and consent wording. */
  textColor?: string
  inputBackground?: string
  inputText?: string
  inputBorder?: string
  /** The Privacy Policy / Texting terms links under the form (default on). */
  showLegalLinks?: boolean
  /** The business logo (Business Profile) at the top of the form (default on). */
  showLogo?: boolean
  /** Chat widget: the message that pops up beside the button, as GHL's does ('' = none; unset = the heading). */
  greeting?: string
  /** Review survey: ratings at or above this (out of 5) go to the Google review link; lower ones leave feedback. */
  reviewThreshold?: number
  /** Where those links go for this form. Blank = the sub-account's (Business Profile), else the Hub's hosted pages. */
  privacyUrl?: string
  termsUrl?: string
}

export type HlStage = { id: string; name: string }

/** Contact keys a form field can fill directly. */
export const CONTACT_FIELD_KEYS = ['first_name', 'last_name', 'full_name', 'phone', 'email'] as const

export const OPPORTUNITY_STATUSES = ['open', 'won', 'lost', 'abandoned'] as const
