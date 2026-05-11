/**
 * Pinned Google Sheets — surfaced at the top of /documents so the
 * team can view + edit the two operationally-critical spreadsheets
 * without bouncing to Google Drive.
 *
 *   1. Genisys Financial Dashboard
 *      Where Alex tracks revenue, expenses, and margin for the
 *      agency. Drives every "are we profitable this month" decision.
 *
 *   2. Mary Client Sheet
 *      Per-client fulfillment status + qualification criteria for
 *      booking. This is the source of truth Mary checks against
 *      every appointment to decide if a lead qualifies — keeping it
 *      front-and-center on the Hub means the team can update
 *      criteria the moment a client changes their requirements.
 *
 * Embed strategy:
 *   - The full Google Sheets UI loads in an iframe (?embedded=true),
 *     which means editing works in-place for users signed into
 *     Google in the same browser. This is the simplest "actually
 *     edit a sheet" experience we can give without re-implementing
 *     Google Sheets from scratch.
 *   - Cookie/X-Frame-Options edge cases (third-party-cookie blocked
 *     browsers, incognito tabs without Google session) are caught
 *     by the prominent "Open in Google Sheets" escape button on
 *     each card.
 *
 * Adding a third sheet later: append a new entry here, no other
 * changes needed.
 */

/** A single cell or column reference in A1 notation, e.g. "B6" or "C10".
 *  Parsed by readCellValue() / parseCellRef() in pinned-sheets-analysis.ts. */
export type CellRef = string

/** How to coerce a cell's raw string into a display value. */
export type CellFormat = 'currency' | 'integer' | 'percent' | 'string'

/** A single KPI tile — reads one cell, formats it, shows it under a label. */
export type StructuredKpi = {
  label: string
  cell: CellRef
  format: CellFormat
  /** Optional secondary line under the value (e.g. "of total X"). */
  hint?: string
  /** When defined, this row renders "—" instead of its computed
   *  value if the guard cell is empty or zero. Used for DERIVED
   *  metrics (rates, averages, cost-per-X) where the underlying
   *  formula returns 0 when there's no input data, making "0%" or
   *  "$0" misleading. E.g. Mary's Show Rate at I12 should be "—"
   *  not "0%" when she's booked zero appointments (I10). */
  nullWhenZero?: CellRef
}

/** A logical group of metrics rendered as a labeled list/table. */
export type StructuredMetricSection = {
  title: string
  rows: Array<{
    label: string
    cell: CellRef
    format: CellFormat
    /** See StructuredKpi.nullWhenZero. Same semantics for section rows. */
    nullWhenZero?: CellRef
  }>
}

/** Description of an inline grid (e.g. the Monthly P&L block). */
export type StructuredGrid = {
  title: string
  /** 1-indexed sheet row containing column headers. */
  headerRow: number
  /** Inclusive 1-indexed row range containing data rows. */
  dataRowsStart: number
  dataRowsEnd: number
  /** 1-indexed sheet row containing the totals/sum row. Optional. */
  totalsRow?: number
  /** Inclusive 1-indexed column range (A=1, B=2, …) to show. */
  columnsStart: number
  columnsEnd: number
  /** Per-column display formatting. Length must match columnsEnd - columnsStart + 1.
   *  First entry is for the column at columnsStart (usually the row label, 'string'). */
  columnFormats: CellFormat[]
}

/** Full layout config for a workbook. When present, the detail view
 *  renders structured KPIs / metric sections / grids instead of running
 *  the generic "find the dollar signs" inference. The named tab must
 *  exist in the workbook; if it doesn't, the structured render falls
 *  back to the generic path. */
export type StructuredLayout = {
  /** Tab name (sheet title) whose values feed every cell ref below. */
  tab: string
  /** Headline KPI strip at the top of the detail page. */
  headlineKpis: StructuredKpi[]
  /** Grouped metric sections rendered below the headline. */
  metricSections?: StructuredMetricSection[]
  /** Optional inline grids (rendered as small tables). */
  grids?: StructuredGrid[]
}

