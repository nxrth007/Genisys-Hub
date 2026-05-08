import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { PINNED_SHEETS, getEmbedUrl, getViewUrl } from '@/lib/pinned-sheets'
import { getSheetData } from '@/lib/drive'

/**
 * GET /api/documents/pinned-sheets
 *
 * Returns the static config for each pinned sheet + a lightweight
 * read of the default tab so the UI can render summary stats above
 * the iframe (row count, currency totals, qualification snapshot).
 *
 * The actual viewing/editing happens in the iframe; this endpoint
 * is just for the "headline numbers" badge row.
 *
 * Read-source: the first connected DriveAccount that has access.
 * If neither sheet is shared with any connected account, the
 * iframe still works for the user (their Google session in the
 * browser handles auth) — we just don't show summary stats.
 */
export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial

  // Pick the first connected Drive account as the read-source.
  // We only need ONE account that has view access on both sheets.
  // If you've got multiple connected, this will use whichever was
  // connected first; that's deterministic enough for our needs.
  const account = await prisma.driveAccount.findFirst({
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  })

  const results = await Promise.all(
    PINNED_SHEETS.map(async (sheet) => {
      const base = {
        key: sheet.key,
        title: sheet.title,
        description: sheet.description,
        spreadsheetId: sheet.spreadsheetId,
        defaultGid: sheet.defaultGid,
        embedUrl: getEmbedUrl(sheet),
        viewUrl: getViewUrl(sheet),
        accent: sheet.accent,
      }

      if (!account) {
        return { ...base, tabs: null, summary: null, readError: null }
      }

      try {
        const data = await getSheetData(account.email, sheet.spreadsheetId)
        return {
          ...base,
          tabs: data.tabs.map((t) => ({
            id: t.id,
            title: t.title,
            rowCount: t.rowCount,
            columnCount: t.columnCount,
          })),
          summary: summarize(sheet.key, data.activeTab, data.values),
          readError: null,
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Failed to read sheet'
        return {
          ...base,
          tabs: null,
          summary: null,
          readError: message,
        }
      }
    }),
  )

  return NextResponse.json({
    sourceAccountEmail: account?.email ?? null,
    sheets: results,
  })
}

/* -------------------------------------------------------------------------- */
/*  Summary generation                                                         */
/*                                                                             */
/*  Per-sheet "headline numbers" we render as badges above the iframe. The     */
/*  goal is to make the sheet's purpose obvious at a glance even before the    */
/*  iframe finishes loading — so admin sees "Revenue MTD: $12,450" or          */
/*  "8 active clients · 3 unqualified" before scrolling.                       */
/*                                                                             */
/*  Each summarizer is defensive: real spreadsheets are messy (merged cells,   */
/*  missing headers, formula text in random cells), so every helper falls      */
/*  back to a generic "X rows" stat if it can't extract anything richer.       */
/* -------------------------------------------------------------------------- */

export type SheetSummaryItem = {
  label: string
  value: string
  /** Optional secondary line — used for "of total X" style context. */
  hint?: string
}

function summarize(
  key: 'financials' | 'fulfillment',
  activeTab: string,
  values: string[][],
): { items: SheetSummaryItem[]; activeTab: string } {
  if (key === 'financials') {
    return { items: summarizeFinancials(values), activeTab }
  }
  if (key === 'fulfillment') {
    return { items: summarizeFulfillment(values), activeTab }
  }
  return { items: [genericRowsBadge(values)], activeTab }
}

/** Always-safe "N data rows" badge — used as a fallback. */
function genericRowsBadge(values: string[][]): SheetSummaryItem {
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

/* ------------------------------- Financials ------------------------------- */

/**
 * Try to find revenue / expense totals by sweeping every cell for
 * dollar-formatted text and bucketing into "biggest single value"
 * (assumed to be a grand total). For a Sheets dashboard with a
 * "Revenue YTD" cell or a SUM() row, this surfaces the real number;
 * for a less-structured sheet it falls back to a row count.
 */
function summarizeFinancials(values: string[][]): SheetSummaryItem[] {
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

  // Sum of positive cells = rough "money in" estimate. Sum of
  // negatives = "money out". Both are best-effort directional
  // numbers, NOT authoritative — labeled "approx" so admin doesn't
  // mistake them for the spreadsheet's own totals.
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

function parseCurrency(raw: string): number | null {
  if (!raw) return null
  // Match $1,234.56 / -$1,234 / ($1,234) / $1.2M-style cells.
  const trimmed = raw.trim()
  if (!/[$0-9]/.test(trimmed)) return null
  if (!/\$|^[-(]?\d/.test(trimmed)) return null
  // Skip pure date / phone / id-looking values that happen to start
  // with a digit but aren't currency.
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

function formatCurrency(n: number): string {
  const abs = Math.abs(n)
  const formatted =
    abs >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : abs >= 10_000
        ? `$${Math.round(n / 1_000).toLocaleString()}K`
        : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return formatted
}

/**
 * Try to label a cell by walking left/up to the nearest text label.
 * In a finance sheet a $12,000 in row 3 col 5 is usually preceded
 * by a row-label in column 1 ("MRR") or a column-header in row 1
 * ("Q3"). Returning the row label gets us the more meaningful one.
 */
function cellLabel(
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
  // Fallback: try the column header (row 0).
  const header = values[0]?.[col]?.trim()
  if (header && /[A-Za-z]/.test(header)) {
    return header.length > 40 ? header.slice(0, 40) + '…' : header
  }
  return null
}

/* ------------------------------- Fulfillment ------------------------------ */

/**
 * Mary's client sheet has one row per client (or per criterion
 * within a client). We surface:
 *   - Number of distinct rows that look like client entries
 *   - Count of rows tagged "qualified" / "yes" / equivalent if
 *     a status column is present
 *   - Number of empty / missing cells in the first 2 columns
 *     (often a "this row is incomplete" smell)
 *
 * If the structure doesn't match what we expect, we show row count
 * only. That's still useful — admin knows the sheet has data even
 * if our heuristics can't classify it.
 */
function summarizeFulfillment(values: string[][]): SheetSummaryItem[] {
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

  // Look for a status column — headers like "qualified", "status",
  // "stage", "active". If found, count the most common value to
  // give a "X qualified" headline.
  const statusColIdx = headerRow.findIndex((h) =>
    /qualif|status|stage|active|approve/.test(h),
  )
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

  // Count first-column unique values — usually client names. Useful
  // to spot duplicates / understand the unit-of-tracking.
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

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}
