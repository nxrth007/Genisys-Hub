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
import { snapshotSolarFromCache, type SolarSummary } from './solar'

/** Strip everything but digits, prefix with +1 for 10-digit US
 *  numbers. Same idea as the GHL helper but lives here so this module
 *  doesn't have to take a dependency on lib/ghl. Used to compute the
 *  stable content-dedup key — "(555) 123-4567" and "5551234567" must
 *  collapse to the same canonical form so dedup catches them. */
function normalizePhoneForKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}` // best-effort intl
  return null // too short to be useful as a dedup key
}

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

    // Idempotency check — two-pronged:
    //   1. (sourceKey, channelId): catches the common case where the
    //      same row is re-scanned across cron ticks
    //   2. (channelId, normalizedPhone, apptDateTime): catches the
    //      sneaky case where Mary inserts/deletes a row above this
    //      one, shifting its rowNumber. Old sourceKey was for the
    //      old position; new sourceKey looks fresh, but the content
    //      key is stable so we still skip.
    const normalizedPhone = normalizePhoneForKey(row.customerPhone)
    const apptDate = row.apptDateTime ? new Date(row.apptDateTime) : null
    const apptDateValid = apptDate && !isNaN(apptDate.getTime())

    const existing = await prisma.sheetSlackDelivery.findFirst({
      where: {
        channelId: candidate.slackChannelId,
        OR: [
          { sourceKey },
          ...(normalizedPhone && apptDateValid
            ? [
                {
                  customerPhone: normalizedPhone,
                  apptDateTime: apptDate,
                },
              ]
            : []),
        ],
      },
      select: { id: true, status: true, sourceKey: true },
    })
    if (existing) {
      result.skipped++
      // If the existing row tracked this delivery via a stale
      // sourceKey (i.e. the row shifted), opportunistically refresh
      // it to the current sourceKey so future scans hit the cheaper
      // unique-index path. Idempotent — same delivery either way.
      if (existing.sourceKey !== sourceKey) {
        await prisma.sheetSlackDelivery
          .update({
            where: { id: existing.id },
            data: { sourceKey },
          })
          .catch(() => {
            // Unique constraint hit means another row with the
            // current sourceKey already exists for this channel.
            // Both rows represent the same delivery; safe to leave
            // them in place.
          })
      }
      continue
    }

    // Build the message body. Falls back to the raw row values when
    // tz / formatting helpers can't resolve — better partial info
    // than a missed delivery. Solar info comes from the cache when
    // Mary clicked "Check solar potential" before saving — never
    // triggers a fresh billable lookup from the cron.
    const solar = row.address
      ? await snapshotSolarFromCache(row.address).catch(() => null)
      : null
    const body = formatAppointmentForClientChannel(row, { solar })

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
      // Defensive — Slack's WebClient is supposed to throw on ok:false,
      // but we've seen mismatches in the wild where a delivery row
      // gets recorded as 'delivered' but the channel never actually
      // got the post. Requiring a real message timestamp before we
      // claim success means a silent-fail surfaces as 'failed' (which
      // the UI offers a Retry button for) instead of a phantom
      // 'delivered' that the channel doesn't reflect.
      if (!post.ok || !post.ts) {
        throw new Error(
          `Slack acknowledged the post without returning a message id (ok=${post.ok}). Treating as failed so it can be retried.`,
        )
      }
      await prisma.sheetSlackDelivery.create({
        data: {
          sourceKey,
          clientId: candidate.id,
          channelId: candidate.slackChannelId,
          status: 'delivered',
          messageTs: post.ts ?? null,
          deliveredAt: new Date(),
          // Stable content key — survives row-number shifts in the
          // sheet. The pre-insert dedup query checks both this and
          // sourceKey before getting here.
          customerPhone: normalizedPhone,
          apptDateTime: apptDateValid ? apptDate : null,
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
            customerPhone: normalizedPhone,
            apptDateTime: apptDateValid ? apptDate : null,
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
 * and records every existing row that *would route to* this client —
 * via either the explicit Client column OR address-state inference —
 * as `backfilled` so the next sync tick treats them as already-
 * delivered.
 *
 * Critical first-deploy safety: must mirror EXACTLY what the sync
 * pass would route. The first version of this only matched on the
 * explicit Client column, which missed every row where the call
 * center had left it blank but the address state pointed at this
 * client (the sync's tier-2 inference). Result: those rows blasted
 * into the channel on the first cron tick. Lesson: backfill and sync
 * must agree on "what counts as this client's row" — done now by
 * sharing the routing brain.
 */
export async function backfillClientDeliveries(params: {
  clientId: string
  channelId: string
}): Promise<{ recorded: number; alreadyTracked: number }> {
  const { clientId, channelId } = params

  // Pull every active client (not just the one being backfilled) so
  // the routing brain sees the full picture and produces the same
  // verdicts the sync would. Using a single-client view here would
  // make state inference incorrectly route everyone in that state to
  // this client, which is wrong when other clients share the state.
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
    console.error('[client-delivery] backfill: sheet read failed:', err)
    return { recorded: 0, alreadyTracked: 0 }
  }

  let recorded = 0
  let alreadyTracked = 0

  for (const row of rows) {
    if (!row.customerName?.trim()) continue
    const route = routeRowToClient(
      { client: row.client, address: normalizeAddress(row.address) },
      index
    )
    // Only mark rows that actually resolve to *this* client. Ambiguous
    // and unrouted rows are left untouched — the sync will see them
    // and refuse to deliver too, so there's no risk of leakage.
    if (route.source === 'unrouted') continue
    if (route.client.id !== clientId) continue

    const sourceKey = `sheet:Master Table:${row.rowNumber}`
    try {
      await prisma.sheetSlackDelivery.create({
        data: {
          sourceKey,
          clientId: target.id,
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
/*  Cleanup — undo erroneous deliveries                                        */
/* -------------------------------------------------------------------------- */

/**
 * Used to recover from a misconfiguration where the sync posted
 * historical rows that should have been backfilled. For a given
 * client + channel, deletes every recent 'delivered' message from
 * Slack and flips the ledger entry to 'backfilled' so the row stays
 * tracked (no future re-post) without leaving a stale Slack message
 * in the channel.
 *
 * Slack's chat.delete only works for messages the bot itself posted,
 * which is exactly our case. Failure to delete (e.g. message already
 * removed) is treated as success — the goal is "don't show in the
 * channel anymore, AND don't re-post" and the latter is the bit we
 * actually control via the ledger flip.
 */
export async function undoClientDeliveries(params: {
  clientId: string
  channelId: string
  /** Only undo deliveries newer than this. Default: 24 hours back —
   *  prevents an admin from accidentally wiping months of legitimate
   *  posts when they meant to fix the most recent batch. */
  sinceHoursAgo?: number
}): Promise<{
  found: number
  deletedFromSlack: number
  ledgerUpdated: number
  errors: string[]
}> {
  const sinceHoursAgo = params.sinceHoursAgo ?? 24
  const cutoff = new Date(Date.now() - sinceHoursAgo * 60 * 60 * 1000)
  const errors: string[] = []

  const deliveries = await prisma.sheetSlackDelivery.findMany({
    where: {
      clientId: params.clientId,
      channelId: params.channelId,
      status: 'delivered',
      deliveredAt: { gte: cutoff },
    },
  })
  if (deliveries.length === 0) {
    return { found: 0, deletedFromSlack: 0, ledgerUpdated: 0, errors }
  }

  const token = await getSecretByName('Slack Bot Token')
  const slack = new WebClient(token)
  let deletedFromSlack = 0
  let ledgerUpdated = 0

  for (const d of deliveries) {
    if (d.messageTs) {
      try {
        await slack.chat.delete({
          channel: params.channelId,
          ts: d.messageTs,
        })
        deletedFromSlack++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // message_not_found / already_deleted is fine — we just want
        // the row gone from the channel one way or another.
        if (
          !message.includes('message_not_found') &&
          !message.includes('already_deleted')
        ) {
          errors.push(`row ${d.sourceKey}: ${message}`)
        }
      }
    }
    // Always flip the ledger — even if the Slack delete failed, we
    // don't want this row to *re-post* on the next sync.
    await prisma.sheetSlackDelivery.update({
      where: { id: d.id },
      data: {
        status: 'backfilled',
        messageTs: null,
        deliveredAt: null,
        errorMessage: null,
      },
    })
    ledgerUpdated++
  }

  return {
    found: deliveries.length,
    deletedFromSlack,
    ledgerUpdated,
    errors,
  }
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
  opts: { isTest?: boolean; solar?: SolarSummary | null } = {}
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
  // Avoid :calendar: anywhere; in Slack it renders with a stuck "17"
  // numeral that's easy to misread as the appointment's day.
  if (opts.isTest) {
    lines.push(`:test_tube: *Test post — ignore* :test_tube:`)
  }
  lines.push(`<!channel> :zap: *New appointment booked*`)
  lines.push('')
  lines.push(`*${row.customerName}*`)
  lines.push(`:clock3: ${apptStr}`)

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

  // Solar potential — only included when Mary clicked "Check solar
  // potential" before saving (which populates the cache that the
  // sync looks up). If there's no cached lookup OR Sunroof has no
  // imagery for the location ("unavailable"), we silently skip the
  // block so the post doesn't contain a sad "no data" line.
  if (opts.solar && opts.solar.viability !== 'unavailable') {
    const solarLines: string[] = []
    if (opts.solar.maxSunshineHoursPerYear != null) {
      solarLines.push(
        `*Sunshine:* ${Math.round(opts.solar.maxSunshineHoursPerYear).toLocaleString()} hrs/yr`,
      )
    }
    if (opts.solar.maxPanelCount != null) {
      const panels =
        opts.solar.recommendedPanelCount != null &&
        opts.solar.recommendedPanelCount !== opts.solar.maxPanelCount
          ? `${opts.solar.maxPanelCount} max (${opts.solar.recommendedPanelCount} typical)`
          : `${opts.solar.maxPanelCount}`
      solarLines.push(`*Max panels:* ${panels}`)
    }
    if (opts.solar.recommendedAnnualKwh != null) {
      solarLines.push(
        `*Est. production:* ${Math.round(opts.solar.recommendedAnnualKwh).toLocaleString()} kWh/yr`,
      )
    }
    if (opts.solar.roofAreaM2 != null) {
      const sqft = Math.round(opts.solar.roofAreaM2 * 10.7639)
      solarLines.push(`*Roof area:* ${sqft.toLocaleString()} sq ft`)
    }
    if (solarLines.length > 0) {
      lines.push('')
      const viabilityLabel =
        opts.solar.viability.charAt(0).toUpperCase() +
        opts.solar.viability.slice(1)
      lines.push(`:sunny: *Solar potential — ${viabilityLabel}*`)
      lines.push(solarLines.join('  ·  '))
    }
  }

  if (row.notes?.trim()) {
    lines.push('')
    lines.push(`> ${row.notes.trim().replace(/\n/g, '\n> ')}`)
  }

  return lines.join('\n')
}
