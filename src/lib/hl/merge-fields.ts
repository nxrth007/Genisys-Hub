import type { MergeData } from './merge'
import { PROFILE_FIELDS, type HlProfile } from './types'

/**
 * Every {{merge field}} Hell-level fills in, as the builder's reference shows
 * it: what each one fills with, where that comes from, what a message gets
 * when it's blank, and GoHighLevel's name for it. The Insert field menus are
 * made from this list too, and tests/hl-merge-fields.test.mjs renders every
 * entry through the real renderTemplate (src/lib/hl/merge.ts), so the
 * reference can't say something the code doesn't do. Client-safe: no server
 * imports.
 */

export type MergeFieldDoc = {
  /** What to type. With <…> it stands for many ({{form.<field key>}}); `example` is a real one. */
  token: string
  /** Its name in the Insert field menu. */
  label: string
  /** What it fills with. */
  fills: string
  /** Where that value comes from. */
  from: string
  /** What the message gets when there's nothing to put in. */
  blank: string
  /** GoHighLevel's names for the same value. Hell-level fills these too (the test checks). Empty = Hell-level only. */
  ghl: string[]
  /** GoHighLevel's names for it that Hell-level doesn't fill: use `token` instead. */
  ghlNot?: string[]
  /** How GoHighLevel did it, where that isn't a merge field Hell-level fills. */
  ghlNote?: string
  /** Other spellings Hell-level fills the same way. */
  also?: string[]
  /** GoHighLevel's names (the "GoHighLevel's names" group): the Hell-level field that holds the same value. */
  hl?: string
  /** Offered in the Insert field menu. */
  pick?: boolean
  /** A real token for a <…> family: what clicking puts in the message, and what the preview and the test fill. */
  example?: string
}

export type MergeFieldGroup = { key: string; title: string; intro: string; fields: MergeFieldDoc[] }

type ProfileDoc = Pick<MergeFieldDoc, 'fills' | 'from' | 'blank' | 'ghl' | 'ghlNot' | 'ghlNote'>

