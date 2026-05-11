import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import {
  findPinnedSheet,
  getEmbedUrl,
  getViewUrl,
} from '@/lib/pinned-sheets'
import { getSheetData } from '@/lib/drive'
import {
  summarize,
  summarizeStructured,
  type SheetSummary,
  type StructuredSummary,
} from '@/lib/pinned-sheets-analysis'

/**
 * GET /api/documents/pinned-sheets/[key]
 *
 * Detail-view payload — reads EVERY tab in the workbook (not just
 * the default), runs per-tab analysis, and includes a row preview
 * of the default tab so the UI can render structured layouts:
 *
 *   - financials: per-tab KPI cards in a grid, each clickable to
 *     focus the iframe on that tab
 *   - fulfillment: per-row "client breakdown" cards built from the
 *     header→value pairs of each non-empty data row
 *
 * Caps: each tab's preview is truncated to 200 rows × 30 columns.
 * Tabs beyond a sane row count don't get their values returned —
 * the iframe is still the source of truth for full data.
 */

const MAX_PREVIEW_ROWS = 200
const MAX_PREVIEW_COLS = 30

export type PinnedSheetTabDetail = {
  id: number
  title: string
  rowCount: number
  columnCount: number
  /** Per-tab summary stats (same shape as listing endpoint). */
  summary: SheetSummary | null
  /** Truncated 2D values preview for client-side rendering. null if read failed. */
  preview: string[][] | null
  previewTruncated: boolean
  readError: string | null
}

export type PinnedSheetDetailResponse = {
  key: string
  title: string
  description: string
  spreadsheetId: string
  defaultGid: number
  embedUrl: string
  viewUrl: string
  accent: {
    badgeBg: string
    badgeText: string
    iconBg: string
    iconText: string
  }
  sourceAccountEmail: string | null
  tabs: PinnedSheetTabDetail[]
  /** Pre-computed structured summary when the workbook has an
   *  explicit layout config (see lib/pinned-sheets.ts). When present,
   *  the detail view renders these as the headline KPIs instead of
   *  running the generic dollar-sign inference, which is noisy on
   *  workbooks with cross-tab formulas + labels-above-values layout. */
  structuredSummary: StructuredSummary | null
  globalReadError: string | null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const denial = await requireStaff()
  if (denial) return denial

  const { key } = await params
  const sheet = findPinnedSheet(key)
  if (!sheet) {
    return NextResponse.json({ error: 'Unknown sheet key' }, { status: 404 })
  }

  const account = await prisma.driveAccount.findFirst({
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  })

  const base = {
    key: sheet.key,
    title: sheet.title,
    description: sheet.description,
    spreadsheetId: sheet.spreadsheetId,
    defaultGid: sheet.defaultGid,
    embedUrl: getEmbedUrl(sheet),
    viewUrl: getViewUrl(sheet),
    accent: sheet.accent,
    sourceAccountEmail: account?.email ?? null,
  } as const

  if (!account) {
    return NextResponse.json({
      ...base,
      tabs: [],
      structuredSummary: null,
      globalReadError:
        'No Drive account connected. Iframe still works; connect a Drive account in Settings to enable per-tab analysis.',
    } satisfies PinnedSheetDetailResponse)
  }

  // First read: get the tab list. We piggy-back on the default-tab
  // values from this call so we don't double-fetch the first tab.
  let initial: Awaited<ReturnType<typeof getSheetData>>
  try {
    initial = await getSheetData(account.email, sheet.spreadsheetId)
  } catch (err: unknown) {
    return NextResponse.json({
      ...base,
      tabs: [],
      structuredSummary: null,
      globalReadError:
        err instanceof Error ? err.message : 'Failed to load workbook',
    } satisfies PinnedSheetDetailResponse)
  }

  // Read every other tab in parallel. Each call hits the Sheets API
  // independently; for ~10 tabs that's ~10 round-trips but it caps
  // total time at ~longest-tab-read instead of N x avg.
  const tabs = await Promise.all(
    initial.tabs.map(
      async (t): Promise<PinnedSheetTabDetail> => {
        const tabBase = {
          id: t.id,
          title: t.title,
          rowCount: t.rowCount,
          columnCount: t.columnCount,
        }

        // Reuse the values we already fetched for the active tab.
        if (t.title === initial.activeTab) {
          return {
            ...tabBase,
            summary: summarize(sheet.key, t.title, initial.values),
            preview: truncatePreview(initial.values),
            previewTruncated: shouldTruncate(initial.values),
            readError: null,
          }
        }

        try {
          const data = await getSheetData(
            account.email,
            sheet.spreadsheetId,
            t.title,
          )
          return {
            ...tabBase,
            summary: summarize(sheet.key, t.title, data.values),
            preview: truncatePreview(data.values),
            previewTruncated: shouldTruncate(data.values),
            readError: null,
          }
        } catch (err: unknown) {
          // Tab-level failure is non-fatal — other tabs still render.
          return {
            ...tabBase,
            summary: null,
            preview: null,
            previewTruncated: false,
            readError:
              err instanceof Error ? err.message : 'Failed to read tab',
          }
        }
      },
    ),
  )

  // Structured summary — when the sheet has a declared layout, find
  // the named tab and compute the KPIs/sections/grids from its values.
  // Falls back to null when the layout's named tab isn't present in
  // the workbook (renamed, deleted, etc.) so the UI can fall back to
  // the generic per-tab cards.
  let structuredSummary: StructuredSummary | null = null
  if (sheet.layout) {
    const layoutTab = tabs.find((t) => t.title === sheet.layout!.tab)
    if (layoutTab?.preview && !layoutTab.readError) {
      structuredSummary = summarizeStructured(
        layoutTab.preview,
        sheet.layout,
      )
    }
  }

  return NextResponse.json({
    ...base,
    tabs,
    structuredSummary,
    globalReadError: null,
  } satisfies PinnedSheetDetailResponse)
}

function shouldTruncate(values: string[][]): boolean {
  if (values.length > MAX_PREVIEW_ROWS) return true
  return values.some((row) => row.length > MAX_PREVIEW_COLS)
}

function truncatePreview(values: string[][]): string[][] {
  const rows = values.slice(0, MAX_PREVIEW_ROWS)
  return rows.map((row) => row.slice(0, MAX_PREVIEW_COLS))
}
