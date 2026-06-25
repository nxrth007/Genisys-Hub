/**
 * Client Alerts — SMS notifications to a client's contactPhone whenever
 * a new appointment lands in the master sheet for them. Mirrors the
 * Slack delivery flow (lib/client-delivery.ts) but over GHL SMS, with
 * its own ledger so failures on one channel don't suppress the other.
 *
 * Trigger: independent 5-min cron tick (scheduler.ts). Fires alongside
 * the Slack sync, not chained to it — that way a Slack outage doesn't
 * silence the SMS, and vice versa.
 *
 * Idempotency: every send is recorded in ClientAlertDelivery, keyed by
 * (sourceKey, recipientPhone). Same dual-key dedup as the Slack ledger
 * — sourceKey for the same-row case, content key (recipientPhone +
 * customerPhone + apptDateTime) within a 48h window for the row-shift
 * case while letting old test data age out.
 *
 * Routing: shares the routing brain (buildRoutingIndex / routeRowToClient)
 * with the Slack sync so the two channels can never disagree on which
 * client owns a row.
 *
 * First-enable: when admin flips the master toggle on, backfill marks
 * every existing master-sheet row as 'backfilled' so we don't blast
 * historical bookings to the new SMS channel.
 */

import { prisma } from './prisma'
// readMasterTableRows is still used for the admin "deliver this row
// by rowNumber" tool — that path only operates on the primary sheet
// because rowNumber alone doesn't disambiguate across multiple
// sheets. Sync + backfill use readAllSheetRows so secondaries get
// the same SMS coverage as primary.
import { readMasterTableRows, type MasterTableRow } from './drive'
import { readAllSheetRows, rowSourceKey } from './secondary-sheets'
import { normalizeAddress } from './address'
import {
  formatInTimezone,
  resolveCustomerTimezone,
  timezoneForAddress,
} from './timezone'
import { buildRoutingIndex, routeRowToClient } from './client-routing'
import { snapshotSolarFromCache, type SolarSummary } from './solar'
import { sendSmsToPhone } from './ghl'

/** Strip-and-prefix US phone normalizer. Same shape as the helper in
 *  client-delivery.ts; duplicated locally so this module doesn't have
 *  to take a dependency on its sibling. */
function normalizePhoneForKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return null
}

type AlertResult = {
  scanned: number
  delivered: number
  skipped: number
  failed: number
  unrouted: number
  inferred: number
  ambiguous: number
}

/**
 * Cron tick: scan the master sheet, send a Client Alert SMS for every
 * row that routes to a client with a contactPhone configured, and
 * record the result in the ClientAlertDelivery ledger.
 *
 * Returns counts so the scheduler can heartbeat-log every tick (same
 * pattern as syncClientDeliveriesFromSheet).
 */
