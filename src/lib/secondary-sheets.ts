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
      rows = await fetchSheetRowsWithFallback(client, s.spreadsheetId, s.tabTitle)
    } catch (err) {
      // Don't let one bad sheet take down the whole sync. Common
      // causes: file deleted, share permission revoked, API quota
      // burst, configured tab name doesn't exist AND the spreadsheet
      // has no readable first tab either. Logged so admin can see
      // why a client suddenly has no sheet-keyed appointments.
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

  // Yassin's reps cram structured fields (bill, utility, roof) into
  // the free-text Notes blob instead of separate columns. Parse them
  // out so the Master Tracker's column display + the per-client
  // tracker on /client don't show "—" for fields the customer
  // actually told us about. The original notes string still gets
  // displayed verbatim — extraction is additive, never destructive.
  const parsed = parseYassinNotes(notes || rawNotes || '')

  return {
    rowNumber: rowIndex + 2, // 1-based + skip header row
    apptDateTime,
    client: ctx.clientName,
    customerName,
    customerPhone,
    address,
    email: orNull(get(4)),
    monthlyBill: parsed.monthlyBill,
    utilityProvider: parsed.utilityProvider,
    roofType: parsed.roofType,
    roofAge: parsed.roofAge,
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

/**
 * Fetch every data row (header excluded) from a secondary sheet,
 * with a fallback path for the common "Yassin renamed the tab"
 * failure mode. Behavior:
 *
 *   1. Try the configured tabTitle first. If it works, return the
 *      A2:Z slice.
 *   2. If Google rejects the range as unparsable, fetch the
 *      spreadsheet's metadata, find the first visible tab, and
 *      retry against that. This makes the integration robust to
 *      partners renaming tabs without us redeploying.
 *   3. If even the metadata fetch fails or the spreadsheet has no
 *      sheets at all, rethrow so the caller logs and skips.
 *
 * Exported so the diagnostic endpoint can use the same logic — that
 * way "what does production actually see for this sheet" matches
 * what the cron sees during sync.
 */
export async function fetchSheetRowsWithFallback(
  client: Awaited<ReturnType<typeof getSheetsClient>>,
  spreadsheetId: string,
  preferredTabTitle: string,
): Promise<string[][]> {
  const tryFetch = async (tabTitle: string) => {
    const range = `'${tabTitle.replace(/'/g, "''")}'!A2:Z`
    const res = await client.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: 'FORMATTED_VALUE',
    })
    return (res.data.values ?? []) as string[][]
  }

  try {
    return await tryFetch(preferredTabTitle)
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    // Only fall back on "Unable to parse range" — that's the Sheets
    // API's signal for "this tab name doesn't exist." Auth /
    // permission / network errors should bubble up so the caller
    // logs them clearly instead of getting swallowed by a fallback.
    if (!/parse range|Unable to parse/i.test(message)) {
      throw err
    }
    // Look up the spreadsheet's actual sheet list and try the first
    // visible one. This handles partners who renamed the default tab
    // from "Sheet1" to "Appointments" / "Form Responses 1" / etc.
    const meta = await client.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
    })
    const firstSheet = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title && !s.properties?.hidden,
    )
    const firstTabTitle = firstSheet?.properties?.title
    if (!firstTabTitle) {
      throw new Error(
        `Spreadsheet ${spreadsheetId} has no visible tabs — configured tab "${preferredTabTitle}" not found and no fallback available`,
      )
    }
    console.warn(
      `[secondary-sheets] configured tab "${preferredTabTitle}" not found in ${spreadsheetId}, falling back to first tab "${firstTabTitle}"`,
    )
    return await tryFetch(firstTabTitle)
  }
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

/* -------------------------------------------------------------------------- */
/*  Notes-blob parsing (extract structured fields from free text)             */
/* -------------------------------------------------------------------------- */

/** Parses the free-text Notes blob Yassin's reps fill in to pull out
 *  structured fields (monthly bill, utility provider, roof type, roof
 *  age) the master sheet has dedicated columns for. We're conservative:
 *  only populate a field when the pattern is unambiguous; otherwise
 *  leave it null and let the notes blob be the source of truth.
 *
 *  Sample input (lightly tidied from a real Yassin row):
 *    "Name: Jialin L Zhang, single family yes, bill 200+, FPL,
 *     credit 660+, no shading, good shingle roof, virtual 5/12 10am,
 *     sole decision maker"
 *
 *  Extracted:
 *    monthlyBill:     '$200'
 *    utilityProvider: 'FPL'
 *    roofType:        'Asphalt Shingle'
 *    roofAge:         null   (no explicit age cue)
 *
 *  Exported for use in the diagnostic endpoint + future test cases. */
export function parseYassinNotes(raw: string): {
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
} {
  const empty = {
    monthlyBill: null,
    utilityProvider: null,
    roofType: null,
    roofAge: null,
  }
  if (!raw || !raw.trim()) return empty

  return {
    monthlyBill: extractMonthlyBill(raw),
    utilityProvider: extractUtility(raw),
    roofType: extractRoofType(raw),
    roofAge: extractRoofAge(raw),
  }
}

/** Bill detection patterns, ordered most-specific first. We anchor on
 *  context cues ("bill", "/mo", "monthly") so a bare "$200" in another
 *  context (e.g. "$200 deposit") doesn't get mistaken for a bill. */
