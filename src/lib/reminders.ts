/**
 * Appointment SMS reminder library — synced from the master Google
 * Sheet on every scheduler tick (so manual sheet entries get
 * reminders, not just Hub-booked rows). Dispatched via the existing
 * GHL SMS helper.
 *
 * Flow per scheduler tick:
 *   1. syncRemindersFromSheet() — read every active sheet row, upsert
 *      one reminder per (row, type) for the four windows. Cancel
 *      reminders whose source row went away or got marked cancelled.
 *   2. dispatchDueReminders() — pick up status='pending' rows whose
 *      scheduledFor <= now() and send them, marking sent/failed.
 */

import { prisma } from './prisma'
import { readMasterTableRows, type MasterTableRow } from './drive'
import { sendSmsToPhone } from './ghl'
import { formatInTimezone, timezoneForAddress } from './timezone'

// Re-export the client-safe constants so existing server-side
// callers (scheduler, dispatcher, lib helpers) can keep importing
// from this single module. Client code should import from
// './reminders-constants' directly to avoid pulling Prisma into the
// browser bundle.
export {
  REMINDER_TYPES,
  REMINDER_LABELS,
  DEFAULT_TEMPLATES,
  type ReminderType,
} from './reminders-constants'
import { REMINDER_TYPES, DEFAULT_TEMPLATES, type ReminderType } from './reminders-constants'

/**
 * Window in milliseconds before the appointment for each reminder
 * type. `start` is 0 — fires at the appointment moment itself.
 */
const REMINDER_OFFSET_MS: Record<ReminderType, number> = {
  '1day': 24 * 60 * 60 * 1000,
  '2hr': 2 * 60 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  start: 0,
}

// DEFAULT_TEMPLATES + ReminderType are re-exported above; the values
// live in reminders-constants.ts so client code can import them
// without dragging Prisma along.

/* -------------------------------------------------------------------------- */

type SyncResult = {
  scanned: number
  upserted: number
  skippedPast: number
  cancelled: number
}

/**
 * Idempotent — reads the master sheet, upserts one reminder row per
 * (sheet row, reminder type) for every appointment whose datetime is
 * still in the future. Anything already past gets marked 'skipped'
 * at insert time so the dispatcher never accidentally fires it.
 *
 * Also marks reminders 'cancelled' when:
 *   - The source sheet row no longer exists (row deleted)
 *   - The source row's status changed to "cancelled"
 *   - The source row's apptDateTime moved (we cancel + recreate)
 */
