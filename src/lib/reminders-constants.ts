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
//
// '1day' (day-before) was DROPPED 2026-06-24 with the "dispatched"
// gating change: the customer sequence is now a short confirmation at
// booking + four same-day reminders (4hr/2hr/30min/start) that only
// arm once an agent marks the appointment "dispatched". '1day' stays
// in the ReminderType union + DEFAULT_TEMPLATES so any in-flight rows
// already queued under the old flow still render, but it's no longer
// queued for new appointments.
export const REMINDER_TYPES: ReminderType[] = [
  'confirmation',
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
// Copy strategy (Alex-approved 2026-06-24, "dispatched" flow): a short
// confirmation FYI fires at booking (no time/Y/N — the appointment
// isn't locked yet, "dispatched" is the lock step). The four same-day
// reminders are warm logistics, all referencing the energy expert who
// will reach out. These bodies are mirrored into the Global
// ReminderTemplate rows by the 20260624120000_dispatched_reminder_copy
// migration (the dispatcher reads the DB row, this is the fallback) —
// edit further in Settings → Reminders, not here.
export const DEFAULT_TEMPLATES: Record<ReminderType, string> = {
  confirmation:
    'Hi {customerName}, thanks for speaking with our representative. We\'ll keep you updated about your appointment with an energy expert in your area.',
  // Day-before — retired from the active sequence (see REMINDER_TYPES).
  // Kept only so in-flight rows queued under the old flow still render.
  '1day':
    'Hi {customerName}, reminder: your {clientName} appointment is tomorrow at {apptTime}.',
  '4hr':
    'Hi {customerName}, just a heads up — your appointment with {clientName} is scheduled for today at {apptTime}. An energy expert will be reaching out then to go over your solar options and potential savings. Talk soon.',
  '2hr':
    'Hi {customerName}, reminder that your appointment with {clientName} is coming up at {apptTime}. Your energy expert will be reaching out in a couple of hours to go over your solar options and answer any questions.',
  '30min':
    'Hi {customerName}, your appointment with {clientName} starts in about 30 minutes. Please keep your phone nearby — your energy expert will be reaching out shortly.',
  start:
    'Hi {customerName}, your appointment with {clientName} is starting now. Your energy expert will be reaching out shortly.',
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