export type PinnedSheet = {
  /** Stable key used in React keys + analysis dispatch. */
  key: 'financials' | 'fulfillment'
  /** Display title shown in the card header. */
  title: string
  /** One-liner so admin remembers what each sheet is for. */
  description: string
  /** Google Sheets file id. */
  spreadsheetId: string
  /** Default tab gid (numeric sheetId Google uses in URLs). */
  defaultGid: number
  /**
   * Tone classes for the card accent — matches the existing color
   * vocabulary used on /settings cards (emerald for money, violet
   * for client comms).
   */
  accent: {
    badgeBg: string
    badgeText: string
    iconBg: string
    iconText: string
  }
  /** Optional declarative layout. When set, the detail page renders
   *  the structured KPIs / sections / grids defined here instead of
   *  running the generic dollar-sign inference (which produces noisy
   *  results on workbooks that already have a structured Dashboard
   *  tab — see /lib/pinned-sheets-analysis.ts). Omit for sheets
   *  where the generic inference is fine (Mary's Client Sheet). */
  layout?: StructuredLayout
}

export const PINNED_SHEETS: PinnedSheet[] = [
  {
    key: 'financials',
    title: 'Genisys Financial Dashboard',
    description:
      'Revenue, expenses, and margin for the agency. The single source of truth for "are we profitable" — update tabs as money moves.',
    spreadsheetId: '1Dt2lIr8qv-uPrITdkfxfvBp0V3wQe-AUUDqFKD3a-Bk',
    defaultGid: 494286460,
    accent: {
      badgeBg: 'bg-emerald-50 dark:bg-emerald-950',
      badgeText: 'text-emerald-700 dark:text-emerald-300',
      iconBg: 'bg-emerald-50 dark:bg-emerald-950',
      iconText: 'text-emerald-600 dark:text-emerald-300',
    },
    // Cell map for the Genisys Financial Dashboard. Verified against
    // the actual workbook on 2026-05-11. The Dashboard tab has a
    // "labels above values" layout (row 5 holds KPI labels, row 6
    // holds the values), which the generic dollar-sign inference
    // cannot handle — hence reading by cell ref here.
    layout: {
      tab: 'Dashboard',
      headlineKpis: [
        { label: 'Total Revenue', cell: 'B6', format: 'currency' },
        { label: 'Total Expenses', cell: 'E6', format: 'currency' },
        { label: 'Net Profit', cell: 'H6', format: 'currency' },
      ],
      metricSections: [
        {
          title: 'Business metrics',
          rows: [
            { label: 'Active Clients', cell: 'C10', format: 'integer' },
            { label: 'Total Contract Value', cell: 'C11', format: 'currency' },
            { label: 'Revenue Collected', cell: 'C12', format: 'currency' },
            { label: 'Outstanding Receivables', cell: 'C13', format: 'currency' },
            { label: 'Appointments Promised', cell: 'C14', format: 'integer' },
            { label: 'Appointments Delivered (Sits)', cell: 'C15', format: 'integer' },
            { label: 'Appointments Remaining', cell: 'C16', format: 'integer' },
            { label: 'Total Ad Spend', cell: 'C17', format: 'currency' },
          ],
        },
        {
          // Total Expenses is shown in the headline KPI strip already;
          // omitting from this section avoids duplicating the same
          // number twice on the same view.
          title: 'Cost breakdown',
          rows: [
            { label: 'Mary (Setter)', cell: 'F10', format: 'currency' },
            { label: 'Yassine (Setter)', cell: 'F11', format: 'currency' },
            { label: 'Ad Spend (Meta)', cell: 'F12', format: 'currency' },
            { label: 'Software / Subscriptions', cell: 'F13', format: 'currency' },
            { label: 'Payroll / Contractors', cell: 'F14', format: 'currency' },
            { label: 'Other', cell: 'F15', format: 'currency' },
          ],
        },
        {
          // Show Rate / Cost-per-Sit are derived metrics. The sheet's
          // IFERROR(..., 0) wrapper returns 0 when the denominator is
          // missing, which would render as "0%" / "$0" — misleading
          // (reads like "0% show rate" when really it's "no data yet").
          // nullWhenZero points at the upstream count cell so the row
          // renders "—" instead when that count is empty / zero.
          title: 'Appointment metrics',
          rows: [
            { label: 'Mary — Booked', cell: 'I10', format: 'integer' },
            { label: 'Mary — Sits', cell: 'I11', format: 'integer' },
            { label: 'Mary — Show Rate', cell: 'I12', format: 'percent', nullWhenZero: 'I10' },
            { label: 'Mary — Cost / Sit', cell: 'I13', format: 'currency', nullWhenZero: 'I11' },
            { label: 'Yassine — Booked', cell: 'I14', format: 'integer' },
            { label: 'Yassine — Sits', cell: 'I15', format: 'integer' },
            { label: 'Yassine — Show Rate', cell: 'I16', format: 'percent', nullWhenZero: 'I14' },
            { label: 'Yassine — Cost / Sit', cell: 'I17', format: 'currency', nullWhenZero: 'I15' },
          ],
        },
      ],
      grids: [
        {
          // Monthly P&L block — header row at 21, data rows 22-27
          // (Mar-Aug 2026), totals row 28. Columns B-I.
          title: 'Monthly P&L',
          headerRow: 21,
          dataRowsStart: 22,
          dataRowsEnd: 27,
          totalsRow: 28,
          columnsStart: 2, // B
          columnsEnd: 9,   // I
          columnFormats: [
            'string',   // B - Month
            'currency', // C - Revenue
            'currency', // D - Setter Costs
            'currency', // E - Ad Spend
            'currency', // F - Subs
            'currency', // G - Payroll
            'currency', // H - Other
            'currency', // I - Net Profit
          ],
        },
      ],
    },
  },
  {
    key: 'fulfillment',
    title: 'Mary Client Sheet',
    description:
      "Per-client fulfillment + qualification criteria. Mary's reference whenever an appointment lands — keep this updated the moment a client tweaks their requirements.",
    spreadsheetId: '1OL0pkuKihrid8uzsO5vo6ZH9n_wcmdCOgdoRGIm9sn8',
    defaultGid: 1833651533,
    accent: {
      badgeBg: 'bg-violet-50 dark:bg-violet-950',
      badgeText: 'text-violet-700 dark:text-violet-300',
      iconBg: 'bg-violet-50 dark:bg-violet-950',
      iconText: 'text-violet-600 dark:text-violet-300',
    },
  },
]