/** The Business Profile's fields ({{account.*}}). Keyed by every profile key, so a new field without its entry here doesn't build. */
const PROFILE_DOCS: Record<keyof HlProfile, ProfileDoc> = {
  businessName: {
    fills: 'The business’s name.',
    from: 'Onboarding, as the Automation Copy board has it; else the client’s name in the Hub.',
    blank: 'Nothing: the kit’s texts sign off “- Rick at ” with no name.',
    ghl: ['{{location.name}}', '{{custom_values.business_name}}'],
  },
  ownerFirstName: {
    fills: 'The owner’s first name: texts to leads are signed with it, and owner alerts greet them with it.',
    from: 'The Automation Copy board’s owner first name.',
    blank: 'Nothing: “Hey {{account.owner_first_name}},” comes out “Hey,” and a sign-off reads “-  from …”.',
    ghl: ['{{user.first_name}}', '{{custom_values.owner_first_name}}'],
  },
  ownerName: {
    fills: 'The owner’s full name: the quote and chat confirmation texts sign off with it.',
    from: 'The Automation Copy board’s owner full name.',
    blank: 'Nothing: “- {{account.owner_name}} at …” reads “-  at …”.',
    ghl: ['{{user.name}}', '{{custom_values.owner_full_name}}'],
  },
  businessPhone: {
    fills: 'The number leads are told to call, written (727) 555-6403.',
    from: 'The Automation Copy board’s phone.',
    blank: 'Nothing: “reach out to us directly at ” ends with no number.',
    ghl: ['{{location.phone}}', '{{custom_values.business_phone}}'],
  },
  website: {
    fills: 'The client’s website, where “click this link for a free quote” sends people: the site Genisys built.',
    from: 'The Automation Copy board’s quote link.',
    blank: 'Nothing: the missed-call text-back goes out with no link.',
    ghl: ['{{location.website}}', '{{custom_values.website_link}}'],
  },
  notifyPhone: {
    fills: 'Where owner alert texts go. Several numbers are separated by commas.',
    from: 'Onboarding: the owner’s cell from the onboarding form, else the client’s phone in the Hub.',
    blank: 'An Internal notification (SMS) action with no “Send to” fails with “No notification phone on the sub-account”. The workflow carries on.',
    ghl: ['{{user.phone}}'],
  },
  notifyEmail: {
    fills: 'Where owner alert emails go. Several addresses are separated by commas.',
    from: 'The Automation Copy board’s notification email, else the onboarding form’s email, else the client’s email in the Hub.',
    blank: 'An Internal notification (email) action with no “Send to” fails with “No notification email on the sub-account”. The workflow carries on.',
    ghl: ['{{user.email}}', '{{location.email}}', '{{custom_values.notification_email}}'],
  },
  reviewLink: {
    fills: 'The client’s Google review link, as it is (not tracked).',
    from: 'The Google profile board, once the profile is marked verified there; or the review page of the client’s Google Maps listing, saved after a person checks it.',
    blank: 'Nothing. The tracked review link ({{trigger_link.review}}) still works: happy reviewers land on a Google search for the business instead.',
    ghl: [],
    ghlNote: 'GHL’s review texts sent a trigger link instead: {{trigger_link.review}} here.',
  },
  address: {
    fills: 'The business address, as it’s typed in Business Profile.',
    from: 'The onboarding form’s business address (crossed name/address answers are fixed), else the client’s address in the Hub.',
    blank: 'Nothing.',
    ghl: ['{{location.address}}', '{{location.full_address}}'],
    ghlNot: ['{{location.city}}', '{{location.state}}', '{{location.postal_code}}'],
  },
  legalName: {
    fills: 'The registered name (LLC, Inc…), for texting verification.',
    from: 'The onboarding form’s business name, else the client’s name in the Hub.',
    blank: 'Nothing.',
    ghl: [],
  },
  ein: {
    fills: 'The EIN, for texting verification. Not in the Insert field menu.',
    from: 'The onboarding form, kept only when it has 9 digits.',
    blank: 'Nothing (the business verifies as a sole proprietor).',
    ghl: [],
  },
  privacyUrl: {
    fills: 'The client’s privacy policy page.',
    from: 'Their website’s /privacy page, filled in when Genisys built the site; or typed in Business Profile.',
    blank: 'Nothing. Forms link to the privacy page the Hub hosts instead.',
    ghl: [],
  },
  termsUrl: {
    fills: 'The client’s terms page.',
    from: 'Their website’s /terms page, filled in when Genisys built the site; or typed in Business Profile.',
    blank: 'Nothing. Forms link to the terms page the Hub hosts instead.',
    ghl: [],
  },
  logoUrl: {
    fills: 'The logo, as an image link.',
    from: 'Business Profile: “Find them on their website”, an upload, or a pasted link.',
    blank: 'Nothing. Forms show no logo.',
    ghl: [],
    ghlNot: ['{{location.logo_url}}'],
  },
  brandColor: {
    fills: 'The brand colour, as #hex.',
    from: 'Business Profile: “Find them on their website”, or picked there.',
    blank: 'Nothing. Forms use their own colour.',
    ghl: [],
  },
}

