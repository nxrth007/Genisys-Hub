/**
 * Sheet analysis helpers — read a 2D values array (the shape
 * `getSheetData()` returns from the Google Sheets API) and emit
 * "headline numbers" badges that go above the iframe on /documents
 * and the per-sheet detail page.
 *
 * Two flavors today (one per pinned sheet), exposed via `summarize()`:
 *
 *   - financials: detect dollar-formatted cells, surface the largest-
 *     magnitude one as the headline, plus rough +/- sums for "money
 *     in / out" directional context.
 *
 *   - fulfillment: count data rows, find a status-like column and
 *     surface the most-common value, count unique first-column
 *     entries to spot duplicates / understand unit-of-tracking.
 *
 * Each summarizer is defensive: real spreadsheets are messy (merged
 * cells, missing headers, formula text in random cells). Every helper
 * falls back to a generic "X rows" stat if it can't extract anything
 * richer.
 *
 * Lives in /lib so both the listing endpoint (every pinned sheet,
 * first tab only) and the detail endpoint (every tab in one sheet)
 * can reuse the same logic without duplication.
 */

export type SheetSummaryItem = {
  label: string
  value: string
  /** Optional secondary line — used for "of total X" style context. */
  hint?: string
}

export type SheetSummary = {
  items: SheetSummaryItem[]
  activeTab: string
}

/* -------------------------------------------------------------------------- */
/*  Public dispatcher                                                          */
/* -------------------------------------------------------------------------- */

export function summarize(
  key: 'financials' | 'fulfillment',
  activeTab: string,
  values: string[][],
): SheetSummary {
  if (key === 'financials') {
    return { items: summarizeFinancials(values), activeTab }
  }
  if (key === 'fulfillment') {
    return { items: summarizeFulfillment(values), activeTab }
  }
  return { items: [genericRowsBadge(values)], activeTab }
}

/** Always-safe "N data rows" badge — used as a fallback. */
export function genericRowsBadge(values: string[][]): SheetSummaryItem {
  // Subtract 1 if the top row looks like a header (all non-empty
  // strings). Imperfect heuristic but better than counting "Header"
  // as a row.
  const dataRows =
    values.length > 0 && values[0].every((c) => c.trim().length > 0)
      ? values.length - 1
      : values.length
  return {
    label: 'Rows',
    value: String(Math.max(0, dataRows)),
  }
}

/* -------------------------------------------------------------------------- */
/*  Financials                                                                 */
/* -------------------------------------------------------------------------- */

export function summarizeFinancials(values: string[][]): SheetSummaryItem[] {
  const items: SheetSummaryItem[] = []
  const currencyCells: Array<{ row: number; col: number; amount: number; raw: string }> = []

  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < (values[r]?.length ?? 0); c++) {
      const raw = values[r][c]
      const parsed = parseCurrency(raw)
      if (parsed != null) {
        currencyCells.push({ row: r, col: c, amount: parsed, raw })
      }
    }
  }

  if (currencyCells.length === 0) {
    return [genericRowsBadge(values)]
  }

  // Largest currency cell is almost always the "grand total" or
  // headline metric in a finance dashboard. Show it prominently.
  const top = currencyCells.reduce((max, x) =>
    Math.abs(x.amount) > Math.abs(max.amount) ? x : max,
  )
  items.push({
    label: 'Top figure',
    value: formatCurrency(top.amount),
    hint: cellLabel(values, top.row, top.col) || undefined,
  })

  const positives = currencyCells.filter((c) => c.amount > 0)
  const negatives = currencyCells.filter((c) => c.amount < 0)
  if (positives.length > 0) {
    items.push({
      label: 'Sum of positive cells',
      value: formatCurrency(positives.reduce((s, x) => s + x.amount, 0)),
      hint: `approx · ${positives.length} cells`,
    })
  }
  if (negatives.length > 0) {
    items.push({
      label: 'Sum of negative cells',
      value: formatCurrency(negatives.reduce((s, x) => s + x.amount, 0)),
      hint: `approx · ${negatives.length} cells`,
    })
  }

  return items
}

