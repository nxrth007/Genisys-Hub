import { NextResponse } from 'next/server'
import { WebClient } from '@slack/web-api'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'
import { readMasterTableRows } from '@/lib/drive'
import {
  buildRoutingIndex,
  routeRowToClient,
} from '@/lib/client-routing'
import {
  formatAppointmentForClientChannel,
} from '@/lib/client-delivery'
import { snapshotSolarFromCache } from '@/lib/solar'
import { normalizeAddress } from '@/lib/address'
import { getSecretByName } from '@/lib/vault-service'

/**
 * POST /api/admin/slack-delivery/deliver-row
 *
 * Force-deliver a single Master Tracker row to its client's Slack
 * channel. Staff-only — used by the per-row "Deliver" button in the
 * Master Tracker UI to recover from rows that ended up stuck in the
 * ledger as 'backfilled' or 'failed' (or never tracked at all),
 * which the cron sync would otherwise refuse to re-attempt.
 *
 * Body:
 *   { rowNumber: number, force?: boolean }
 *
 * If a `delivered` ledger record already exists for this row (via
 * sourceKey OR the content-stable phone+apptTime key), the endpoint
 * refuses unless force=true. Prevents accidental double-posts when
 * an admin clicks the button on an already-delivered row without
 * realizing.
 */
function normalizePhoneForKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return null
}

export async function POST(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: { rowNumber?: unknown; force?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const rowNumber =
    typeof body.rowNumber === 'number' && Number.isFinite(body.rowNumber)
      ? Math.round(body.rowNumber)
      : null
  if (!rowNumber || rowNumber < 1) {
    return NextResponse.json(
      { error: 'rowNumber is required (positive integer)' },
      { status: 400 },
    )
  }
  const force = body.force === true

  // Pull the sheet + active clients in parallel, same as the cron.
  const [rows, clients] = await Promise.all([
    readMasterTableRows(),
    prisma.client.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        state: true,
        slackChannelId: true,
        slackChannelName: true,
      },
    }),
  ])
  const row = rows.find((r) => r.rowNumber === rowNumber)
  if (!row) {
    return NextResponse.json(
      {
        error: `Row ${rowNumber} not found on the master sheet. The row may have been deleted or the sheet was edited mid-request.`,
      },
      { status: 404 },
    )
  }

  if (!row.customerName?.trim() || !row.customerPhone?.trim()) {
    return NextResponse.json(
      { error: 'Row is missing customer name or phone — fill the row in before delivering.' },
      { status: 400 },
    )
  }

  const index = buildRoutingIndex(clients)
  const route = routeRowToClient(
    { client: row.client, address: normalizeAddress(row.address) },
    index,
  )
  if (route.source === 'unrouted') {
    const reason =
      route.reason === 'ambiguous-state-match'
        ? `Address state matches multiple clients (${(route.candidates ?? []).map((c) => c.name).join(', ')}). Fill in the Client column on the sheet to disambiguate.`
        : route.reason === 'name-mismatch-no-state-match'
          ? "Client column has a value we couldn't resolve, and the address doesn't infer one either. Fix the Client column on the sheet."
          : "Couldn't route this row to a client — Client column is blank and address doesn't include a recognized state."
    return NextResponse.json(
      { error: `Routing failed: ${reason}` },
      { status: 400 },
    )
  }
  const client = route.client
  if (!client.slackChannelId) {
    return NextResponse.json(
      {
        error: `${client.name} doesn't have a Slack channel configured yet. Set one in Settings → Client → Slack delivery.`,
      },
      { status: 400 },
    )
  }

  const sourceKey = `sheet:Master Table:${row.rowNumber}`
  const phoneKey = normalizePhoneForKey(row.customerPhone)
  const apptDate = row.apptDateTime ? new Date(row.apptDateTime) : null
  const apptDateValid = apptDate && !isNaN(apptDate.getTime())

  // Look up any existing delivery record for this row (either index).
  const existing = await prisma.sheetSlackDelivery.findFirst({
    where: {
      channelId: client.slackChannelId,
      OR: [
        { sourceKey },
        ...(phoneKey && apptDateValid
          ? [{ customerPhone: phoneKey, apptDateTime: apptDate }]
          : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
  })
  if (existing && existing.status === 'delivered' && !force) {
    return NextResponse.json(
      {
        error:
          'This row was already delivered. Pass force=true to deliver again (creates a duplicate post).',
        existingMessageTs: existing.messageTs,
      },
      { status: 409 },
    )
  }

  // Solar pass — same cache-only contract as the cron. Adds the
  // solar block to the message body if Mary clicked Check earlier.
  const solar = row.address
    ? await snapshotSolarFromCache(row.address).catch(() => null)
    : null
  const body_ = formatAppointmentForClientChannel(row, { solar })

  // Send.
  const token = await getSecretByName('Slack Bot Token')
  const slack = new WebClient(token)
  try {
    const post = await slack.chat.postMessage({
      channel: client.slackChannelId,
      text: body_,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    })
    // Update or create the ledger row. If `existing` was non-
    // delivered (backfilled/failed/etc.), flip it to delivered with
    // the fresh messageTs. Otherwise create a new row. Both paths
    // converge on a clean 'delivered' state.
    if (existing) {
      await prisma.sheetSlackDelivery.update({
        where: { id: existing.id },
        data: {
          status: 'delivered',
          messageTs: post.ts ?? null,
          deliveredAt: new Date(),
          errorMessage: null,
          // Refresh the keys to current values so future cron ticks
          // hit the fast path.
          sourceKey,
          customerPhone: phoneKey,
          apptDateTime: apptDateValid ? apptDate : null,
        },
      })
    } else {
      await prisma.sheetSlackDelivery.create({
        data: {
          sourceKey,
          clientId: client.id,
          channelId: client.slackChannelId,
          status: 'delivered',
          messageTs: post.ts ?? null,
          deliveredAt: new Date(),
          customerPhone: phoneKey,
          apptDateTime: apptDateValid ? apptDate : null,
        },
      })
    }
    return NextResponse.json({
      ok: true,
      messageTs: post.ts ?? null,
      channelName: client.slackChannelName ?? client.slackChannelId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Slack post failed'
    // Record the failure on the ledger so admins see it later. Don't
    // re-throw — the response already carries the error message.
    try {
      if (existing) {
        await prisma.sheetSlackDelivery.update({
          where: { id: existing.id },
          data: { status: 'failed', errorMessage: message },
        })
      } else {
        await prisma.sheetSlackDelivery.create({
          data: {
            sourceKey,
            clientId: client.id,
            channelId: client.slackChannelId,
            status: 'failed',
            errorMessage: message,
            customerPhone: phoneKey,
            apptDateTime: apptDateValid ? apptDate : null,
          },
        })
      }
    } catch {
      // Race — fine.
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
