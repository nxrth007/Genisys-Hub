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
import { parsePhoneEntries } from './phone'

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
const REMINDER_OFFSET_MS: Record<Exclude<ReminderType, 'confirmation'>, number> = {
  '1day': 24 * 60 * 60 * 1000,
  '2hr': 2 * 60 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  start: 0,
}

/** "Confirmation" doesn't fit the "X before appointment time" model
 *  the other types use — it should land right after the appointment
 *  is recorded, regardless of when the appointment itself is. We
 *  still set scheduledFor to a real Date so the dispatcher's
 *  due-window query works without special cases.
 *
 *  20-minute delay gives Mary a real window to catch a typo'd
 *  booking before the customer's phone buzzes. Editing the
 *  appointment within that window updates the reminder snapshot
 *  via the upsert path, so the customer gets the corrected info.
 *  Was 30s originally → 15 min when Alex first flagged the
 *  fat-finger risk → 20 min after live-test feedback. */
const CONFIRMATION_DELAY_MS = 20 * 60 * 1000

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
    select: { id: true, name: true, state: true, contactName: true },
  })
  const clientByLowerName = new Map(
    clients.map((c) => [c.name.toLowerCase(), c])
  )

  // Pull every Hub-booked appointment that already has reminders
  // queued via the DB-driven path (sourceKey "db:appointment:*").
  // We use these to build a content-key set so the sheet-driven
  // sync below skips any sheet row whose appointment was already
  // covered by upsertRemindersForAppointment — otherwise the cron
  // creates a parallel "sheet:Master Table:N" set of reminders and
  // the customer gets every text twice.
  const dbReminderApptIds = new Set<string>()
  {
    const dbReminders = await prisma.appointmentReminder.findMany({
      where: { sourceKey: { startsWith: 'db:appointment:' } },
      select: { appointmentId: true },
      distinct: ['appointmentId'],
    })
    for (const r of dbReminders) {
      if (r.appointmentId) dbReminderApptIds.add(r.appointmentId)
    }
  }
  // Build a content-key set (phone + apptDateTime to the minute)
  // for the covered DB appointments. Sheet rows matching one of
  // these keys are already handled by the DB path.
  const coveredContentKeys = new Set<string>()
  if (dbReminderApptIds.size > 0) {
    const dbAppts = await prisma.appointment.findMany({
      where: { id: { in: Array.from(dbReminderApptIds) } },
      select: { customerPhone: true, apptDateTime: true },
    })
    for (const a of dbAppts) {
      const key = sheetContentKey(a.customerPhone, a.apptDateTime)
      if (key) coveredContentKeys.add(key)
    }
  }

  // Confirmation reminders are gated on a master flag — leaving it
  // off means the type still appears in the template editor (so
  // admins can author copy ahead of time) but the sync skips
  // creating any rows. Flipping on without the matching backfill
  // would blast every existing appointment retroactively, which is
  // why the Settings UI runs backfillSkippedConfirmations() the
  // moment the toggle flips.
  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
    select: { confirmationEnabled: true },
  })
  const confirmationEnabled = config?.confirmationEnabled ?? false

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

    // Skip sheet rows already covered by the DB-driven upsert path
    // — those appointments get their reminders queued immediately
    // on save via /api/agent/appointments POST. Without this skip,
    // the cron would create a parallel "sheet:Master Table:N" set
    // and the customer would get every text twice.
    const contentKey = sheetContentKey(r.customerPhone, r.apptDateTime)
    if (contentKey && coveredContentKeys.has(contentKey)) continue

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
      // Confirmation rides on a different schedule than the rest
      // (fire ASAP, not "X before appointment"). Skip its creation
      // entirely when the master flag is off so the cron stays a
      // no-op for that type until admin opts in.
      if (type === 'confirmation' && !confirmationEnabled) continue

      let fireAt: Date
      let isPast: boolean
      if (type === 'confirmation') {
        // Tiny delay buys Mary a window to catch a typo'd booking
        // before the customer's phone buzzes. Dispatcher polls
        // every minute, so the customer still sees the text within
        // ~1 minute of the row landing.
        fireAt = new Date(now + CONFIRMATION_DELAY_MS)
        // Confirmation is never "past" — it's meant to fire as soon
        // as we sync, regardless of where the appointment date falls.
        isPast = false
      } else {
        fireAt = new Date(
          apptDate.getTime() -
            REMINDER_OFFSET_MS[type as Exclude<ReminderType, 'confirmation'>]
        )
        isPast = fireAt.getTime() <= now
      }

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
              clientContactName: clientLookup?.contactName ?? null,
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
              clientContactName: clientLookup?.contactName ?? null,
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