export async function syncClientAlertsFromSheet(): Promise<AlertResult> {
  const result: AlertResult = {
    scanned: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    unrouted: 0,
    inferred: 0,
    ambiguous: 0,
  }

  // Master enable check — if the singleton config row says off (or
  // doesn't exist yet), no-op cheaply. Avoids loading the sheet on
  // every tick when the feature isn't being used.
  const config = await prisma.clientAlertsConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config?.enabled) return result

  // Pull every active client into the routing index — same as the
  // Slack sync so the two channels can never disagree.
  const clients = await prisma.client.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      state: true,
      contactPhone: true,
      // Used for GHL contact firstName/lastName when creating a NEW
      // contact at the client's contactPhone. Existing GHL contacts
      // are not touched (findContactByPhone short-circuits upsert),
      // so this is purely a create-time hint.
      contactName: true,
    },
  })

  // Cheap exit: nobody has a contactPhone configured → nothing to do.
  // (active=true clients with null/empty contactPhone fall through
  // and get logged as 'unrouted' below for visibility, but bailing
  // when literally everyone is empty saves a sheet read.)
  const anyPhoneConfigured = clients.some((c) => normalizePhoneForKey(c.contactPhone))
  if (!anyPhoneConfigured) return result

  const index = buildRoutingIndex(clients)

  // All configured sheets — primary + every enabled SecondarySheet.
  // Yassin's call center rows (Forward Energy + Brighton Capital)
  // flow through the same client-alert SMS pipeline as Mary's master-
  // sheet bookings; clients should hear about new appointments
  // regardless of which sheet they were typed into.
  let rows: Awaited<ReturnType<typeof readAllSheetRows>>
  try {
    rows = await readAllSheetRows()
  } catch (err) {
    console.error('[client-alert] failed to read sheet:', err)
    return result
  }
  result.scanned = rows.length

  // Stale-appointment cutoff: skip rows whose appointment is more
  // than STALE_HOURS in the past. Without this guard, adding a new
  // secondary sheet (or any catch-up data entry of historical rows
  // on the master sheet) would blast every old row to the client's
  // contactPhone as if it were a fresh booking. Mary's "I'm typing
  // in a row whose appointment is in 30 min" case is still fine —
  // we only skip when the appointment is meaningfully old. 24h
  // chosen because anything older than that is almost certainly
  // historical data, not a fresh booking we missed.
  const STALE_HOURS = 24
  const staleThreshold = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000)

  // Dispatch gate data — client SMS only fires once the Hub Dispatch
  // Status is "confirmed". That status is DB-only, so map it by sheet
  // rowNumber (+ phone/time content key) and skip rows that aren't
  // confirmed. Same gate the Slack channel sync applies.
  const dbDispatch = await prisma.appointment.findMany({
    select: {
      masterSheetRowNumber: true,
      customerPhone: true,
      apptDateTime: true,
      dispatchStatus: true,
    },
  })
  const dispatchByRow = new Map<number, string>()
  const dispatchByContent = new Map<string, string>()
  for (const a of dbDispatch) {
    if (a.masterSheetRowNumber != null) {
      dispatchByRow.set(a.masterSheetRowNumber, a.dispatchStatus)
    }
    const pk = normalizePhoneForKey(a.customerPhone)
    if (pk && a.apptDateTime) {
      dispatchByContent.set(
        `${pk}|${a.apptDateTime.toISOString()}`,
        a.dispatchStatus,
      )
    }
  }

  for (const row of rows) {
    if (!row.customerName?.trim() || !row.customerPhone?.trim()) continue
    if (!row.apptDateTime) continue
    if ((row.status || '').toLowerCase().includes('cancel')) continue

    // Dispatch gate — hold until the Hub Dispatch Status is "confirmed".
    const rowDispatchStatus =
      dispatchByRow.get(row.rowNumber) ??
      (() => {
        const pk = normalizePhoneForKey(row.customerPhone)
        if (pk && row.apptDateTime) {
          const t = new Date(row.apptDateTime)
          if (!isNaN(t.getTime())) {
            return dispatchByContent.get(`${pk}|${t.toISOString()}`)
          }
        }
        return undefined
      })() ??
      'not_dispatched'
    if (rowDispatchStatus !== 'confirmed') {
      result.skipped++
      continue
    }

    // Skip old appointments without firing the SMS. We still record
    // a 'backfilled' delivery row below the dedup check so the audit
    // log keeps consistent state and a later sync run can't suddenly
    // decide it's new.
    const rowApptDate = new Date(row.apptDateTime)
    const apptIsStale =
      !isNaN(rowApptDate.getTime()) && rowApptDate < staleThreshold

    // sourceKey via rowSourceKey so primary rows keep the legacy
    // "sheet:Master Table:N" shape while secondaries get
    // "sheet:<spreadsheetId>:N". Otherwise primary row 5 and any
    // secondary sheet's row 5 would collide in the unique index.
    const sourceKey = rowSourceKey(row)
    const route = routeRowToClient(
      { client: row.client, address: normalizeAddress(row.address) },
      index,
    )

    if (route.source === 'unrouted') {
      result.unrouted++
      if (route.reason === 'ambiguous-state-match') {
        result.ambiguous++
        const names = (route.candidates ?? []).map((c) => c.name).join(', ')
        console.warn(
          `[client-alert] ambiguous routing for sheet row ${row.rowNumber}: address state matches multiple clients (${names}). Fill in the Client column on the sheet to disambiguate.`,
        )
      }
      continue
    }

    const candidate = route.client
    const recipientPhone = normalizePhoneForKey(candidate.contactPhone)
    if (!recipientPhone) {
      result.unrouted++
      console.warn(
        `[client-alert] sheet row ${row.rowNumber} routed to ${candidate.name} but that client has no contactPhone configured — skipping. Set the phone in /clients → ${candidate.name} to start receiving SMS alerts.`,
      )
      continue
    }

    if (route.source === 'inferred-state') {
      result.inferred++
    }

    // Idempotency check — same dual-key story as SheetSlackDelivery:
    //   1. (sourceKey, recipientPhone): permanent — the sheet row's
    //      position is the most stable identifier we have
    //   2. (recipientPhone, customerPhone, apptDateTime) within last
    //      48h: catches sheet rearrangements while letting old test
    //      data age out so retesting with the same numbers works
    const customerPhoneKey = normalizePhoneForKey(row.customerPhone)
    const apptDate = row.apptDateTime ? new Date(row.apptDateTime) : null
    const apptDateValid = apptDate && !isNaN(apptDate.getTime())
    const contentMatchSince = new Date(Date.now() - 48 * 60 * 60 * 1000)

    const existing = await prisma.clientAlertDelivery.findFirst({
      where: {
        recipientPhone,
        OR: [
          { sourceKey },
          ...(customerPhoneKey && apptDateValid
            ? [
                {
                  customerPhone: customerPhoneKey,
                  apptDateTime: apptDate,
                  createdAt: { gte: contentMatchSince },
                },
              ]
            : []),
        ],
      },
      select: { id: true, status: true, sourceKey: true },
    })
    if (existing) {
      result.skipped++
      // Don't migrate sourceKey on pending rows — the dispatcher
      // parses `db:appointment:<id>` to know which appointment to
      // re-fetch when sending. Rewriting it to `sheet:Master Table:N`
      // would break dispatch. Pending rows are short-lived (≤30 min)
      // anyway; the migration kicks in once they flip to delivered.
      if (
        existing.sourceKey !== sourceKey &&
        existing.status !== 'pending'
      ) {
        await prisma.clientAlertDelivery
          .update({
            where: { id: existing.id },
            data: { sourceKey },
          })
          .catch(() => {
            // Unique constraint hit means another row already has this
            // sourceKey for this recipient — both represent the same
            // delivery; safe to leave them in place.
          })
      }
      continue
    }

    // Stale-row safety net: row passed the idempotency check (no
    // prior delivery on file), but the appointment itself is more
    // than 24h in the past. Don't send — just record a 'backfilled'
    // row so the next sync tick (or later edits) doesn't think it's
    // new again. Catches the "Yassin's team backfills a historical
    // row" and "Mary catches up on data entry days later" cases.
    if (apptIsStale) {
      try {
        await prisma.clientAlertDelivery.create({
          data: {
            sourceKey,
            clientId: candidate.id,
            recipientPhone,
            status: 'backfilled',
            customerPhone: customerPhoneKey,
            apptDateTime: apptDateValid ? apptDate : null,
          },
        })
      } catch (err) {
        const code =
          err instanceof Error && 'code' in err
            ? (err as { code?: string }).code
            : undefined
        if (code !== 'P2002') {
          console.error(
            '[client-alert] stale-row backfill insert failed:',
            err,
          )
        }
      }
      result.skipped++
      console.log(
        `[client-alert] skipped historical row (appt ${rowApptDate.toISOString()}, sourceKey=${sourceKey}) — recorded as backfilled instead of blasting client.`,
      )
      continue
    }

    const solar = row.address
      ? await snapshotSolarFromCache(row.address).catch(() => null)
      : null
    const body = formatAppointmentForClientSms(row, { solar })

    try {
      // GHL contact naming: companyName goes in GHL's proper
      // "Business name" field (not firstName — the old bug).
      // firstName/lastName come from Client.contactName if filled
      // in (e.g. "Ray Rodriguez" → firstName="Ray" / lastName=
      // "Rodriguez"). All three are only used when GHL CREATES a
      // new contact — existing contacts are left fully untouched
      // by the find-first logic in upsertContactByPhone.
      const contactNames = splitContactName(candidate.contactName)
      const send = await sendSmsToPhone(config.vaultEntryName, {
        phone: recipientPhone,
        message: body,
        firstName: contactNames.firstName,
        lastName: contactNames.lastName,
        companyName: candidate.name,
        // Optional sender override — when null, GHL routes via the
        // location's default phone. Settings UI surfaces the field
        // so admin can pin a dedicated number (e.g. 603-803-4828).
        ...(config.senderPhone ? { fromNumber: config.senderPhone } : {}),
      })

      await prisma.clientAlertDelivery.create({
        data: {
          sourceKey,
          clientId: candidate.id,
          recipientPhone,
          status: 'delivered',
          messageId: send.messageId ?? null,
          conversationId: send.conversationId ?? null,
          deliveredAt: new Date(),
          customerPhone: customerPhoneKey,
          apptDateTime: apptDateValid ? apptDate : null,
        },
      })
      result.delivered++
      if (route.source === 'inferred-state') {
        console.log(
          `[client-alert] sheet row ${row.rowNumber} routed to ${candidate.name} via address-state inference (${route.matchedState}). Client column was blank — consider filling it for clarity.`,
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'SMS send failed'
      try {
        await prisma.clientAlertDelivery.create({
          data: {
            sourceKey,
            clientId: candidate.id,
            recipientPhone,
            status: 'failed',
            errorMessage: message,
            customerPhone: customerPhoneKey,
            apptDateTime: apptDateValid ? apptDate : null,
          },
        })
      } catch {
        // Race — another concurrent attempt won. Fine.
      }
      result.failed++
      console.error(
        `[client-alert] sheet row ${row.rowNumber} → ${candidate.name} (${recipientPhone}) failed:`,
        message,
      )
    }
  }

  return result
}

/* -------------------------------------------------------------------------- */
/*  DB-driven delivery (immediate trigger from /api/agent/appointments POST)   */
/* -------------------------------------------------------------------------- */

/**
 * Send a Client Alert SMS for a freshly-created DB Appointment,
 * WITHOUT going through the master sheet. Fires from the agent-form
 * POST handler so the SMS lands within seconds of save, fully
 * decoupled from the sheet round-trip.
 *
 * Same dual-key idempotency story as the sheet-driven sync —
 * sourceKey `db:appointment:{id}` + content key (recipientPhone +
 * customerPhone + apptDateTime within 48h).
 *
 * Bails when:
 *   - ClientAlertsConfig.enabled is false (cron is also a no-op)
 *   - Routing returns 'unrouted'
 *   - The matched client has no contactPhone configured
 *   - A delivery record already exists for this appointment id
 *
 * Now QUEUES instead of firing: writes a row with status='pending'
 * + scheduledFor=now+CLIENT_ALERT_BUFFER_MS, and lets
 * dispatchPendingClientAlerts() (every-minute cron) actually send the
 * SMS once the window passes. If the appointment is edited before
 * the window expires, this function rolls scheduledFor forward so
 * the alert reflects the latest state and Mary has the full buffer
 * to fix typos.
 */
/** 30-minute window between an agent saving and the SMS firing.
 *  Per Alex's 2026-05-22 spec — gives Mary room to edit / fix
 *  typos / reassign the client before the agency-side gets pinged.
 *  Each subsequent edit re-bases the timer. Bumped from 20 min on
 *  2026-05-22 after the Dionito Tanion mis-routing incident showed
 *  the original window wasn't always enough for Mary to catch a
 *  client-swap before the SMS fired. */
const CLIENT_ALERT_BUFFER_MS = 30 * 60 * 1000

export async function deliverAppointmentAsSms(
  appointmentId: string,
): Promise<{
  status:
    | 'queued'
    | 'rolled'
    | 'skipped'
    | 'unrouted'
    | 'no-phone'
    | 'disabled'
    | 'failed'
  reason?: string
  scheduledFor?: Date
}> {
  const config = await prisma.clientAlertsConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config?.enabled) return { status: 'disabled' }

  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      client: { select: { id: true, name: true, state: true } },
    },
  })
  if (!appt) return { status: 'failed', reason: 'appointment not found' }
  // Defensive dispatch gate — never queue a client SMS unless the appt
  // is Confirmed, no matter who calls this. Legit callers only invoke
  // on a confirmed transition; this makes a future stray call a no-op.
  if (appt.dispatchStatus !== 'confirmed') {
    return { status: 'skipped', reason: 'dispatch status not confirmed' }
  }

  const allClients = await prisma.client.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      state: true,
      contactPhone: true,
      // Used for GHL contact firstName/lastName when creating a NEW
      // contact at the client's contactPhone. Existing GHL contacts
      // are not touched (findContactByPhone short-circuits upsert),
      // so this is purely a create-time hint.
      contactName: true,
    },
  })
  const index = buildRoutingIndex(allClients)
  const route = routeRowToClient(
    {
      client: appt.client?.name ?? null,
      address: normalizeAddress(appt.address),
    },
    index,
  )
  if (route.source === 'unrouted') {
    return { status: 'unrouted', reason: route.reason }
  }
  const candidate = route.client
  const recipientPhone = normalizePhoneForKey(candidate.contactPhone)
  if (!recipientPhone) {
    console.warn(
      `[client-alert] DB appointment ${appointmentId} routed to ${candidate.name} but no contactPhone configured.`,
    )
    return { status: 'no-phone' }
  }

  const sourceKey = `db:appointment:${appointmentId}`
  const customerPhoneKey = normalizePhoneForKey(appt.customerPhone)
  const contentMatchSince = new Date(Date.now() - 48 * 60 * 60 * 1000)
  const newScheduledFor = new Date(Date.now() + CLIENT_ALERT_BUFFER_MS)

  // Look up any existing delivery row for this appointment. We split
  // by status because pending = roll the buffer; everything else =
  // already handled, skip.
  const existing = await prisma.clientAlertDelivery.findFirst({
    where: {
      recipientPhone,
      OR: [
        { sourceKey },
        ...(customerPhoneKey
          ? [
              {
                customerPhone: customerPhoneKey,
                apptDateTime: appt.apptDateTime,
                createdAt: { gte: contentMatchSince },
              },
            ]
          : []),
      ],
    },
    select: { id: true, status: true },
  })

  if (existing) {
    if (existing.status === 'pending') {
      // Roll the buffer — the agent edited the appointment before
      // the window expired, so push the fire time forward to give
      // them the full window again. Same pattern as customer-side
      // confirmation reminders bumping fireAt on each save.
      await prisma.clientAlertDelivery.update({
        where: { id: existing.id },
        data: { scheduledFor: newScheduledFor },
      })
      return { status: 'rolled', scheduledFor: newScheduledFor }
    }
    // delivered / backfilled / failed — already handled; no-op.
    return { status: 'skipped', reason: `existing status=${existing.status}` }
  }

  // No prior row — queue a fresh pending alert. Wrap in try/catch
  // for P2002: a near-simultaneous POST + PATCH can both pass the
  // findFirst above and race into create. The unique index on
  // (sourceKey, recipientPhone) guarantees only one row lands; we
  // treat the loser of the race as "already queued" so the caller
  // never sees an unhandled rejection.
  try {
    await prisma.clientAlertDelivery.create({
      data: {
        sourceKey,
        clientId: candidate.id,
        recipientPhone,
        status: 'pending',
        scheduledFor: newScheduledFor,
        customerPhone: customerPhoneKey,
        apptDateTime: appt.apptDateTime,
      },
    })
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err
        ? (err as { code?: string }).code
        : undefined
    if (code === 'P2002') {
      return { status: 'skipped', reason: 'duplicate (race)' }
    }
    throw err
  }
  return { status: 'queued', scheduledFor: newScheduledFor }
}