export const MERGE_GROUPS: MergeFieldGroup[] = [
  {
    key: 'contact',
    title: 'Contact',
    intro: 'The person the workflow is running for. They’re read again after every action, so a name or answer saved mid-workflow shows up in later messages.',
    fields: [
      {
        token: '{{contact.first_name}}',
        label: 'Contact first name',
        fills: 'Their first name.',
        from: 'Whatever brought them in: a form or the chat widget (a full name is split), the booking page, an inbound webhook, the GoHighLevel import, or Contacts. Someone who only called or texted has none until it’s added.',
        blank: 'Nothing. “Hey {{contact.first_name}}!” comes out “Hey!”, but one at the very start leaves its comma behind (“, we could use your help!”).',
        ghl: ['{{contact.first_name}}'],
        pick: true,
      },
      {
        token: '{{contact.last_name}}',
        label: 'Contact last name',
        fills: 'Their last name.',
        from: 'As the first name.',
        blank: 'Nothing.',
        ghl: ['{{contact.last_name}}'],
        pick: true,
      },
      {
        token: '{{contact.full_name}}',
        label: 'Contact full name',
        fills: 'First and last name together.',
        from: 'As the first name.',
        blank: 'Nothing.',
        ghl: ['{{contact.name}}'],
        also: ['{{contact.name}}'],
        pick: true,
      },
      {
        token: '{{contact.phone}}',
        label: 'Contact phone',
        fills: 'Their phone number, written (512) 555-0123.',
        from: 'The form, the call or text they sent, the booking page, an inbound webhook, the import, or Contacts.',
        blank: 'Nothing (someone who only left an email).',
        ghl: ['{{contact.phone}}'],
        ghlNot: ['{{contact.phone_raw}}'],
        pick: true,
      },
      {
        token: '{{contact.email}}',
        label: 'Contact email',
        fills: 'Their email address.',
        from: 'The form, the booking page, an inbound webhook, the import, or Contacts.',
        blank: 'Nothing.',
        ghl: ['{{contact.email}}'],
        pick: true,
      },
      {
        token: '{{contact.company_name}}',
        label: 'Contact company',
        fills: 'Their company.',
        from: 'A form field with the key company_name, an Update contact action, or the company of a contact brought over from GoHighLevel.',
        blank: 'Nothing.',
        ghl: ['{{contact.company_name}}'],
        also: ['{{contact.business_name}}'],
      },
      {
        token: '{{contact.<field key>}}',
        label: 'Any answer or custom field saved on them',
        fills: 'Whatever is saved on the contact under that key: form answers other than name, phone and email ({{contact.service}}; the review survey’s {{contact.rate_us}}), custom fields (GoHighLevel’s keep their GHL key), and an imported contact’s address1, city, state, postal_code, country, website and date_of_birth.',
        from: 'Every form, chat or survey they send saves its answers on them. Update custom field and Update contact actions write here, and the GoHighLevel import brought custom fields and addresses across.',
        blank: 'Nothing, when nothing is saved under that key. Capitals don’t matter and spaces count as underscores: {{contact.Rate Us}} reads rate_us.',
        ghl: ['{{contact.<field key>}}'],
        example: '{{contact.service}}',
      },
    ],
  },
  {
    key: 'form',
    title: 'Form answers',
    intro: 'The answers of the form, chat widget or survey that started this run, by each field’s key (the form builder shows each field’s merge field under it). Other runs have none, including a workflow started by another workflow’s Add to workflow action. A run started by hand (Test workflow) uses the contact’s saved answers instead.',
    fields: [
      {
        token: '{{form.service}}',
        label: 'Form: service needed',
        fills: 'The Website Quote Form’s “Service needed” answer.',
        from: 'The website quote form.',
        blank: 'Nothing, when they skipped it or no form started the run.',
        ghl: [],
        ghlNote: 'GHL keeps form answers on the contact as fields: {{contact.<field key>}}, which works here too.',
        pick: true,
      },
      {
        token: '{{form.message}}',
        label: 'Form: project details',
        fills: 'The quote form’s “Project details”, or the chat widget’s message.',
        from: 'The website quote form or chat widget.',
        blank: 'Nothing, when they skipped it or no form started the run.',
        ghl: [],
        ghlNote: 'GHL keeps form answers on the contact as fields: {{contact.<field key>}}, which works here too.',
        pick: true,
      },
      {
        token: '{{form.<field key>}}',
        label: 'Any answer on the form',
        fills: 'That field’s answer. The kit’s forms: Website Quote Form full_name, phone, email, service, message. Website Chat Widget full_name, phone, message. Review Survey rate_us, your_feedback, full_name, email. 5 Star Review Request Form first_name, phone, email.',
        from: 'The form that started the run.',
        blank: 'Nothing, when they skipped it or no form started the run.',
        ghl: [],
        ghlNote: 'GHL keeps form answers on the contact as fields: {{contact.<field key>}}, which works here too.',
        example: '{{form.full_name}}',
      },
    ],
  },
  {
    key: 'appointment',
    title: 'Appointment',
    intro: 'The appointment that started the run (Customer booked appointment, Appointment status), read fresh each time the run moves, so a reschedule shows. Times are in the sub-account’s timezone (Settings → Business Profile). In any other run these are blank. Calendar notifications fill the same fields.',
    fields: [
      {
        token: '{{appointment.start_time}}',
        label: 'Appointment: date and time',
        fills: 'Day, date, time and zone: “Tuesday, November 3, 2026 at 2:00 PM EST”.',
        from: 'The appointment: booked on a calendar’s booking page, or added in Calendars.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: ['{{appointment.start_time}}'],
        also: ['{{appointment.start_date_time}}'],
        pick: true,
      },
      {
        token: '{{appointment.only_start_date}}',
        label: 'Appointment: date',
        fills: 'The date: “Nov 3, 2026”.',
        from: 'The appointment.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: ['{{appointment.only_start_date}}'],
        also: ['{{appointment.date}}'],
        pick: true,
      },
      {
        token: '{{appointment.only_start_time}}',
        label: 'Appointment: time',
        fills: 'The time: “2:00 PM”.',
        from: 'The appointment.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: ['{{appointment.only_start_time}}'],
        also: ['{{appointment.time}}'],
        pick: true,
      },
      {
        token: '{{appointment.day_of_week}}',
        label: 'Appointment: weekday',
        fills: 'The weekday: “Tuesday”.',
        from: 'The appointment.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: ['{{appointment.day_of_week}}'],
      },
      {
        token: '{{appointment.timezone}}',
        label: 'Appointment: timezone',
        fills: 'The zone’s short name: “EST”.',
        from: 'The sub-account’s timezone.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: ['{{appointment.timezone}}'],
      },
      {
        token: '{{appointment.title}}',
        label: 'Appointment: title',
        fills: 'The appointment’s title: what was typed when it was added in Calendars, else the calendar’s event title setting, else the contact’s name.',
        from: 'The appointment.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: ['{{appointment.title}}'],
      },
      {
        token: '{{appointment.calendar}}',
        label: 'Appointment: calendar',
        fills: 'The calendar’s name: “Free Estimate”.',
        from: 'The calendar it was booked on.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: [],
        ghlNot: ['{{calendar.name}}'],
        also: ['{{appointment.calendar_name}}'],
        pick: true,
      },
      {
        token: '{{appointment.meeting_location}}',
        label: 'Appointment: where',
        fills: 'Where it happens: the appointment’s address, or the Google Meet link on a Meet calendar.',
        from: 'The appointment.',
        blank: 'Nothing, when the appointment has no place.',
        ghl: ['{{appointment.meeting_location}}'],
        also: ['{{appointment.location}}'],
        pick: true,
      },
      {
        token: '{{appointment.status}}',
        label: 'Appointment: status',
        fills: 'Its status as Hell-level keeps it: new, confirmed, showed, noshow, cancelled or invalid.',
        from: 'The appointment.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: [],
      },
      {
        token: '{{appointment.reschedule_link}}',
        label: 'Appointment: reschedule link',
        fills: 'A link to the appointment’s own page, where they can move it.',
        from: 'Made for each appointment.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: ['{{appointment.reschedule_link}}'],
        also: ['{{reschedule_link}}'],
        pick: true,
      },
      {
        token: '{{appointment.cancellation_link}}',
        label: 'Appointment: cancel link',
        fills: 'The same page, opened ready to cancel. (In calendar notifications it opens the page as it is.)',
        from: 'Made for each appointment.',
        blank: 'Nothing, unless an appointment started the run.',
        ghl: ['{{appointment.cancellation_link}}'],
        also: ['{{appointment.cancel_link}}', '{{cancellation_link}}'],
        pick: true,
      },
      {
        token: '{{appointment.booking_link}}',
        label: 'Appointment: booking page',
        fills: 'The calendar’s booking page, to book another time.',
        from: 'The calendar.',
        blank: 'Always blank in workflows: only the calendar’s own notifications fill it.',
        ghl: [],
      },
    ],
  },
  {
    key: 'account',
    title: 'Business profile',
    intro: 'The client’s business details, the same in every workflow of the sub-account: GHL’s custom values. Edit them in Settings → Business Profile. A new client’s come from onboarding, as the Automation Copy board and the Google profile board have them. After that, a save on the Automation Copy board carries over what it changed (business name, owner names, phone, website, notification email); anything typed here stays until that detail changes on the board. Phone numbers are written (727) 555-6403.',
    fields: PROFILE_FIELDS.map((f) => ({ token: `{{${f.merge}}}`, label: f.label, ...PROFILE_DOCS[f.key], ...(f.key === 'ein' ? {} : { pick: true }) })),
  },
  {
    key: 'links',
    title: 'Trigger links',
    intro: 'Links made for each contact, so opening one is known to be theirs (GHL’s trigger links).',
    fields: [
      {
        token: '{{trigger_link.review}}',
        label: 'Review link (tracked)',
        fills: 'The contact’s own review link. Opening it fires “Trigger link clicked” (the kit’s Tag on Review Link Click then tags them “review link clicked by customer”) and opens the review survey: high ratings go on to the Google review link, low ones leave feedback.',
        from: 'Made for each contact. Where it leads: the sub-account’s review survey and the Google review link in Business Profile.',
        blank: 'Never blank. With no review survey it goes straight to the Google review link, or to a Google search for the business when there’s no link.',
        ghl: ['{{trigger_link.<link id>}}'],
        ghlNote: 'Any GHL trigger link’s id fills with this review link: a client sub-account has just the one.',
        pick: true,
      },
    ],
  },
  {
    key: 'call',
    title: 'Missed call',
    intro: 'The call that started the run (Missed call trigger). Other runs have none.',
    fields: [
      {
        token: '{{call.from}}',
        label: 'Missed call: caller',
        fills: 'The caller’s number, written (512) 555-0123.',
        from: 'The missed call.',
        blank: 'Nothing, unless a missed call started the run. {{contact.phone}} is the same number in any run.',
        ghl: [],
        ghlNote: 'GHL’s missed-call texts used {{contact.phone}}.',
      },
      {
        token: '{{call.to}}',
        label: 'Missed call: number called',
        fills: 'The sub-account’s number they called.',
        from: 'The missed call.',
        blank: 'Nothing, unless a missed call started the run.',
        ghl: [],
      },
      {
        token: '{{call.why}}',
        label: 'Missed call: why',
        fills: 'Why it went unanswered, as the phone company reports it: no-answer, busy, failed…',
        from: 'The missed call.',
        blank: 'Nothing, unless a missed call started the run.',
        ghl: [],
      },
    ],
  },
  {
    key: 'webhook',
    title: 'Inbound webhook',
    intro: 'The request another app sent to an Inbound webhook trigger’s URL. Only runs that trigger started have one. The trigger’s mapping reference request puts its fields in the Insert field menu.',
    fields: [
      {
        token: '{{inboundWebhookRequest.<path>}}',
        label: 'A field of the request',
        fills: 'The value at that path: {{inboundWebhookRequest.email}}, {{inboundWebhookRequest.contact.phone}}, items.0.name in a list. Names match whatever their capitals. A list of plain values comes out comma-separated, anything bigger as JSON; leave the path off for the whole request.',
        from: 'The request that started the run.',
        blank: 'Nothing, when the request didn’t have it.',
        ghl: ['{{inboundWebhookRequest.<path>}}'],
        also: ['{{webhook.<path>}}'],
        example: '{{inboundWebhookRequest.contact.email}}',
      },
    ],
  },
  {
    key: 'responses',
    title: 'Webhook responses',
    intro: 'What a Webhook action got back, when its “Keep the response for later steps” switch is on. Actions after it in the same run can use it. <step> is the action’s id (GHL’s step number in imported workflows); the Insert field menu writes it for you after a test request.',
    fields: [
      {
        token: '{{custom_webhook.<step>.response.<field>}}',
        label: 'A field of the response',
        fills: 'A field of the answer, with paths as for inbound webhooks; leave the field off for the whole answer.',
        from: 'That Webhook action’s answer in this run. A failed request keeps whatever came back too.',
        blank: 'Nothing, when that action hasn’t run yet in this run, doesn’t save its response, or the answer had no such field.',
        ghl: ['{{custom_webhook.<step>.response.<field>}}'],
        example: '{{custom_webhook.step1.response.id}}',
      },
      {
        token: '{{custom_webhook.<step>.status}}',
        label: 'The response’s status code',
        fills: 'The status code it answered with: 200, 404…',
        from: 'That Webhook action’s answer in this run.',
        blank: 'Nothing, when that action hasn’t run yet in this run, or the other app never answered.',
        ghl: [],
        example: '{{custom_webhook.step1.status}}',
      },
    ],
  },
  {
    key: 'dates',
    title: 'Dates',
    intro: 'Filled when the action runs.',
    fields: [
      {
        token: '{{today}}',
        label: 'Today’s date',
        fills: 'Today’s date in the sub-account’s timezone: 2026-11-13. Workflow actions only: calendar notifications leave it as typed.',
        from: 'The moment the action runs.',
        blank: 'Never blank.',
        ghl: [],
        ghlNote: 'GHL’s Update field action had a “current date” option: imported workflows get {{today}} in its place. GHL’s {{right_now.…}} fields don’t fill here.',
        pick: true,
      },
    ],
  },
  {
    key: 'ghl',
    title: 'GoHighLevel’s names',
    intro: 'GHL copy pasted or imported as it is keeps working: these GHL names fill from the Business Profile. The Business profile fields are the Hell-level names for the same values.',
    fields: [
      {
        token: '{{user.name}}',
        label: 'GHL: user name',
        fills: 'The owner’s full name, or their first name when there’s no full name.',
        from: 'Business Profile: owner full name.',
        blank: 'Nothing.',
        ghl: ['{{user.name}}'],
        hl: '{{account.owner_name}}',
      },
      {
        token: '{{user.first_name}}',
        label: 'GHL: user first name',
        fills: 'The owner’s first name, or the first word of their full name.',
        from: 'Business Profile: owner first name.',
        blank: 'Nothing.',
        ghl: ['{{user.first_name}}'],
        hl: '{{account.owner_first_name}}',
      },
      {
        token: '{{user.last_name}}',
        label: 'GHL: user last name',
        fills: 'The owner’s full name after its first word.',
        from: 'Business Profile: owner full name.',
        blank: 'Nothing, when the full name is one word or blank.',
        ghl: ['{{user.last_name}}'],
      },
      {
        token: '{{user.phone}}',
        label: 'GHL: user phone',
        fills: 'The first notification phone, or the business phone when there’s none.',
        from: 'Business Profile: notification phone.',
        blank: 'Nothing, when both are blank.',
        ghl: ['{{user.phone}}'],
        hl: '{{account.notify_phone}}',
      },
      {
        token: '{{user.email}}',
        label: 'GHL: user email',
        fills: 'The first notification email.',
        from: 'Business Profile: notification email.',
        blank: 'Nothing.',
        ghl: ['{{user.email}}'],
        hl: '{{account.notify_email}}',
      },
      {
        token: '{{location.name}}',
        label: 'GHL: business name',
        fills: 'The business’s name.',
        from: 'Business Profile: business name.',
        blank: 'Nothing.',
        ghl: ['{{location.name}}'],
        hl: '{{account.business_name}}',
      },
      {
        token: '{{location.phone}}',
        label: 'GHL: business phone',
        fills: 'The business phone, written (727) 555-6403.',
        from: 'Business Profile: business phone.',
        blank: 'Nothing.',
        ghl: ['{{location.phone}}'],
        hl: '{{account.business_phone}}',
      },
      {
        token: '{{location.email}}',
        label: 'GHL: business email',
        fills: 'The first notification email.',
        from: 'Business Profile: notification email.',
        blank: 'Nothing.',
        ghl: ['{{location.email}}'],
        hl: '{{account.notify_email}}',
      },
      {
        token: '{{location.address}}',
        label: 'GHL: business address',
        fills: 'The business address.',
        from: 'Business Profile: business address.',
        blank: 'Nothing.',
        ghl: ['{{location.address}}'],
        also: ['{{location.full_address}}'],
        hl: '{{account.address}}',
      },
      {
        token: '{{location.website}}',
        label: 'GHL: website',
        fills: 'The website.',
        from: 'Business Profile: website.',
        blank: 'Nothing.',
        ghl: ['{{location.website}}'],
        hl: '{{account.website}}',
      },
      {
        token: '{{custom_values.<key>}}',
        label: 'GHL: a custom value',
        fills: 'A Business Profile field by its key ({{custom_values.business_name}} is {{account.business_name}}), plus the names the Automation Copy board gave GHL’s custom values: owner_full_name, website_link and notification_email.',
        from: 'Business Profile.',
        blank: 'Custom values copied from GoHighLevel (Settings → Custom Values, “From GoHighLevel”) don’t fill: they come out blank. Use the Business profile field instead.',
        ghl: ['{{custom_values.<key>}}'],
        example: '{{custom_values.website_link}}',
      },
    ],
  },
]

