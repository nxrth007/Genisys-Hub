import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { readMasterTableRows } from '@/lib/drive'
import { normalizeAddress } from '@/lib/address'
import { buildRoutingIndex, routeRowToClient } from '@/lib/client-routing'

/**
 * GET /api/call-center/master-tracker
 *
 * Returns every row in the Master Table sheet, shaped like the
 * Appointment objects the rest of /call-center renders. This is the
 * source of truth for the Master Tracker page because the call center
 * is currently typing rows directly into the sheet (not through the
 * Hub's /agent portal). Pulling from the sheet means we see *all*
 * appointments — manually-entered ones AND Hub-synced ones — without
 * double-counting (the Hub's sync writes into the same sheet).
 *
 * Staff-only — middleware already blocks role=agent.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Pull every active client so the routing brain (shared with the
  // Slack-delivery sync) can match by explicit Client column OR by
  // state inference, and refuse to guess when a state has multiple
  // clients claiming it.
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, state: true, color: true },
  })
  const routingIndex = buildRoutingIndex(clients)

  let rows
  try {
    rows = await readMasterTableRows()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read sheet'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Fetch every Slack delivery record so each row can render its
  // current delivery state (delivered / backfilled / failed / not
  // tracked). Done as one bulk query instead of N per-row lookups
  // — the sheet typically holds dozens to hundreds of rows and the
  // delivery ledger lives in the same DB. Indexed by sourceKey for
  // primary match; secondary content-key match (channel + phone +
  // apptDateTime) catches rows whose rowNumber shifted after the
  // ledger entry was created.
  const deliveries = await prisma.sheetSlackDelivery.findMany({
    where: {
      sourceKey: { startsWith: 'sheet:Master Table:' },
    },
    select: {
      sourceKey: true,
      channelId: true,
      status: true,
      messageTs: true,
      deliveredAt: true,
      customerPhone: true,
      apptDateTime: true,
    },
  })

  // Two indexes — sourceKey for the fast path and (channel, phone,
  // apptDateTime) for the content-stable path that survives row
  // shifts in the sheet.
  const deliveryBySourceKey = new Map<string, typeof deliveries>()
  const deliveryByContent = new Map<string, typeof deliveries>()
  for (const d of deliveries) {
    const sk = deliveryBySourceKey.get(d.sourceKey) ?? []
    sk.push(d)
    deliveryBySourceKey.set(d.sourceKey, sk)
    if (d.customerPhone && d.apptDateTime) {
      const ck = `${d.channelId}|${d.customerPhone}|${d.apptDateTime.toISOString()}`
      const list = deliveryByContent.get(ck) ?? []
      list.push(d)
      deliveryByContent.set(ck, list)
    }
  }

  function normalizePhoneForKey(raw: string | null): string | null {
    if (!raw) return null
    const digits = raw.replace(/\D/g, '')
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    if (digits.length >= 10) return `+${digits}`
    return null
  }

  // Normalize sheet status values into the same lowercase-with-underscore
  // tokens the Hub UI uses for tone classes ("booked" / "showed" / etc).
  const normalizeStatus = (raw: string | null): string => {
    if (!raw) return 'booked' // sensible default — rows in the sheet
    // are usually freshly booked unless flagged otherwise.
    const s = raw.toLowerCase().trim()
    if (s === 'no show' || s === 'no-show' || s === 'noshow') return 'no_show'
    if (s === 'rescheduled' || s === 'reschedule') return 'rescheduled'
    if (s === 'showed' || s === 'show' || s === 'shown') return 'showed'
    if (s === 'cancelled' || s === 'canceled' || s === 'cancel') {
      return 'cancelled'
    }
    return 'booked'
  }

  const appointments = rows.map((r) => {
    // Clean the address once at the API boundary. Everything downstream
    // (display, CSV export, search) reads this canonical form, and the
    // raw sheet value is never touched. Reads as a no-op for addresses
    // that are already well-formatted.
    const cleanedAddress = normalizeAddress(r.address)

    // Same routing tiers the Slack delivery uses: explicit name match
    // → state inference (only when 1 client per state) → unrouted.
    // 'inferred-state' rows render a small "auto" hint so Ethan can
    // spot which rows still need the Client column filled in upstream.
    // 'ambiguous-state-match' rows render as "no client" so it's
    // visible at a glance which need disambiguation.
    const route = routeRowToClient(
      { client: r.client, address: cleanedAddress },
      routingIndex
    )
    const clientLookup =
      route.source === 'explicit' || route.source === 'inferred-state'
        ? route.client
        : null
    const clientInferred = route.source === 'inferred-state'

    // Slack delivery status for this row. Look up by sourceKey
    // (fast path) AND content key (for rows that drifted post-
    // delivery via row-number shifts in the sheet). Pick the most
    // recent matching record so the "delivered" status wins over
    // an older "failed" attempt for the same row.
    const sourceKey = `sheet:Master Table:${r.rowNumber}`
    const phoneKey = normalizePhoneForKey(r.customerPhone)
    const apptISO = r.apptDateTime
      ? new Date(r.apptDateTime).toISOString()
      : null
    const matched: typeof deliveries = []
    matched.push(...(deliveryBySourceKey.get(sourceKey) ?? []))
    if (phoneKey && apptISO) {
      // Content match could span multiple channels — keep them all
      // and let the per-channel status surface separately. For now
      // we report a single "primary" delivery per row (the
      // delivered one if any, else the most recent record).
      for (const list of deliveryByContent.values()) {
        for (const d of list) {
          if (
            d.customerPhone === phoneKey &&
            d.apptDateTime &&
            d.apptDateTime.toISOString() === apptISO &&
            !matched.includes(d)
          ) {
            matched.push(d)
          }
        }
      }
    }
    // Pick the most-favorable record. A 'delivered' row WITHOUT a
    // messageTs is suspect — historically these correspond to a
    // Slack post that never actually landed but where we recorded
    // the outcome as success anyway. Demote these to the same rank
    // as 'failed' so the UI surfaces a Retry button rather than a
    // green pill that lies.
    function rank(d: { status: string; messageTs: string | null }) {
      if (d.status === 'delivered' && d.messageTs) return 3
      if (d.status === 'delivered') return 2 // suspect — no Slack ts
      if (d.status === 'failed') return 2
      if (d.status === 'backfilled') return 1
      return 0
    }
    matched.sort((a, b) => {
      const r = rank(b) - rank(a)
      if (r !== 0) return r
      const at = a.deliveredAt?.getTime() ?? 0
      const bt = b.deliveredAt?.getTime() ?? 0
      return bt - at
    })
    const primary = matched[0] ?? null
    // Same demotion in the API surface — a 'delivered' record without
    // a messageTs gets reported to the UI as 'failed' so the user
    // sees a Retry button. Saves admins from staring at a "Delivered"
    // pill when nothing actually landed in Slack.
    const reportedStatus =
      primary && primary.status === 'delivered' && !primary.messageTs
        ? 'failed'
        : primary?.status
    const slackDelivery = primary
      ? {
          status: reportedStatus as
            | 'delivered'
            | 'backfilled'
            | 'failed'
            | string,
          messageTs: primary.messageTs,
          deliveredAt: primary.deliveredAt
            ? primary.deliveredAt.toISOString()
            : null,
          channelId: primary.channelId,
        }
      : null

    return {
      // Synthetic id from the sheet row number — stable across reads as
      // long as the sheet's row order doesn't change. Used as React key.
      id: `sheet:${r.rowNumber}`,
      apptDateTime:
        r.apptDateTime ||
        // Fall back to today midnight so the row still renders if the
        // date column is blank/unparsable.
        new Date().toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      address: cleanedAddress,
      email: r.email,
      monthlyBill: r.monthlyBill,
      utilityProvider: r.utilityProvider,
      roofType: r.roofType,
      roofAge: r.roofAge,
      status: normalizeStatus(r.status),
      estimatedDealValue: r.estimatedDealValue,
      notes: r.notes,
      callRecordingLink: r.callRecordingLink,
      lastSyncedAt: null,
      syncError: null,
      // `createdAt` keeps a non-null value so the CSV export "Logged At"
      // column always renders something (falls back to apptDateTime,
      // then to "now"). Do *not* use this for "booked today"–style
      // filters — that's what `loggedAt` below is for.
      createdAt: r.loggedAt
        ? new Date(r.loggedAt).toISOString()
        : r.apptDateTime || new Date().toISOString(),
      // Honest timestamp of when the row was logged. Null when the
      // sheet's Logged At column is blank or the cell value can't be
      // parsed as a date — we'd rather drop the value than fall back
      // to apptDateTime (which would silently mislabel rows as
      // "booked today" by their appointment date). The Master Tracker
      // "Booked today / this week" filters key off this exclusively.
      loggedAt: parseSheetDateOrNull(r.loggedAt),
      // Sent-to-client manual flag. Normalized to one of three
      // tokens so the UI can render a chip-tone select without
      // worrying about case / synonym sprawl.
      sentToClient: normalizeSentToClient(r.sentToClient),
      // Synthetic agent so the page doesn't have to special-case sheet
      // rows. Agent links go nowhere meaningful for these rows but they
      // render correctly.
      agent: {
        id: `sheet-agent:${(r.agentEmail || r.agentName || 'unknown').toLowerCase()}`,
        name: r.agentName || null,
        email: r.agentEmail || '',
      },
      // If the client name matches a registered Client, attach the real
      // record so badge color/state show. Otherwise null so the UI
      // displays "—" / treats it as unassigned.
      client: clientLookup
        ? {
            id: clientLookup.id,
            name: clientLookup.name,
            state: clientLookup.state,
            color: clientLookup.color,
          }
        : r.client
          ? {
              // Unknown client name — preserve what's in the sheet so
              // Ethan can spot typos / new clients that haven't been
              // registered yet. Falls back to a neutral grey.
              id: `sheet-client:${r.client.toLowerCase()}`,
              name: r.client,
              state: null,
              color: '#6b7280',
            }
          : null,
      clientInferred,
      // Per-row Slack delivery status, surfaced so the Master
      // Tracker UI can render a "Delivered ✓" pill or a manual
      // "Deliver" button as appropriate. Staff-only feature; the
      // /agent route hides the button via pathname check on the
      // client.
      slackDelivery,
    }
  })

  return NextResponse.json({ appointments })
}

/**
 * Best-effort date parse for a sheet cell value. Returns null when the
 * input is empty/unparseable rather than throwing — sheet cells come
 * back as FORMATTED_VALUE strings which can be in surprising shapes
 * (locale-specific, missing year, "5/1" with no time, etc.) and we'd
 * rather lose one row's loggedAt than crash the whole endpoint.
 */
function parseSheetDateOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * Normalize the sheet's "Sent to Client?" column into one of three
 * canonical tokens — empty cell = unassigned, anything affirmative
 * (yes / y / 1 / true / sent) = yes, anything negative = no, anything
 * else = unassigned (preserved as such until someone explicitly flips
 * it).
 */
function normalizeSentToClient(raw: string | null | undefined): 'yes' | 'no' | 'unassigned' {
  if (!raw) return 'unassigned'
  const s = String(raw).trim().toLowerCase()
  if (!s) return 'unassigned'
  if (['yes', 'y', '1', 'true', 'sent', 'delivered', 'handed off'].includes(s))
    return 'yes'
  if (['no', 'n', '0', 'false', 'not sent'].includes(s)) return 'no'
  return 'unassigned'
}
