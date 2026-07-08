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
import { type MasterTableRow } from './drive'
import { readAllSheetRows, rowSourceKey } from './secondary-sheets'
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
  '4hr': 4 * 60 * 60 * 1000,
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
 *  Was 30s originally → 15 min → 20 min, then back to 0 once Alex
 *  flipped the buffer onto the client-alert path instead (see
 *  CLIENT_ALERT_BUFFER_MS in client-alert.ts). The customer-side
 *  confirmation now fires on the next dispatch tick (worst case
 *  ~60s) so the homeowner gets immediate validation that their
 *  appointment is real.
 *
 *  As of 2026-06-08, confirmations are ALSO exempt from the quiet-
 *  hours gate (see dispatchDueReminders). Treating a booking ack as
 *  TCPA-protected marketing made evening bookings look broken —
 *  customer booked at 8 PM ET → confirmation held for 12h → "Thanks
 *  for booking!" arrived at 8 AM, after the customer had moved on.
 *  Transactional acks to an action the customer just took with the
 *  client are not regulated as marketing under TCPA. */
const CONFIRMATION_DELAY_MS = 0

/**
 * Per-type cutoff for "this reminder is too stale to be useful." If
 * a row's scheduledFor is older than this threshold by the time the
 * dispatcher picks it up, we mark it 'skipped' with a clear reason
 * instead of sending. Two reasons we need this:
 *
 *   1. Safety belt for the confirmation-quiet-hours exemption — if
 *      a pending confirmation has been sitting in the queue for >24h
 *      for ANY reason (e.g. a long master-toggle outage), the deploy
 *      that exempts confirmations from quiet hours can't accidentally
 *      blast a customer who booked days ago.
 *
 *   2. Fixes the long-standing bug where 2hr + 30min reminders for an
 *      early-morning appointment all queue up overnight in quiet
 *      hours, then fire SIMULTANEOUSLY at 08:00 when the window opens
 *      — moments before or at the appointment start. With these
 *      thresholds, those uselessly-late reminders cleanly skip
 *      instead of texting the customer "your appointment is in 2
 *      hours" 5 minutes after the appointment already started.
 *
 * Thresholds reflect when the wording stops matching reality:
 *   - confirmation: 24h (customer remembers booking ~within a day)
 *   - 1day:        12h (after 12h late, appt is <12h out — "tomorrow"
 *                       is wrong)
 *   - 4hr:          2h (after 2h late, appt is <2h out — the 2hr
 *                       reminder takes over from there)
 *   - 2hr:          1h (after 1h late, appt is <1h out — call it a
 *                       30-min reminder, not 2hr)
 *   - 30min:       25min (after 25min late, customer gets it within 5
 *                         min of start — useless)
 *   - start:        5min (must be on time or skipped)
 */
const STALENESS_THRESHOLD_MS: Record<ReminderType, number> = {
  confirmation: 24 * 60 * 60 * 1000,
  '1day': 12 * 60 * 60 * 1000,
  '4hr': 2 * 60 * 60 * 1000,
  '2hr': 1 * 60 * 60 * 1000,
  '30min': 25 * 60 * 1000,
  start: 5 * 60 * 1000,
}

// DEFAULT_TEMPLATES + ReminderType are re-exported above; the values
// live in reminders-constants.ts so client code can import them
// without dragging Prisma along.

/* -------------------------------------------------------------------------- */