/**
 * Called when an admin first flips confirmationEnabled to true.
 * Walks the current sheet and creates a `confirmation` reminder
 * row in 'skipped' status for every appointment that matches what
 * the sync would otherwise create. Result: when the next cron tick
 * runs, those rows already exist (unique on sourceKey+type) and
 * the sync's create branch silently no-ops, so no historical
 * "Thanks for booking!" texts get blasted retroactively.
 *
 * Same shape as the Slack-delivery backfill — single-use safety
 * net for first enable, idempotent so re-running it is a no-op.
 */
export async function backfillSkippedConfirmations(): Promise<{
  recorded: number
  alreadyTracked: number
}> {
  let rows: MasterTableRow[]
  try {
    rows = await readMasterTableRows()
  } catch (err) {
    console.error('[reminders] confirmation backfill: sheet read failed:', err)
    return { recorded: 0, alreadyTracked: 0 }
  }

  let recorded = 0
  let alreadyTracked = 0

  for (const r of rows) {
    if (!r.customerName?.trim() || !r.customerPhone?.trim()) continue
    if (!r.apptDateTime) continue
    const apptDate = new Date(r.apptDateTime)
    if (isNaN(apptDate.getTime())) continue
    if ((r.status || '').toLowerCase().includes('cancel')) continue

    const sourceKey = `sheet:Master Table:${r.rowNumber}`
    const tz = timezoneForAddress(r.address)

    try {
      await prisma.appointmentReminder.create({
        data: {
          sourceKey,
          reminderType: 'confirmation',
          // Stamp scheduledFor with the appointment time so the
          // row's chronology in admin views still makes sense.
          // Status='skipped' means the dispatcher never picks it
          // up regardless of the schedule.
          scheduledFor: apptDate,
          status: 'skipped',
          errorMessage:
            'Backfilled when booking-confirmation SMS was first enabled — never attempted.',
          customerName: r.customerName,
          customerPhone: r.customerPhone,
          customerTimezone: tz,
          apptDateTime: apptDate,
          clientName: r.client ?? null,
          address: r.address ?? null,
          agentName: r.agentName ?? null,
          sheetTabTitle: 'Master Table',
          sheetRowNumber: r.rowNumber,
        },
      })
      recorded++
    } catch (err) {
      // P2002 = unique constraint hit, meaning a confirmation row
      // already exists for this (sourceKey, type). Could happen if
      // backfill runs twice, or if confirmationEnabled was flipped
      // off and back on. Idempotent no-op.
      const code =
        err instanceof Error && 'code' in err
          ? (err as { code?: string }).code
          : undefined
      if (code === 'P2002') {
        alreadyTracked++
        continue
      }
      throw err
    }
  }

  return { recorded, alreadyTracked }
}

/**
 * Run when admin flips the master `enabled` flag from false → true.
 * Marks every currently-pending AppointmentReminder as 'backfilled'
 * so the dispatcher won't fire any of them.
 *
 * Why this exists: the cron's syncRemindersFromSheet has been
 * running regardless of the master toggle, queueing pending rows
 * for every master-sheet appointment ever since the reminder
 * feature was deployed. Without this backfill, flipping master
 * enable on would walk those queued rows and SMS-blast every
 * customer already in the CRM as their windows arrive. Alex's
 * explicit constraint: "from this point forward only — no back-
 * tracking to existing customers."
 *
 * After this runs, only NEW reminders (created post-toggle by the
 * direct upsertRemindersForAppointment path or the cron picking up
 * fresh sheet rows) start in 'pending' and the dispatcher fires
 * them normally.
 *
 * Idempotent — re-running is a no-op since rows already in
 * 'backfilled' aren't matched by the `status: 'pending'` filter.
 */
