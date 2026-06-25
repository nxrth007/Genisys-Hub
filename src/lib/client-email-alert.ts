/**
 * Client Email Alerts — appointment notifications to a client's
 * contactEmail whenever a new booking lands. Parallels client-alert.ts
 * (SMS via GHL) and client-delivery.ts (Slack channel posts); the
 * three channels are independent so an outage on one never silences
 * the others.
 *
 * Trigger flow:
 *   1. Hub form POST queues a 'pending' row keyed by
 *      `db:appointment:<id>` with scheduledFor=now+20min. Mary has
 *      that window to edit / fix typos; each subsequent edit rolls
 *      the timer forward.
 *   2. Every-minute dispatch tick (dispatchPendingClientEmailAlerts)
 *      sends rows whose buffer expired.
 *   3. Independent 5-min sheet sync (syncClientEmailAlertsFromSheet)
 *      catches sheet-only bookings (Yassin's secondary sheets, or
 *      manual master-sheet entries) — same ledger, same dedup, no
 *      buffer (sheet-sourced rows fire immediately when picked up).
 *
 * Idempotency: every send writes a ClientEmailDelivery row keyed by
 * (sourceKey, recipientEmail). Dual-key dedup matches the SMS ledger:
 *   1. sourceKey — fast path, stable as long as the row's identity
 *      doesn't change.
 *   2. (recipientEmail + customerPhone + apptDateTime) within a 48h
 *      window — catches sheet rearrangements where rowNumber drifts
 *      but content stays put.
 *
 * Routing: shares the routing brain (buildRoutingIndex / routeRowToClient)
 * with the SMS + Slack syncs so all three channels can never disagree
 * on which client owns a row.
 *
 * Master enable: ClientEmailAlertsConfig.enabled. Per-client opt-in:
 * Client.emailAlertsEnabled. Spring Solar is seeded with the per-client
 * flag on at launch; all other clients start off.
 */

import { prisma } from './prisma'
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
import { sendEmail } from './gmail'
import { signRecordingUrl } from './recording-proxy'
import { clientRecordingLinksEnabled } from './client-recording-flag'

/** Hub origin used to construct the signed recording proxy URL.
 *  AUTH_URL is set by NextAuth's Render config to the public hostname.
 *  Trimmed of trailing slash so concatenated URLs stay clean. */
function getHubOrigin(): string {
  const raw = process.env.AUTH_URL || 'http://localhost:3000'
  return raw.replace(/\/$/, '')
}

/** Default Gmail account to send alerts from when
 *  ClientEmailAlertsConfig.fromGmailAccount is null and the env var
 *  CLIENT_EMAIL_ALERT_FROM is also unset. Matches the agency primary. */
const DEFAULT_FROM_GMAIL =
  process.env.CLIENT_EMAIL_ALERT_FROM || 'alex@leadgenisys.com'

/** Default display name on the From: header — set the singleton's
 *  senderName to override (e.g. "Genisys Hub Alerts"). */
const DEFAULT_SENDER_NAME = 'Genisys Hub'

/** Lowercase + trim. Email match key for dedup — we don't want
 *  "Foo@Bar.com" and "foo@bar.com" to count as different recipients
 *  in the ledger. */
function normalizeEmailForKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed.includes('@')) return null
  return trimmed
}

/** Strip-and-prefix US phone normalizer — same shape as the helper
 *  in client-alert.ts. Duplicated to keep this module's import graph
 *  small. Used for the content-key dedup. */
function normalizePhoneForKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return null
}

type EmailAlertResult = {
  scanned: number
  delivered: number
  skipped: number
  failed: number
  unrouted: number
  inferred: number
  ambiguous: number
}

/* -------------------------------------------------------------------------- */
/*  Sheet-driven sync                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Cron tick: scan every configured sheet, send a Client Email Alert
 * for every row that routes to a client with emailAlertsEnabled=true
 * + a contactEmail set, and record the result in the
 * ClientEmailDelivery ledger.
 */