/* -------------------------------------------------------------------------- */
/*  Pending dispatch — fires queued alerts whose buffer expired                */
/* -------------------------------------------------------------------------- */

/** How long a row can stay in `sending` before we assume the worker
 *  crashed mid-send and reset it back to `pending`. */
const STUCK_SENDING_MS = 10 * 60 * 1000

/** Picked up by the every-minute scheduler tick. Finds any pending
 *  ClientAlertDelivery rows whose scheduledFor has passed, re-fetches
 *  the underlying Appointment (so any edits during the buffer window
 *  are reflected in the SMS body), and sends via GHL. Updates status
 *  to 'delivered' on success or 'failed' on error.
 *
 *  Concurrency: each row is claimed via an atomic `pending → sending`
 *  updateMany before the SMS fires, so an overlapping tick (or a
 *  rolling-deploy overlap) can't double-send. Stuck `sending` rows
 *  older than STUCK_SENDING_MS are reset to `pending` at the top of
 *  each tick so a crashed worker self-heals on the next run. */
export async function dispatchPendingClientAlerts(): Promise<{
  attempted: number
  delivered: number
  failed: number
  skipped: number
}> {
  const result = { attempted: 0, delivered: 0, failed: 0, skipped: 0 }

  const config = await prisma.clientAlertsConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config?.enabled) return result

  // Stuck-state recovery: any row left in `sending` past the cutoff
  // belongs to a previous tick that crashed (or a deploy that killed
  // the worker mid-send). Reset to `pending` so this tick picks it up.
  await prisma.clientAlertDelivery.updateMany({
    where: {
      status: 'sending',
      updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_MS) },
    },
    data: { status: 'pending' },
  })

  const due = await prisma.clientAlertDelivery.findMany({
    where: {
      status: 'pending',
      scheduledFor: { lte: new Date() },
    },
    select: {
      id: true,
      sourceKey: true,
      clientId: true,
      recipientPhone: true,
      customerPhone: true,
      apptDateTime: true,
    },
  })

  // Client routing index for the per-row recipient re-validation in
  // the loop. Built once per tick. Lets us detect a delivery row
  // whose stored recipient no longer matches the appointment's
  // CURRENT client — i.e. the agent reassigned the appointment to a
  // different client during the 30-min buffer (a mistake-fix Alex
  // explicitly wants agents to make via edit rather than re-upload).
  const routingClients = await prisma.client.findMany({
    where: { active: true },
    select: { id: true, name: true, state: true, contactPhone: true },
  })
  const dispatchRoutingIndex = buildRoutingIndex(routingClients)

  for (const row of due) {
    result.attempted++

    // Primary path: pending row keyed by db:appointment:<id>. Most
    // pending rows arrive here — the Hub form's POST handler queues
    // them with a 30-min buffer.
    let appointmentId: string | null = null
    const dbMatch = row.sourceKey.match(/^db:appointment:(.+)$/)
    if (dbMatch) {
      appointmentId = dbMatch[1]!
    } else {
      // Self-heal path: pending row with a sheet sourceKey. Shouldn't
      // happen in normal operation — sheet sync writes 'delivered' /
      // 'failed' rows directly, never 'pending'. Historically these
      // appeared because rekeyClientAlertAfterSheetSync used to flip
      // sourceKey on pending rows (db:* → sheet:*) before the
      // dispatcher had a chance to fire them, leaving the row
      // orphaned with a key shape the dispatcher refused to handle.
      // Now: try to recover by looking up the Appointment via the
      // sheet rowNumber. If we find one, treat the row as if it had
      // its original db: shape. If we don't, skip silently (could
      // be a row for a secondary sheet that genuinely has no DB
      // appointment).
      const primarySheetMatch = row.sourceKey.match(
        /^sheet:Master Table:(\d+)$/,
      )
      if (primarySheetMatch) {
        const rowNumber = parseInt(primarySheetMatch[1]!, 10)
        if (Number.isFinite(rowNumber) && rowNumber > 0) {
          const matching = await prisma.appointment.findFirst({
            where: { masterSheetRowNumber: rowNumber },
            select: { id: true },
          })
          if (matching) {
            appointmentId = matching.id
            console.warn(
              `[client-alert] dispatch self-heal: pending row ${row.id} had sourceKey "${row.sourceKey}" but matches Appointment ${matching.id} — firing through DB path.`,
            )
          }
        }
      }
    }

    if (!appointmentId) {
      result.skipped++
      continue
    }

    // Atomic claim — flip pending → sending only if the row is still
    // pending. If count is 0, another tick (or a manual retry) won
    // the race, so this loop iteration is a no-op.
    const claim = await prisma.clientAlertDelivery.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'sending' },
    })
    if (claim.count === 0) {
      result.skipped++
      continue
    }

    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        client: { select: { id: true, name: true, state: true } },
      },
    })
    if (!appt) {
      // Appointment got deleted during the buffer window. Mark as
      // skipped (not failed — this isn't an SMS error, it's an
      // intentional non-send) and move on.
      await prisma.clientAlertDelivery.update({
        where: { id: row.id },
        data: { status: 'skipped', errorMessage: 'appointment deleted' },
      })
      result.skipped++
      continue
    }
    // Dispatch gate — only send once the appointment is Confirmed. If
    // not (e.g. a row queued by a sheet sync before the gate, or one
    // un-confirmed inside the buffer), release the claim back to pending
    // so it can fire later if/when it's confirmed.
    if (appt.dispatchStatus !== 'confirmed') {
      await prisma.clientAlertDelivery.update({
        where: { id: row.id },
        data: { status: 'pending' },
      })
      result.skipped++
      continue
    }
    if ((appt.status ?? '').toLowerCase().includes('cancel')) {
      // Booking was cancelled inside the window — flip the row to
      // 'skipped' with a clear reason so it's not re-dispatched.
      await prisma.clientAlertDelivery.update({
        where: { id: row.id },
        data: {
          status: 'skipped',
          errorMessage: 'appointment cancelled before buffer expired',
        },
      })
      result.skipped++
      continue
    }

    // RECIPIENT RE-VALIDATION — the agent may have reassigned this
    // appointment to a DIFFERENT client during the buffer window. If
    // so, the appointment now routes to another client's phone, and
    // THIS row's stored recipient no longer owns it. Sending anyway
    // would leak one client's appointment details to a different
    // client (the original client gets an SMS describing the new
    // client's appointment). Re-route the current appointment and
    // skip this row when its recipient no longer matches — the
    // correctly-rerouted client has its own row that fires normally.
    const currentRoute = routeRowToClient(
      {
        client: appt.client?.name ?? null,
        address: normalizeAddress(appt.address),
      },
      dispatchRoutingIndex,
    )
    const currentRecipient =
      currentRoute.source !== 'unrouted'
        ? normalizePhoneForKey(currentRoute.client.contactPhone)
        : null
    if (!currentRecipient || currentRecipient !== row.recipientPhone) {
      await prisma.clientAlertDelivery.update({
        where: { id: row.id },
        data: {
          status: 'skipped',
          errorMessage:
            'client reassigned during buffer — this recipient no longer owns the appointment',
        },
      })
      result.skipped++
      continue
    }

    // Build the SMS body using the latest appointment state. Same
    // synthetic-row trick we used in the immediate-fire version.
    const customerTz = resolveCustomerTimezone({
      address: appt.address,
      clientState: appt.client?.state ?? null,
    })
    const synthRow: MasterTableRow = {
      rowNumber: 0,
      apptDateTime: appt.apptDateTime.toISOString(),
      customerName: appt.customerName,
      customerPhone: appt.customerPhone,
      address: appt.address,
      email: appt.email,
      monthlyBill: appt.monthlyBill,
      utilityProvider: appt.utilityProvider,
      roofType: appt.roofType,
      roofAge: appt.roofAge,
      estimatedDealValue: appt.estimatedDealValue,
      status: appt.status,
      notes: appt.notes,
      callRecordingLink: appt.callRecordingLink,
      loggedAt: appt.createdAt.toISOString(),
      sentToClient: null,
      client: appt.client?.name ?? null,
      agentName: null,
      agentEmail: null,
      timezone: null,
      resolvedTimezone: customerTz,
      apptDateRaw: null,
      apptTimeRaw: null,
      apptDateTimeRaw: null,
    }
    const solar = appt.address
      ? await snapshotSolarFromCache(appt.address).catch(() => null)
      : null
    const body = formatAppointmentForClientSms(synthRow, { solar })

    try {
      // Business name goes to GHL's companyName field. firstName/
      // lastName left blank here — this path doesn't currently carry
      // the Client.contactName through, and find-first means existing
      // contacts aren't touched anyway.
      const send = await sendSmsToPhone(config.vaultEntryName, {
        phone: row.recipientPhone,
        message: body,
        companyName: appt.client?.name ?? undefined,
        ...(config.senderPhone ? { fromNumber: config.senderPhone } : {}),
      })
      await prisma.clientAlertDelivery.update({
        where: { id: row.id },
        data: {
          status: 'delivered',
          messageId: send.messageId ?? null,
          conversationId: send.conversationId ?? null,
          deliveredAt: new Date(),
          // Refresh apptDateTime in case the agent edited it
          // during the buffer window.
          apptDateTime: appt.apptDateTime,
        },
      })
      result.delivered++
    } catch (err) {
      const message = err instanceof Error ? err.message : 'SMS send failed'
      await prisma.clientAlertDelivery.update({
        where: { id: row.id },
        data: { status: 'failed', errorMessage: message },
      })
      result.failed++
      console.error(
        `[client-alert] dispatch failed for ${appointmentId}:`,
        message,
      )
    }
  }

  return result
}

