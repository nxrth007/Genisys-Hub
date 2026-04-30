/**
 * Constants + types for the reminder system that are safe to import
 * from client components. The full library at lib/reminders.ts pulls
 * in Prisma + Drive helpers (server-only); this file is the public
 * surface the Settings UI consumes.
 */

export type ReminderType = '1day' | '2hr' | '30min' | 'start'

export const REMINDER_TYPES: ReminderType[] = ['1day', '2hr', '30min', 'start']

export const REMINDER_LABELS: Record<ReminderType, string> = {
  '1day': 'Day before',
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
export const DEFAULT_TEMPLATES: Record<ReminderType, string> = {
  '1day':
    'Hi {customerName}, this is a reminder that you have an appointment with {clientName} tomorrow at {apptTime}. Reply STOP to opt out.',
  '2hr':
    'Hi {customerName}, just a heads up — your {clientName} appointment is in 2 hours at {apptTime}. Talk soon!',
  '30min':
    'Hi {customerName}, your {clientName} appointment is starting in 30 minutes. Make sure you’re ready. Reply STOP to opt out.',
  start:
    'Hi {customerName}, your {clientName} appointment is starting now. A representative will reach out shortly.',
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
    label: 'Client name',
    sample: 'Brighton Capital Solar',
    description: 'The Genisys client this appointment is booked for.',
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