type SyncResult = {
  scanned: number
  upserted: number
  skippedPast: number
  skippedDuplicatePhone: number
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
  // Read every configured sheet (primary "Master Table" + every
  // registered SecondarySheet — e.g. Yassin's Forward Energy +
  // Brighton Capital sheets). Each row arrives tagged with its
  // source so we can build per-sheet dedup keys below.
  let rows: Awaited<ReturnType<typeof readAllSheetRows>>
  try {
    rows = await readAllSheetRows()
  } catch (err) {
    // Non-fatal: a one-off Drive failure shouldn't break the cron.
    // The next tick re-tries.
    console.error('[reminders] sync: failed to read sheet:', err)
    return {
      scanned: 0,
      upserted: 0,
      skippedPast: 0,
      skippedDuplicatePhone: 0,
      cancelled: 0,
    }
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
  //
  // ALSO build a phone → [appt epoch ms] map for a FUZZY fallback.
  // The exact content key requires the sheet's parsed time to match
  // the DB time to the minute — but a Hub-booked appointment and
  // its mirrored sheet row can land hours apart when a timezone-
  // naive datetime string round-trips through the sheet (the Fayaz
  // Shaik incident, 2026-06-11: DB stored 6 PM Mountain / 00:00Z,
  // the sheet copy parsed back as 22:00Z — 2 h off — so the exact
  // key missed and the customer got TWO reminder tracks, one at
  // 6 PM and one at "8 PM"). Matching phone + within ±12 h collapses
  // that fork while still allowing a genuinely separate appointment
  // for the same customer on another day to keep its own reminders.
  const coveredContentKeys = new Set<string>()
  const coveredPhoneTimes = new Map<string, number[]>()
  if (dbReminderApptIds.size > 0) {
    const dbAppts = await prisma.appointment.findMany({
      where: { id: { in: Array.from(dbReminderApptIds) } },
      select: { customerPhone: true, apptDateTime: true },
    })
    for (const a of dbAppts) {
      const key = sheetContentKey(a.customerPhone, a.apptDateTime)
      if (key) coveredContentKeys.add(key)
      const phone = digitsOnlyPhone(a.customerPhone)
      if (phone) {
        const arr = coveredPhoneTimes.get(phone) ?? []
        arr.push(a.apptDateTime.getTime())
        coveredPhoneTimes.set(phone, arr)
      }
    }
  }
  const FUZZY_DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000

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

  // Dispatch gate data — the four timed reminders (4hr/2hr/30min/start)
  // only arm once the row's appointment has Dispatch Status "confirmed".
  // That's a DB-only field, so map it by appointment content key (phone
  // + appt time) and sheet rowNumber. Confirmation is exempt (it's the
  // booking-time FYI). A sheet row whose appointment isn't confirmed (or
  // has no DB appointment yet) gets only the confirmation, no timed set.
  // Keyed by CONTENT identity (phone + appt time) ONLY, not sheet
  // rowNumber — masterSheetRowNumber is corrupted (rows shift, so it
  // points at the wrong appointment), which could arm reminders off a
  // different confirmed appointment's stale row number.
  const dispatchByContent = new Map<string, string>()
  {
    const dispatchAppts = await prisma.appointment.findMany({
      select: {
        customerPhone: true,
        apptDateTime: true,
        dispatchStatus: true,
      },
    })
    for (const a of dispatchAppts) {
      const key = sheetContentKey(a.customerPhone, a.apptDateTime)
      if (key) dispatchByContent.set(key, a.dispatchStatus)
    }
  }

  // Track every sourceKey we touched in this run — used at the end
  // to cancel any stranded reminders whose source no longer matches
  // an active sheet row.
  const touchedSourceKeys = new Set<string>()
  let upserted = 0
  let skippedPast = 0

  // Phone-level dedup within this sync run. One customer phone =
  // one reminder set, regardless of how many sheet rows mention
  // them. Added 2026-05-13 after Ron Running showed up with 8 pending
  // reminders (two sheet rows entered by mistake, four reminders
  // each). The unique constraint on (sourceKey, reminderType) only
  // prevents duplicates within the same sheet row; without phone
  // dedup, two rows for the same customer each produced their own
  // four reminders.
  //
  // First sheet row encountered wins (rows arrive in sheet row-
  // number order). Subsequent rows with the same phone get skipped,
  // and the cancel pass at the bottom marks any leftover reminders
  // from their sourceKey as cancelled — so existing duplicates
  // self-heal on the next tick. If the winning row's appt time gets
  // edited, the upsert path updates scheduledFor in place; the
  // customer's single reminder set just shifts.
  //
  // Tradeoff: a customer with two genuinely-distinct appointments
  // (e.g. consultation in the morning, follow-up in the afternoon)
  // only gets reminders for one. That's rare enough to be acceptable;
  // admin can always send a manual SMS for the second appt.
  const seenSheetPhones = new Set<string>()
  let skippedDuplicatePhone = 0

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
    // Fuzzy fallback: same phone + a DB appointment within ±12 h.
    // Catches the timezone-drift case where the exact key misses
    // (see coveredPhoneTimes above). A DB-booked appointment is
    // authoritative; its sheet mirror should never spawn a second
    // track even if the parsed time drifted a couple hours.
    const rowPhone = digitsOnlyPhone(r.customerPhone)
    if (rowPhone) {
      const dbTimes = coveredPhoneTimes.get(rowPhone)
      if (
        dbTimes &&
        dbTimes.some(
          (t) => Math.abs(t - apptDate.getTime()) <= FUZZY_DEDUP_WINDOW_MS,
        )
      ) {
        continue
      }
    }

    // Phone-only dedup — one customer = one reminder set per sync
    // run. See the seenSheetPhones declaration above for the why.
    // First sheet row encountered wins; subsequent rows for the same
    // phone get skipped, and the cancel pass at the bottom cleans up
    // any stranded reminders from their sourceKey on this and future
    // ticks.
    const phoneDigits = digitsOnlyPhone(r.customerPhone)
    if (phoneDigits) {
      if (seenSheetPhones.has(phoneDigits)) {
        skippedDuplicatePhone++
        console.log(
          `[reminders] skipping sheet row ${r.rowNumber} — phone ${phoneDigits} already covered earlier in this run (likely duplicate booking on the sheet)`,
        )
        continue
      }
      seenSheetPhones.add(phoneDigits)
    }

    // sourceKey shape: "sheet:Master Table:N" for primary rows
    // (legacy format, keeps existing reminder ledger entries
    // matching), "sheet:<spreadsheetId>:N" for secondary-sheet
    // rows so two secondary sheets can have a row 5 without
    // colliding in the unique index.
    const sourceKey = rowSourceKey(r)
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

      // Dispatch gate — the four timed reminders only arm once the
      // appointment's Dispatch Status is "confirmed". Match by content
      // identity (phone + time) only; default to not_dispatched when
      // there's no matching confirmed DB appointment. Confirmation is
      // exempt (booking-time FYI).
      if (type !== 'confirmation') {
        const rowDispatch =
          (contentKey ? dispatchByContent.get(contentKey) : undefined) ??
          'not_dispatched'
        if (rowDispatch !== 'confirmed') continue
      }

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
              // Sheet metadata: track which sheet/tab this row came
              // from so admin tooling can navigate to the source. For
              // primary rows this is always "Master Table"; for
              // secondaries it's the SecondarySheet.tabTitle.
              sheetTabTitle:
                r.source.kind === 'secondary' ? r.source.tabTitle : 'Master Table',
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
  //
  // The startsWith prefix used to be "sheet:Master Table:" — narrow
  // enough that secondary-sheet sourceKeys ("sheet:<id>:N") slipped
  // through and never got cancelled. Broadened to "sheet:" now,
  // which covers both. Note: DB-keyed reminders ("db:appointment:*")
  // are untouched — those have their own lifecycle tied to the
  // Appointment row's onDelete: Cascade, which already removes
  // their reminders.
  const stranded = await prisma.appointmentReminder.updateMany({
    where: {
      status: 'pending',
      sourceKey: { startsWith: 'sheet:' },
      NOT: { sourceKey: { in: Array.from(touchedSourceKeys) } },
    },
    data: { status: 'cancelled' },
  })

  return {
    scanned: rows.length,
    upserted,
    skippedPast,
    skippedDuplicatePhone,
    cancelled: stranded.count,
  }
}

/** Strip all non-digits and normalize to the 10-digit US form for
 *  customer-phone equality. Handles "(909) 732-2032", "9097322032",
 *  "+1 909-732-2032", and "1-909-732-2032" all → "9097322032". Used
 *  as the dedup key in syncRemindersFromSheet so two sheet rows with
 *  the same customer (in any phone formatting) collapse to one
 *  reminder set. Returns empty string for inputs that don't have at
 *  least 10 digits — callers treat that as "no dedup key, skip
 *  dedup". */
function digitsOnlyPhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const d = String(raw).replace(/\D/g, '')
  if (d.length < 10) return ''
  // Drop a leading "1" so "+19097322032" and "9097322032" match.
  if (d.length === 11 && d.startsWith('1')) return d.slice(1)
  // 12+ digits → take the last 10 as a best guess. Rare edge case.
  if (d.length > 10) return d.slice(-10)
  return d
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
  let rows: Awaited<ReturnType<typeof readAllSheetRows>>
  try {
    rows = await readAllSheetRows()
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

    const sourceKey = rowSourceKey(r)
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
          sheetTabTitle:
            r.source.kind === 'secondary'
              ? r.source.tabTitle
              : 'Master Table',
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
  /** Pending rows that were eligible to fire but held because the
   *  customer is currently inside the configured quiet-hours window.
   *  Confirmations are exempt and never increment this (they fire
   *  immediately regardless of quiet hours — see CONFIRMATION_DELAY_MS
   *  doc-comment). Non-confirmation rows stay 'pending' and retry on
   *  subsequent ticks until either quiet hours end OR the row exceeds
   *  its STALENESS_THRESHOLD_MS and gets skipped. */
  quietHoursHeld: number
  /** Rows the dispatcher decided are too late to be useful (per
   *  STALENESS_THRESHOLD_MS by type). Marked status='skipped' so they
   *  never retry. Most common cause: a non-confirmation reminder that
   *  sat through enough of a quiet-hours window that the wording no
   *  longer matches reality (e.g. a "2hr" reminder firing 90 min late
   *  when the appointment is now only 30 min out). */
  staleSkipped: number
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
  if (!config?.enabled)
    return {
      attempted: 0,
      sent: 0,
      failed: 0,
      quietHoursHeld: 0,
      staleSkipped: 0,
    }

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
  let quietHoursHeld = 0
  let staleSkipped = 0

  // Sender-side dispatch gate data — never send a timed reminder for an
  // appointment that isn't Confirmed. This is the backstop that catches
  // any timed reminders queued BEFORE the queue-time gates existed (e.g.
  // by the sheet sync). Built only when the due batch actually contains
  // a non-confirmation reminder, so quiet ticks stay cheap.
  const dispatchById = new Map<string, string>()
  const dispatchByContent = new Map<string, string>()
  if (due.some((d) => d.reminderType !== 'confirmation')) {
    const gateAppts = await prisma.appointment.findMany({
      select: {
        id: true,
        customerPhone: true,
        apptDateTime: true,
        dispatchStatus: true,
      },
    })
    for (const a of gateAppts) {
      dispatchById.set(a.id, a.dispatchStatus)
      const key = sheetContentKey(a.customerPhone, a.apptDateTime)
      if (key) dispatchByContent.set(key, a.dispatchStatus)
    }
  }

  for (const reminder of due) {
    // Staleness guard FIRST — runs ahead of the quiet-hours gate so a
    // row that's already past its useful window can't keep retrying
    // every tick (which would silently spam the dispatch logs). Also
    // acts as a safety belt against any "backlog suddenly becomes
    // eligible" scenario — e.g. an admin who toggled `enabled` off
    // for half a day and back on; or the 2026-06-08 confirmation-
    // quiet-hours exemption, which made rows that had been silently
    // looping for days theoretically eligible to fire.
    //
    // Per-type thresholds (see STALENESS_THRESHOLD_MS) reflect when
    // the wording stops matching reality. Anything past its threshold
    // gets a terminal 'skipped' status with a clear reason so admin
    // diagnostics show exactly why the customer never got the text.
    //
    // Atomic claim via updateMany so if two ticks race only one wins.
    const ageMs = now.getTime() - reminder.scheduledFor.getTime()
    const staleThreshold =
      STALENESS_THRESHOLD_MS[reminder.reminderType as ReminderType]
    if (staleThreshold !== undefined && ageMs > staleThreshold) {
      const claim = await prisma.appointmentReminder.updateMany({
        where: { id: reminder.id, status: 'pending' },
        data: {
          status: 'skipped',
          errorMessage: `Skipped — became stale (${Math.round(
            ageMs / 60_000,
          )} min past scheduledFor; threshold for "${reminder.reminderType}" is ${Math.round(
            staleThreshold / 60_000,
          )} min). Most common cause: row sat in quiet hours past its useful window.`,
        },
      })
      if (claim.count > 0) staleSkipped++
      continue
    }

    // Dispatch gate — hold any non-confirmation reminder whose
    // appointment isn't Confirmed. Stays 'pending' (so it can still fire
    // if it gets confirmed later) until the staleness guard above
    // eventually retires it. Confirmation is exempt (booking-time FYI).
    if (reminder.reminderType !== 'confirmation') {
      const ds =
        (reminder.appointmentId
          ? dispatchById.get(reminder.appointmentId)
          : undefined) ??
        dispatchByContent.get(
          sheetContentKey(reminder.customerPhone, reminder.apptDateTime) ?? '',
        ) ??
        'not_dispatched'
      if (ds !== 'confirmed') continue
    }

    // Quiet hours guard — don't send SMS outside the configured
    // window in the *customer's* local timezone. Compliance-driven
    // (TCPA generally caps to 8 AM–9 PM). Reminders that would land
    // outside stay pending and get retried on subsequent ticks; the
    // next pass that lands inside the window picks them up.
    //
    // EXCEPTION: confirmations bypass this gate entirely. They're
    // transactional acknowledgments for an action the customer just
    // took with the client over the phone (the booking itself), not
    // marketing reach-out, and so they're outside TCPA's quiet-hours
    // protection. Pre-2026-06-08 the dispatcher held them through
    // the window like every other type, which made an 8 PM booking's
    // confirmation arrive at 8 AM the next morning — long after the
    // customer had moved on and started wondering whether the
    // booking even went through. The staleness guard above provides
    // the upper-bound safety net: confirmations older than 24h still
    // skip, so deploy-time backlog can't accidentally blast anyone.
    if (
      reminder.reminderType !== 'confirmation' &&
      isInQuietHours(reminder.customerTimezone, config)
    ) {
      quietHoursHeld++
      continue
    }

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

      // Send the reminder to EVERY phone on the customer record
      // (deduplicated). Most common case is a husband-wife household
      // where Mary listed both lines in the same field — both spouses
      // should know the appointment is on. Rolls up to "sent" if at
      // least one phone succeeded, "failed" only when every send
      // failed. Per-phone outcomes are captured in errorMessage when
      // the rollup is partial so admin can spot a bad number even
      // when the overall reminder shows as delivered.
      const phones = extractedPhonesFor(reminder.customerPhone)
      if (phones.length === 0) {
        // Validator should have caught this upstream, but defend
        // against any drift between validator + dispatcher.
        throw new Error(
          `No deliverable phone number in "${reminder.customerPhone}"`,
        )
      }

      type PerPhone =
        | {
            phone: string
            ok: true
            contactId: string | null
            messageId: string | null
            conversationId: string | null
          }
        | { phone: string; ok: false; error: string }

      const sendResults: PerPhone[] = []
      for (const phone of phones) {
        try {
          const r = await sendSmsToPhone(config.vaultEntryName, {
            phone,
            message: body,
            firstName: firstNameOf(reminder.customerName),
            lastName: lastNameOf(reminder.customerName),
            fromNumber: config.senderPhone || undefined,
          })
          sendResults.push({
            phone,
            ok: true,
            contactId: r.contactId,
            messageId: r.messageId ?? null,
            conversationId: r.conversationId ?? null,
          })
        } catch (err) {
          sendResults.push({
            phone,
            ok: false,
            error: err instanceof Error ? err.message : 'Send failed',
          })
        }
      }

      const successes = sendResults.filter(
        (r): r is Extract<PerPhone, { ok: true }> => r.ok,
      )
      const failures = sendResults.filter(
        (r): r is Extract<PerPhone, { ok: false }> => !r.ok,
      )

      if (successes.length === 0) {
        // Every send failed — mark the row failed with combined
        // error detail so admin can see which numbers errored and
        // why (typo? GHL outage? carrier rejection?).
        const detail = failures
          .map((f) => `${f.phone} — ${f.error}`)
          .join('; ')
        await prisma.appointmentReminder.update({
          where: { id: reminder.id },
          data: {
            status: 'failed',
            errorMessage: `All ${phones.length} phone${phones.length === 1 ? '' : 's'} failed: ${detail}`,
          },
        })
        failed++
      } else {
        // At least one phone got the text. Store the IDs from the
        // first success as the canonical GHL trail (the Recent
        // Activity panel only displays one anyway). Surface partial
        // failures in errorMessage so admin notices a bad number
        // without changing the overall rollup status.
        const first = successes[0]
        const errorMessage =
          failures.length === 0
            ? null
            : `Sent to ${successes.length} of ${phones.length} phones. Failed: ${failures.map((f) => `${f.phone} — ${f.error}`).join('; ')}`
        await prisma.appointmentReminder.update({
          where: { id: reminder.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            messageBody: body,
            ghlContactId: first.contactId,
            ghlMessageId: first.messageId,
            ghlConversationId: first.conversationId,
            errorMessage,
          },
        })
        sent++
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Send failed'
      await prisma.appointmentReminder.update({
        where: { id: reminder.id },
        data: { status: 'failed', errorMessage: message },
      })
      failed++
    }
  }

  return {
    attempted: due.length,
    sent,
    failed,
    quietHoursHeld,
    staleSkipped,
  }
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
 *
 * NOTE: as of 2026-05-11 the customer-reminder dispatcher uses
 * extractedPhonesFor() and sends to EVERY phone in a multi-phone
 * field (e.g. husband + wife). primaryPhoneFor() is kept for legacy
 * call sites that still need a single best-guess number.
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

/**
 * Extract EVERY phone number from a customerPhone field, deduplicated
 * by E.164 digits. Used by the reminder dispatcher to send the same
 * SMS to all valid lines on a customer record — most common case is
 * a household with mobile + home (or husband's + wife's lines on the
 * same row, e.g. "Isaac and Naomi Mizie" with two phones). Sending
 * to all of them keeps both spouses in sync about their appointment
 * without forcing Mary to think about which number is "primary."
 *
 * Dedup catches the case where Mary fat-fingered the same number
 * twice — only one SMS goes out per unique phone.
 *
 * Returns an empty array when no phones can be parsed (caller should
 * surface as a failed reminder with a clear error). Returns the raw
 * string in a singleton array as a fallback only when isValidUsPhone
 * already accepted it — keeps unusual one-off formats from getting
 * silently dropped.
 */
export function extractedPhonesFor(raw: string | null | undefined): string[] {
  if (!raw) return []
  const { entries } = parsePhoneEntries(raw)
  if (entries.length === 0) {
    // Defensive fallback: if the raw string contains a 10/11-digit
    // sequence (the validator accepts it), pass it through as one
    // entry. Belt-and-suspenders for unusual formats the regex didn't
    // catch but the validator did.
    const digits = raw.replace(/\D/g, '')
    if (
      digits.length === 10 ||
      (digits.length === 11 && digits.startsWith('1'))
    ) {
      return [raw]
    }
    return []
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of entries) {
    const key = e.number.replace(/\D/g, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(e.number)
  }
  return out
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
 * Loose validation — accept any field that contains AT LEAST ONE
 * valid US phone number. Sheet entries are wildly inconsistent in
 * formatting ("(555) 123-4567" / "5551234567" / "1-555-123-4567"),
 * AND Mary often enters two phones in the same field ("(201)
 * 674-4561 (201) 248-9140" for a household with a mobile + home).
 *
 * Previously this stripped non-digits from the WHOLE raw string and
 * checked length — which fails two-phone entries (20 digits ≠ 10/11)
 * and falsely marks the reminder as "invalid phone" before the
 * dispatch path could parse out the primary number. Now we delegate
 * to parsePhoneEntries (which the send-path's primaryPhoneFor()
 * already uses) and accept if any extracted entry is a 10/11-digit
 * US number. Single-phone entries still validate via the same regex.
 */
function isValidUsPhone(phone: string): boolean {
  const { entries } = parsePhoneEntries(phone)
  if (entries.length > 0) {
    return entries.some((e) => {
      const digits = e.number.replace(/\D/g, '')
      return (
        digits.length === 10 ||
        (digits.length === 11 && digits.startsWith('1'))
      )
    })
  }
  // Defensive fallback when the parser finds nothing: behave like the
  // old loose check on the raw string so we don't regress edge cases
  // where the format is unusual but a 10-digit sequence is present.
  const digits = phone.replace(/\D/g, '')
  return (
    digits.length === 10 ||
    (digits.length === 11 && digits.startsWith('1'))
  )
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

    // Dispatch gate: the four same-day reminders (4hr/2hr/30min/start)
    // only arm once the appointment's DISPATCH status is "confirmed" —
    // that's the go state. Confirmation is exempt (it's the booking-time
    // FYI). Re-run on the confirm transition, which is what creates
    // these rows; until then they don't exist, so nothing can fire.
    // not_dispatched / dispatched / reschedule_requested / needs_review
    // never arm. (A reschedule re-arms via the regular status flow while
    // the appt is still confirmed.)
    if (type !== 'confirmation' && appt.dispatchStatus !== 'confirmed')
      continue

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
            // Re-arm on reschedule: when the appointment TIME moved,
            // re-queue this window for the NEW time regardless of the
            // row's prior status. A rescheduled appointment whose old
            // reminders already sent / were skipped / were cancelled
            // (e.g. after a no-show, or the "N"-reply suppression that
            // cancels the pending set) MUST get a fresh reminder set
            // for the new date — otherwise the customer Hannah just
            // rebooked hears nothing and no-shows again. Confirmation
            // is excluded: we don't re-send "thanks for booking" on a
            // reschedule (the reschedule-confirmation SMS is sent
            // separately). sentAt/errorMessage cleared so a re-armed
            // row reads as a clean pending, not a stale send.
            ...(apptShifted &&
              type !== 'confirmation' && {
                scheduledFor: fireAt,
                status,
                sentAt: null,
                errorMessage: phoneInvalid ? undefined : null,
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

/**
 * One-off "your appointment has been rescheduled" SMS to the
 * customer, sent when an appointment's time is changed + marked
 * rescheduled (e.g. Hannah's rebooking calls). Separate from the
 * reminder pipeline — this is the immediate heads-up; the re-armed
 * reminders (upsertRemindersForAppointment) handle the lead-up.
 *
 * Sends to every phone on the record (household), via the same GHL
 * sender + quiet-hours-exempt path semantics as a confirmation
 * (a reschedule ack is transactional, not marketing). No-op when the
 * reminder system's master toggle is off or the phone is unusable.
 */
export async function sendRescheduleConfirmation(params: {
  customerName: string
  customerPhone: string
  clientName: string | null
  apptDateTime: Date
  address?: string | null
}): Promise<{ sent: number }> {
  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config?.enabled) return { sent: 0 }
  const phones = extractedPhonesFor(params.customerPhone)
  if (phones.length === 0) return { sent: 0 }

  const tz = timezoneForAddress(params.address)
  const when = formatInTimezone(params.apptDateTime, tz, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const body = `Hi ${customerFirstNameForSms(params.customerName)}, your appointment with ${
    params.clientName ?? 'us'
  } has been rescheduled to ${when}. We'll send reminders leading up to it. Reply STOP to opt out.`

  let sent = 0
  for (const phone of phones) {
    try {
      await sendSmsToPhone(config.vaultEntryName, {
        phone,
        message: body,
        firstName: firstNameOf(params.customerName),
        lastName: lastNameOf(params.customerName),
        fromNumber: config.senderPhone || undefined,
      })
      sent++
    } catch (err) {
      console.error(
        `[reminders] reschedule confirmation send failed for ${phone}:`,
        err,
      )
    }
  }
  return { sent }
}
