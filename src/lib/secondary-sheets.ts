/**
 * Secondary Google Sheets that feed the Master Tracker beyond the
 * primary "Master Table." Added 2026-05-13 so Yassin's call center
 * (running Forward Energy Solutions + Brighton Capital Solar on
 * their own sheets) can flow into the same pipeline without anyone
 * having to reformat anything.
 *
 * Each registered SecondarySheet row maps a spreadsheet+tab to one
 * Client. Rows from that sheet are hard-attributed to that Client
 * — no routing brain. The column layout is picked by columnMappingKey;
 * 'yassin' covers both currently-known sheets (identical 15-column
 * layout, different content). Future partners with different layouts
 * just need a new preset added here.
 *
 * Returned rows match the MasterTableRow shape so every downstream
 * consumer (reminders, client alerts, Slack delivery, with-counts,
 * the master tracker UI) gets the same data structure. The `source`
 * field is the only difference — consumers use it to e.g. hide
 * secondary rows from Mary's tracker view.
 */
import { prisma } from './prisma'
import {
  getSheetsClient,
  getWriterAccountEmail,
  readMasterTableRows,
  type MasterTableRow,
} from './drive'
import {
  timezoneForAddress,
  wallClockInTzToUtcIso,
} from './timezone'

/** Source tag attached to every row so consumers can tell whether
 *  a row came from the primary master sheet or one of the secondary
 *  registered sheets. Cheap to compute, expensive to recover later
 *  without it. */
export type RowSource =
  | { kind: 'primary' }
  | {
      kind: 'secondary'
      spreadsheetId: string
      tabTitle: string
      clientId: string | null
      sheetLabel: string | null
    }

/** MasterTableRow + source info. The fields are identical to
 *  MasterTableRow so a consumer can ignore source if it doesn't
 *  care, and just treat the row like any other. */
export type SourcedRow = MasterTableRow & { source: RowSource }

/**
 * Read every enabled SecondarySheet row from its Google Sheet,
 * map columns to the canonical MasterTableRow shape, and return a
 * flat list across all sheets.
 *
 * Sheets with no clientId attached are skipped (orphaned config from
 * a deleted Client — the SetNull FK keeps the SecondarySheet row but
 * we have no way to attribute rows). Sheets the Google API can't
 * fetch (deleted file, permission revoked, transient outage) are
 * logged and skipped — one bad sheet doesn't poison the rest.
 */
export async function readSecondarySheetRows(): Promise<SourcedRow[]> {
  const sheets = await prisma.secondarySheet.findMany({
    where: { enabled: true, clientId: { not: null } },
    select: {
      id: true,
      spreadsheetId: true,
      tabTitle: true,
      clientId: true,
      columnMappingKey: true,
      label: true,
      client: { select: { name: true } },
    },
  })

  if (sheets.length === 0) return []

  // One auth handshake reused across every sheet — getSheetsClient
  // caches inside drive.ts so the per-sheet fetches that follow
  // share the same OAuth token.
  const writerEmail = await getWriterAccountEmail()
  const client = await getSheetsClient(writerEmail)

  const all: SourcedRow[] = []
  for (const s of sheets) {
    if (!s.clientId) continue
    const mapping = getColumnMapping(s.columnMappingKey)
    if (!mapping) {
      console.warn(
        `[secondary-sheets] unknown columnMappingKey="${s.columnMappingKey}" for sheet ${s.spreadsheetId} — skipping`,
      )
      continue
    }

    let rows: string[][]
    try {
      const range = `'${s.tabTitle.replace(/'/g, "''")}'!A2:Z`
      const res = await client.spreadsheets.values.get({
        spreadsheetId: s.spreadsheetId,
        range,
        valueRenderOption: 'FORMATTED_VALUE',
      })
      rows = (res.data.values ?? []) as string[][]
    } catch (err) {
      // Don't let one bad sheet take down the whole sync. Common
      // causes: file deleted, share permission revoked, API quota
      // burst. Logged so admin can see why a client suddenly has no
      // sheet-keyed appointments.
      console.error(
        `[secondary-sheets] failed to read ${s.spreadsheetId} / ${s.tabTitle}:`,
        err,
      )
      continue
    }

    const source: RowSource = {
      kind: 'secondary',
      spreadsheetId: s.spreadsheetId,
      tabTitle: s.tabTitle,
      clientId: s.clientId,
      sheetLabel: s.label,
    }
    const clientName = s.client?.name ?? null

    rows.forEach((cells, i) => {
      const row = mapping(cells, i, {
        clientName,
        clientId: s.clientId!,
      })
      if (row) all.push({ ...row, source })
    })
  }

  return all
}

