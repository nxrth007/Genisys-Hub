/**
 * Constants + types for the reminder system that are safe to import
 * from client components. The full library at lib/reminders.ts pulls
 * in Prisma + Drive helpers (server-only); this file is the public
 * surface the Settings UI consumes.
 */

export type ReminderType =
  | 'confirmation'
  | '1day'
  | '4hr'
  | '2hr'
  | '30min'
  | 'start'

// Order matters here — Settings' template editor renders cells in
// this order, and the dispatcher logs in this order too. Put
// confirmation first since it's the earliest one in the lifecycle.
// '4hr' added 2026-06-11 per Alex; slots between day-before and
// 2hr to keep lifecycle order.
export const REMINDER_TYPES: ReminderType[] = [
  'confirmation',
  '1day',
  '4hr',
  '2hr',
  '30min',
  'start',
]

export const REMINDER_LABELS: Record<ReminderType, string> = {
  confirmation: 'Booking confirmation',
  '1day': 'Day before',
  '4hr': '4 hours before',
  '2hr': '2 hours before',
  '30min': '30 minutes before',
  start: 'Appointment start',
}

/**
 * Hardcoded fallback copy. Server-side dispatch falls back to these
 * when no DB template exists for (clientId, reminderType). The
 * Settings UI shows them as the "default" cell content so admins see
 * what would actually go out.
 */
// Copy strategy (Alex-approved 2026-06-11): ONE hard Y/N ask at
// day-before (early enough that an "N" lets the call center rebook
// the slot), one soft check at 4hr, everything else pure logistics.
// Repeating the ask on every message trains customers to ignore it
// and drives STOP replies. "Reply STOP" lives on the confirmation
// (first touch) only, keeping the later messages at 1 SMS segment.
// The same bodies are seeded into the Global ReminderTemplate rows
// by the 20260611120000_reminder_copy_refresh migration — edit
// further in Settings → Reminders, not here.
export const DEFAULT_TEMPLATES: Record<ReminderType, string> = {
  confirmation:
    'Hi {customerName}, thanks for speaking with our representative — your appointment with {clientName} is set for {apptDateTime}. We\'ll text you reminders as it gets close. Reply STOP to opt out.',
  '1day':
    'Hi {customerName}, reminder: your {clientName} appointment is tomorrow at {apptTime}. Will you be able to make it? Reply Y to confirm or N to reschedule.',
  '4hr':
    'Hi {customerName}, we\'re all set for today at {apptTime} with {clientName}. If anything has changed, just reply here and we\'ll help you reschedule.',
  '2hr':
    'Hi {customerName}, quick heads up — your {clientName} appointment is in 2 hours at {apptTime}.',
  '30min':
    'Hi {customerName}, your {clientName} appointment starts in 30 minutes. Please be available — talk soon!',
  start:
    'Hi {customerName}, it\'s time! A {clientName} representative will reach out now.',
}

/**
 * Template variables the renderer recognizes. Each one carries:
 *  - `key`         — the placeholder key without braces ("customerName")
 *  - `placeholder` — the form admins type/click ("{customerName}")
 *  - `label`       — short, friendly button label
 *  - `sample`      — example fill used in the live preview + length hint
 *  - `description` — tooltip on the chip explaining what it resolves to
 *
 * The Settings UI iterates this for click-to-insert chips so admins
 * never have to type a variable by hand (and never have to wonder
 * why `{customername}` showed up literally in a sent SMS — the
 * editor flags unknown keys before save).
 */
export type TemplateVariable = {
  key: string
  placeholder: string
  label: string
  sample: string
  description: string
}

export const TEMPLATE_VARIABLES: ReadonlyArray<TemplateVariable> = [
  {
    key: 'customerName',
    placeholder: '{customerName}',
    label: 'Customer first name',
    sample: 'Tony',
    description:
      "First name only, with all-caps Title-Cased ('TONY' → 'Tony'). The default.",
  },
  {
    key: 'customerFullName',
    placeholder: '{customerFullName}',
    label: 'Customer full name',
    sample: 'Tony Ugas',
    description:
      'Full name as logged. Use only when formal language is needed (e.g. legal opt-out copy).',
  },
  {
    key: 'clientName',
    placeholder: '{clientName}',
    label: 'Client business name',
    sample: 'Brighton Capital Solar',
    description:
      'Business name of the Genisys client (the company), e.g. "Brighton Capital Solar".',
  },
  {
    key: 'clientContactName',
    placeholder: '{clientContactName}',
    label: 'Client contact name',
    sample: 'David Mehta',
    description:
      'Primary human contact at the client (the person), e.g. "David Mehta". Empty if no contact is set.',
  },
  {
    key: 'apptDate',
    placeholder: '{apptDate}',
    label: 'Appointment date',
    sample: 'Tuesday, May 12',
    description:
      "Day + month + day, rendered in the customer's local timezone.",
  },
  {
    key: 'apptTime',
    placeholder: '{apptTime}',
    label: 'Appointment time',
    sample: '2:30 PM',
    description: "Hour + minute, in the customer's local timezone.",
  },
  {
    key: 'apptDateTime',
    placeholder: '{apptDateTime}',
    label: 'Date + time',
    sample: 'Tuesday, May 12 at 2:30 PM',
    description: 'Full date and time combined into one phrase.',
  },
  {
    key: 'address',
    placeholder: '{address}',
    label: 'Address',
    sample: '1533 218th St, Torrance, CA 90501',
    description: 'Customer address as logged on the master sheet.',
  },
  {
    key: 'agentName',
    placeholder: '{agentName}',
    label: 'Booking agent',
    sample: 'Jane Doe',
    description: 'Name of the agent who booked the appointment.',
  },
]

/** Set of valid placeholder keys for unknown-variable detection. */
export const VALID_PLACEHOLDER_KEYS = new Set(
  TEMPLATE_VARIABLES.map((v) => v.key)
)

/** Sample fills indexed by key — used by the editor's live preview
 *  and the SMS-length hint. Mirrors what the dispatcher renders. */
export const SAMPLE_FILLS: Record<string, string> = Object.fromEntries(
  TEMPLATE_VARIABLES.map((v) => [v.key, v.sample])
)