/**
 * GoHighLevel names Hell-level doesn't fill (from GHL's own merge field list),
 * and what to use instead. `becomes` is what a message gets: "blank" when the
 * part before the dot is one Hell-level knows (no warning in the editor), "kept"
 * when it isn't: it goes out as typed and the editor warns "Won't fill".
 */
export const GHL_NOT_FILLED: { token: string; becomes: 'blank' | 'kept'; instead?: string; note?: string }[] = [
  { token: '{{calendar.name}}', becomes: 'kept', instead: '{{appointment.calendar}}' },
  { token: '{{appointment.end_time}}', becomes: 'blank', note: 'Hell-level’s messages have no end time yet.' },
  { token: '{{appointment.only_end_date}}', becomes: 'blank' },
  { token: '{{appointment.only_end_time}}', becomes: 'blank' },
  { token: '{{appointment.notes}}', becomes: 'blank' },
  { token: '{{appointment.user.name}}', becomes: 'blank', note: 'The team member on the appointment isn’t a merge field yet.' },
  { token: '{{user.calendar_link}}', becomes: 'blank', note: 'Paste the calendar’s booking page link into the message instead.' },
  { token: '{{user.email_signature}}', becomes: 'blank' },
  { token: '{{location.city}}', becomes: 'blank', instead: '{{account.address}}', note: 'The whole address is one field.' },
  { token: '{{location.state}}', becomes: 'blank', instead: '{{account.address}}' },
  { token: '{{location.postal_code}}', becomes: 'blank', instead: '{{account.address}}' },
  { token: '{{location.logo_url}}', becomes: 'blank', instead: '{{account.logo_url}}' },
  { token: '{{location_owner.first_name}}', becomes: 'kept', instead: '{{account.owner_first_name}}' },
  { token: '{{contact.phone_raw}}', becomes: 'blank', instead: '{{contact.phone}}' },
  { token: '{{contact.full_address}}', becomes: 'blank', instead: '{{contact.address1}}', note: 'An imported contact’s address1, city, state and postal_code fill one by one.' },
  { token: '{{contact.source}}', becomes: 'blank' },
  { token: '{{right_now.day}}', becomes: 'kept', instead: '{{today}}', note: 'Every {{right_now.…}} field stays as typed.' },
  { token: '{{message.body}}', becomes: 'kept' },
]