/* -------------------------------------------------------------------------- */
/*  Column-mapping presets                                                    */
/* -------------------------------------------------------------------------- */

type MappingContext = {
  clientName: string | null
  clientId: string
}

type ColumnMapping = (
  cells: string[],
  rowIndex: number, // 0-based across the rows we got back (header excluded)
  ctx: MappingContext,
) => MasterTableRow | null

function getColumnMapping(key: string): ColumnMapping | null {
  if (key === 'yassin') return yassinMapping
  return null
}

/**
 * Forward Energy Solutions + Brighton Capital Solar share an identical
 * 15-column layout from Yassin's call center. Headers (0-indexed):
 *
 *   0  Timestamp            → loggedAt
 *   1  Agent name           → agentName
 *   2  Lead Name            → customerName
 *   3  Phone                → customerPhone
 *   4  Email                → email
 *   5  HO' Address          → address
 *   6  Appt. Type           → prefixed onto notes as "[Type]"
 *   7  Appointment Date     → date half of apptDateTime
 *   8  Appt. Time           → time half of apptDateTime
 *   9  Notes                → notes (concatenated with the prefix/suffix
 *                              chunks below)
 *   10 Agent Recording      → callRecordingLink
 *   11 Notes From Quality   → appended to notes ("Quality: …")
 *   12 Appointments status  → status (normalized to our vocab)
 *   13 Notes From Sales Rep → appended to notes ("Sales rep: …")
 *   14 System Size          → appended to notes ("System size: …")
 *
 * Yassin's sheets are missing several master-sheet fields (monthly
 * bill, utility, roof type/age, deal value). Those come through as
 * null — the customer's client sees "—" in those columns on /client.
 * Acceptable for now; could be improved later by parsing the free-text
 * Notes column for "bill 200+", "FPL", etc.
 */