export async function syncRemindersFromSheet(): Promise<SyncResult> {
  // Read sheet — same source the Master Tracker UI uses, so manual
  // entries + Hub-booked rows are both covered.
  let rows: MasterTableRow[]
  try {
    rows = await readMasterTableRows()
  } catch (err) {
    // Non-fatal: a one-off Drive failure shouldn't break the cron.
    // The next tick re-tries.
    console.error('[reminders] sync: failed to read sheet:', err)
    return { scanned: 0, upserted: 0, skippedPast: 0, cancelled: 0 }
  }

  // Pull existing client list once so we can map sheet "Client" cell
  // values to canonical Client ids (state-based fallback when blank).
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, state: true },
  })
  const clientByLowerName = new Map(
    clients.map((c) => [c.name.toLowerCase(), c])
  )

  // Track every sourceKey we touched in this run — used at the end
  // to cancel any stranded reminders whose source no longer matches
  // an active sheet row.
  const touchedSourceKeys = new Set<string>()
  let upserted = 0
  let skippedPast = 0

  const now = Date.now()

  for (const r of rows) {
    if (!r.customerName?.trim() || !r.customerPhone?.trim()) continue
    if (!r.apptDateTime) continue
    const apptDate = new Date(r.apptDateTime)
    if (isNaN(apptDate.getTime())) continue

    // Honor the row-level "cancelled" status — if the call center
    // marked it cancelled in the sheet, don't keep the reminders
    // active. The cancel pass at the end of this function picks
    // these up by NOT adding them to touchedSourceKeys.
    if ((r.status || '').toLowerCase().includes('cancel')) continue

    const sourceKey = `sheet:${'Master Table'}:${r.rowNumber}`
    touchedSourceKeys.add(sourceKey)

    const tz = timezoneForAddress(r.address)
    const clientLookup = r.client
      ? clientByLowerName.get(r.client.toLowerCase())
      : null

    // Phone validation — bad phones at sync time get marked 'failed'
    // with a clear error message rather than sitting as 'pending' and
    // surfacing as a confusing GHL error later. Done once per sheet
    // row so we don't repeat the regex check four times for the four
    // reminder types.
    const phoneInvalid = !isValidUsPhone(r.customerPhone)

    for (const type of REMINDER_TYPES) {
      const fireAt = new Date(apptDate.getTime() - REMINDER_OFFSET_MS[type])
      const isPast = fireAt.getTime() <= now
      const status = phoneInvalid
        ? 'failed'
        : isPast
          ? 'skipped'
          : 'pending'
      if (isPast && !phoneInvalid) skippedPast++

      // Upsert by (sourceKey, reminderType). Updates the snapshot
      // fields if the source row was edited; the schedule + status
      // only flip on first insert (we don't auto-revive a skipped
      // reminder if the appointment moves earlier — admin would
      // need to delete + re-sync, which is fine for the use case).
      try {
        const existing = await prisma.appointmentReminder.findUnique({
          where: {
            sourceKey_reminderType: { sourceKey, reminderType: type },
          },
        })
        if (existing) {
          // If apptDateTime moved, reschedule. Otherwise just refresh
          // snapshot fields so an edited customer name / phone gets
          // picked up before fire.
          const apptShifted =
            existing.apptDateTime.getTime() !== apptDate.getTime()
          await prisma.appointmentReminder.update({
            where: { id: existing.id },
            data: {
              customerName: r.customerName,
              customerPhone: r.customerPhone,
              customerTimezone: tz,
              apptDateTime: apptDate,
              clientId: clientLookup?.id ?? null,
              clientName: clientLookup?.name ?? r.client ?? null,
              address: r.address ?? null,
              agentName: r.agentName ?? null,
              sheetTabTitle: 'Master Table',
              sheetRowNumber: r.rowNumber,
              ...(apptShifted &&
                existing.status === 'pending' && {
                  scheduledFor: fireAt,
                  status,
                }),
            },
          })
        } else {
          await prisma.appointmentReminder.create({
            data: {
              sourceKey,
              reminderType: type,
              scheduledFor: fireAt,
              status,
              errorMessage: phoneInvalid
                ? `Customer phone "${r.customerPhone}" is not a valid US 10-digit number — fix in the sheet and re-sync.`
                : null,
              customerName: r.customerName,
              customerPhone: r.customerPhone,
              customerTimezone: tz,
              apptDateTime: apptDate,
              clientId: clientLookup?.id ?? null,
              clientName: clientLookup?.name ?? r.client ?? null,
              address: r.address ?? null,
              agentName: r.agentName ?? null,
              sheetTabTitle: 'Master Table',
              sheetRowNumber: r.rowNumber,
            },
          })
          upserted++
        }
      } catch (err) {
        console.error(
          `[reminders] upsert failed for ${sourceKey}/${type}:`,
          err
        )
      }
    }
  }

  // Cancel pass — anything still pending whose sourceKey wasn't
  // touched this run means the source row is gone (deleted or
  // cancelled). Mark them cancelled so they stop firing.
  const stranded = await prisma.appointmentReminder.updateMany({
    where: {
      status: 'pending',
      sourceKey: { startsWith: 'sheet:Master Table:' },
      NOT: { sourceKey: { in: Array.from(touchedSourceKeys) } },
    },
    data: { status: 'cancelled' },
  })

  return {
    scanned: rows.length,
    upserted,
    skippedPast,
    cancelled: stranded.count,
  }
}

/* -------------------------------------------------------------------------- */

type DispatchResult = {
  attempted: number
  sent: number
  failed: number
}

/**
 * Picks up status='pending' reminders whose scheduledFor has arrived
 * and sends them via GHL. Atomic claim (status pending → sending) so
 * we don't double-send if two scheduler ticks race.
 *
 * Buffer: we fire reminders that are due within the next 60 seconds
 * so a tick that's slightly late doesn't miss the window.
 */
export async function dispatchDueReminders(): Promise<DispatchResult> {
  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config?.enabled) return { attempted: 0, sent: 0, failed: 0 }

  const now = new Date()
  const fireWindowEnd = new Date(now.getTime() + 60 * 1000)

  // Load due rows (cap to 25 per tick to keep latency bounded if a
  // big batch of reminders bunches up).
  const due = await prisma.appointmentReminder.findMany({
    where: {
      status: 'pending',
      scheduledFor: { lte: fireWindowEnd },
    },
    orderBy: { scheduledFor: 'asc' },
    take: 25,
  })

  let sent = 0
  let failed = 0

  for (const reminder of due) {
    // Quiet hours guard — don't send SMS outside the configured
    // window in the *customer's* local timezone. Compliance-driven
    // (TCPA generally caps to 8 AM–9 PM). Reminders that would land
    // outside stay pending and get retried on subsequent ticks; the
    // next pass that lands inside the window picks them up.
    if (isInQuietHours(reminder.customerTimezone, config)) continue

    // Atomic claim — if another tick beat us to this row the count
    // comes back 0 and we skip.
    const claim = await prisma.appointmentReminder.updateMany({
      where: { id: reminder.id, status: 'pending' },
      data: { status: 'sending' },
    })
    if (claim.count === 0) continue

    try {
      const template = await loadTemplate(
        reminder.clientId,
        reminder.reminderType as ReminderType
      )
      if (!template?.enabled) {
        // Template disabled — silently skip without marking failed.
        await prisma.appointmentReminder.update({
          where: { id: reminder.id },
          data: { status: 'cancelled', errorMessage: 'Template disabled' },
        })
        continue
      }

      const body = renderTemplate(template.body, {
        // {customerName} resolves to the first name only — friendlier
        // than a full all-caps "TONY UGAS" in an SMS. The full name
        // is still available via {customerFullName} for admins who
        // want it (formal language, legal opt-out copy, etc.).
        customerName: customerFirstNameForSms(reminder.customerName),
        customerFullName: reminder.customerName,
        clientName: reminder.clientName ?? 'our partner',
        address: reminder.address ?? '',
        agentName: reminder.agentName ?? '',
        apptDate: formatInTimezone(reminder.apptDateTime, reminder.customerTimezone, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        }),
        apptTime: formatInTimezone(reminder.apptDateTime, reminder.customerTimezone, {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }),
        apptDateTime: formatInTimezone(
          reminder.apptDateTime,
          reminder.customerTimezone,
          {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          }
        ),
      })

      const result = await sendSmsToPhone(config.vaultEntryName, {
        phone: reminder.customerPhone,
        message: body,
        firstName: firstNameOf(reminder.customerName),
        lastName: lastNameOf(reminder.customerName),
      })

      await prisma.appointmentReminder.update({
        where: { id: reminder.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          messageBody: body,
          ghlContactId: result.contactId,
          ghlMessageId: result.messageId ?? null,
          ghlConversationId: result.conversationId ?? null,
          errorMessage: null,
        },
      })
      sent++
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Send failed'
      await prisma.appointmentReminder.update({
        where: { id: reminder.id },
        data: { status: 'failed', errorMessage: message },
      })
      failed++
    }
  }

  return { attempted: due.length, sent, failed }
}