export function parseCurrency(raw: string): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/[$0-9]/.test(trimmed)) return null
  if (!/\$|^[-(]?\d/.test(trimmed)) return null
  if (/[A-Za-z]/.test(trimmed) && !/[$M K B]/.test(trimmed)) return null
  if (/[\/]/.test(trimmed)) return null // dates like 1/2/2026
  if (/^\d{4,}-\d/.test(trimmed)) return null // iso dates

  const isParenNeg = /^\(.*\)$/.test(trimmed)
  let cleaned = trimmed.replace(/[()$,\s]/g, '')
  let multiplier = 1
  if (/k$/i.test(cleaned)) {
    multiplier = 1_000
    cleaned = cleaned.replace(/k$/i, '')
  } else if (/m$/i.test(cleaned)) {
    multiplier = 1_000_000
    cleaned = cleaned.replace(/m$/i, '')
  } else if (/b$/i.test(cleaned)) {
    multiplier = 1_000_000_000
    cleaned = cleaned.replace(/b$/i, '')
  }
  const num = Number(cleaned)
  if (!Number.isFinite(num) || num === 0) return null
  return (isParenNeg ? -num : num) * multiplier
}

export function formatCurrency(n: number): string {
  // Precision tiers tuned for a small-agency dashboard. Previously
  // anything >= $10K got rounded to thousands ("$21K"), which hid the
  // bottom $500 of a $20,500 figure — meaningful at this revenue size.
  // New tiers: full dollar amount up through ~$100K, K-shorthand only
  // when the digits stop fitting comfortably, M-shorthand above $1M.
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 100_000) return `$${Math.round(n / 1_000).toLocaleString()}K`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

/**
 * Try to label a cell by walking left/up to the nearest text label.
 * In a finance sheet a $12,000 in row 3 col 5 is usually preceded
 * by a row-label in column 1 ("MRR") or a column-header in row 1
 * ("Q3"). Returning the row label gets us the more meaningful one.
 */
export function cellLabel(
  values: string[][],
  row: number,
  col: number,
): string | null {
  for (let c = col - 1; c >= 0; c--) {
    const v = values[row]?.[c]?.trim()
    if (v && !parseCurrency(v) && /[A-Za-z]/.test(v)) {
      return v.length > 40 ? v.slice(0, 40) + '…' : v
    }
  }
  const header = values[0]?.[col]?.trim()
  if (header && /[A-Za-z]/.test(header)) {
    return header.length > 40 ? header.slice(0, 40) + '…' : header
  }
  return null
}

/* -------------------------------------------------------------------------- */
/*  Fulfillment                                                                */
/* -------------------------------------------------------------------------- */