/* -------------------------------------------------------------------------- */
/*  Manual retry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Force-fire a Client Alert SMS regardless of current status. Called
 * from the Settings UI's Recent activity panel "Retry" button.
 * Re-fetches fresh data (latest appointment state for db:* rows,
 * latest sheet row for sheet:* rows), rebuilds the SMS body, and
 * fires inline through GHL. Updates the existing ledger row in
 * place — `delivered` on success, or `failed` with a new
 * errorMessage on another error.
 *
 * Refuses only when:
 *   - row doesn't exist
 *   - status is `sending` (would double-fire if a tick is mid-send)
 *
 * Everything else (pending stuck past scheduledFor, failed, delivered,
 * backfilled, cancelled, skipped) is allowed because admin clicking
 * Retry is an explicit override of whatever state the row is in.
 * Bypasses the master `enabled` toggle for the same reason — admin
 * is taking manual control.
 */
export async function retryFailedClientAlert(
  deliveryId: string,
): Promise<
  | { ok: true; messageId: string | null }
  | { ok: false; error: string; status?: string }
> {
  const row = await prisma.clientAlertDelivery.findUnique({
    where: { id: deliveryId },
  })
  if (!row) return { ok: false, error: 'delivery not found' }
  if (row.status === 'sending') {
    return {
      ok: false,
      error:
        'this row is currently being sent by the dispatcher — wait a moment and refresh',
      status: row.status,
    }
  }

  const config = await prisma.clientAlertsConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config) {
    return { ok: false, error: 'Client Alerts config not found' }
  }
  // Note: we do NOT check config.enabled here. Manual retry is an
  // explicit admin override; if they clicked Retry, they want this
  // SMS fired regardless of whether the master toggle is currently
  // on. The dispatcher cron still respects the toggle.

  // Resolve client name for the GHL contact upsert. clientId is
  // nullable (SetNull on client delete), so fall back gracefully.
  const client = row.clientId
    ? await prisma.client.findUnique({
        where: { id: row.clientId },
        select: { id: true, name: true, state: true },
      })
    : null

  // Build the SMS body from fresh source data so the retry reflects
  // the latest state — same principle as the dispatcher's "synthRow"
  // trick.
  let body: string
  const dbMatch = row.sourceKey.match(/^db:appointment:(.+)$/)
  const sheetMatch = row.sourceKey.match(/^sheet:Master Table:(\d+)$/)

  if (dbMatch) {
    const appointmentId = dbMatch[1]
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { client: { select: { id: true, name: true, state: true } } },
    })
    if (!appt) {
      return { ok: false, error: 'underlying appointment was deleted' }
    }
    if ((appt.status ?? '').toLowerCase().includes('cancel')) {
      return { ok: false, error: 'appointment is cancelled' }
    }
    const customerTz = resolveCustomerTimezone({
      address: appt.address,
      clientState: appt.client?.state ?? null,
    })
    const synthRow: MasterTableRow = {
      rowNumber: 0,
      apptDateTime: appt.apptDateTime.toISOString(),
      customerName: appt.customerName,
      customerPhone: appt.customerPhone,
      address: appt.address,
      email: appt.email,
      monthlyBill: appt.monthlyBill,
      utilityProvider: appt.utilityProvider,
      roofType: appt.roofType,
      roofAge: appt.roofAge,
      estimatedDealValue: appt.estimatedDealValue,
      status: appt.status,
      notes: appt.notes,
      callRecordingLink: appt.callRecordingLink,
      loggedAt: appt.createdAt.toISOString(),
      sentToClient: null,
      client: appt.client?.name ?? null,
      agentName: null,
      agentEmail: null,
      timezone: null,
      resolvedTimezone: customerTz,
      apptDateRaw: null,
      apptTimeRaw: null,
      apptDateTimeRaw: null,
    }
    const solar = appt.address
      ? await snapshotSolarFromCache(appt.address).catch(() => null)
      : null
    body = formatAppointmentForClientSms(synthRow, { solar })
  } else if (sheetMatch) {
    const sheetRowNumber = parseInt(sheetMatch[1]!, 10)
    let rows: MasterTableRow[]
    try {
      rows = await readMasterTableRows()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'sheet read failed'
      return { ok: false, error: `couldn't read master sheet: ${message}` }
    }
    const sheetRow = rows.find((r) => r.rowNumber === sheetRowNumber)
    if (!sheetRow) {
      return {
        ok: false,
        error: `sheet row ${sheetRowNumber} no longer exists`,
      }
    }
    if ((sheetRow.status || '').toLowerCase().includes('cancel')) {
      return { ok: false, error: 'sheet row is marked cancelled' }
    }
    const solar = sheetRow.address
      ? await snapshotSolarFromCache(sheetRow.address).catch(() => null)
      : null
    body = formatAppointmentForClientSms(sheetRow, { solar })
  } else {
    return {
      ok: false,
      error: `unrecognized sourceKey shape: ${row.sourceKey}`,
    }
  }

  try {
    const send = await sendSmsToPhone(config.vaultEntryName, {
      phone: row.recipientPhone,
      message: body,
      // Business name → GHL companyName (not firstName). Existing
      // contacts at this phone are left untouched by find-first.
      companyName: client?.name ?? undefined,
      ...(config.senderPhone ? { fromNumber: config.senderPhone } : {}),
    })
    await prisma.clientAlertDelivery.update({
      where: { id: row.id },
      data: {
        status: 'delivered',
        messageId: send.messageId ?? null,
        conversationId: send.conversationId ?? null,
        deliveredAt: new Date(),
        errorMessage: null,
      },
    })
    return { ok: true, messageId: send.messageId ?? null }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SMS send failed'
    await prisma.clientAlertDelivery.update({
      where: { id: row.id },
      data: { status: 'failed', errorMessage: message },
    })
    return { ok: false, error: message }
  }
}