/**
 * Iframe-embeddable URL. `embedded=true` strips Google's chrome
 * (toolbars, file menu) but keeps the cell grid + edit affordances.
 * We append `&rm=minimal` to drop the bottom menu bar too — fewer
 * pixels lost to Google UI inside the iframe.
 *
 * The trailing `#gid=` is what actually controls which tab loads;
 * Google ignores the gid query param in some cases, so we put it
 * in both places for reliability.
 */
export function getEmbedUrl(s: PinnedSheet, gid?: number): string {
  const targetGid = gid ?? s.defaultGid
  return `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit?embedded=true&rm=minimal&gid=${targetGid}#gid=${targetGid}`
}

/** Full-tab URL — what the "Open in Google Sheets" button uses. */
export function getViewUrl(s: PinnedSheet, gid?: number): string {
  const targetGid = gid ?? s.defaultGid
  return `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit?gid=${targetGid}#gid=${targetGid}`
}

/**
 * Look up a pinned sheet by its stable `key`. Used by the detail
 * route at /documents/sheets/[key] to validate the param + load the
 * right config. Returns undefined for unknown keys; callers should
 * 404 on undefined.
 */
export function findPinnedSheet(key: string): PinnedSheet | undefined {
  return PINNED_SHEETS.find((s) => s.key === key)
}
