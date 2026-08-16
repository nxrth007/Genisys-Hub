/**
 * In-process cron scheduler for recurring jobs.
 *
 * Started via src/instrumentation.ts when the server boots. Runs inside the
 * same Node process as Next.js — no separate worker, no external cron service.
 *
 * Jobs:
 *   - Morning brief: checks every minute, sends Slack DM to users whose
 *     ScheduledSms.timeOfDay matches the current time in their timezone.
 *     (Named ScheduledSms from the Prisma model, but delivery is now via Slack.)
 *   - Appointment SMS reminders: every minute syncs reminder rows from the
 *     master sheet + dispatches anything due. Master enable + per-client
 *     templates live in the RemindersConfig + ReminderTemplate tables.
 */
import cron from 'node-cron'
import { prisma } from './prisma'
import { buildAndSendBrief, buildAndSendSmsBrief } from './morning-brief'
import {
  syncRemindersFromSheet,
  dispatchDueReminders,
} from './reminders'
import { syncClientDeliveriesFromSheet } from './client-delivery'
import {
  syncClientAlertsFromSheet,
  dispatchPendingClientAlerts,
} from './client-alert'
import {
  syncClientEmailAlertsFromSheet,
  dispatchPendingClientEmailAlerts,
} from './client-email-alert'
import { syncClientMessageAlerts } from './client-message-alert'
import { syncReminderReplyAlerts } from './reminder-reply-alert'
import { snapshotAllVicidialLists } from './vicidial-snapshots'
import { syncSheetAppointmentsToDb } from './sheet-appointment-import'
import { backfillMissingCounties } from './county-lookup'
import { syncInbox, syncSent, listConnectedAccounts } from './gmail'
import { maybeRunScheduledBulkCredentials } from './bulk-credentials-scheduled-run'
import { processPpaInvoicingForAllClients } from './ppa-invoicing'
import { expireOldChatAttachments } from './chat-attachment-expiry'
import { runSweep } from './nct-billing'

let initialized = false

// Sync the sheet less aggressively than we dispatch — reading every
// minute hammers the Drive API for no benefit. 5-minute cadence still
// picks up new appointments well within the 30-min reminder window.
const REMINDER_SYNC_INTERVAL_MS = 5 * 60 * 1000
let lastReminderSyncAt = 0

// Sheet→DB appointment import — same 5-min cadence. Brings sheet-only
// appointments (e.g. Brighton Capital's) into the DB so the client
// dashboard + status updates work on them. Never queues reminders, so
// the reminder engine stays unaware of imported rows (no double-fire).
const SHEET_IMPORT_INTERVAL_MS = 5 * 60 * 1000
let lastSheetImportAt = 0
let sheetImportInFlight = false

// Client-channel delivery sync runs on the same cadence as the
// reminder sync — both read the same sheet, so co-locating them
// would be a small win, but keeping them separate makes cron logs
// + per-feature failure isolation cleaner.
const CLIENT_DELIVERY_SYNC_INTERVAL_MS = 5 * 60 * 1000
let lastClientDeliverySyncAt = 0

// Client Alerts SMS sync — independent from the Slack channel sync
// so a Slack outage doesn't suppress the SMS and vice versa. Same
// 5-min cadence; cheap no-op when ClientAlertsConfig.enabled is false
// (the singleton check inside the sync exits before the sheet read).
const CLIENT_ALERT_SYNC_INTERVAL_MS = 5 * 60 * 1000
let lastClientAlertSyncAt = 0

// Client Email Alerts sync — third channel parallel to Slack + SMS.
// Same 5-min cadence; cheap no-op when ClientEmailAlertsConfig.enabled
// is false OR no client has emailAlertsEnabled=true. Spring Solar is
// the only seeded opt-in today.
const CLIENT_EMAIL_ALERT_SYNC_INTERVAL_MS = 5 * 60 * 1000
let lastClientEmailAlertSyncAt = 0

// Inbound-client-message Slack alerts. Tighter cadence (1 min) than
// the appointment syncs because the value here is "respond fast";
// 5 min is too long to wait for a client message ping.
const CLIENT_MESSAGE_ALERT_INTERVAL_MS = 60 * 1000
let lastClientMessageAlertAt = 0