export function summarizeFulfillment(values: string[][]): SheetSummaryItem[] {
  if (values.length === 0) {
    return [{ label: 'Rows', value: '0', hint: 'sheet appears empty' }]
  }

  const items: SheetSummaryItem[] = []
  const headerRow = values[0]?.map((c) => c.trim().toLowerCase()) ?? []
  const dataRows = values.slice(1).filter((row) => row.some((c) => c.trim()))

  items.push({
    label: 'Data rows',
    value: String(dataRows.length),
    hint: dataRows.length === 1 ? 'row tracked' : 'rows tracked',
  })

  const statusColIdx = findStatusColumn(headerRow)
  if (statusColIdx >= 0 && dataRows.length > 0) {
    const counts = new Map<string, number>()
    for (const row of dataRows) {
      const v = (row[statusColIdx] ?? '').trim()
      if (!v) continue
      const k = v.toLowerCase()
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    if (counts.size > 0) {
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      const headerLabel = headerRow[statusColIdx] || 'status'
      items.push({
        label: titleCase(headerLabel),
        value: `${top[1]} ${titleCase(top[0])}`,
        hint:
          counts.size > 1
            ? `${counts.size} distinct values across rows`
            : undefined,
      })
    }
  }

  const firstColValues = dataRows
    .map((row) => row[0]?.trim() ?? '')
    .filter((v) => v.length > 0)
  const uniqueFirstCol = new Set(firstColValues)
  if (
    uniqueFirstCol.size > 0 &&
    uniqueFirstCol.size !== dataRows.length &&
    headerRow[0]
  ) {
    items.push({
      label: `Unique ${titleCase(headerRow[0])}`,
      value: String(uniqueFirstCol.size),
      hint:
        firstColValues.length > uniqueFirstCol.size
          ? `${firstColValues.length - uniqueFirstCol.size} dupes`
          : undefined,
    })
  }

  return items
}

/** Status-ish column header detector — used by both badge + detail view. */
export function findStatusColumn(lowerHeaders: string[]): number {
  return lowerHeaders.findIndex((h) =>
    /qualif|status|stage|active|approve/.test(h),
  )
}

export function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

/* -------------------------------------------------------------------------- */
/*  Structured layout reader                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Cell-by-cell readers + formatters used when a pinned sheet declares
 * an explicit StructuredLayout (see lib/pinned-sheets.ts). These bypass
 * the generic dollar-sign inference entirely — for workbooks whose
 * authors already laid out fixed KPI cells (B6 = Total Revenue, etc.),
 * reading by cell ref is both more accurate and orders of magnitude
 * less noisy than scanning every cell for currency-shaped strings.
 *
 * The Genisys Financial Dashboard is the motivating example: it stores
 * labels ABOVE values ("TOTAL REVENUE" in B5, the value in B6), which
 * the generic cellLabel() helper can't see because it only walks left.
 * Plus it has the same revenue figure repeated in 4+ cells via
 * cross-tab formulas, so any sum-positive-cells aggregate triple-counts.
 */

import type {
  CellRef,
  CellFormat,
  StructuredLayout,
  StructuredKpi,
  StructuredMetricSection,
  StructuredGrid,
  StructuredCard,
  StructuredCardTemplate,
} from './pinned-sheets'

/** Parse "B6" / "AA12" into 0-indexed { row, col }. Returns null on
 *  invalid input (caller surfaces as N/A in the rendered tile). */
export function parseCellRef(ref: CellRef): { row: number; col: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim())
  if (!m) return null
  const colLetters = m[1].toUpperCase()
  const rowNumber = parseInt(m[2], 10)
  if (!Number.isFinite(rowNumber) || rowNumber < 1) return null
  // A=1, B=2, ..., Z=26, AA=27. Convert to 0-indexed.
  let colOneBased = 0
  for (const ch of colLetters) {
    colOneBased = colOneBased * 26 + (ch.charCodeAt(0) - 64)
  }
  return { row: rowNumber - 1, col: colOneBased - 1 }
}

/** Read a cell from a 2D values array using A1 notation. Returns empty
 *  string if out of bounds, the cell is missing, or the ref is invalid. */
export function readCellValue(values: string[][], ref: CellRef): string {
  const parsed = parseCellRef(ref)
  if (!parsed) return ''
  const row = values[parsed.row]
  if (!row) return ''
  return row[parsed.col] ?? ''
}

/** Format a raw cell string for display in a KPI tile. Defensive against
 *  the Sheets API returning currency strings ("$20,500.00"), already-
 *  rounded numbers ("7"), percentages ("0.85" or "85%"), and totally
 *  empty cells.
 *
 *  Conventions:
 *    currency: shows "$1,234" or "$1.2M"/"$320K" for magnitude; "$0" for zero.
 *    integer:  shows "7"; "0" stays "0" (not "—") so admin sees the real value.
 *    percent:  shows "85%". Tolerates input as "0.85" or "85" or "85%".
 *    string:   trimmed verbatim. Empty string → "—".
 */
export function formatCellValue(raw: string, format: CellFormat): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return '—'

  if (format === 'string') return trimmed

  if (format === 'currency') {
    // Strip $ and commas, treat parentheses as negative.
    const isParenNeg = /^\(.*\)$/.test(trimmed)
    const cleaned = trimmed.replace(/[$,()]/g, '').replace(/\s/g, '')
    const n = Number(cleaned)
    if (!Number.isFinite(n)) return trimmed
    const signed = isParenNeg ? -n : n
    return formatCurrency(signed)
  }

  if (format === 'integer') {
    const n = Number(trimmed.replace(/[,$\s]/g, ''))
    if (!Number.isFinite(n)) return trimmed
    return Math.round(n).toLocaleString()
  }

  if (format === 'percent') {
    // Either "0.85" → 85%, or "85" → 85%, or "85%" → 85%
    const hadPercent = /%\s*$/.test(trimmed)
    const cleaned = trimmed.replace(/%/g, '').replace(/[,\s]/g, '')
    const n = Number(cleaned)
    if (!Number.isFinite(n)) return trimmed
    const pct = hadPercent || Math.abs(n) > 1 ? n : n * 100
    return `${pct.toFixed(0)}%`
  }

  return trimmed
}

