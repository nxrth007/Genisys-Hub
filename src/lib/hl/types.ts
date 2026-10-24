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
  | 'appointment_booked'
  | 'appointment_status'
  | 'manual'

export type HlTrigger = {
  type: HlTriggerType
  /** form_submitted / chat_submitted: only this form (blank = any). */
  formId?: string
  /** inbound_sms: only messages containing this word (blank = any). */
  keyword?: string
  /** tag_added: only this tag. */
  tag?: string
  /** opportunity_stage: only moves into this stage id. */
  stageId?: string
  /** appointment_booked / appointment_status: only this calendar (blank = any). */
  calendarId?: string
  /** appointment_status: only this status (blank = any change). */
  status?: string
}

/** What "Appointment status" can listen for (GHL's statuses, plus a reschedule). */
export const APPOINTMENT_STATUSES = ['confirmed', 'cancelled', 'showed', 'noshow', 'rescheduled'] as const

export const TRIGGERS: { type: HlTriggerType; label: string; hint: string }[] = [
  { type: 'form_submitted', label: 'Form submitted', hint: 'Someone sends a form on the website' },
  { type: 'chat_submitted', label: 'Chat widget submitted', hint: 'Someone sends a message through the chat bubble' },
  { type: 'missed_call', label: 'Missed call', hint: 'A call to the sub-account’s number isn’t answered' },
  { type: 'inbound_sms', label: 'Customer replied', hint: 'A contact texts the sub-account’s number' },
  { type: 'contact_created', label: 'Contact created', hint: 'A new contact is added, any way' },
  { type: 'tag_added', label: 'Tag added', hint: 'A tag is put on a contact' },
  { type: 'opportunity_stage', label: 'Pipeline stage changed', hint: 'An opportunity moves into a stage' },
  { type: 'appointment_booked', label: 'Customer booked appointment', hint: 'Someone books on a calendar’s booking page' },
  { type: 'appointment_status', label: 'Appointment status', hint: 'An appointment is confirmed, cancelled, rescheduled, or marked showed / no-show' },
  { type: 'manual', label: 'Manual', hint: 'Only when someone adds a contact by hand' },
]

export type HlStepType =
  | 'send_sms'
  | 'internal_sms'
  | 'internal_email'
  | 'wait'
  | 'add_tag'
  | 'remove_tag'
  | 'create_opportunity'
  | 'move_opportunity'
  | 'if_tag'
  | 'wait_appointment'

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
    pipelineId?: string
    stageId?: string
    /** if_tag: skip to the end when the contact does (or doesn't) have the tag. */
    has?: boolean
  }
}

export const STEPS: { type: HlStepType; label: string; group: 'Communication' | 'Timing' | 'Contact' | 'Pipeline' | 'Logic' }[] = [
  { type: 'send_sms', label: 'Send SMS', group: 'Communication' },
  { type: 'internal_sms', label: 'Internal notification (SMS)', group: 'Communication' },
  { type: 'internal_email', label: 'Internal notification (email)', group: 'Communication' },
  { type: 'wait', label: 'Wait', group: 'Timing' },
  { type: 'wait_appointment', label: 'Wait: before / after the appointment', group: 'Timing' },
  { type: 'add_tag', label: 'Add tag', group: 'Contact' },
  { type: 'remove_tag', label: 'Remove tag', group: 'Contact' },
  { type: 'create_opportunity', label: 'Create opportunity', group: 'Pipeline' },
  { type: 'move_opportunity', label: 'Move opportunity', group: 'Pipeline' },
  { type: 'if_tag', label: 'If / else: tag', group: 'Logic' },
]

export const stepLabel = (t: HlStepType) => STEPS.find((s) => s.type === t)?.label ?? t
export const triggerLabel = (t: HlTriggerType) => TRIGGERS.find((s) => s.type === t)?.label ?? t

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
  /** Where those links go for this form. Blank = the sub-account's (Business Profile), else the Hub's hosted pages. */
  privacyUrl?: string
  termsUrl?: string
}

export type HlStage = { id: string; name: string }

/** Contact keys a form field can fill directly. */
export const CONTACT_FIELD_KEYS = ['first_name', 'last_name', 'full_name', 'phone', 'email'] as const

export const OPPORTUNITY_STATUSES = ['open', 'won', 'lost', 'abandoned'] as const
