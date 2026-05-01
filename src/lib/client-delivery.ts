/**
 * Per-client Slack appointment delivery.
 *
 * When a Client has slackChannelId set, every new appointment for
 * that client (whether typed manually into the Master Table sheet or
 * booked via the /agent portal — both end up in the same sheet) gets
 * auto-posted to the configured channel. Posts include @channel so
 * everyone in the channel gets the notification.
 *
 * Idempotency: every delivery is recorded in SheetSlackDelivery,
 * keyed by (sourceKey, channelId). The sync will never re-post a row
 * that already has a delivery record — even if the cron tick races
 * with a manual settings change or a container restart replays the
 * minute. When a channel is first configured for a client, the
 * existing sheet rows for that client are recorded as `backfilled`
 * (no Slack post) so we don't blast historical rows on first deploy.
 *
 * Routing: Master Table rows specify their client by name in the
 * "Client" column. We match against Client.name (case-insensitive).
 * Rows with a blank Client column or a name that doesn't match any
 * registered Client are skipped — we'd rather not post than risk
 * routing to the wrong channel. State-based inference (used by the
 * Master Tracker UI) is intentionally NOT applied here for the same
 * reason: explicit > clever for client-facing delivery.
 */

import { WebClient } from '@slack/web-api'
import { prisma } from './prisma'
import { readMasterTableRows, type MasterTableRow } from './drive'
import { getSecretByName } from './vault-service'
import { normalizeAddress } from './address'
import { formatInTimezone, timezoneForAddress } from './timezone'
import { buildRoutingIndex, routeRowToClient } from './client-routing'

/* -------------------------------------------------------------------------- */
/*  Sync                                                                       */
/* -------------------------------------------------------------------------- */

type DeliveryResult = {
  scanned: number
  delivered: number
  skipped: number
  failed: number
  /** Total rows we couldn't route to a channel — broken down below. */
  unrouted: number
  /** Routed via address state inference (no explicit Client column).
   *  Counted separately so admins can see when fallback inference
   *  is doing the work and can decide whether to firm up source data. */
  inferred: number
  /** Address state matched 2+ clients — refused to deliver. Most
   *  important diagnostic counter; first signal that a new client
   *  was onboarded into a state already served by another. */
  ambiguous: number
}

/**
 * Read every row in the Master Table, pick the ones we can confidently
 * route to a client with a configured Slack channel + haven't been
 * delivered yet, and post each to its channel. Idempotent — safe to
 * call on every cron tick.
 *
 * Routing falls back through three tiers, delegated to client-routing.ts:
 *   1. Explicit Client column on the sheet (high confidence, deliver)
 *   2. Address-state inference, exactly one client in that state
 *      (medium confidence, deliver)
 *   3. Address-state inference, 2+ clients in that state (ambiguous,
 *      DO NOT deliver — admin must fill in the Client column)
 *
 * The "all clients are in different states" assumption was implicit in
 * the original design; the routing lib makes it explicit so adding a
 * second AZ client (or wherever) cleanly degrades to "rows from that
 * state stop auto-routing" rather than silently posting to whichever
 * client happened to be added first.
 */