export type ResolvedKpi = {
  label: string
  value: string
  hint?: string
}

export type ResolvedSection = {
  title: string
  rows: Array<{ label: string; value: string }>
}

export type ResolvedGrid = {
  title: string
  headers: string[]
  rows: string[][]
  totals: string[] | null
}

export type ResolvedCard = {
  title: string
  headline: { label: string; value: string } | null
  bullets: { sectionLabel: string; items: string[] } | null
}

export type StructuredSummary = {
  /** Tab name the structured summary was computed from. */
  tab: string
  headlineKpis: ResolvedKpi[]
  metricSections: ResolvedSection[]
  grids: ResolvedGrid[]
  cards: ResolvedCard[]
}

/** Returns true when the cell's raw value parses as 0 or is blank /
 *  missing. Used to gate derived metrics (Show Rate, Cost-per-Sit)
 *  whose underlying formula returns 0 when the input is empty —
 *  rendering "0%" or "$0" in that case is misleading. */
function isZeroOrEmpty(raw: string): boolean {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return true
  // Strip currency / percent / paren / comma formatting before
  // parsing. Treats "(0)", "$0.00", "0%", "0" all as zero.
  const cleaned = trimmed.replace(/[$,%()\s]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) && n === 0
}

function resolveKpi(values: string[][], kpi: StructuredKpi): ResolvedKpi {
  // Guard: when the row points at a derived metric, check the upstream
  // count cell first. If empty/zero, render "—" instead of the
  // formula's IFERROR fallback value.
  if (kpi.nullWhenZero) {
    const guard = readCellValue(values, kpi.nullWhenZero)
    if (isZeroOrEmpty(guard)) {
      return { label: kpi.label, value: '—', hint: kpi.hint }
    }
  }
  return {
    label: kpi.label,
    value: formatCellValue(readCellValue(values, kpi.cell), kpi.format),
    hint: kpi.hint,
  }
}

function resolveSection(
  values: string[][],
  section: StructuredMetricSection,
): ResolvedSection {
  return {
    title: section.title,
    rows: section.rows.map((r) => {
      // Same guard logic as resolveKpi — when the upstream count
      // cell is empty/zero, render "—" so the derived metric doesn't
      // confuse "no data" with "0%".
      if (r.nullWhenZero) {
        const guard = readCellValue(values, r.nullWhenZero)
        if (isZeroOrEmpty(guard)) {
          return { label: r.label, value: '—' }
        }
      }
      return {
        label: r.label,
        value: formatCellValue(readCellValue(values, r.cell), r.format),
      }
    }),
  }
}