/**
 * Counterpart to rekeySlackDeliveryAfterSheetSync — same idea for
 * the SMS ledger. Updates db:* sourceKey to sheet:* once the sheet
 * sync writes the row, so the cron's later scan dedup-matches by
 * sourceKey too.
 */
export async function rekeyClientAlertAfterSheetSync(
  appointmentId: string,
  sheetRowNumber: number,
): Promise<void> {
  const dbSourceKey = `db:appointment:${appointmentId}`
  const sheetSourceKey = `sheet:Master Table:${sheetRowNumber}`
  try {
    // CRITICAL: only rekey rows that are NOT pending. The dispatcher
    // (dispatchPendingClientAlerts) only fires rows whose sourceKey
    // starts with "db:appointment:" — if we rekey a pending row to
    // "sheet:Master Table:N", the dispatcher skips it forever, the
    // row stays pending, and Mary's client SMS never fires.
    //
    // This was Alex's reported bug on 2026-05-13: customer reminders
    // worked (different pipeline, no rekey) but client SMS alerts
    // silently never fired after Hub-form bookings. The cron log
    // would show "0 delivered, 0 failed, N skipped (of N due)" with
    // the same N rows skipping every minute. Lines 201-210 of the
    // sheet sync already had this guard; the rekey function was
    // missing it.
    await prisma.clientAlertDelivery.updateMany({
      where: {
        sourceKey: dbSourceKey,
        NOT: { status: 'pending' },
      },
      data: { sourceKey: sheetSourceKey },
    })
  } catch (err) {
    console.error(
      `[client-alert] re-key after sheet sync failed for ${appointmentId}:`,
      err,
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  First-enable backfill                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mark every current master-sheet row as 'backfilled' for the given
 * client so the next sync tick won't blast historical bookings to the
 * SMS channel. Called when admin flips ClientAlertsConfig.enabled on
 * for the first time, or when adding a contactPhone to a client that
 * already has historical rows.
 *
 * Idempotent — rows that already have a delivery record are left
 * untouched.
 */
export async function backfillClientAlerts(params: {
  clientId: string
  recipientPhone: string
}): Promise<{ recorded: number; alreadyTracked: number }> {
  const { clientId } = params
  const recipientPhone = normalizePhoneForKey(params.recipientPhone)
  if (!recipientPhone) return { recorded: 0, alreadyTracked: 0 }

  const allClients = await prisma.client.findMany({
    where: { active: true },
    select: { id: true, name: true, state: true },
  })
  const target = allClients.find((c) => c.id === clientId)
  if (!target) return { recorded: 0, alreadyTracked: 0 }

  const index = buildRoutingIndex(allClients)

  // Backfill walks every configured sheet so newly-registered
  // secondary sheets are skipped-record'd alongside the primary —
  // otherwise flipping a secondary on would blast every historical
  // row in that sheet at the next sync tick.
  let rows: Awaited<ReturnType<typeof readAllSheetRows>>
  try {
    rows = await readAllSheetRows()
  } catch (err) {
    console.error('[client-alert] backfill: sheet read failed:', err)
    return { recorded: 0, alreadyTracked: 0 }
  }

  let recorded = 0
  let alreadyTracked = 0

  for (const row of rows) {
    if (!row.customerName?.trim()) continue
    const route = routeRowToClient(
      { client: row.client, address: normalizeAddress(row.address) },
      index,
    )
    if (route.source === 'unrouted') continue
    if (route.client.id !== clientId) continue

    const sourceKey = `sheet:Master Table:${row.rowNumber}`
    try {
      await prisma.clientAlertDelivery.create({
        data: {
          sourceKey,
          clientId: target.id,
          recipientPhone,
          status: 'backfilled',
        },
      })
      recorded++
    } catch (err) {
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

/* -------------------------------------------------------------------------- */
/*  Test send                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send a sample SMS to a phone using a fake appointment. Used by the
 * Settings UI's "Test SMS" button so admins can verify routing +
 * sender number before flipping the master toggle on.
 */
export async function sendTestClientAlert(params: {
  vaultEntryName: string
  senderPhone: string | null
  recipientPhone: string
  clientName: string
}): Promise<{ ok: boolean; messageId: string | null }> {
  const recipient = normalizePhoneForKey(params.recipientPhone)
  if (!recipient) {
    throw new Error(
      `Could not normalize recipient phone "${params.recipientPhone}". Use a US 10-digit number.`,
    )
  }
  const sample: MasterTableRow = {
    rowNumber: 0,
    apptDateTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    customerName: 'Sample Customer',
    customerPhone: '(555) 123-4567',
    address: '123 Main St, Phoenix, AZ 85001',
    email: 'sample@example.com',
    monthlyBill: '$240',
    utilityProvider: 'APS',
    roofType: 'Asphalt shingle',
    roofAge: '12 years',
    estimatedDealValue: '$28,000',
    status: 'booked',
    notes: `Test SMS for ${params.clientName} — confirms Client Alerts routing + sender number. Ignore.`,
    callRecordingLink: null,
    loggedAt: new Date().toISOString(),
    sentToClient: null,
    client: params.clientName,
    agentName: null,
    agentEmail: null,
    timezone: null,
    resolvedTimezone: 'America/Phoenix',
    apptDateRaw: null,
    apptTimeRaw: null,
    apptDateTimeRaw: null,
  }
  const body =
    `Test SMS — ignore.\n\n` +
    formatAppointmentForClientSms(sample, { solar: null })

  const send = await sendSmsToPhone(params.vaultEntryName, {
    phone: recipient,
    message: body,
    // Business name → companyName. Existing GHL contacts at this
    // phone are left untouched by find-first inside the upsert.
    companyName: params.clientName,
    ...(params.senderPhone ? { fromNumber: params.senderPhone } : {}),
  })
  return { ok: true, messageId: send.messageId ?? null }
}

/* -------------------------------------------------------------------------- */
/*  SMS body                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Plain-text SMS body for a client-alert post. Mirrors the shape of
 * formatAppointmentForClientChannel (Slack body) so the SMS channel
 * shows the same fields, but without Slack's mrkdwn / mention syntax.
 *
 * Length guidance: a typical body comes in around 500-600 chars, which
 * GHL bills as 4 SMS segments (~$0.03/send). Acceptable for our
 * volume (~30 client-alerts/week). When solar data is present the
 * body grows by ~150 chars (~5 segments).
 */
export function formatAppointmentForClientSms(
  row: MasterTableRow,
  opts: { solar?: SolarSummary | null } = {},
): string {
  const lines: string[] = []
  const cleanedAddress = normalizeAddress(row.address)
  const tz = row.resolvedTimezone || timezoneForAddress(cleanedAddress)

  const apptDate = row.apptDateTime ? new Date(row.apptDateTime) : null
  const apptStr =
    apptDate && !isNaN(apptDate.getTime())
      ? formatInTimezone(apptDate, tz, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZoneName: 'short',
        })
      : row.apptDateTime || 'Time TBD'

  lines.push(`New Booked Appointment:`)
  lines.push('')
  lines.push(`Customer: ${row.customerName}`)
  lines.push(`Date / Time: ${apptStr}`)
  lines.push(`Phone: ${row.customerPhone}`)
  if (cleanedAddress) lines.push(`Address: ${cleanedAddress}`)
  if (row.email) lines.push(`Email: ${row.email}`)

  const propertyLines: string[] = []
  if (row.utilityProvider) propertyLines.push(`Utility: ${row.utilityProvider}`)
  if (row.monthlyBill) propertyLines.push(`Monthly bill: ${row.monthlyBill}`)
  const roofPiece =
    row.roofType && row.roofAge
      ? `${row.roofType} · ${row.roofAge}`
      : row.roofType || row.roofAge
  if (roofPiece) propertyLines.push(`Roof: ${roofPiece}`)
  if (row.estimatedDealValue) {
    propertyLines.push(`Est. deal value: ${row.estimatedDealValue}`)
  }
  if (propertyLines.length > 0) {
    lines.push('')
    lines.push(`Property details:`)
    for (const p of propertyLines) lines.push(`  ${p}`)
  }

  if (opts.solar && opts.solar.viability !== 'unavailable') {
    const solarLines: string[] = []
    if (opts.solar.maxSunshineHoursPerYear != null) {
      solarLines.push(
        `Sunshine: ${Math.round(opts.solar.maxSunshineHoursPerYear).toLocaleString()} hrs/yr`,
      )
    }
    if (opts.solar.maxPanelCount != null) {
      const panels =
        opts.solar.recommendedPanelCount != null &&
        opts.solar.recommendedPanelCount !== opts.solar.maxPanelCount
          ? `${opts.solar.maxPanelCount} max (${opts.solar.recommendedPanelCount} typical)`
          : `${opts.solar.maxPanelCount}`
      solarLines.push(`Max panels: ${panels}`)
    }
    if (opts.solar.recommendedAnnualKwh != null) {
      solarLines.push(
        `Est. production: ${Math.round(opts.solar.recommendedAnnualKwh).toLocaleString()} kWh/yr`,
      )
    }
    if (opts.solar.roofAreaM2 != null) {
      const sqft = Math.round(opts.solar.roofAreaM2 * 10.7639)
      solarLines.push(`Roof area: ${sqft.toLocaleString()} sq ft`)
    }
    if (solarLines.length > 0) {
      lines.push('')
      lines.push(`Solar potential:`)
      for (const s of solarLines) lines.push(`  ${s}`)
    }
  }

  if (row.notes) {
    lines.push('')
    lines.push(`Notes: ${row.notes}`)
  }

  // Brief opt-out footer. GHL handles STOP at the carrier level, but
  // surfacing the option keeps clients happy + we're not relying on
  // platform behavior to be obvious.
  lines.push('')
  lines.push('Reply STOP to opt out.')

  return lines.join('\n')
}

/** Split a full name into firstName + lastName for GHL contact create.
 *  "Ray Rodriguez" → firstName="Ray", lastName="Rodriguez".
 *  "Ray" alone → firstName="Ray", lastName=undefined. Empty / null →
 *  both undefined. Names with 3+ words put the rest in lastName so
 *  multi-part names stay together. */
function splitContactName(raw: string | null | undefined): {
  firstName: string | undefined
  lastName: string | undefined
} {
  if (!raw) return { firstName: undefined, lastName: undefined }
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: undefined, lastName: undefined }
  if (parts.length === 1) return { firstName: parts[0], lastName: undefined }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}