function yassinMapping(
  cells: string[],
  rowIndex: number,
  ctx: MappingContext,
): MasterTableRow | null {
  // Trim every cell up front so we don't have to call .trim() at
  // every read site. Empty strings become null where the field is
  // nullable.
  const get = (i: number) => (cells[i] ?? '').toString().trim()
  const orNull = (v: string) => (v.length > 0 ? v : null)

  const customerName = get(2)
  const customerPhone = get(3)
  // Skip blank rows — same convention as the primary master sheet
  // reader. Avoids inserting reminder rows for "Lead Name is blank,
  // Phone is blank" placeholder lines below the real data.
  if (!customerName && !customerPhone) return null

  const address = orNull(get(5))
  const apptDateRaw = orNull(get(7))
  const apptTimeRaw = orNull(get(8))

  // Combine date + time in the customer's local timezone. Same logic
  // the primary reader uses — we infer tz from the address (Florida →
  // ET, Arizona → MST/no-DST). Empty time defaults to midnight.
  const tz = timezoneForAddress(address) ?? 'America/New_York'
  let apptDateTime: string | null = null
  if (apptDateRaw || apptTimeRaw) {
    const combined = apptTimeRaw
      ? `${apptDateRaw ?? ''} ${apptTimeRaw}`.trim()
      : (apptDateRaw ?? '')
    apptDateTime = wallClockInTzToUtcIso(combined, tz)
    if (!apptDateTime) {
      // V8 fallback if our parser couldn't make sense of the format.
      const d = new Date(combined)
      if (!isNaN(d.getTime())) apptDateTime = d.toISOString()
    }
  }

  const apptType = orNull(get(6))
  const rawNotes = orNull(get(9))
  const qualityNotes = orNull(get(11))
  const salesRepNotes = orNull(get(13))
  const systemSize = orNull(get(14))
  // Glue the auxiliary Yassin-specific fields onto the main notes
  // blob so they're visible everywhere notes are displayed (the
  // master tracker, /client tracker, etc.). Order is deliberate:
  // appt type up top, the agent's notes, then post-call additions.
  const notes = [
    apptType ? `[${apptType}]` : null,
    rawNotes,
    qualityNotes ? `Quality: ${qualityNotes}` : null,
    salesRepNotes ? `Sales rep: ${salesRepNotes}` : null,
    systemSize ? `System size: ${systemSize}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    rowNumber: rowIndex + 2, // 1-based + skip header row
    apptDateTime,
    client: ctx.clientName,
    customerName,
    customerPhone,
    address,
    email: orNull(get(4)),
    monthlyBill: null,
    utilityProvider: null,
    roofType: null,
    roofAge: null,
    status: orNull(normalizeYassinStatus(get(12))),
    estimatedDealValue: null,
    notes: notes.length > 0 ? notes : null,
    callRecordingLink: orNull(get(10)),
    agentName: orNull(get(1)),
    agentEmail: null,
    loggedAt: orNull(get(0)),
    sentToClient: null,
    timezone: null,
    resolvedTimezone: tz,
    apptDateRaw,
    apptTimeRaw,
    apptDateTimeRaw: apptDateRaw && apptTimeRaw ? `${apptDateRaw} ${apptTimeRaw}` : null,
  }
}

/**
 * Read every configured sheet (primary "Master Table" + every enabled
 * SecondarySheet) and return all rows as one flat array, each tagged
 * with its source. Consumers that don't care about source just iterate
 * normally; consumers that do (e.g. the Mary-visible Master Tracker
 * filter) inspect row.source.kind.
 *
 * The two reads run in parallel — secondary sheets don't block the
 * primary, primary doesn't block secondaries. Order of returned rows:
 * primary first, then secondaries in spreadsheet registration order.
 * Consumers that sort by apptDateTime / loggedAt should keep doing
 * that; the unstable order across runs from concurrent fetches
 * doesn't matter once they sort.
 *
 * One bad sheet (transient API error, deleted file) only takes itself
 * down — see readSecondarySheetRows for the per-sheet try/catch. The
 * primary sheet failure currently bubbles up (existing behavior); we
 * could harden later but the primary failing is itself the "system
 * is broken" signal we want.
 */
export async function readAllSheetRows(): Promise<SourcedRow[]> {
  const [primary, secondary] = await Promise.all([
    readMasterTableRows(),
    readSecondarySheetRows(),
  ])
  const tagged: SourcedRow[] = primary.map((r) => ({
    ...r,
    source: { kind: 'primary' as const },
  }))
  return [...tagged, ...secondary]
}

/** Returns a stable, globally-unique sourceKey for a row's reminder
 *  ledger entry. Primary rows keep the legacy "sheet:Master Table:N"
 *  format so existing reminder rows in the DB still match. Secondary
 *  rows use the spreadsheet ID as the namespace so two different
 *  sheets can have a row 5 without colliding. */
export function rowSourceKey(row: SourcedRow): string {
  if (row.source.kind === 'primary') {
    return `sheet:Master Table:${row.rowNumber}`
  }
  return `sheet:${row.source.spreadsheetId}:${row.rowNumber}`
}

/** Yassin's status vocab is roughly the same as ours but with
 *  inconsistent casing + extra punctuation ("No Show" vs "no_show",
 *  "Showed Up" vs "showed"). Normalize so the downstream Master
 *  Tracker UI / status filters work without special-casing. Unknown
 *  values pass through verbatim — admin can spot them. */
function normalizeYassinStatus(raw: string): string {
  const v = raw.toLowerCase().replace(/[-_\s]+/g, ' ').trim()
  if (!v) return ''
  if (v === 'booked' || v === 'scheduled' || v === 'set') return 'booked'
  if (v.includes('reschedule')) return 'rescheduled'
  if (v === 'showed' || v === 'showed up' || v === 'attended') return 'showed'
  if (v === 'won' || v === 'closed' || v === 'sold') return 'won'
  if (v === 'lost' || v.includes('not interest')) return 'lost'
  if (v.includes('no show')) return 'no_show'
  if (v.includes('cancel')) return 'cancelled'
  // Pass through whatever they typed — the UI's StatusBadge has a
  // generic fallback for unknown values.
  return raw
}

