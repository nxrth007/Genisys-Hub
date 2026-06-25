import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { normalizeAddress } from '@/lib/address'
import { buildRoutingIndex, routeRowToClient } from '@/lib/client-routing'
import { readAllSheetRows, rowSourceKey } from '@/lib/secondary-sheets'
import { signRecordingUrl } from '@/lib/recording-proxy'

/** Hub origin used to construct signed recording proxy URLs in the
 *  response payload. Falls back to localhost for dev. */
function getHubOrigin(): string {
  const raw = process.env.AUTH_URL || 'http://localhost:3000'
  return raw.replace(/\/$/, '')
}

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
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Pull every active client so the routing brain (shared with the
  // Slack-delivery sync) can match by explicit Client column OR by
  // state inference, and refuse to guess when a state has multiple
  // clients claiming it.
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      name: true,
      state: true,
      color: true,
      contactName: true,
    },
  })
  const routingIndex = buildRoutingIndex(clients)

  // Pull every Hub-booked appointment so we can hydrate sheet rows
  // with the DB's authoritative createdAt when the sheet's Logged At
  // cell is empty (which it is by default — the sheet doesn't have
  // a Logged At column header, and we're moving away from the sheet
  // as source of truth anyway). Two index keys: masterSheetRowNumber
  // for the fast path; (phone + apptDateTime) for the in-flight
  // sync window where the row exists in the DB but rowNumber hasn't
  // been written back yet.
  const dbAppts = await prisma.appointment.findMany({
    where: { masterSheetRowNumber: { not: null } },
    select: {
      masterSheetRowNumber: true,
      customerPhone: true,
      apptDateTime: true,
      createdAt: true,
      // Client-side update fields — pulled here so the master
      // tracker rows can surface "client reported showed 5 min ago"
      // hints + the client's own notes alongside Mary's. Added
      // 2026-05-29 with the client status-update feature.
      clientNotes: true,
      clientStatusUpdatedAt: true,
      // County (geocoded from address at booking) — surfaced in the
      // master-tracker County column right after Address.
      county: true,
      // Hub-only dispatch lifecycle — drives the Dispatch Status column
      // + the automation gate.
      dispatchStatus: true,
    },
  })

  let rows: Awaited<ReturnType<typeof readAllSheetRows>>
  try {
    rows = await readAllSheetRows()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read sheet'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Visibility filter: the agent view only sees the primary
  // "Master Table" sheet. Secondary partner-call-center sheets
  // (Yassin's Forward Energy + Brighton Capital, as of 2026-05-13)
  // carry the purple "partner" chip and are admin-only per Ethan's
  // spec — they shouldn't be mixed into an agent's working pipeline.
  //
  // Two triggers, because Mary + Hannah are now ADMINS (promoted for
  // master-tracker edit access) yet still work out of the /agent
  // portal. Role alone no longer identifies them, so the agent view
  // sends ?view=agent and we drop partner rows on either signal:
  //   - role=agent           → any genuine agent account
  //   - ?view=agent          → the /agent portal, whatever the role
  // The Call Center (/call-center) staff view sends neither and sees
  // everything.
  const role = (session.user as { role?: string }).role
  const agentView = req.nextUrl.searchParams.get('view') === 'agent'
  if (role === 'agent' || agentView) {
    rows = rows.filter((r) => r.source.kind === 'primary')
  }

  // Fetch every Slack delivery record so each row can render its
  // current delivery state (delivered / backfilled / failed / not
  // tracked). Done as one bulk query instead of N per-row lookups
  // — the sheet typically holds dozens to hundreds of rows and the
  // delivery ledger lives in the same DB. Indexed by sourceKey for
  // primary match; secondary content-key match (channel + phone +
  // apptDateTime) catches rows whose rowNumber shifted after the
  // ledger entry was created.
  // Broadened from "sheet:Master Table:" → "sheet:" so Slack delivery
  // records for secondary-sheet rows also surface here. Secondary
  // sourceKeys look like "sheet:<spreadsheetId>:<rowNumber>"; the
  // shared "sheet:" prefix catches both.
  const deliveries = await prisma.sheetSlackDelivery.findMany({
    where: {
      sourceKey: { startsWith: 'sheet:' },
    },
    select: {
      sourceKey: true,
      channelId: true,
      status: true,
      messageTs: true,
      permalink: true,
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

  // Build the DB createdAt index now that normalizePhoneForKey is in
  // scope. Two paths so a row hits whichever signal is available
  // first: rowNumber when the sync wrote it back, content key
  // otherwise.
  const dbCreatedAtByRow = new Map<number, Date>()
  const dbCreatedAtByContent = new Map<string, Date>()
  /** Companion indices for the client-side fields — same lookup
   *  pattern as createdAt so we can join sheet rows to their DB
   *  appointment by rowNumber (fast path) or by phone + apptDate
   *  (content path that survives row shifts). */
  type ClientUpdate = {
    notes: string | null
    updatedAt: Date | null
  }
  const dbClientUpdateByRow = new Map<number, ClientUpdate>()
  const dbClientUpdateByContent = new Map<string, ClientUpdate>()
  // rowNumber → geocoded county (null when not yet resolved).
  const dbCountyByRow = new Map<number, string | null>()
  const dbCountyByContent = new Map<string, string | null>()
  // rowNumber → Hub dispatch status (defaults to not_dispatched).
  const dbDispatchByRow = new Map<number, string>()
  const dbDispatchByContent = new Map<string, string>()
  for (const a of dbAppts) {
    if (a.masterSheetRowNumber) {
      dbCreatedAtByRow.set(a.masterSheetRowNumber, a.createdAt)
      dbClientUpdateByRow.set(a.masterSheetRowNumber, {
        notes: a.clientNotes,
        updatedAt: a.clientStatusUpdatedAt,
      })
      dbCountyByRow.set(a.masterSheetRowNumber, a.county)
      dbDispatchByRow.set(a.masterSheetRowNumber, a.dispatchStatus)
    }
    const phoneKey = normalizePhoneForKey(a.customerPhone)
    if (phoneKey && a.apptDateTime) {
      const ck = `${phoneKey}|${a.apptDateTime.toISOString()}`
      dbClientUpdateByContent.set(ck, {
        notes: a.clientNotes,
        updatedAt: a.clientStatusUpdatedAt,
      })
      dbCountyByContent.set(ck, a.county)
      dbDispatchByContent.set(ck, a.dispatchStatus)
      dbCreatedAtByContent.set(ck, a.createdAt)
    }
  }

  // Build a duplicate-detection index. Two rows count as "likely the
  // same booking" when they share normalized phone + a stripped
  // alphanumeric address key. Same-phone different-address is left
  // alone — could be a legitimate rebooking at a different property.
  // Same-phone same-address with different appt times almost always
  // means the row got entered twice; flagging both lets admin pick
  // the canonical one and delete the other in the sheet directly.
  function addressKeyFor(raw: string | null): string | null {
    const cleaned = normalizeAddress(raw)
    if (!cleaned) return null
    const key = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '')
    return key.length >= 8 ? key : null
  }
  const dupGroups = new Map<string, number[]>()
  for (const r of rows) {
    if (!r.customerName?.trim()) continue
    const phoneKey = normalizePhoneForKey(r.customerPhone)
    const addrKey = addressKeyFor(r.address)
    if (!phoneKey || !addrKey) continue
    const groupKey = `${phoneKey}|${addrKey}`
    const list = dupGroups.get(groupKey) ?? []
    list.push(r.rowNumber)
    dupGroups.set(groupKey, list)
  }
  // Index per row → other row numbers in the same group. Empty
  // arrays for non-duplicates so the UI can render a clean "no
  // duplicate" path without a null check.
  const duplicateRowIdsByRow = new Map<number, number[]>()
  for (const [, members] of dupGroups) {
    if (members.length < 2) continue
    for (const rn of members) {
      duplicateRowIdsByRow.set(
        rn,
        members.filter((m) => m !== rn),
      )
    }
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
    // Won/lost are closer outcomes captured after the appointment.
    // Accept the obvious variants Mary or admin might type.
    if (s === 'won' || s === 'closed' || s === 'sold' || s === 'win') {
      return 'won'
    }
    if (s === 'lost' || s === 'no sale' || s === 'no-sale' || s === 'loss') {
      return 'lost'
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
    // an older "failed" attempt for the same row. sourceKey comes
    // from secondary-sheets.rowSourceKey so primary rows keep the
    // legacy "sheet:Master Table:N" shape and secondary rows use
    // "sheet:<spreadsheetId>:N".
    const sourceKey = rowSourceKey(r)
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
          permalink: primary.permalink,
          deliveredAt: primary.deliveredAt
            ? primary.deliveredAt.toISOString()
            : null,
          channelId: primary.channelId,
        }
      : null

    return {
      // Synthetic id from the sheet source + row number — stable across
      // reads as long as row order doesn't change. Primary rows keep
      // the legacy "sheet:N" id shape so the per-row PATCH endpoint
      // continues to work. Secondary rows use a "secondary:<sheetId>:N"
      // prefix so React keys stay unique across sheets AND the PATCH
      // endpoint can refuse to write to a read-only secondary sheet.
      id:
        r.source.kind === 'secondary'
          ? `secondary:${r.source.spreadsheetId}:${r.rowNumber}`
          : `sheet:${r.rowNumber}`,
      // Source tag surfaced to the UI so admin can render a badge
      // ("via Yassin's sheet"). Mary never sees this since secondary
      // rows are filtered out for role=agent above.
      source:
        r.source.kind === 'secondary'
          ? {
              kind: 'secondary' as const,
              label: r.source.sheetLabel,
              spreadsheetId: r.source.spreadsheetId,
              tabTitle: r.source.tabTitle,
            }
          : { kind: 'primary' as const },
      apptDateTime:
        r.apptDateTime ||
        // Fall back to today midnight so the row still renders if the
        // date column is blank/unparsable.
        new Date().toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      address: cleanedAddress,
      /** County — geocoded from the address at booking, looked up from
       *  the matching DB Appointment via rowNumber + content-key (same
       *  index clientNotes uses). Sheet-only rows with no DB record (or
       *  not-yet-geocoded ones) stay null. */
      county: (() => {
        const byRow = dbCountyByRow.get(r.rowNumber)
        if (byRow) return byRow
        const phoneKey = normalizePhoneForKey(r.customerPhone)
        if (phoneKey && r.apptDateTime) {
          const ck = `${phoneKey}|${new Date(r.apptDateTime).toISOString()}`
          const byContent = dbCountyByContent.get(ck)
          if (byContent) return byContent
        }
        return null
      })(),
      /** Hub-only dispatch lifecycle. Defaults to not_dispatched for
       *  sheet-only rows that don't have a DB appointment yet. */
      dispatchStatus: (() => {
        const byRow = dbDispatchByRow.get(r.rowNumber)
        if (byRow) return byRow
        const phoneKey = normalizePhoneForKey(r.customerPhone)
        if (phoneKey && r.apptDateTime) {
          const ck = `${phoneKey}|${new Date(r.apptDateTime).toISOString()}`
          const byContent = dbDispatchByContent.get(ck)
          if (byContent) return byContent
        }
        return 'not_dispatched'
      })(),
      email: r.email,
      monthlyBill: r.monthlyBill,
      utilityProvider: r.utilityProvider,
      roofType: r.roofType,
      roofAge: r.roofAge,
      status: normalizeStatus(r.status),
      estimatedDealValue: r.estimatedDealValue,
      notes: r.notes,
      callRecordingLink: r.callRecordingLink,
      /** Signed proxy URL — Hub-hosted shim around the raw vicitel
       *  link so admins (and clients) can play recordings without
       *  having their home IP on the upstream allowlist. Null when
       *  the proxy isn't configured (RECORDING_PROXY_SECRET unset
       *  on Render) or the upstream host isn't allowlisted. The UI
       *  prefers this when present and falls back to the raw
       *  callRecordingLink for admins whose IPs ARE on the
       *  allowlist already. */
      callRecordingProxyUrl: r.callRecordingLink
        ? signRecordingUrl(r.callRecordingLink, getHubOrigin())
        : null,
      /** Client-side update fields — surfaced so the master tracker
       *  can show a small "Client reported" badge + the client's
       *  own notes alongside Mary's. Looked up from the matching DB
       *  Appointment row via the same rowNumber + content-key index
       *  the createdAt lookup uses. Sheet-only rows (no DB record)
       *  stay null naturally. */
      clientNotes: (() => {
        const byRow = dbClientUpdateByRow.get(r.rowNumber)
        if (byRow && byRow.notes) return byRow.notes
        const phoneKey = normalizePhoneForKey(r.customerPhone)
        if (phoneKey && r.apptDateTime) {
          const ck = `${phoneKey}|${new Date(r.apptDateTime).toISOString()}`
          const byContent = dbClientUpdateByContent.get(ck)
          if (byContent && byContent.notes) return byContent.notes
        }
        return null
      })(),
      clientStatusUpdatedAt: (() => {
        const byRow = dbClientUpdateByRow.get(r.rowNumber)
        if (byRow && byRow.updatedAt) return byRow.updatedAt.toISOString()
        const phoneKey = normalizePhoneForKey(r.customerPhone)
        if (phoneKey && r.apptDateTime) {
          const ck = `${phoneKey}|${new Date(r.apptDateTime).toISOString()}`
          const byContent = dbClientUpdateByContent.get(ck)
          if (byContent && byContent.updatedAt) return byContent.updatedAt.toISOString()
        }
        return null
      })(),
      lastSyncedAt: null,
      syncError: null,
      // `createdAt` keeps a non-null value so the CSV export "Logged At"
      // column always renders something (falls back to apptDateTime,
      // then to "now"). Do *not* use this for "booked today"–style
      // filters — that's what `loggedAt` below is for.
      createdAt: r.loggedAt
        ? new Date(r.loggedAt).toISOString()
        : r.apptDateTime || new Date().toISOString(),
      // Honest timestamp of when the row was logged. Resolution
      // order:
      //   1. Sheet's Logged At cell (parsed) — only present when
      //      Mary types it manually since the sheet currently has
      //      no Logged At column header
      //   2. DB Appointment.createdAt by masterSheetRowNumber — set
      //      when the Hub form synced the row to the sheet
      //   3. DB Appointment.createdAt by content key (phone +
      //      apptDateTime) — catches the in-flight window where the
      //      DB row exists but rowNumber hasn't been written back
      //   4. null — sheet-typed rows from before the Hub-form era
      //      genuinely don't have a logged-at signal; the "Set
      //      today" filter excludes them rather than mislabel.
      // This makes the "Set today" chip work for every Hub-booked
      // appointment without needing a Logged At sheet column. Long-
      // term the master tracker will read directly from the DB and
      // skip the sheet round-trip entirely.
      loggedAt: (() => {
        const fromSheet = parseSheetDateOrNull(r.loggedAt)
        if (fromSheet) return fromSheet
        const byRow = dbCreatedAtByRow.get(r.rowNumber)
        if (byRow) return byRow.toISOString()
        const phoneKey = normalizePhoneForKey(r.customerPhone)
        if (phoneKey && r.apptDateTime) {
          const ck = `${phoneKey}|${new Date(r.apptDateTime).toISOString()}`
          const byContent = dbCreatedAtByContent.get(ck)
          if (byContent) return byContent.toISOString()
        }
        return null
      })(),
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
            contactName: clientLookup.contactName,
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
              contactName: null,
            }
          : null,
      clientInferred,
      // Per-row Slack delivery status, surfaced so the Master
      // Tracker UI can render a "Delivered ✓" pill or a manual
      // "Deliver" button as appropriate. Staff-only feature; the
      // /agent route hides the button via pathname check on the
      // client.
      slackDelivery,
      // Sheet rowNumbers of OTHER rows that look like the same
      // booking (matching normalized phone + address). Empty when
      // this row has no probable duplicates. UI uses this to render
      // a "⚠ Possible duplicate" warning so admins can spot and
      // clean up double-entries without auto-hiding real data.
      possibleDuplicateRowIds: duplicateRowIdsByRow.get(r.rowNumber) ?? [],
      // Explicit tz override Mary typed into the sheet's Timezone
      // column, plus the resolved IANA zone the row was actually
      // parsed in. The UI uses `resolvedTimezone` for display so
      // the time column always matches the customer's clock,
      // regardless of which source pinned it.
      timezone: r.timezone,
      resolvedTimezone: r.resolvedTimezone,
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
