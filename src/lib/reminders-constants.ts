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

/** Template variables the renderer recognizes. Kept as a list so the
 *  Settings UI can show admins what placeholders are valid. */
export const TEMPLATE_PLACEHOLDERS = [
  '{customerName}',
  '{clientName}',
  '{apptDate}',
  '{apptTime}',
  '{apptDateTime}',
  '{address}',
  '{agentName}',
] as const