// Gmail Inbox/Outbox auto-sync. Runs every 12 hours per Alex's spec —
// the "Sync" button on /inbox is still there for manual pulls, but
// the cron means new emails land in the DB without anyone having to
// click. The two-per-day cadence is light enough that the Gmail API
// quota is never a concern even with many connected accounts.
// On a process cold-start (fresh deploy) lastGmailSyncAt resets to 0
// so the first tick fires the sync within a minute — gives every
// deploy a free fresh-mail pull as a side effect.
const GMAIL_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000
let lastGmailSyncAt = 0
// In-flight guard. A first-time sync on a busy account can take
// 30-60s per folder per account; if a tick somehow fires while a
// previous run is still going (clock skew on a deploy boundary,
// for instance) we skip silently rather than stack a second pull
// on top.
let gmailSyncInFlight = false
// In-flight guard. node-cron's '* * * * *' fires every minute
// regardless of whether the previous tick finished — when a GHL fetch
// + 100-conversation scan takes >60s, two ticks of syncClientMessageAlerts
// run concurrently and race on the (conversationId, lastMessageId)
// dedup insert. This flag skips the new tick if the previous one is
// still running. Symptom we're fixing: occasional prisma:error
// "Unique constraint failed" stacks in the Render logs even after the
// findFirst pre-check — pure race, app-level dedup still correct, but
// noisy. Same pattern would help the other long-running jobs but only
// the client-msg alert was hot enough to spam logs in practice.
let clientMessageAlertInFlight = false

// Reminder-reply alerts — same GHL recent-100 scan shape as the
// client-msg alert, so it gets the same in-flight protection.
const REMINDER_REPLY_ALERT_INTERVAL_MS = 60 * 1000
let lastReminderReplyAlertAt = 0
let reminderReplyAlertInFlight = false

// PPA bi-weekly invoicing — fires once daily during a fixed window
// (14:00–14:59 UTC = 10–11 AM EDT). We don't want a Render cold-
// start during that hour to fire the run a second time, so we
// track the YYYY-MM-DD of the last successful run in memory + the
// in-flight flag.
//
// AppSetting (bulkCredentialsScheduledRun.ts pattern) would be
// more robust across deploys, but a redundant fire here is
// harmless: every per-client step is wrapped in a transaction that
// advances lastInvoicedAt before sending email/SMS, so the second
// run sees the advanced timestamp and bails on every client.
let ppaInvoicingInFlight = false
let lastPpaInvoicingDayUtc: string | null = null
const PPA_INVOICING_HOUR_UTC = 14 // 10 AM EDT, 7 AM PDT

// Chat attachment expiry — same once-per-UTC-day gate as PPA but
// at a different hour so they don't pile up on a single tick. The
// query is cheap (single bounded deleteMany), no in-flight guard
// needed.
let lastChatExpiryDayUtc: string | null = null
const CHAT_EXPIRY_HOUR_UTC = 7 // 3 AM EDT — off-peak

// Vicidial list burn-down snapshots — once daily, off-peak for the
// dialer (the BPO's shifts run US daytime; 10:00 UTC = 6 AM EDT is
// before the floor fills up). One stats-page fetch per list.
let lastVicidialSnapshotDayUtc: string | null = null
let vicidialSnapshotInFlight = false
const VICIDIAL_SNAPSHOT_HOUR_UTC = 10

// County backfill — geocode appointments that have an address but no
// county yet, a small batch per tick, until the backlog drains. Runs
// fire-and-forget (concurrent with the rest of the tick) so it never
// delays reminder dispatch, and in-flight guarded so two ticks can't
// overlap. ONLY writes Appointment.county — never touches reminders,
// client alerts, or dispatch.
let countyBackfillInFlight = false
const COUNTY_BACKFILL_BATCH = 20

// NCT lead billing — sweep settled Stripe cash to Mercury so the buffer
// is topped up before NCT charges the virtual card the next day. The
// per-lead CHARGE happens inline in the webhook (must be immediate);
// only the payout runs on a schedule, because a fresh charge sits in
// Stripe's pending balance for ~2 business days and can't be paid out
// yet. runSweep() no-ops unless it's enabled in the NCT Leads tab.
const NCT_SWEEP_INTERVAL_MS = 15 * 60 * 1000
let lastNctSweepAt = 0
let nctSweepInFlight = false

