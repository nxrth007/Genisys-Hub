'use client'

/**
 * Pinned-sheets banner at the top of /documents.
 *
 * Renders a card per sheet from /api/documents/pinned-sheets:
 *   - Header row with title + description + "Open in Sheets" button
 *   - Summary badges (top revenue figure, qualified-client count, …)
 *   - Tab switcher across the visible sheet's tabs (each click swaps
 *     the iframe gid)
 *   - The actual editable iframe (Google Sheets in-place)
 *   - Toggle to expand/collapse the iframe so admin can hide it once
 *     they've checked the headline numbers
 *
 * Editing inside the iframe works for users signed into Google in
 * the same browser. If third-party cookies are blocked or they're
 * in incognito, "Open in Google Sheets" launches a full tab.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
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
    // Sheets metadata is light; refresh every minute so summary
    // badges stay roughly current as people edit.
    staleTime: 60_000,
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
  const [expanded, setExpanded] = useState(true)
  const [activeGid, setActiveGid] = useState<number>(sheet.defaultGid)

  const tabs = sheet.tabs ?? []

  // Build the embed URL with the currently-selected gid. Memoized
  // so we don't reconstruct the iframe src on every parent render
  // (which would force-reload the iframe and lose the user's
  // scroll/edit position).
  const embedUrl = useMemo(() => {
    const base = sheet.embedUrl.split('#')[0].split('?')[0]
    return `${base}?embedded=true&rm=minimal&gid=${activeGid}#gid=${activeGid}`
  }, [sheet.embedUrl, activeGid])

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {/* Card header */}
      <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <div className="flex items-start gap-3">
          <div className={cn('rounded-lg p-2', sheet.accent.iconBg)}>
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
        <a
          href={sheet.viewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          title="Open in Google Sheets"
        >
          <ExternalLink className="h-3 w-3" />
          Open in Sheets
        </a>
      </div>

      {/* Summary badges — only render if we got values back. */}
      {sheet.summary && sheet.summary.items.length > 0 && (
        <div className="flex flex-wrap items-stretch gap-2 border-b border-zinc-200 bg-zinc-50/50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/50">
          {sheet.summary.items.map((item, i) => (
            <div
              key={`${item.label}-${i}`}
              className={cn(
                'rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900',
              )}
            >
              <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                {item.label}
              </div>
              <div
                className={cn(
                  'mt-0.5 text-sm font-semibold tabular-nums',
                  sheet.accent.badgeText,
                )}
              >
                {item.value}
              </div>
              {item.hint && (
                <div className="mt-0.5 text-[10px] text-zinc-400">
                  {item.hint}
                </div>
              )}
            </div>
          ))}
          <div className="ml-auto self-end text-[10px] text-zinc-400">
            Active tab: {sheet.summary.activeTab}
          </div>
        </div>
      )}

      {sheet.readError && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Couldn&apos;t read sheet metadata ({sheet.readError}). The iframe
          below still works — you may just need to share this sheet with a
          connected Drive account to enable summary stats.
        </div>
      )}

      {/* Tab switcher — only meaningful when there's >1 tab. */}
      {tabs.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-zinc-50/30 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/30">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveGid(tab.id)}
              className={cn(
                'flex-shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                activeGid === tab.id
                  ? cn(
                      sheet.accent.badgeBg,
                      sheet.accent.badgeText,
                      'ring-1 ring-current/20',
                    )
                  : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300',
              )}
            >
              {tab.title}
            </button>
          ))}
        </div>
      )}

      {/* The iframe — Google Sheets full UI in place. Editing works
          for users signed into Google in this browser. Height is
          generous (640px) so admin doesn't have to scroll inside
          the iframe to see most of the visible region. */}
      <div className={cn('relative bg-white dark:bg-zinc-900')}>
        {expanded ? (
          <iframe
            // The key forces a remount when the gid changes — Google
            // Sheets won't re-navigate inside an iframe just because
            // the src hash changes, so we force a fresh load.
            key={activeGid}
            src={embedUrl}
            title={sheet.title}
            className="h-[640px] w-full border-0"
            // Allow same-origin so the user's Google session cookie
            // is present in the iframe context.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        ) : (
          <div className="px-5 py-8 text-center text-xs text-zinc-400">
            Sheet hidden — click Expand to load the embed.
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-center gap-1.5 border-t border-zinc-200 bg-zinc-50 py-2 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
      >
        {expanded ? (
          <>
            <ChevronUp className="h-3 w-3" />
            Collapse
          </>
        ) : (
          <>
            <ChevronDown className="h-3 w-3" />
            Expand
          </>
        )}
      </button>
    </div>
  )
}