export async function syncClientEmailAlertsFromSheet(): Promise<EmailAlertResult> {
  const result: EmailAlertResult = {
    scanned: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    unrouted: 0,
    inferred: 0,
    ambiguous: 0,
  }

  // Master enable — singleton row gates the whole feature. Cheap
  // early exit when the toggle is off (no sheet read needed).
  const config = await prisma.clientEmailAlertsConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config?.enabled) return result

  // Only opted-in clients are candidates. Same routing brain as the
  // SMS + Slack flows so all three channels agree on ownership.
  const clients = await prisma.client.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      state: true,
      contactEmail: true,
      contactName: true,
      emailAlertsEnabled: true,
    },
  })
  // Cheap exit: nobody opted in → skip the sheet read entirely.
  const anyOptedIn = clients.some(
    (c) => c.emailAlertsEnabled && normalizeEmailForKey(c.contactEmail),
  )
  if (!anyOptedIn) return result

  const index = buildRoutingIndex(clients)

  let rows: Awaited<ReturnType<typeof readAllSheetRows>>
  try {
    rows = await readAllSheetRows()
  } catch (err) {
    console.error('[client-email-alert] failed to read sheet:', err)
    return result
  }
  result.scanned = rows.length

  // Same stale-row guard as the SMS + Slack syncs — historical rows
  // get recorded as 'backfilled' instead of blasted to the email
  // channel. Catches Yassin's team backfilling old leads, Mary
  // catching up on data entry, etc.
  const STALE_HOURS = 24
  const staleThreshold = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000)

  // Dispatch gate data — client email only fires once the Hub Dispatch
  // Status is "confirmed". DB-only field, so map by sheet rowNumber (+
  // phone/time content key); same gate the Slack + SMS syncs apply.
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

    const rowApptDate = new Date(row.apptDateTime)
    const apptIsStale =
      !isNaN(rowApptDate.getTime()) && rowApptDate < staleThreshold

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
          `[client-email-alert] ambiguous routing for sheet row ${row.rowNumber}: address state matches multiple clients (${names}). Fill in the Client column on the sheet to disambiguate.`,
        )
      }
      continue
    }

    const candidate = route.client
    // Per-client opt-in check. Silent skip (no result.unrouted++)
    // because this is the normal state for every client except
    // Spring Solar at launch.
    if (!candidate.emailAlertsEnabled) continue
    const recipientEmail = normalizeEmailForKey(candidate.contactEmail)
    if (!recipientEmail) {
      result.unrouted++
      console.warn(
        `[client-email-alert] sheet row ${row.rowNumber} routed to ${candidate.name} but that client has emailAlertsEnabled=true with no contactEmail — skipping. Set the email in Settings → Clients → ${candidate.name}.`,
      )
      continue
    }

    if (route.source === 'inferred-state') {
      result.inferred++
    }

    // Dual-key dedup. (1) (sourceKey, recipientEmail) — fast path,
    // unique index. (2) (recipientEmail + customerPhone +
    // apptDateTime) within last 48h — catches sheet rearrangements
    // while letting old test data age out so retests work.
    const customerPhoneKey = normalizePhoneForKey(row.customerPhone)
    const apptDate = row.apptDateTime ? new Date(row.apptDateTime) : null
    const apptDateValid = apptDate && !isNaN(apptDate.getTime())
    const contentMatchSince = new Date(Date.now() - 48 * 60 * 60 * 1000)

    const existing = await prisma.clientEmailDelivery.findFirst({
      where: {
        recipientEmail,
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
      // Refresh sourceKey to the current value when the existing row
      // matched on content-key — keeps future scans on the fast
      // index path. Skip pending rows (the dispatcher parses
      // db:appointment:<id> to know which appointment to re-fetch
      // when sending; rewriting that key would break dispatch).
      if (
        existing.sourceKey !== sourceKey &&
        existing.status !== 'pending'
      ) {
        await prisma.clientEmailDelivery
          .update({
            where: { id: existing.id },
            data: { sourceKey },
          })
          .catch(() => {
            // Unique constraint race — another row already has the
            // current sourceKey for this recipient. Both represent
            // the same delivery; safe to leave them alone.
          })
      }
      continue
    }

    // Stale-row safety net — record 'backfilled' so the next sync
    // tick treats it as already-handled, but skip the actual send.
    if (apptIsStale) {
      try {
        await prisma.clientEmailDelivery.create({
          data: {
            sourceKey,
            clientId: candidate.id,
            recipientEmail,
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
            '[client-email-alert] stale-row backfill insert failed:',
            err,
          )
        }
      }
      result.skipped++
      console.log(
        `[client-email-alert] skipped historical row (appt ${rowApptDate.toISOString()}, sourceKey=${sourceKey}) — recorded as backfilled.`,
      )
      continue
    }

    // Solar enrichment — same cache-only contract as the other two
    // channels. Never triggers a fresh billable lookup from cron.
    const solar = row.address
      ? await snapshotSolarFromCache(row.address).catch(() => null)
      : null
    const subject = subjectLineForRow(row, candidate.name)
    const html = formatAppointmentForClientEmail(row, {
      clientName: candidate.name,
      solar,
      includeRecording: await clientRecordingLinksEnabled(),
    })

    try {
      const send = await sendEmail({
        accountEmail: config.fromGmailAccount || DEFAULT_FROM_GMAIL,
        to: recipientEmail,
        subject,
        body: html,
        fromName: config.senderName || DEFAULT_SENDER_NAME,
      })
      await prisma.clientEmailDelivery.create({
        data: {
          sourceKey,
          clientId: candidate.id,
          recipientEmail,
          status: 'delivered',
          messageId: send.id ?? null,
          deliveredAt: new Date(),
          customerPhone: customerPhoneKey,
          apptDateTime: apptDateValid ? apptDate : null,
        },
      })
      result.delivered++
      if (route.source === 'inferred-state') {
        console.log(
          `[client-email-alert] sheet row ${row.rowNumber} routed to ${candidate.name} via address-state inference (${route.matchedState}). Client column was blank — consider filling it for clarity.`,
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'send failed'
      try {
        await prisma.clientEmailDelivery.create({
          data: {
            sourceKey,
            clientId: candidate.id,
            recipientEmail,
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
        `[client-email-alert] sheet row ${row.rowNumber} → ${candidate.name} (${recipientEmail}) failed:`,
        message,
      )
    }
  }

  return result
}

/* -------------------------------------------------------------------------- */
/*  DB-driven immediate fire (from /api/agent/appointments POST)               */
/* -------------------------------------------------------------------------- */

/** 30-minute buffer — matches the SMS path so Mary's edit window is
 *  consistent across the alert channels (SMS + email). Bumped from
 *  20 min on 2026-05-22 alongside the SMS bump. */
const CLIENT_EMAIL_BUFFER_MS = 30 * 60 * 1000

export async function deliverAppointmentAsEmail(
  appointmentId: string,
): Promise<{
  status:
    | 'queued'
    | 'rolled'
    | 'skipped'
    | 'unrouted'
    | 'no-email'
    | 'not-opted-in'
    | 'disabled'
    | 'failed'
  reason?: string
  scheduledFor?: Date
}> {
  const config = await prisma.clientEmailAlertsConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config?.enabled) return { status: 'disabled' }

  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      client: {
        select: {
          id: true,
          name: true,
          state: true,
          contactEmail: true,
          emailAlertsEnabled: true,
        },
      },
    },
  })
  if (!appt) return { status: 'failed', reason: 'appointment not found' }
  // Defensive dispatch gate — never queue a client email unless the
  // appt is Confirmed, no matter who calls this.
  if (appt.dispatchStatus !== 'confirmed') {
    return { status: 'skipped', reason: 'dispatch status not confirmed' }
  }

  const allClients = await prisma.client.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      state: true,
      contactEmail: true,
      emailAlertsEnabled: true,
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
  if (!candidate.emailAlertsEnabled) {
    return { status: 'not-opted-in', reason: `${candidate.name} has emailAlertsEnabled=false` }
  }
  const recipientEmail = normalizeEmailForKey(candidate.contactEmail)
  if (!recipientEmail) {
    return { status: 'no-email', reason: 'contactEmail not set on client' }
  }

  const sourceKey = `db:appointment:${appointmentId}`
  const customerPhoneKey = normalizePhoneForKey(appt.customerPhone)
  const contentMatchSince = new Date(Date.now() - 48 * 60 * 60 * 1000)
  const newScheduledFor = new Date(Date.now() + CLIENT_EMAIL_BUFFER_MS)

  // Pending → roll the buffer (agent edited the appointment); any
  // other terminal state → no-op skip.
  const existing = await prisma.clientEmailDelivery.findFirst({
    where: {
      recipientEmail,
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
      await prisma.clientEmailDelivery.update({
        where: { id: existing.id },
        data: { scheduledFor: newScheduledFor },
      })
      return { status: 'rolled', scheduledFor: newScheduledFor }
    }
    return { status: 'skipped', reason: `existing status=${existing.status}` }
  }

  try {
    await prisma.clientEmailDelivery.create({
      data: {
        sourceKey,
        clientId: candidate.id,
        recipientEmail,
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

const STUCK_SENDING_MS = 10 * 60 * 1000

export async function dispatchPendingClientEmailAlerts(): Promise<{
  attempted: number
  delivered: number
  failed: number
  skipped: number
}> {
  const result = { attempted: 0, delivered: 0, failed: 0, skipped: 0 }

  const config = await prisma.clientEmailAlertsConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config?.enabled) return result

  // Stuck-state recovery — same pattern as the SMS dispatcher.
  await prisma.clientEmailDelivery.updateMany({
    where: {
      status: 'sending',
      updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_MS) },
    },
    data: { status: 'pending' },
  })

  const due = await prisma.clientEmailDelivery.findMany({
    where: {
      status: 'pending',
      scheduledFor: { lte: new Date() },
    },
    select: {
      id: true,
      sourceKey: true,
      clientId: true,
      recipientEmail: true,
      customerPhone: true,
      apptDateTime: true,
    },
  })

  for (const row of due) {
    result.attempted++

    const dbMatch = row.sourceKey.match(/^db:appointment:(.+)$/)
    if (!dbMatch) {
      // Pending rows are always db: sourceKeys in normal operation
      // (sheet sync writes terminal statuses directly, never pending).
      // Skip silently — a sheet sourceKey here would be a logic bug.
      result.skipped++
      continue
    }
    const appointmentId = dbMatch[1]!

    // Atomic claim — flip pending → sending only if the row is still
    // pending. Prevents two ticks (or a rolling deploy overlap) from
    // double-sending.
    const claim = await prisma.clientEmailDelivery.updateMany({
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
        client: {
          select: {
            id: true,
            name: true,
            state: true,
            contactEmail: true,
            emailAlertsEnabled: true,
          },
        },
      },
    })
    if (!appt) {
      await prisma.clientEmailDelivery.update({
        where: { id: row.id },
        data: { status: 'skipped', errorMessage: 'appointment deleted' },
      })
      result.skipped++
      continue
    }
    // Dispatch gate — only send once the appointment is Confirmed. If
    // not (a row queued by a sheet sync before the gate, or one
    // un-confirmed inside the buffer), release the claim back to pending
    // so it holds until/unless it's confirmed.
    if (appt.dispatchStatus !== 'confirmed') {
      await prisma.clientEmailDelivery.update({
        where: { id: row.id },
        data: { status: 'pending' },
      })
      result.skipped++
      continue
    }
    if ((appt.status ?? '').toLowerCase().includes('cancel')) {
      await prisma.clientEmailDelivery.update({
        where: { id: row.id },
        data: {
          status: 'skipped',
          errorMessage: 'appointment cancelled before buffer expired',
        },
      })
      result.skipped++
      continue
    }
    // The client could have flipped emailAlertsEnabled off during
    // the buffer window. Respect that — don't send.
    if (!appt.client?.emailAlertsEnabled) {
      await prisma.clientEmailDelivery.update({
        where: { id: row.id },
        data: {
          status: 'skipped',
          errorMessage: 'client opted out before buffer expired',
        },
      })
      result.skipped++
      continue
    }

    // RECIPIENT RE-VALIDATION — same guard as the SMS dispatcher. If
    // the agent reassigned this appointment to a DIFFERENT client
    // during the buffer window, this row's recipientEmail no longer
    // owns the appointment. Sending would email the ORIGINAL client a
    // description of the NEW client's appointment (a cross-client
    // leak). The appointment's current linked client is authoritative
    // — skip when its email no longer matches this row; the
    // correctly-reassigned client has its own row that fires normally.
    const currentRecipientEmail = normalizeEmailForKey(
      appt.client?.contactEmail,
    )
    if (
      !currentRecipientEmail ||
      currentRecipientEmail !== row.recipientEmail
    ) {
      await prisma.clientEmailDelivery.update({
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
    const subject = subjectLineForRow(synthRow, appt.client?.name ?? 'Client')
    const html = formatAppointmentForClientEmail(synthRow, {
      clientName: appt.client?.name ?? 'Client',
      solar,
      includeRecording: await clientRecordingLinksEnabled(),
      // DB-driven dispatch path — we have the appointment id, so
      // the "Update Appointment Status" button can deep-link the
      // client straight to the report modal.
      appointmentId: appt.id,
    })

    try {
      const send = await sendEmail({
        accountEmail: config.fromGmailAccount || DEFAULT_FROM_GMAIL,
        to: row.recipientEmail,
        subject,
        body: html,
        fromName: config.senderName || DEFAULT_SENDER_NAME,
      })
      await prisma.clientEmailDelivery.update({
        where: { id: row.id },
        data: {
          status: 'delivered',
          messageId: send.id ?? null,
          deliveredAt: new Date(),
          apptDateTime: appt.apptDateTime,
        },
      })
      result.delivered++
    } catch (err) {
      const message = err instanceof Error ? err.message : 'send failed'
      await prisma.clientEmailDelivery.update({
        where: { id: row.id },
        data: { status: 'failed', errorMessage: message },
      })
      result.failed++
      console.error(
        `[client-email-alert] dispatch failed for ${appointmentId}:`,
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
 * Force-fire an email alert regardless of current status. Called from
 * the Settings UI "Retry" button. Bypasses the master enable toggle
 * (admin clicking Retry is an explicit override) but still respects
 * the per-client emailAlertsEnabled flag — refusing to send to a
 * client who's been turned off.
 */
export async function retryFailedClientEmailAlert(
  deliveryId: string,
): Promise<
  | { ok: true; messageId: string | null }
  | { ok: false; error: string; status?: string }
> {
  const row = await prisma.clientEmailDelivery.findUnique({
    where: { id: deliveryId },
  })
  if (!row) return { ok: false, error: 'delivery not found' }
  if (row.status === 'sending') {
    return {
      ok: false,
      error: 'this row is being sent right now — wait a moment and refresh',
      status: row.status,
    }
  }

  const config = await prisma.clientEmailAlertsConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config) return { ok: false, error: 'Email alerts config not found' }

  const client = row.clientId
    ? await prisma.client.findUnique({
        where: { id: row.clientId },
        select: {
          id: true,
          name: true,
          state: true,
          emailAlertsEnabled: true,
        },
      })
    : null
  if (client && !client.emailAlertsEnabled) {
    return {
      ok: false,
      error: `${client.name} has email alerts disabled — turn it back on in Settings to retry.`,
    }
  }

  let html: string
  let subject: string
  const dbMatch = row.sourceKey.match(/^db:appointment:(.+)$/)
  const sheetMatch = row.sourceKey.match(/^sheet:Master Table:(\d+)$/)

  if (dbMatch) {
    const appointmentId = dbMatch[1]
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { client: { select: { id: true, name: true, state: true } } },
    })
    if (!appt) return { ok: false, error: 'underlying appointment was deleted' }
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
    subject = subjectLineForRow(synthRow, appt.client?.name ?? 'Client')
    html = formatAppointmentForClientEmail(synthRow, {
      clientName: appt.client?.name ?? 'Client',
      solar,
      includeRecording: await clientRecordingLinksEnabled(),
      // Manual retry of a DB-keyed delivery — appointmentId
      // available; surface the update button.
      appointmentId: appt.id,
    })
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
    subject = subjectLineForRow(sheetRow, client?.name ?? 'Client')
    html = formatAppointmentForClientEmail(sheetRow, {
      clientName: client?.name ?? 'Client',
      solar,
      includeRecording: await clientRecordingLinksEnabled(),
    })
  } else {
    return { ok: false, error: `unrecognized sourceKey shape: ${row.sourceKey}` }
  }

  try {
    const send = await sendEmail({
      accountEmail: config.fromGmailAccount || DEFAULT_FROM_GMAIL,
      to: row.recipientEmail,
      subject,
      body: html,
      fromName: config.senderName || DEFAULT_SENDER_NAME,
    })
    await prisma.clientEmailDelivery.update({
      where: { id: row.id },
      data: {
        status: 'delivered',
        messageId: send.id ?? null,
        deliveredAt: new Date(),
        errorMessage: null,
      },
    })
    return { ok: true, messageId: send.id ?? null }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'send failed'
    await prisma.clientEmailDelivery.update({
      where: { id: row.id },
      data: { status: 'failed', errorMessage: message },
    })
    return { ok: false, error: message }
  }
}

/**
 * Re-key db: sourceKeys to sheet: shapes after the sheet sync writes
 * the row back, mirroring the SMS counterpart. Pending rows are NOT
 * rekeyed because the dispatcher parses the db: shape to fetch the
 * underlying appointment.
 */
export async function rekeyClientEmailAlertAfterSheetSync(
  appointmentId: string,
  sheetRowNumber: number,
): Promise<void> {
  const dbSourceKey = `db:appointment:${appointmentId}`
  const sheetSourceKey = `sheet:Master Table:${sheetRowNumber}`
  try {
    await prisma.clientEmailDelivery.updateMany({
      where: {
        sourceKey: dbSourceKey,
        NOT: { status: 'pending' },
      },
      data: { sourceKey: sheetSourceKey },
    })
  } catch (err) {
    console.error(
      `[client-email-alert] re-key after sheet sync failed for ${appointmentId}:`,
      err,
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  First-enable backfill                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mark every current sheet row as 'backfilled' for the given client
 * so the next sync tick won't blast historical bookings to the email
 * channel. Called when admin flips a client's emailAlertsEnabled on
 * for the first time. Idempotent.
 */
export async function backfillClientEmailAlerts(params: {
  clientId: string
  recipientEmail: string
}): Promise<{ recorded: number; alreadyTracked: number }> {
  const { clientId } = params
  const recipientEmail = normalizeEmailForKey(params.recipientEmail)
  if (!recipientEmail) return { recorded: 0, alreadyTracked: 0 }

  const allClients = await prisma.client.findMany({
    where: { active: true },
    select: { id: true, name: true, state: true },
  })
  const target = allClients.find((c) => c.id === clientId)
  if (!target) return { recorded: 0, alreadyTracked: 0 }

  const index = buildRoutingIndex(allClients)

  let rows: Awaited<ReturnType<typeof readAllSheetRows>>
  try {
    rows = await readAllSheetRows()
  } catch (err) {
    console.error('[client-email-alert] backfill: sheet read failed:', err)
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

    const sourceKey = rowSourceKey(row)
    try {
      await prisma.clientEmailDelivery.create({
        data: {
          sourceKey,
          clientId: target.id,
          recipientEmail,
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
 * Send a sample email to an address using a fake appointment. Used
 * by the Settings UI "Test email" button so admins can verify
 * routing + From: header + rendering before flipping a client on.
 */
export async function sendTestClientEmailAlert(params: {
  fromGmailAccount: string
  senderName: string | null
  recipientEmail: string
  clientName: string
}): Promise<{ ok: boolean; messageId: string | null }> {
  const recipient = normalizeEmailForKey(params.recipientEmail)
  if (!recipient) {
    throw new Error(
      `Could not parse recipient email "${params.recipientEmail}".`,
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
    notes: `Test email for ${params.clientName} — confirms Client Email Alerts setup. Ignore.`,
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
  const html = formatAppointmentForClientEmail(sample, {
    clientName: params.clientName,
    solar: null,
  })
  const subject = `[TEST] New Booked Appointment — ${params.clientName}`

  const send = await sendEmail({
    accountEmail: params.fromGmailAccount,
    to: recipient,
    subject,
    body: html,
    fromName: params.senderName || DEFAULT_SENDER_NAME,
  })
  return { ok: true, messageId: send.id ?? null }
}

/* -------------------------------------------------------------------------- */
/*  Subject + HTML body                                                        */
/* -------------------------------------------------------------------------- */

/** Subject line: "New Booked Appointment — {Customer} — {Date in tz}".
 *  Customer name + date make scanning the inbox a one-glance task. */
function subjectLineForRow(row: MasterTableRow, clientName: string): string {
  const tz = row.resolvedTimezone || timezoneForAddress(row.address) || 'UTC'
  const apptDate = row.apptDateTime ? new Date(row.apptDateTime) : null
  const dateStr =
    apptDate && !isNaN(apptDate.getTime())
      ? formatInTimezone(apptDate, tz, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
      : 'Time TBD'
  return `New appointment for ${clientName} — ${row.customerName} — ${dateStr}`
}

/**
 * HTML email body — a branded, table-based layout that renders well
 * in every major email client (Gmail, Outlook, Apple Mail). Inline
 * styles only; no external CSS. Same content shape as the SMS / Slack
 * bodies but presented as labeled sections with subtle dividers.
 */
export function formatAppointmentForClientEmail(
  row: MasterTableRow,
  opts: {
    clientName: string
    solar?: SolarSummary | null
    /** DB Appointment.id when one exists for this row (Mary's
     *  Hub-form bookings have one; Yassin's secondary-sheet rows
     *  don't). When present, renders an "Update Appointment Status"
     *  button at the bottom of the email that deep-links to the
     *  client dashboard with a pre-opened report modal. Skipped
     *  when null — partner-sheet rows can't be updated through the
     *  client dashboard since they're not in our DB. */
    appointmentId?: string | null
    /** Whether to render the "Listen to the call" recording button.
     *  Gated by the clientRecordingLinks flag at the delivery call
     *  site — defaults OFF (fail-closed) so a caller that forgets to
     *  pass it never emails a recording link to a client. */
    includeRecording?: boolean
  },
): string {
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

  // Build the property-details rows (only render when populated).
  const propertyRows: Array<{ label: string; value: string }> = []
  if (row.utilityProvider) {
    propertyRows.push({ label: 'Utility', value: row.utilityProvider })
  }
  if (row.monthlyBill) {
    propertyRows.push({ label: 'Monthly bill', value: row.monthlyBill })
  }
  const roofPiece =
    row.roofType && row.roofAge
      ? `${row.roofType} · ${row.roofAge}`
      : row.roofType || row.roofAge
  if (roofPiece) propertyRows.push({ label: 'Roof', value: roofPiece })
  if (row.estimatedDealValue) {
    propertyRows.push({
      label: 'Est. deal value',
      value: row.estimatedDealValue,
    })
  }

  // Build the solar-details rows (only when the cache had data).
  const solarRows: Array<{ label: string; value: string }> = []
  if (opts.solar && opts.solar.viability !== 'unavailable') {
    if (opts.solar.maxSunshineHoursPerYear != null) {
      solarRows.push({
        label: 'Sunshine',
        value: `${Math.round(opts.solar.maxSunshineHoursPerYear).toLocaleString()} hrs/yr`,
      })
    }
    if (opts.solar.maxPanelCount != null) {
      const panels =
        opts.solar.recommendedPanelCount != null &&
        opts.solar.recommendedPanelCount !== opts.solar.maxPanelCount
          ? `${opts.solar.maxPanelCount} max (${opts.solar.recommendedPanelCount} typical)`
          : `${opts.solar.maxPanelCount}`
      solarRows.push({ label: 'Max panels', value: panels })
    }
    if (opts.solar.recommendedAnnualKwh != null) {
      solarRows.push({
        label: 'Est. production',
        value: `${Math.round(opts.solar.recommendedAnnualKwh).toLocaleString()} kWh/yr`,
      })
    }
    if (opts.solar.roofAreaM2 != null) {
      const sqft = Math.round(opts.solar.roofAreaM2 * 10.7639)
      solarRows.push({
        label: 'Roof area',
        value: `${sqft.toLocaleString()} sq ft`,
      })
    }
  }

  // Helpers — keep the template inline for readability. Inline styles
  // are mandatory in email HTML (Gmail strips <style>).
  function esc(s: string | null | undefined): string {
    if (!s) return ''
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
  function row2col(label: string, value: string): string {
    return `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280;font-size:13px;width:140px;vertical-align:top;">${esc(label)}</td>
        <td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600;vertical-align:top;">${esc(value)}</td>
      </tr>`
  }

  const propertySection =
    propertyRows.length === 0
      ? ''
      : `
      <h3 style="margin:24px 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-weight:700;">Property details</h3>
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
        ${propertyRows.map((r) => row2col(r.label, r.value)).join('')}
      </table>`

  const solarSection =
    solarRows.length === 0
      ? ''
      : `
      <h3 style="margin:24px 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-weight:700;">Solar potential</h3>
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
        ${solarRows.map((r) => row2col(r.label, r.value)).join('')}
      </table>`

  const notesSection = row.notes
    ? `
      <h3 style="margin:24px 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-weight:700;">Notes</h3>
      <p style="margin:0;color:#374151;font-size:14px;line-height:1.5;white-space:pre-wrap;">${esc(row.notes)}</p>`
    : ''

  // Call recording — surface a prominent "Listen to call" button
  // routed through the Hub's signed proxy. signRecordingUrl returns
  // null when the proxy isn't configured yet OR the upstream host
  // isn't on the allowlist, in which case we silently drop the
  // button rather than ship a link that wouldn't work.
  const signedRecordingUrl =
    opts.includeRecording === true && row.callRecordingLink?.trim()
      ? signRecordingUrl(row.callRecordingLink.trim(), getHubOrigin())
      : null
  const recordingSection = signedRecordingUrl
    ? `
      <div style="margin:24px 0 0 0;">
        <a href="${esc(signedRecordingUrl)}"
           style="display:inline-block;background:#1e3a8a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;">
          🎧 Listen to the call
        </a>
        <p style="margin:6px 0 0 0;color:#6b7280;font-size:12px;">
          Streams from your browser — no install or login required.
        </p>
      </div>`
    : ''

  // "Update appointment status" deep-link — only rendered when we
  // have a DB Appointment id (partner-sheet rows don't, so they
  // silently skip the button, matching Alex's "unless they're from
  // a Partner" requirement). Click → opens /client?report=<id> in
  // a new tab; the dashboard's modal auto-opens for that appointment
  // (logged-in clients land directly; logged-out clients go through
  // the standard NextAuth callback flow first).
  const updateStatusUrl = opts.appointmentId
    ? `${getHubOrigin()}/client?report=${encodeURIComponent(opts.appointmentId)}`
    : null
  const updateStatusSection = updateStatusUrl
    ? `
      <div style="margin:16px 0 0 0;">
        <a href="${esc(updateStatusUrl)}"
           target="_blank"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;">
          Update Appointment Status
        </a>
        <p style="margin:6px 0 0 0;color:#6b7280;font-size:12px;">
          After the meeting, log into your dashboard and mark the
          outcome — showed, didn't show, plus any notes. Helps us
          close the loop without a follow-up call.
        </p>
      </div>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>New Booked Appointment</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
          <!-- Header bar -->
          <tr>
            <td style="background:#1e3a8a;padding:18px 28px;color:#ffffff;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;opacity:0.7;">Genisys Hub</div>
              <div style="font-size:18px;font-weight:700;margin-top:2px;">New Booked Appointment</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 16px 0;color:#374151;font-size:14px;line-height:1.5;">
                A new appointment has been booked for <strong>${esc(opts.clientName)}</strong>.
              </p>

              <h3 style="margin:0 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-weight:700;">Customer</h3>
              <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
                ${row2col('Name', row.customerName)}
                ${row2col('Date / Time', apptStr)}
                ${row2col('Phone', row.customerPhone)}
                ${cleanedAddress ? row2col('Address', cleanedAddress) : ''}
                ${row.email ? row2col('Email', row.email) : ''}
              </table>

              ${propertySection}
              ${solarSection}
              ${notesSection}
              ${recordingSection}
              ${updateStatusSection}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:18px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5;">
              You're receiving this because your account at Genisys Hub has email alerts enabled for new bookings.
              To stop receiving these, reply to this email and we'll turn them off.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