/**
 * Solar-era jobs: master-sheet reminders, the sheet→DB appointment
 * import, every client-alert channel, the Slack message alerts, and the
 * Vicidial snapshots.
 *
 * Genisys stopped selling solar appointment-setting, so these now scan
 * sheets and hit Slack every minute to deliver nothing — and their
 * output buries anything real in the Render logs. Set
 * LEGACY_SOLAR_JOBS=off to stop them.
 *
 * Defaults to ON so deploying this changes nothing until the variable is
 * set. Deliberately NOT covering the NCT Stripe→Mercury sweep: that has
 * its own sweepEnabled toggle, and a second gate would mean two switches
 * to remember when the roofing line comes back.
 */
const LEGACY_SOLAR_JOBS = process.env.LEGACY_SOLAR_JOBS !== 'off'

export function initScheduler() {
  if (initialized) return
  initialized = true

  console.log('[scheduler] Starting cron jobs (every minute)')

  // Tick every minute, check if any user's brief is due.
  cron.schedule('* * * * *', async () => {
    // One-time scheduled bulk-credential provisioning. Reads the
    // BULK_CREDENTIALS_FIRE_AT env var and an AppSetting record to
    // decide whether to fire. No-op when the env var is unset
    // (which is the steady-state after the 2026-06-01 roll-out).
    // Wrapped in its own try/catch so a failure here can't block
    // the rest of the tick — briefs, dispatches, syncs all
    // independent.
    try {
      await maybeRunScheduledBulkCredentials()
    } catch (err) {
      console.error('[scheduler] scheduled bulk-credentials check failed:', err)
    }

    // PPA bi-weekly invoicing — fire once during the 14:00 UTC hour
    // each day. Cheap no-op every other minute. Per-day key uses UTC
    // so the gate is deterministic regardless of which Render
    // instance handles the tick.
    try {
      const now = new Date()
      const utcHour = now.getUTCHours()
      const utcDay = now.toISOString().slice(0, 10) // YYYY-MM-DD
      if (
        utcHour === PPA_INVOICING_HOUR_UTC &&
        lastPpaInvoicingDayUtc !== utcDay &&
        !ppaInvoicingInFlight
      ) {
        ppaInvoicingInFlight = true
        try {
          const summary = await processPpaInvoicingForAllClients()
          lastPpaInvoicingDayUtc = utcDay
          console.log(
            `[scheduler] PPA invoicing run done: checked=${summary.clientsChecked} invoiced=${summary.clientsInvoiced} overflow=${summary.clientsOverflowed} empty=${summary.clientsEmpty} errors=${summary.errors.length}`,
          )
        } finally {
          ppaInvoicingInFlight = false
        }
      }
    } catch (err) {
      console.error('[scheduler] PPA invoicing tick failed:', err)
    }

    // Chat attachment expiry — fires once per UTC day at the
    // CHAT_EXPIRY_HOUR_UTC hour. Cheap query gated by the same
    // day-key pattern.
    try {
      const now = new Date()
      const utcHour = now.getUTCHours()
      const utcDay = now.toISOString().slice(0, 10)
      if (
        utcHour === CHAT_EXPIRY_HOUR_UTC &&
        lastChatExpiryDayUtc !== utcDay
      ) {
        const { deleted } = await expireOldChatAttachments()
        lastChatExpiryDayUtc = utcDay
        if (deleted > 0) {
          console.log(
            `[scheduler] chat attachment expiry done: deleted=${deleted}`,
          )
        }
      }
    } catch (err) {
      console.error('[scheduler] chat attachment expiry tick failed:', err)
    }

    if (LEGACY_SOLAR_JOBS) {
      // Vicidial list burn-down snapshots — once per UTC day. Walks
      // every dialer list and records its status counts so /leads can
      // chart depletion. In-flight guarded: N lists = N stats-page
      // fetches, which can outlive a tick on a slow dialer day.
      try {
        const now = new Date()
        const utcHour = now.getUTCHours()
        const utcDay = now.toISOString().slice(0, 10)
        if (
          utcHour === VICIDIAL_SNAPSHOT_HOUR_UTC &&
          lastVicidialSnapshotDayUtc !== utcDay &&
          !vicidialSnapshotInFlight
        ) {
          lastVicidialSnapshotDayUtc = utcDay
          vicidialSnapshotInFlight = true
          try {
            const result = await snapshotAllVicidialLists()
            console.log(
              `[scheduler] vicidial snapshots: ${result.snapshotted} written, ${result.failed} failed`,
            )
          } finally {
            vicidialSnapshotInFlight = false
          }
        }
      } catch (err) {
        console.error('[scheduler] vicidial snapshot tick failed:', err)
      }
    }

    try {
      await checkAndSendBriefs()
    } catch (err) {
      console.error('[scheduler] Brief check failed:', err)
    }

    if (LEGACY_SOLAR_JOBS) {
      // Reminder sync (every 5 min) + dispatch (every minute). Wrapped
      // in their own try/catch so a sheet read failure doesn't kill
      // the brief tick or the dispatch tick.
      try {
        const now = Date.now()
        if (now - lastReminderSyncAt >= REMINDER_SYNC_INTERVAL_MS) {
          lastReminderSyncAt = now
          const result = await syncRemindersFromSheet()
          if (
            result.upserted > 0 ||
            result.cancelled > 0 ||
            result.skippedDuplicatePhone > 0
          ) {
            console.log(
              `[scheduler] reminders sync: ${result.upserted} new, ${result.skippedPast} past, ${result.skippedDuplicatePhone} dupe-phone skipped, ${result.cancelled} cancelled (of ${result.scanned} scanned)`
            )
          }
        }
      } catch (err) {
        console.error('[scheduler] reminders sync failed:', err)
      }

      // Sheet→DB appointment import (every 5 min). In-flight guarded —
      // a full sheet read + per-row client resolution can outlast a
      // tick on a big sheet. Never touches reminders.
      if (!sheetImportInFlight) {
        const now = Date.now()
        if (now - lastSheetImportAt >= SHEET_IMPORT_INTERVAL_MS) {
          lastSheetImportAt = now
          sheetImportInFlight = true
          try {
            const result = await syncSheetAppointmentsToDb()
            if (result.imported > 0) {
              console.log(
                `[scheduler] sheet-import: ${result.imported} new appointments imported (${result.skippedExisting} already, ${result.skippedNoClient} no-client, ${result.skippedHubBooked} hub-booked) of ${result.scanned} scanned`,
              )
            }
          } catch (err) {
            console.error('[scheduler] sheet-import failed:', err)
          } finally {
            sheetImportInFlight = false
          }
        }
      }
    }

    // NCT Stripe -> Mercury sweep. Disabled by default; runSweep() checks
    // the toggle itself and returns "skipped" when off or when the
    // available balance is under the floor + minimum.
    try {
      const now = Date.now()
      if (now - lastNctSweepAt >= NCT_SWEEP_INTERVAL_MS && !nctSweepInFlight) {
        lastNctSweepAt = now
        nctSweepInFlight = true
        void runSweep(false)
          .then((r) => {
            if (r.status === 'ok') {
              console.log(
                `[scheduler] nct sweep: $${(r.amountCents / 100).toFixed(2)} paid out to Mercury (${r.payoutId})`,
              )
            } else if (r.status === 'failed') {
              console.error(`[scheduler] nct sweep failed: ${r.detail}`)
            }
          })
          .catch((err) => console.error('[scheduler] nct sweep failed:', err))
          .finally(() => {
            nctSweepInFlight = false
          })
      }
    } catch (err) {
      console.error('[scheduler] nct sweep failed:', err)
    }

    // County backfill (fire-and-forget) — drains existing appointments
    // missing a county a batch at a time. Concurrent with the rest of
    // the tick so it never delays reminder dispatch; no-op once the
    // backlog is empty. Writes only the county field.
    if (!countyBackfillInFlight) {
      countyBackfillInFlight = true
      void backfillMissingCounties(COUNTY_BACKFILL_BATCH)
        .then((r) => {
          if (r.filled > 0 || r.unresolved > 0) {
            console.log(
              `[scheduler] county backfill: ${r.filled} filled, ${r.unresolved} no-county, ${r.remaining} remaining`,
            )
          }
          if (r.likelyConfigError) {
            console.error(
              '[scheduler] county backfill: whole batch failed to geocode — check "Google Maps Key" vault entry + Geocoding API enablement',
            )
          }
        })
        .catch((err) =>
          console.error('[scheduler] county backfill failed:', err),
        )
        .finally(() => {
          countyBackfillInFlight = false
        })
    }

    if (LEGACY_SOLAR_JOBS) {
      try {
        const result = await dispatchDueReminders()
        if (result.attempted > 0) {
          // quietHoursHeld + staleSkipped surface in every tick log so
          // I can spot "lots of rows holding overnight, then a spike of
          // stale skips at 08:00" patterns without needing a separate
          // admin panel. Hiding the zeroes would help nothing.
          console.log(
            `[scheduler] reminders dispatch: ${result.sent} sent, ${result.failed} failed, ${result.quietHoursHeld} held (quiet hours), ${result.staleSkipped} skipped (stale) (of ${result.attempted} attempted)`,
          )
        }
      } catch (err) {
        console.error('[scheduler] reminders dispatch failed:', err)
      }

      // Client-channel delivery sync — posts new sheet rows to the
      // configured Slack channel for each client. Cheap no-op when
      // no client has slackChannelId set.
      try {
        const now = Date.now()
        if (now - lastClientDeliverySyncAt >= CLIENT_DELIVERY_SYNC_INTERVAL_MS) {
          lastClientDeliverySyncAt = now
          const result = await syncClientDeliveriesFromSheet()
          // Heartbeat-log every 5-min tick (not just on activity) so a
          // test "I made a new appointment, will it auto-deliver?" has
          // a clear log line to grep for in Render. Without it, a
          // silently-skipped row was indistinguishable from a cron
          // that never ran.
          console.log(
            `[scheduler] client-delivery sync: ${result.delivered} delivered (${result.inferred} via state inference), ${result.failed} failed, ${result.skipped} skipped, ${result.unrouted} unrouted, ${result.ambiguous} ambiguous (of ${result.scanned} scanned)`
          )
        }
      } catch (err) {
        console.error('[scheduler] client-delivery sync failed:', err)
      }

      // Client Alerts SMS sync — sends an SMS to each client's
      // contactPhone when new appointments land. Independent from the
      // Slack tick above so a Slack outage doesn't suppress SMS, and
      // an SMS / GHL outage doesn't suppress Slack. The sync itself
      // exits early when ClientAlertsConfig.enabled is false, so the
      // heartbeat will read all-zeros until admin flips it on.
      try {
        const now = Date.now()
        if (now - lastClientAlertSyncAt >= CLIENT_ALERT_SYNC_INTERVAL_MS) {
          lastClientAlertSyncAt = now
          const result = await syncClientAlertsFromSheet()
          console.log(
            `[scheduler] client-alert sync: ${result.delivered} delivered (${result.inferred} via state inference), ${result.failed} failed, ${result.skipped} skipped, ${result.unrouted} unrouted, ${result.ambiguous} ambiguous (of ${result.scanned} scanned)`
          )
        }
      } catch (err) {
        console.error('[scheduler] client-alert sync failed:', err)
      }

      // Pending-alert dispatch (every minute). Fires DB-driven alerts
      // whose 30-min buffer expired — gives Mary a window to fix typos
      // / re-edit before the client gets pinged. Independent from the
      // sheet sync above so neither path can starve the other.
      try {
        const result = await dispatchPendingClientAlerts()
        if (result.attempted > 0) {
          console.log(
            `[scheduler] client-alert dispatch: ${result.delivered} delivered, ${result.failed} failed, ${result.skipped} skipped (of ${result.attempted} due)`,
          )
        }
      } catch (err) {
        console.error('[scheduler] client-alert dispatch failed:', err)
      }

      // Client Email Alerts — third channel (Slack + SMS + email). Same
      // 5-min sheet sync cadence as the other two; the sync exits early
      // when the master toggle is off OR no client has opted in, so
      // the heartbeat reads all-zeros when only Spring Solar is on
      // and no new bookings landed this tick.
      try {
        const now = Date.now()
        if (now - lastClientEmailAlertSyncAt >= CLIENT_EMAIL_ALERT_SYNC_INTERVAL_MS) {
          lastClientEmailAlertSyncAt = now
          const result = await syncClientEmailAlertsFromSheet()
          console.log(
            `[scheduler] client-email-alert sync: ${result.delivered} delivered (${result.inferred} via state inference), ${result.failed} failed, ${result.skipped} skipped, ${result.unrouted} unrouted, ${result.ambiguous} ambiguous (of ${result.scanned} scanned)`,
          )
        }
      } catch (err) {
        console.error('[scheduler] client-email-alert sync failed:', err)
      }

      // Pending email-alert dispatch (every minute) — mirror of the
      // SMS dispatcher. Fires queued alerts whose 30-min buffer expired.
      try {
        const result = await dispatchPendingClientEmailAlerts()
        if (result.attempted > 0) {
          console.log(
            `[scheduler] client-email-alert dispatch: ${result.delivered} delivered, ${result.failed} failed, ${result.skipped} skipped (of ${result.attempted} due)`,
          )
        }
      } catch (err) {
        console.error('[scheduler] client-email-alert dispatch failed:', err)
      }

      // Client message Slack alerts. Scans the Genisys GHL sub-account
      // every minute for new inbound messages from registered clients
      // and posts a one-line ping to #genisys-alerts so the team can
      // respond fast. Reminder-system threads are excluded server-side.
      //
      // Wrapped in clientMessageAlertInFlight guard so a slow GHL fetch
      // (which can push one tick past the 60s mark) doesn't cause the
      // next tick to start a second concurrent scan — that race was the
      // source of the "Unique constraint failed" prisma:error stacks we
      // were chasing in the logs.
      if (clientMessageAlertInFlight) {
        // Previous tick still running. Skip silently — no log line so we
        // don't spam under sustained slowness; the next free tick will
        // pick things up.
      } else {
        const now = Date.now()
        if (
          now - lastClientMessageAlertAt >=
          CLIENT_MESSAGE_ALERT_INTERVAL_MS
        ) {
          lastClientMessageAlertAt = now
          clientMessageAlertInFlight = true
          try {
            const result = await syncClientMessageAlerts()
            if (result.alerted > 0 || result.failed > 0) {
              console.log(
                `[scheduler] client-msg alert: ${result.alerted} new, ${result.skipped} already-alerted, ${result.outbound} our-replies, ${result.unmatched} non-client, ${result.failed} failed (of ${result.scanned} scanned)`,
              )
            }
          } catch (err) {
            console.error('[scheduler] client-msg alert failed:', err)
          } finally {
            clientMessageAlertInFlight = false
          }
        }
      }

      // Reminder-reply alerts — customer replies (especially the
      // day-before "Reply Y/N" ask) on reminder SMS threads. Mirror
      // image of the client-msg alert stream: that one excludes
      // reminder conversations, this one alerts only on them. Kept as
      // separate jobs so each stream's failures + logs stay isolated.
      if (!reminderReplyAlertInFlight) {
        const now = Date.now()
        if (now - lastReminderReplyAlertAt >= REMINDER_REPLY_ALERT_INTERVAL_MS) {
          lastReminderReplyAlertAt = now
          reminderReplyAlertInFlight = true
          try {
            const result = await syncReminderReplyAlerts()
            if (result.alerted > 0 || result.failed > 0) {
              console.log(
                `[scheduler] reminder-reply alert: ${result.alerted} new (${result.negative} negative), ${result.skipped} already-alerted, ${result.outbound} our-sends, ${result.failed} failed (of ${result.watched} watched)`,
              )
            }
          } catch (err) {
            console.error('[scheduler] reminder-reply alert failed:', err)
          } finally {
            reminderReplyAlertInFlight = false
          }
        }
      }
    }

    // Gmail Inbox + Sent auto-sync (every 12h). Pulls fresh messages
    // for every connected Gmail account into the Email table so the
    // /inbox + /outbox views don't depend on someone clicking Sync.
    // Same per-account error isolation as the manual /api/gmail/sync
    // route — one account's auth failure (e.g. expired refresh token)
    // never blocks the others.
    if (!gmailSyncInFlight) {
      const now = Date.now()
      if (now - lastGmailSyncAt >= GMAIL_SYNC_INTERVAL_MS) {
        lastGmailSyncAt = now
        gmailSyncInFlight = true
        // Fire-and-forget — Gmail sync can take 30-60s on first-pull
        // accounts, and we don't want to block the rest of the cron
        // tick (briefs, dispatch, etc.) waiting on it. The next
        // tick's in-flight guard prevents overlap.
        ;(async () => {
          try {
            const accounts = await listConnectedAccounts()
            if (accounts.length === 0) return
            // Bump maxResults from the API default (50) to give
            // headroom for high-volume accounts between syncs. 100
            // is well under Gmail's rate limit and covers ~12h on
            // even the busiest inboxes we have.
            const MAX = 100
            let totalInboxNew = 0
            let totalSentNew = 0
            const errors: Array<{ email: string; error: string }> = []
            for (const acct of accounts) {
              try {
                const inboxResult = await syncInbox(acct.email, MAX)
                const sentResult = await syncSent(acct.email, MAX)
                // syncInbox / syncSent currently return { synced,
                // skipped } — defensive about that contract so a
                // future refactor doesn't crash the cron.
                const inboxNew = (inboxResult as { synced?: number })
                  ?.synced ?? 0
                const sentNew = (sentResult as { synced?: number })
                  ?.synced ?? 0
                totalInboxNew += inboxNew
                totalSentNew += sentNew
              } catch (err) {
                const message =
                  err instanceof Error ? err.message : 'sync failed'
                errors.push({ email: acct.email, error: message })
                console.error(
                  `[scheduler] gmail sync failed for ${acct.email}:`,
                  message,
                )
              }
            }
            console.log(
              `[scheduler] gmail sync: ${totalInboxNew} new inbox + ${totalSentNew} new sent across ${accounts.length} account${accounts.length === 1 ? '' : 's'}${errors.length ? `, ${errors.length} failed` : ''}`,
            )
          } catch (err) {
            console.error('[scheduler] gmail sync (outer) failed:', err)
          } finally {
            gmailSyncInFlight = false
          }
        })()
      }
    }
  })
}