/** How filling works, in a few lines (the reference's last page). */
export const MERGE_RULES: string[] = [
  'Fields fill when the message goes out, from what’s true at that moment.',
  'A field with nothing to put in comes out empty. A greeting tidies up after it: “Hey {{contact.first_name}}!” becomes “Hey!”.',
  'Capitals and spaces inside the braces don’t matter: {{ Contact.First_Name }} works.',
  'A field Hell-level doesn’t know at all stays in the message as typed, and the editor warns “Won’t fill” under the message box. One that starts with a known part (contact., appointment., location.…) comes out blank instead, with no warning.',
  'The preview under a message uses a made-up lead (Jennifer Smith) with this sub-account’s Business Profile.',
]

/** What the Insert field menus offer, grouped as in the reference. */
export const MERGE_PICKER: { title: string; options: { token: string; label: string }[] }[] = MERGE_GROUPS.map((g) => ({
  title: g.title,
  options: g.fields.filter((f) => f.pick).map((f) => ({ token: f.token, label: f.label })),
})).filter((g) => g.options.length)

/** The same, as one list. {{form.<key>}} also works for any form field. */
export const MERGE_FIELDS: { token: string; label: string }[] = MERGE_PICKER.flatMap((g) => g.options)

/** The token a field puts in a message: a family's example, else itself. */
export const insertToken = (f: MergeFieldDoc) => f.example ?? f.token