export async function backfillSkippedPendingReminders(): Promise<{
  marked: number
}> {
  const result = await prisma.appointmentReminder.updateMany({
    where: { status: 'pending' },
    data: {
      status: 'backfilled',
      errorMessage:
        'Backfilled at first master-enable — pre-existing pending reminder marked skipped so existing CRM customers don’t get retroactive texts.',
    },
  })
  return { marked: result.count }
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
        clientContactName: reminder.clientContactName ?? '',
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
        phone: primaryPhoneFor(reminder.customerPhone),
        message: body,
        firstName: firstNameOf(reminder.customerName),
        lastName: lastNameOf(reminder.customerName),
        fromNumber: config.senderPhone || undefined,
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

/**
 * The customerPhone column accepts free-text — Mary often enters
 * both a Mobile and a Home line on the same row ("(555) 111-1111
 * Mobile\n(555) 222-2222 Home"). For SMS reminders we pick exactly
 * one number to text:
 *   - If multiple are present, prefer the one labeled Mobile/Cell
 *   - Otherwise the first parsed number
 *   - Falls back to the raw string when the parser finds nothing
 *     (so a single bare "(555) 123-4567" entry still works)
 *
 * Texting a landline isn't ideal but isn't catastrophic — most
 * carriers silently drop it. Picking the mobile when present avoids
 * that whenever Mary has labeled the entries.
 */
export function primaryPhoneFor(raw: string | null | undefined): string {
  if (!raw) return ''
  const { entries } = parsePhoneEntries(raw)
  if (entries.length === 0) return raw
  const mobile = entries.find(
    (e) => e.label === 'Mobile' || e.label === 'Cell'
  )
  return (mobile ?? entries[0]).number
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
 * Stable content key (phone digits + apptDateTime to the minute)
 * used to dedup sheet rows against DB-driven reminder upserts.
 * Matches the key shape used elsewhere in the codebase (Slack
 * delivery dedup, /clients ghost-row check).
 */
function sheetContentKey(
  phone: string | null | undefined,
  apptDateTime: Date | string | null | undefined,
): string | null {
  if (!phone || !apptDateTime) return null
  const digits = String(phone).replace(/\D/g, '')
  let normalized: string
  if (digits.length === 10) normalized = `+1${digits}`
  else if (digits.length === 11 && digits.startsWith('1')) normalized = `+${digits}`
  else if (digits.length >= 10) normalized = `+${digits}`
  else return null
  const d = typeof apptDateTime === 'string' ? new Date(apptDateTime) : apptDateTime
  if (isNaN(d.getTime())) return null
  const minute = new Date(Math.floor(d.getTime() / 60_000) * 60_000).toISOString()
  return `${normalized}|${minute}`
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

/* -------------------------------------------------------------------------- */
/*  DB-driven reminder upsert (immediate trigger from the agent form POST)     */
/* -------------------------------------------------------------------------- */

/**
 * Queue customer-SMS reminders for a Hub-form appointment WITHOUT
 * round-tripping through the master sheet. Mirrors what
 * syncRemindersFromSheet would create for the same appointment, but
 * keys off the DB id so it runs the moment Mary clicks Save (no
 * 5-min cron wait, no dependency on Google Sheets being up).
 *
 * Idempotent — uses sourceKey "db:appointment:{id}" + reminderType
 * with the same unique index the sheet path uses, so re-saves and
 * the later cron scan dedup-skip cleanly. When the cron later sees
 * the matching sheet row, it'd produce sourceKey "sheet:Master
 * Table:N" which is different — so we ALSO need to ignore the cron's
 * sheet-side upsert when a db: variant already exists. (Handled
 * separately in the sync cancel pass; the cron's upsert will
 * succeed for the sheet variant but the dispatcher only sends ONE
 * SMS per (customer, type) by content, so no duplicate text.)
 *
 * Honors RemindersConfig.enabled for the master gate AND
 * RemindersConfig.confirmationEnabled for the confirmation sub-gate
 * — both must be on for the corresponding rows to land in 'pending'.
 *
 * Called fire-and-forget from /api/agent/appointments POST after
 * the DB Appointment is committed.
 */
export async function upsertRemindersForAppointment(
  appointmentId: string,
): Promise<{
  upserted: number
  skippedPast: number
  skippedDisabled: boolean
}> {
  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
    select: { enabled: true, confirmationEnabled: true },
  })
  if (!config?.enabled) {
    // Master toggle off — caller's no-op. Returning the flag so the
    // POST handler's diagnostic log surfaces the reason.
    return { upserted: 0, skippedPast: 0, skippedDisabled: true }
  }

  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      client: { select: { id: true, name: true, contactName: true } },
    },
  })
  if (!appt) {
    return { upserted: 0, skippedPast: 0, skippedDisabled: false }
  }
  if (!appt.customerPhone?.trim()) {
    return { upserted: 0, skippedPast: 0, skippedDisabled: false }
  }
  // Cancelled bookings shouldn't queue reminders — same gate the
  // sheet-driven sync applies.
  if ((appt.status || '').toLowerCase().includes('cancel')) {
    return { upserted: 0, skippedPast: 0, skippedDisabled: false }
  }

  const tz = timezoneForAddress(appt.address)
  const phoneInvalid = !isValidUsPhone(appt.customerPhone)
  const sourceKey = `db:appointment:${appointmentId}`
  const now = Date.now()

  let upserted = 0
  let skippedPast = 0

  for (const type of REMINDER_TYPES) {
    if (type === 'confirmation' && !config.confirmationEnabled) continue

    let fireAt: Date
    let isPast: boolean
    if (type === 'confirmation') {
      fireAt = new Date(now + CONFIRMATION_DELAY_MS)
      isPast = false
    } else {
      fireAt = new Date(
        appt.apptDateTime.getTime() -
          REMINDER_OFFSET_MS[type as Exclude<ReminderType, 'confirmation'>],
      )
      isPast = fireAt.getTime() <= now
    }

    const status = phoneInvalid
      ? 'failed'
      : isPast
        ? 'skipped'
        : 'pending'
    if (isPast && !phoneInvalid) skippedPast++

    try {
      const existing = await prisma.appointmentReminder.findUnique({
        where: {
          sourceKey_reminderType: { sourceKey, reminderType: type },
        },
      })
      if (existing) {
        // Edit re-save — refresh the snapshot so a fixed customer
        // name / phone / appt time gets picked up before fire. The
        // appt-shifted reschedule is intentionally limited to rows
        // still 'pending' so a 'sent' or 'skipped' record doesn't
        // get retroactively re-queued.
        const apptShifted =
          existing.apptDateTime.getTime() !== appt.apptDateTime.getTime()
        await prisma.appointmentReminder.update({
          where: { id: existing.id },
          data: {
            customerName: appt.customerName,
            customerPhone: appt.customerPhone,
            customerTimezone: tz,
            apptDateTime: appt.apptDateTime,
            clientId: appt.client?.id ?? null,
            clientName: appt.client?.name ?? null,
            clientContactName: appt.client?.contactName ?? null,
            address: appt.address ?? null,
            agentName: null,
            appointmentId: appt.id,
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
              ? `Customer phone "${appt.customerPhone}" is not a valid US 10-digit number — fix the appointment and re-save.`
              : null,
            customerName: appt.customerName,
            customerPhone: appt.customerPhone,
            customerTimezone: tz,
            apptDateTime: appt.apptDateTime,
            clientId: appt.client?.id ?? null,
            clientName: appt.client?.name ?? null,
            clientContactName: appt.client?.contactName ?? null,
            address: appt.address ?? null,
            agentName: null,
            appointmentId: appt.id,
          },
        })
        upserted++
      }
    } catch (err) {
      console.error(
        `[reminders] DB upsert failed for ${sourceKey}/${type}:`,
        err,
      )
    }
  }

  return { upserted, skippedPast, skippedDisabled: false }
}