/* -------------------------------------------------------------------------- */

/**
 * Resolve the active template for (clientId, type). Falls back, in
 * order:
 *   1. Per-client template row
 *   2. Global template row (clientId null)
 *   3. Hardcoded DEFAULT_TEMPLATES from this file
 *
 * Returning `enabled: false` means the dispatcher should skip this
 * reminder entirely (admin disabled it). Hardcoded defaults are
 * always enabled.
 */
async function loadTemplate(
  clientId: string | null,
  type: ReminderType
): Promise<{ body: string; enabled: boolean } | null> {
  if (clientId) {
    const t = await prisma.reminderTemplate.findUnique({
      where: { clientId_reminderType: { clientId, reminderType: type } },
    })
    if (t) return { body: t.body, enabled: t.enabled }
  }
  // Global override (clientId null)
  const global = await prisma.reminderTemplate.findFirst({
    where: { clientId: null, reminderType: type },
  })
  if (global) return { body: global.body, enabled: global.enabled }
  // Hardcoded fallback
  return { body: DEFAULT_TEMPLATES[type], enabled: true }
}

/**
 * Replace {placeholders} in the template body with values from
 * the variables map. Unknown placeholders are left as-is so an
 * admin typo doesn't silently drop content; they'll see {foo} in
 * the sent message and notice.
 */
export function renderTemplate(
  body: string,
  vars: Record<string, string>
): string {
  return body.replace(/\{(\w+)\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{${key}}`
  )
}

function firstNameOf(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  return trimmed.split(/\s+/)[0]
}

function lastNameOf(name: string): string | undefined {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return undefined
  return parts.slice(1).join(' ')
}

/**
 * Loose validation — accept anything that contains a 10-digit US
 * phone number. Sheet entries are wildly inconsistent in formatting
 * ("(555) 123-4567" / "5551234567" / "1-555-123-4567"), so we strip
 * non-digits and check the digit count rather than enforcing a
 * specific format. The send path normalizes to E.164 separately.
 */
function isValidUsPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '')
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))
}

/**
 * Compute "now" in the customer's timezone as an HH:mm string and
 * decide whether it falls inside the configured quiet-hours window.
 * Window wraps midnight when start > end (the common case for
 * "9 PM to 8 AM the next morning"); a non-wrapping window like
 * "12:00 to 13:00" works too via the alternate branch below.
 */
function isInQuietHours(
  timezone: string,
  config: { quietHoursStart: string; quietHoursEnd: string }
): boolean {
  const start = config.quietHoursStart
  const end = config.quietHoursEnd
  if (!start || !end || start === end) return false
  const now = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date())
  // Lexicographic compare works for HH:mm — both sides are zero-
  // padded same-width strings.
  if (start > end) {
    // Wraps midnight: quiet from start..23:59 OR 00:00..end
    return now >= start || now < end
  }
  return now >= start && now < end
}

/**
 * SMS-friendly first-name extraction. Sheet entries often arrive in
 * all-caps ("TONY UGAS") which reads as shouting in a text message,
 * so we Title-Case any token that's entirely uppercase. Names with
 * intentional inner capitalization ("DeShawn", "MacArthur") are
 * left alone — they don't trigger the all-uppercase check.
 */
export function customerFirstNameForSms(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? fullName.trim()
  if (!first) return ''
  // All-uppercase + at least 2 letters → safe to assume the source
  // was just sheet-shouted, not a stylistic choice.
  if (first.length > 1 && first === first.toUpperCase() && /[A-Z]/.test(first)) {
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
  }
  return first
}