async function checkAndSendBriefs() {
  const schedules = await prisma.scheduledSms.findMany({
    where: { enabled: true },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          timezone: true,
          phoneNumber: true,
        },
      },
    },
  })

  for (const schedule of schedules) {
    const { user } = schedule
    if (!user.email) continue

    const now = new Date()
    // Per-schedule timezone overrides the owner's — critical when admin
    // and recipient live in different time zones (e.g. Alex in ET
    // scheduling Ethan's brief at 9 AM PT).
    const effectiveTz =
      schedule.timezone || user.timezone || 'America/New_York'
    const userTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: effectiveTz,
    })
    if (userTime !== schedule.timeOfDay) continue

    // Atomic claim before send — prevents double-delivery when two
    // scheduler instances overlap during a rolling deploy, or when a
    // container restart replays the same minute. Only one updateMany
    // call per schedule-per-UTC-day can match (lastSentAt < todayStart).
    // Whoever wins the update actually sends; losers see count=0 and skip.
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    )
    const claim = await prisma.scheduledSms.updateMany({
      where: {
        id: schedule.id,
        OR: [
          { lastSentAt: null },
          { lastSentAt: { lt: todayStart } },
        ],
      },
      data: { lastSentAt: now },
    })
    if (claim.count === 0) continue

    try {
      if (schedule.channel === 'ghl_sms') {
        const phone = schedule.recipientPhone || user.phoneNumber
        if (!phone) {
          console.warn(
            `[scheduler] Skipping GHL SMS brief for ${user.email}: no phone configured`
          )
          continue
        }
        // SMS greeting uses the recipient's name, not the schedule owner's.
        // Prefer the Notion assignee (it IS the recipient in the common case),
        // fall back to the owner's first name when the schedule has no assignee.
        const firstName =
          schedule.notionAssignee?.trim().split(/\s+/)[0] ||
          user.name?.trim().split(/\s+/)[0]
        console.log(
          `[scheduler] Sending GHL SMS brief to ${phone} (owner: ${user.email})`
        )
        await buildAndSendSmsBrief({
          phone,
          firstName,
          notionAssignee: schedule.notionAssignee,
          // Prefer the schedule's explicit timezone (set when admin schedules
          // for a recipient in a different tz than themselves), fall back to
          // the owner's profile timezone. Matches how fire-time is computed.
          timeZone: schedule.timezone || user.timezone,
        })
      } else {
        console.log(`[scheduler] Sending Slack brief to ${user.email}`)
        await buildAndSendBrief(user.email)
      }
      console.log(`[scheduler] Brief sent for ${user.email}`)
    } catch (err) {
      console.error(
        `[scheduler] Failed to send brief for ${user.email}:`,
        err
      )
      // We've already claimed today's slot. Intentional trade-off: a
      // failed send loses that day's brief rather than risk a double-send
      // by rolling back the claim (if the send started but the response
      // was lost, we can't tell whether the SMS actually went out).
    }
  }
}