function resolveGrid(values: string[][], grid: StructuredGrid): ResolvedGrid {
  const headers: string[] = []
  for (let c = grid.columnsStart; c <= grid.columnsEnd; c++) {
    const ref = colNumberToLetter(c) + grid.headerRow
    headers.push(readCellValue(values, ref).trim() || '')
  }

  // When dataRowsEnd is omitted, auto-expand from dataRowsStart and
  // stop on the first terminator row. This makes the grid fluid —
  // admin can add rows to the sheet without updating the layout.
  // Terminators: (a) every column in range is empty, or (b) only the
  // leftmost column has content (typical for footer/merged-cell rows
  // like Mary's "If a homeowner doesn't meet criteria..." note).
  const explicitEnd = grid.dataRowsEnd
  const maxRows = grid.maxDataRows ?? 200
  const scanEnd =
    explicitEnd != null
      ? explicitEnd
      : grid.dataRowsStart + maxRows - 1

  const rows: string[][] = []
  for (let r = grid.dataRowsStart; r <= scanEnd; r++) {
    const row: string[] = []
    let nonEmptyCount = 0
    for (let c = grid.columnsStart; c <= grid.columnsEnd; c++) {
      const ref = colNumberToLetter(c) + r
      const raw = readCellValue(values, ref)
      if (raw.trim()) nonEmptyCount++
      const fmtIdx = c - grid.columnsStart
      const fmt = grid.columnFormats[fmtIdx] ?? 'string'
      row.push(formatCellValue(raw, fmt))
    }

    if (explicitEnd != null) {
      // Explicit end: just drop empty rows, keep walking.
      if (nonEmptyCount > 0) rows.push(row)
    } else {
      // Auto-expand: terminate on empty / footer-shaped rows once
      // we've collected at least one data row.
      if (nonEmptyCount === 0) {
        if (rows.length > 0) break
        continue // tolerate leading blank rows
      }
      if (nonEmptyCount === 1 && rows.length > 0) break
      rows.push(row)
    }
  }

  let totals: string[] | null = null
  if (grid.totalsRow) {
    totals = []
    let hasAnyValue = false
    for (let c = grid.columnsStart; c <= grid.columnsEnd; c++) {
      const ref = colNumberToLetter(c) + grid.totalsRow
      const raw = readCellValue(values, ref)
      if (raw.trim()) hasAnyValue = true
      const fmtIdx = c - grid.columnsStart
      const fmt = grid.columnFormats[fmtIdx] ?? 'string'
      totals.push(formatCellValue(raw, fmt))
    }
    if (!hasAnyValue) totals = null
  }

  return { title: grid.title, headers, rows, totals }
}

function resolveCard(values: string[][], card: StructuredCard): ResolvedCard {
  const title = readCellValue(values, card.nameCell).trim() || '(untitled)'

  let headline: ResolvedCard['headline'] = null
  if (card.headline) {
    headline = {
      label: card.headline.label,
      value: formatCellValue(
        readCellValue(values, card.headline.cell),
        card.headline.format,
      ),
    }
  }

  let bullets: ResolvedCard['bullets'] = null
  if (card.bullets) {
    const start = parseCellRef(card.bullets.startCell)
    if (start) {
      const items: string[] = []
      // Walk from startCell down through endRow inclusive. The
      // bullets in Mary's sheet start with a "•" / "▪" glyph; strip
      // it so the UI can apply its own consistent bullet styling.
      const endRowIdx = card.bullets.endRow - 1 // 1-indexed → 0-indexed
      for (let r = start.row; r <= endRowIdx; r++) {
        const row = values[r]
        if (!row) continue
        const raw = (row[start.col] ?? '').trim()
        if (!raw) continue
        // Strip leading bullet glyphs + whitespace. Covers •, ▪, *, -,
        // and the common "·" alternative.
        const cleaned = raw.replace(/^[•▪▫■◦●·*\-–—]\s*/, '').trim()
        if (cleaned) items.push(cleaned)
      }
      if (items.length > 0) {
        bullets = { sectionLabel: card.bullets.sectionLabel, items }
      }
    }
  }

  return { title, headline, bullets }
}

/** Expand a card template into ResolvedCards by scanning the title row.
 *  Walks `template.titleRow` starting at `template.startCol`, stepping
 *  by `template.colStep`. Emits one card per non-empty title cell;
 *  stops at the first empty title once at least one card has been
 *  found, or at `maxCards` (safety cap, default 50).
 *
 *  This is what makes Mary's Client Sheet fluid — adding a 6th client
 *  in column L shows up automatically without any layout config edit. */
function expandCardTemplate(
  values: string[][],
  template: StructuredCardTemplate,
): ResolvedCard[] {
  const maxCards = template.maxCards ?? 50
  const cards: ResolvedCard[] = []

  for (let i = 0; i < maxCards; i++) {
    const col = template.startCol + i * template.colStep
    const titleRef = colNumberToLetter(col) + template.titleRow
    const title = readCellValue(values, titleRef).trim()

    if (!title) {
      // Stop at first empty title once we've collected at least one
      // card. Tolerate leading empty columns just in case.
      if (cards.length > 0) break
      continue
    }

    let headline: ResolvedCard['headline'] = null
    if (template.headline) {
      const ref = colNumberToLetter(col) + template.headline.row
      headline = {
        label: template.headline.label,
        value: formatCellValue(
          readCellValue(values, ref),
          template.headline.format,
        ),
      }
    }

    let bullets: ResolvedCard['bullets'] = null
    if (template.bullets) {
      const items: string[] = []
      for (let r = template.bullets.rowStart; r <= template.bullets.rowEnd; r++) {
        const ref = colNumberToLetter(col) + r
        const raw = readCellValue(values, ref).trim()
        if (!raw) continue
        const cleaned = raw.replace(/^[•▪▫■◦●·*\-–—]\s*/, '').trim()
        if (cleaned) items.push(cleaned)
      }
      if (items.length > 0) {
        bullets = { sectionLabel: template.bullets.sectionLabel, items }
      }
    }

    cards.push({ title, headline, bullets })
  }

  return cards
}