/**
 * The made-up lead previews fill messages with, with the sub-account's real
 * Business Profile. No booking link: workflows never have one.
 */
export const sampleMerge = (profile: HlProfile): MergeData => ({
  contact: { firstName: 'Jennifer', lastName: 'Smith', phone: '+15125550123', email: 'jennifer@example.com', fields: { service: 'Roof repair', message: 'Small leak over the kitchen' } },
  account: profile,
  form: { full_name: 'Jennifer Smith', phone: '+15125550123', email: 'jennifer@example.com', service: 'Roof repair', message: 'Small leak over the kitchen' },
  call: { from: '+15125550123', to: '+15125550100', why: 'no-answer' },
  links: { review: 'https://genisys-hub.onrender.com/hl/l/sample' },
  appointment: {
    title: 'Jennifer Smith',
    startTime: '2026-11-03T19:00:00.000Z',
    timezone: 'America/New_York',
    calendarName: 'Free Estimate',
    location: '123 Main St',
    status: 'confirmed',
    rescheduleUrl: 'https://genisys-hub.onrender.com/hl/a/sample',
    cancelUrl: 'https://genisys-hub.onrender.com/hl/a/sample?cancel=1',
  },
})

/** {{today}} as previews show it (workflow actions fill it with the date in the sub-account's timezone). */
export function fillToday(text: string, at = new Date()): string {
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  return text.replace(/\{\{\s*today\s*\}\}/gi, day)
}
