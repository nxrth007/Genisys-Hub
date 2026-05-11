'use client'

/**
 * Pinned-sheets banner at the top of /documents.
 *
 * Renders a compact preview tile per sheet from /api/documents/pinned-sheets:
 *   - Title + description on the left
 *   - "View detailed" (primary CTA) + "Open in Sheets" buttons on the right
 *   - Summary KPI badges below (accurate layout-aware values when the
 *     sheet declares a structured layout, generic inference otherwise)
 *
 * The live Google Sheets iframe was removed from this listing 2026-05-11
 * (per Alex): two full 640px-tall iframes stacked on /documents was
 * overwhelming as a landing-page experience. The iframe still lives on
 * the per-sheet detail page at /documents/sheets/[key], where it has
 * the full width and the structured KPI cards above it. /documents
 * itself is now a clean overview — quick-glance numbers + a click to
 * drill in.
 */

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  Maximize2,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type SheetSummaryItem = {
  label: string
  value: string
  hint?: string
}

type SheetTab = {
  id: number
  title: string
  rowCount: number
  columnCount: number
}

type PinnedSheetPayload = {
  key: 'financials' | 'fulfillment'
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
  tabs: SheetTab[] | null
  summary: { items: SheetSummaryItem[]; activeTab: string } | null
  readError: string | null
}

type Response = {
  sourceAccountEmail: string | null
  sheets: PinnedSheetPayload[]
}

export function PinnedSheetsSection() {
  const query = useQuery<Response>({
    queryKey: ['pinned-sheets'],
    queryFn: async () => {
      const res = await fetch('/api/documents/pinned-sheets')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load pinned sheets')
      }
      return res.json()
    },
    // Tile summary numbers refresh every minute so the headline values
    // stay roughly current as people edit the underlying sheet.
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-zinc-200 bg-white py-10 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        Couldn&apos;t load pinned sheets: {(query.error as Error).message}
      </div>
    )
  }

  const sheets = query.data?.sheets ?? []
  if (sheets.length === 0) return null

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Pinned sheets
        </h3>
        {query.isFetching && (
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-zinc-400" />
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {sheets.map((s) => (
          <PinnedSheetCard key={s.key} sheet={s} />
        ))}
      </div>
    </section>
  )
}

function PinnedSheetCard({ sheet }: { sheet: PinnedSheetPayload }) {
  const items = sheet.summary?.items ?? []

  return (
    <Link
      href={`/documents/sheets/${sheet.key}`}
      className="group block overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm transition hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
      title="Open the full detail view"
    >
      {/* Card header — title + description on the left, action buttons
          on the right. The whole card is a Link so clicking anywhere
          (except the buttons themselves) opens the detail view. */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn('flex-shrink-0 rounded-lg p-2', sheet.accent.iconBg)}>
            <FileSpreadsheet
              className={cn('h-5 w-5', sheet.accent.iconText)}
            />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold tracking-tight">
              {sheet.title}
            </h4>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              {sheet.description}
            </p>
          </div>
        </div>
        <div
          className="flex flex-shrink-0 items-center gap-2"
          // Buttons inside a Link — stop propagation so external-link
          // click doesn't ALSO trigger the card-level navigation.
          onClick={(e) => e.stopPropagation()}
        >
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition',
              sheet.accent.badgeBg,
              sheet.accent.badgeText,
              'group-hover:brightness-95',
            )}
          >
            <Maximize2 className="h-3 w-3" />
            View detailed
          </span>
          <a
            href={sheet.viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="Open in Google Sheets"
          >
            <ExternalLink className="h-3 w-3" />
            Open in Sheets
          </a>
        </div>
      </div>

      {sheet.readError && (
        <div className="border-t border-amber-200 bg-amber-50 px-5 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Couldn&apos;t read summary metadata ({sheet.readError}). Open the
          detailed view or Google Sheets for the live data.
        </div>
      )}

      {/* Summary KPI strip — the only "content" on this tile now that
          the iframe lives on the detail page. Compact, readable, gives
          admin a one-glance answer to "what's in this workbook." */}
      {items.length > 0 && (
        <div className="border-t border-zinc-200 bg-zinc-50/50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/50">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {items.slice(0, 6).map((item, i) => (
              <div
                key={`${item.label}-${i}`}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="truncate text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  {item.label}
                </div>
                <div
                  className={cn(
                    'mt-0.5 truncate text-sm font-semibold tabular-nums',
                    sheet.accent.badgeText,
                  )}
                  title={item.value}
                >
                  {item.value}
                </div>
                {item.hint && (
                  <div className="mt-0.5 truncate text-[10px] text-zinc-400">
                    {item.hint}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Link>
  )
}