/** Convert 1-indexed column number (A=1, B=2, ..., Z=26, AA=27, ...) to letters. */
export function colNumberToLetter(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const rem = (x - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

/**
 * Convert a full StructuredSummary into compact SheetSummaryItem
 * badges suitable for the /documents listing tile (where each pinned
 * sheet gets a small preview card). Prefers headline KPIs when the
 * layout defines them; otherwise derives "Clients · N" and a
 * "Total <headline label>" pair from the auto-discovered cards.
 *
 * Used by the listing endpoint to replace the noisy generic dollar-
 * sign inference with accurate, layout-aware preview numbers.
 */
export function deriveListingSummary(
  summary: StructuredSummary,
): SheetSummaryItem[] {
  // Workbook with headline KPIs (e.g. the financial dashboard's
  // Total Revenue / Expenses / Net Profit) — pass them through.
  if (summary.headlineKpis.length > 0) {
    return summary.headlineKpis.map((k) => ({
      label: k.label,
      value: k.value,
      hint: k.hint,
    }))
  }

  // Card-driven workbook (e.g. Mary's Client Sheet) — derive a count
  // tile, plus a sum-of-headlines tile when every card's headline
  // shares the same label AND every value is numeric.
  const items: SheetSummaryItem[] = []
  if (summary.cards.length > 0) {
    items.push({
      label: summary.cards.length === 1 ? 'Card' : 'Cards',
      value: String(summary.cards.length),
    })

    const firstHeadline = summary.cards[0]?.headline
    if (firstHeadline) {
      const allMatchLabel = summary.cards.every(
        (c) => c.headline?.label === firstHeadline.label,
      )
      if (allMatchLabel) {
        let sum = 0
        let allNumeric = true
        for (const card of summary.cards) {
          const raw = (card.headline?.value ?? '').replace(/[$,%\s]/g, '')
          const n = Number(raw)
          if (Number.isFinite(n)) {
            sum += n
          } else {
            allNumeric = false
            break
          }
        }
        if (allNumeric) {
          items.push({
            label: `Total ${firstHeadline.label.toLowerCase()}`,
            value: sum.toLocaleString(),
          })
        }
      }
    }
  }

  return items
}

/**
 * Build the full structured summary for a workbook based on its
 * declared StructuredLayout. Callers find the named tab's values in
 * their tab list and pass them in (the layout config names which tab).
 *
 * Returns null when values is missing/empty so callers can fall back
 * to the generic summarizer.
 */
export function summarizeStructured(
  values: string[][],
  layout: StructuredLayout,
): StructuredSummary | null {
  if (!values || values.length === 0) return null

  // Cards: explicit declarations + auto-discovered from template.
  // Concatenated so a workbook can use both (e.g. one bespoke card
  // plus a template-discovered list) — though typical configs use
  // only one or the other.
  const explicitCards = (layout.cards ?? []).map((c) => resolveCard(values, c))
  const templatedCards = layout.cardTemplate
    ? expandCardTemplate(values, layout.cardTemplate)
    : []

  return {
    tab: layout.tab,
    headlineKpis: (layout.headlineKpis ?? []).map((k) => resolveKpi(values, k)),
    metricSections: (layout.metricSections ?? []).map((s) =>
      resolveSection(values, s),
    ),
    grids: (layout.grids ?? []).map((g) => resolveGrid(values, g)),
    cards: [...explicitCards, ...templatedCards],
  }
}
