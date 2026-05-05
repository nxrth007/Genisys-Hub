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
import { readMasterTableRows, type MasterTableRow } from './drive'
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
    },
  })

  // Cheap exit: nobody has a contactPhone configured → nothing to do.
  // (active=true clients with null/empty contactPhone fall through
  // and get logged as 'unrouted' below for visibility, but bailing
  // when literally everyone is empty saves a sheet read.)
  const anyPhoneConfigured = clients.some((c) => normalizePhoneForKey(c.contactPhone))
  if (!anyPhoneConfigured) return result

  const index = buildRoutingIndex(clients)

  let rows: MasterTableRow[]
  try {
    rows = await readMasterTableRows()
  } catch (err) {
    console.error('[client-alert] failed to read sheet:', err)
    return result
  }
  result.scanned = rows.length

  for (const row of rows) {
    if (!row.customerName?.trim() || !row.customerPhone?.trim()) continue
    if (!row.apptDateTime) continue
    if ((row.status || '').toLowerCase().includes('cancel')) continue

    const sourceKey = `sheet:Master Table:${row.rowNumber}`
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
      if (existing.sourceKey !== sourceKey) {
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

    const solar = row.address
      ? await snapshotSolarFromCache(row.address).catch(() => null)
      : null
    const body = formatAppointmentForClientSms(row, { solar })

    try {
      const send = await sendSmsToPhone(config.vaultEntryName, {
        phone: recipientPhone,
        message: body,
        firstName: candidate.name,
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
 */
export async function deliverAppointmentAsSms(
  appointmentId: string,
): Promise<{
  status: 'delivered' | 'skipped' | 'unrouted' | 'no-phone' | 'disabled' | 'failed'
  reason?: string
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

  const allClients = await prisma.client.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      state: true,
      contactPhone: true,
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
    select: { id: true },
  })
  if (existing) return { status: 'skipped', reason: 'already delivered' }

  // Build a synthetic MasterTableRow shape so we can reuse
  // formatAppointmentForClientSms — same body shape clients see in
  // Slack, just plain text.
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
    const send = await sendSmsToPhone(config.vaultEntryName, {
      phone: recipientPhone,
      message: body,
      firstName: candidate.name,
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
        apptDateTime: appt.apptDateTime,
      },
    })
    return { status: 'delivered' }
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
          apptDateTime: appt.apptDateTime,
        },
      })
    } catch {
      // Race — fine.
    }
    console.error(
      `[client-alert] DB-driven SMS failed for ${appointmentId}:`,
      message,
    )
    return { status: 'failed', reason: message }
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
    await prisma.clientAlertDelivery.updateMany({
      where: { sourceKey: dbSourceKey },
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

  let rows: MasterTableRow[]
  try {
    rows = await readMasterTableRows()
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
    firstName: params.clientName,
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