function extractMonthlyBill(text: string): string | null {
  // "bill 200", "bill: $245", "monthly bill 320", "electric bill $180"
  const labeled = text.match(
    /\b(?:monthly\s+bill|electric\s+bill|bill)[\s:]*\$?\s*(\d{2,4})\+?/i,
  )
  if (labeled) return `$${labeled[1]}`
  // "$250/mo", "$300 monthly", "245 per month"
  const slashMo = text.match(
    /\$?\s*(\d{2,4})\s*\+?\s*\/?\s*(?:mo\b|month\b|monthly\b|per\s+month)/i,
  )
  if (slashMo) return `$${slashMo[1]}`
  return null
}

/** Known US residential electricity providers. Kept as a list with a
 *  display label so we can match against case-insensitive variants but
 *  store a clean canonical name. Order matters slightly: longer / more
 *  specific names should appear before short abbreviations (e.g.
 *  "Florida Power & Light" before "FPL") so a row that spells out the
 *  full name doesn't half-match an abbreviation accidentally. */
const KNOWN_UTILITIES: Array<{ label: string; aliases: string[] }> = [
  { label: 'FPL', aliases: ['florida power & light', 'florida power and light', 'fpl'] },
  { label: 'TECO', aliases: ['teco', 'tampa electric'] },
  { label: 'Duke Energy', aliases: ['duke energy', 'duke power'] },
  { label: 'JEA', aliases: ['jea'] },
  { label: 'Eversource', aliases: ['eversource'] },
  { label: 'Con Edison', aliases: ['con edison', 'coned', 'consolidated edison'] },
  { label: 'National Grid', aliases: ['national grid'] },
  { label: 'PSE&G', aliases: ['pseg', 'pse&g', 'public service electric'] },
  { label: 'PG&E', aliases: ['pg&e', 'pg and e', 'pacific gas & electric', 'pacific gas and electric'] },
  { label: 'SCE', aliases: ['southern california edison', 'sce'] },
  { label: 'SDG&E', aliases: ['sdg&e', 'san diego gas', 'san diego gas & electric'] },
  { label: 'LADWP', aliases: ['ladwp', 'la dwp', 'los angeles dwp', 'los angeles department of water'] },
  { label: 'APS', aliases: ['arizona public service', 'aps'] },
  { label: 'SRP', aliases: ['srp', 'salt river project'] },
  { label: 'TXU Energy', aliases: ['txu energy', 'txu'] },
  { label: 'Reliant', aliases: ['reliant energy', 'reliant'] },
  { label: 'Direct Energy', aliases: ['direct energy'] },
  { label: 'Dominion', aliases: ['dominion energy', 'dominion'] },
  { label: 'Xcel Energy', aliases: ['xcel energy', 'xcel'] },
  { label: 'Georgia Power', aliases: ['georgia power'] },
  { label: 'Alabama Power', aliases: ['alabama power'] },
  { label: 'Entergy', aliases: ['entergy'] },
  { label: 'NV Energy', aliases: ['nv energy'] },
  { label: 'PPL Electric', aliases: ['ppl electric', 'ppl'] },
  { label: 'PECO', aliases: ['peco'] },
  { label: 'BGE', aliases: ['bge', 'baltimore gas'] },
]

function extractUtility(text: string): string | null {
  const lower = text.toLowerCase()
  for (const u of KNOWN_UTILITIES) {
    for (const alias of u.aliases) {
      // Word-boundary match for short codes (≤4 chars) to avoid
      // substring false positives like "aps" matching "apps". Plain
      // includes for longer phrase aliases.
      if (alias.length <= 4) {
        const pattern = new RegExp(
          `(?:^|[^a-z0-9])${escapeRegex(alias)}(?:$|[^a-z0-9])`,
          'i',
        )
        if (pattern.test(text)) return u.label
      } else if (lower.includes(alias)) {
        return u.label
      }
    }
  }
  return null
}

/** Roof type keywords. Order: more specific terms first so "wood shake"
 *  doesn't get clobbered by a later "wood" rule. */
function extractRoofType(text: string): string | null {
  const lower = text.toLowerCase()
  if (/\b(?:wood\s+shake|shake\s+roof|cedar\s+shake)\b/.test(lower)) return 'Wood Shake'
  if (/\b(?:asphalt|shingle)\b/.test(lower)) return 'Asphalt Shingle'
  if (/\btile\s+roof|\bclay\s+tile|\bspanish\s+tile|\btile\b/.test(lower)) return 'Tile'
  if (/\bmetal\s+roof|\bstanding\s+seam|\bmetal\b/.test(lower)) return 'Metal'
  if (/\bflat\s+roof|\btar\s+roof|\bbuilt[\s-]up\s+roof/.test(lower)) return 'Flat'
  return null
}

/** Roof age extraction. Heuristics — "new roof" → < 5y, numeric
 *  patterns parse the digit. Returns the same human-readable strings
 *  the master-sheet column uses (the Hub's normalizeRoofAge helper
 *  ultimately tidies these on insert if they hit the DB path). */
function extractRoofAge(text: string): string | null {
  if (/\bnew\s+roof\b|\broof\s+is\s+new\b|\bbrand\s+new\s+roof\b/i.test(text)) {
    return 'New'
  }
  // "10 yr", "5 years", "15-year-old", "8yo"
  const m = text.match(
    /\b(\d{1,2})\s*(?:-|\s)?(?:yr|year|years|yo|y\.o\.|y\s*\/?\s*o)\b/i,
  )
  if (m) return `${m[1]} years`
  return null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