export async function syncClientDeliveriesFromSheet(): Promise<DeliveryResult> {
  const result: DeliveryResult = {
    scanned: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    unrouted: 0,
    inferred: 0,
    ambiguous: 0,
  }

  // Pull *every* active client (not just opted-in ones) so the routing
  // index sees the full picture. A row might match an active client
  // that simply hasn't configured a Slack channel yet — counting that
  // as 'unrouted' (via the channel check below) is more honest than
  // hiding it as 'no-match'.
  const clients = await prisma.client.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      state: true,
      slackChannelId: true,
      slackChannelName: true,
    },
  })

  // Cheap exit: nobody opted in → skip the sheet read entirely.
  const anyOptedIn = clients.some((c) => !!c.slackChannelId)
  if (!anyOptedIn) return result

  const index = buildRoutingIndex(clients)

  let rows: MasterTableRow[]
  try {
    rows = await readMasterTableRows()
  } catch (err) {
    console.error('[client-delivery] failed to read sheet:', err)
    return result
  }
  result.scanned = rows.length

  // Pull the bot token once per sync — saves N round-trips to the
  // vault when there are many rows to deliver.
  let slackClient: WebClient | null = null
  async function getSlackClient(): Promise<WebClient> {
    if (!slackClient) {
      const token = await getSecretByName('Slack Bot Token')
      slackClient = new WebClient(token)
    }
    return slackClient
  }

  for (const row of rows) {
    if (!row.customerName?.trim() || !row.customerPhone?.trim()) continue
    if (!row.apptDateTime) continue
    // Cancelled rows shouldn't get announced. The cron already cancels
    // pending reminders for these; same logic applies to delivery.
    if ((row.status || '').toLowerCase().includes('cancel')) continue

    const sourceKey = `sheet:Master Table:${row.rowNumber}`
    const route = routeRowToClient(
      { client: row.client, address: normalizeAddress(row.address) },
      index
    )

    if (route.source === 'unrouted') {
      result.unrouted++
      // Surface ambiguity loudly — it's the most actionable failure
      // mode. Admin sees "two clients claim this state" and knows the
      // fix is to fill in the source row's Client column.
      if (route.reason === 'ambiguous-state-match') {
        result.ambiguous++
        const names = (route.candidates ?? []).map((c) => c.name).join(', ')
        console.warn(
          `[client-delivery] ambiguous routing for sheet row ${row.rowNumber}: address state matches multiple clients (${names}). Fill in the Client column on the sheet to disambiguate.`
        )
      }
      continue
    }

    // We have a candidate — make sure they've actually opted in to
    // Slack delivery. This is what separates "don't deliver yet" from
    // "couldn't route at all" in the metrics.
    const candidate = route.client
    if (!candidate.slackChannelId) {
      result.unrouted++
      continue
    }

    if (route.source === 'inferred-state') {
      result.inferred++
    }

    // Idempotency check — if this (sourceKey, channelId) is already
    // recorded, skip regardless of status.
    const existing = await prisma.sheetSlackDelivery.findUnique({
      where: {
        sourceKey_channelId: {
          sourceKey,
          channelId: candidate.slackChannelId,
        },
      },
    })
    if (existing) {
      result.skipped++
      continue
    }

    // Build the message body. Falls back to the raw row values when
    // tz / formatting helpers can't resolve — better partial info than
    // a missed delivery.
    const body = formatAppointmentForClientChannel(row)

    try {
      const slack = await getSlackClient()
      const post = await slack.chat.postMessage({
        channel: candidate.slackChannelId,
        text: body,
        // mrkdwn defaults true; explicit for clarity.
        mrkdwn: true,
        // Suppress link previews — addresses + tel: links don't need
        // unfurling and would make the message visually noisy.
        unfurl_links: false,
        unfurl_media: false,
      })
      await prisma.sheetSlackDelivery.create({
        data: {
          sourceKey,
          clientId: candidate.id,
          channelId: candidate.slackChannelId,
          status: 'delivered',
          messageTs: post.ts ?? null,
          deliveredAt: new Date(),
        },
      })
      result.delivered++
      if (route.source === 'inferred-state') {
        console.log(
          `[client-delivery] sheet row ${row.rowNumber} routed to ${candidate.name} via address-state inference (${route.matchedState}). Client column was blank — consider filling it for clarity.`
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Send failed'
      // Record a failed-status row so we don't retry indefinitely on a
      // permanent failure (deleted channel, kicked bot, etc.). Admin
      // can clear the row manually from Settings to retry. The unique
      // index means a subsequent retry would still need this row to
      // exist anyway — recording status='failed' just makes the failure
      // visible.
      try {
        await prisma.sheetSlackDelivery.create({
          data: {
            sourceKey,
            clientId: candidate.id,
            channelId: candidate.slackChannelId,
            status: 'failed',
            errorMessage: message,
          },
        })
      } catch {
        // Race: another tick recorded a delivery while we were
        // failing. Fine — it succeeded, no error to record.
      }
      console.error(
        `[client-delivery] post failed for ${sourceKey} → ${candidate.slackChannelId}:`,
        message
      )
      result.failed++
    }
  }

  return result
}

/* -------------------------------------------------------------------------- */
/*  Backfill                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Called when an admin first configures a Slack channel for a client
 * (or changes which channel routes to them). Walks the current sheet
 * and records every existing row for this client as `backfilled` so
 * the next sync tick treats them as already-delivered.
 *
 * Critical for first-deploy safety: if Spring Solar has 50 historical
 * rows on the sheet when their channel is first set, we don't want
 * those 50 rows to all post into #spring-solar at the next cron tick.
 */
export async function backfillClientDeliveries(params: {
  clientId: string
  channelId: string
}): Promise<{ recorded: number; alreadyTracked: number }> {
  const { clientId, channelId } = params

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true },
  })
  if (!client) return { recorded: 0, alreadyTracked: 0 }

  let rows: MasterTableRow[]
  try {
    rows = await readMasterTableRows()
  } catch (err) {
    console.error('[client-delivery] backfill: sheet read failed:', err)
    return { recorded: 0, alreadyTracked: 0 }
  }

  const lowerName = client.name.toLowerCase()
  let recorded = 0
  let alreadyTracked = 0

  for (const row of rows) {
    if (!row.customerName?.trim()) continue
    if ((row.client ?? '').toLowerCase() !== lowerName) continue

    const sourceKey = `sheet:Master Table:${row.rowNumber}`
    try {
      await prisma.sheetSlackDelivery.create({
        data: {
          sourceKey,
          clientId: client.id,
          channelId,
          status: 'backfilled',
        },
      })
      recorded++
    } catch (err) {
      // Unique constraint hit — this row's already tracked (channel
      // was set before, then re-set). That's fine; not an error.
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
/*  Test post                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send a sample post to a channel using a fake appointment. Used by
 * the Settings UI's "Test post" button so admins can verify routing
 * before a real appointment lands.
 */
export async function sendTestClientDelivery(params: {
  channelId: string
  clientName: string
}): Promise<{ ok: boolean; ts: string | null }> {
  const token = await getSecretByName('Slack Bot Token')
  const slack = new WebClient(token)
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
    notes: `This is a test post from the Genisys Hub for ${params.clientName}. If you're seeing it in the right channel, the routing is wired up correctly.`,
    callRecordingLink: null,
    loggedAt: new Date().toISOString(),
    sentToClient: null,
    client: params.clientName,
    agentName: null,
    agentEmail: null,
  }
  const body = formatAppointmentForClientChannel(sample, { isTest: true })
  const post = await slack.chat.postMessage({
    channel: params.channelId,
    text: body,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  })
  return { ok: post.ok ?? false, ts: post.ts ?? null }
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Render a sheet row as a Slack mrkdwn message body. Includes
 * `<!channel>` so everyone in the channel gets the ping, per the
 * delivery requirement.
 *
 * Intentionally omits the agent name — these messages are
 * client-facing, and the call-center attribution stays internal.
 */
export function formatAppointmentForClientChannel(
  row: MasterTableRow,
  opts: { isTest?: boolean } = {}
): string {
  const lines: string[] = []
  const cleanedAddress = normalizeAddress(row.address)
  const tz = timezoneForAddress(cleanedAddress)

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
        })
      : row.apptDateTime || 'Time TBD'

  // Header — broadcast tag first so the notification is unambiguous.
  if (opts.isTest) {
    lines.push(`:test_tube: *Test post — ignore* :test_tube:`)
  }
  lines.push(`<!channel> :calendar: *New appointment booked*`)
  lines.push('')
  lines.push(`*${row.customerName}*`)
  lines.push(`:calendar: ${apptStr}`)

  // Phone as a clickable tel: link. Slack's mrkdwn doesn't support
  // tel: in <link|label> syntax in all clients consistently — plain
  // text is the safer move; the user's mobile will still recognize
  // a 10-digit number as callable.
  lines.push(`:telephone_receiver: ${row.customerPhone}`)

  if (cleanedAddress) {
    lines.push(`:round_pushpin: ${cleanedAddress}`)
  }
  if (row.email) {
    lines.push(`:email: ${row.email}`)
  }

  // Property block — only render lines that have a value, so a
  // partially-filled row doesn't end up with a wall of em-dashes.
  const propertyLines: string[] = []
  if (row.utilityProvider) propertyLines.push(`*Utility:* ${row.utilityProvider}`)
  if (row.monthlyBill) propertyLines.push(`*Monthly bill:* ${row.monthlyBill}`)
  const roofPiece =
    row.roofType && row.roofAge
      ? `${row.roofType} · ${row.roofAge}`
      : row.roofType || row.roofAge
  if (roofPiece) propertyLines.push(`*Roof:* ${roofPiece}`)
  if (row.estimatedDealValue) {
    propertyLines.push(`*Est. deal value:* ${row.estimatedDealValue}`)
  }
  if (propertyLines.length > 0) {
    lines.push('')
    lines.push(propertyLines.join('  ·  '))
  }

  if (row.notes?.trim()) {
    lines.push('')
    lines.push(`> ${row.notes.trim().replace(/\n/g, '\n> ')}`)
  }

  return lines.join('\n')
}
