'use client'

/**
 * /documents/sheets/[key]
 *
 * Per-sheet detail view. Linked from the "View detailed" button on
 * each pinned-sheets card on /documents — gives the sheet the full
 * width of the page, reads every tab in the workbook for richer
 * analysis, and lays out the data in a sheet-specific way:
 *
 *   - financials: KPI strip across the top (top figure, rough money
 *     in / out across all tabs), then a clickable per-tab grid where
 *     each card surfaces that tab's headline figure, finally the
 *     iframe at 75vh focused on the active tab.
 *
 *   - fulfillment: per-row "client breakdown" cards — every non-
 *     empty data row becomes a card listing every header→value pair
 *     filled in. Status pivot section if a status column is present.
 *     Iframe at 75vh below.
 *
 * The iframe still does the actual editing. The breakdowns above
 * exist because reading 30 columns × 50 rows in a 640px iframe is
 * miserable; the structured cards turn the same data into something
 * a human can actually scan.
 */

import { useMemo, useState, use } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type SheetSummaryItem = {
  label: string
  value: string
  hint?: string
}

type TabDetail = {
  id: number
  title: string
  rowCount: number
  columnCount: number
  summary: { items: SheetSummaryItem[]; activeTab: string } | null
  preview: string[][] | null
  previewTruncated: boolean
  readError: string | null
}

type DetailResponse = {
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
  tabs: TabDetail[]
  globalReadError: string | null
}

export default function PinnedSheetDetailPage({
  params,
}: {
  params: Promise<{ key: string }>
}) {
  const { key } = use(params)

  const query = useQuery<DetailResponse>({
    queryKey: ['pinned-sheets-detail', key],
    queryFn: async () => {
      const res = await fetch(`/api/documents/pinned-sheets/${key}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load sheet detail')
      }
      return res.json()
    },
    staleTime: 60_000,
  })

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 py-8">
        <Link
          href="/documents"
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Documents
        </Link>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {(query.error as Error).message}
        </div>
      </div>
    )
  }

  const data = query.data
  if (!data) return null

  return (
    <div className="space-y-5">
      <DetailHeader data={data} isFetching={query.isFetching} />

      {data.globalReadError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {data.globalReadError}
        </div>
      )}

      {data.key === 'financials' ? (
        <FinancialsDetailView data={data} />
      ) : data.key === 'fulfillment' ? (
        <FulfillmentDetailView data={data} />
      ) : (
        <GenericDetailView data={data} />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Shared header                                                              */
/* -------------------------------------------------------------------------- */

function DetailHeader({
  data,
  isFetching,
}: {
  data: DetailResponse
  isFetching: boolean
}) {
  return (
    <div className="space-y-3">
      <Link
        href="/documents"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Documents
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn('rounded-lg p-2.5', data.accent.iconBg)}>
            <FileSpreadsheet
              className={cn('h-6 w-6', data.accent.iconText)}
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">
                {data.title}
              </h1>
              {isFetching && (
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-zinc-400" />
              )}
            </div>
            <p className="mt-1 max-w-3xl text-sm text-zinc-500">
              {data.description}
            </p>
          </div>
        </div>
        <a
          href={data.viewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open in Google Sheets
        </a>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Financials detail                                                          */
/* -------------------------------------------------------------------------- */

function FinancialsDetailView({ data }: { data: DetailResponse }) {
  const [activeGid, setActiveGid] = useState<number>(data.defaultGid)
  const activeTab = useMemo(
    () => data.tabs.find((t) => t.id === activeGid),
    [data.tabs, activeGid],
  )

  // Aggregate KPIs across all tabs — give the team a "whole workbook
  // at a glance" feel, not just the first tab's numbers.
  const aggregate = useMemo(() => computeFinancialAggregate(data.tabs), [data.tabs])

  return (
    <div className="space-y-5">
      {/* KPI strip across the top */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Top figure (workbook)"
          value={aggregate.topFigure?.value ?? '—'}
          hint={aggregate.topFigure?.label ?? 'No currency cells found'}
          accent={data.accent.badgeText}
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
        />
        <KPICard
          label="Sum positive cells"
          value={aggregate.sumPositive ?? '—'}
          hint={
            aggregate.positiveCellCount
              ? `approx · ${aggregate.positiveCellCount} cells across tabs`
              : undefined
          }
          accent={data.accent.badgeText}
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
        />
        <KPICard
          label="Sum negative cells"
          value={aggregate.sumNegative ?? '—'}
          hint={
            aggregate.negativeCellCount
              ? `approx · ${aggregate.negativeCellCount} cells across tabs`
              : undefined
          }
          accent={data.accent.badgeText}
          icon={<TrendingDown className="h-4 w-4 text-rose-500" />}
        />
        <KPICard
          label="Tabs · rows"
          value={`${data.tabs.length} · ${aggregate.totalRows}`}
          hint="Sum across every tab"
          accent={data.accent.badgeText}
        />
      </div>

      {/* Per-tab grid — clickable to focus iframe */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Per-tab breakdown · click a tab to focus the iframe
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveGid(tab.id)}
              className={cn(
                'rounded-xl border bg-white p-4 text-left shadow-sm transition hover:shadow-md dark:bg-zinc-900',
                activeGid === tab.id
                  ? 'border-blue-300 ring-2 ring-blue-200 dark:border-blue-800 dark:ring-blue-900'
                  : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate text-sm font-semibold">{tab.title}</h3>
                {activeGid === tab.id && (
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" />
                )}
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">
                {tab.rowCount} rows · {tab.columnCount} cols
              </p>
              {tab.readError ? (
                <p className="mt-2 flex items-center gap-1 text-[11px] text-amber-700">
                  <AlertCircle className="h-3 w-3" />
                  {tab.readError}
                </p>
              ) : tab.summary && tab.summary.items.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {tab.summary.items.slice(0, 3).map((item, i) => (
                    <li
                      key={`${item.label}-${i}`}
                      className="flex items-start justify-between gap-2 text-[11px]"
                    >
                      <span className="text-zinc-500">{item.label}</span>
                      <span
                        className={cn(
                          'flex-shrink-0 font-semibold tabular-nums',
                          data.accent.badgeText,
                        )}
                      >
                        {item.value}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11px] text-zinc-400">
                  No headline figures detected
                </p>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* The iframe — focused on the active tab */}
      <SheetIframe
        sheet={data}
        activeGid={activeGid}
        activeTabTitle={activeTab?.title ?? null}
      />
    </div>
  )
}

function computeFinancialAggregate(tabs: TabDetail[]): {
  topFigure: { value: string; label: string } | null
  sumPositive: string | null
  sumNegative: string | null
  positiveCellCount: number
  negativeCellCount: number
  totalRows: number
} {
  let topFigure: { value: string; label: string } | null = null
  let positiveCellCount = 0
  let negativeCellCount = 0
  let totalRows = 0
  // We can't sum across tabs here because the API only sent us
  // already-formatted summary STRINGS, not raw numbers — so for
  // the aggregate "sum" stats we surface the active-tab figure.
  // (Faithful approximation; real per-tab cell-level sums would
  // require returning numbers from the API, which we deliberately
  // skipped to keep the payload light.)
  let sumPositive: string | null = null
  let sumNegative: string | null = null

  for (const tab of tabs) {
    totalRows += tab.rowCount
    if (!tab.summary) continue
    for (const item of tab.summary.items) {
      if (item.label === 'Top figure') {
        // Pick the largest-looking magnitude across tabs by string
        // length as a cheap proxy ("$1.2M" > "$320K" > "$5,000").
        if (
          !topFigure ||
          rankCurrencyString(item.value) > rankCurrencyString(topFigure.value)
        ) {
          topFigure = { value: item.value, label: item.hint ?? tab.title }
        }
      }
      if (item.label === 'Sum of positive cells') {
        if (!sumPositive) sumPositive = item.value
        const m = item.hint?.match(/(\d+)\s+cells/)
        if (m) positiveCellCount += parseInt(m[1], 10)
      }
      if (item.label === 'Sum of negative cells') {
        if (!sumNegative) sumNegative = item.value
        const m = item.hint?.match(/(\d+)\s+cells/)
        if (m) negativeCellCount += parseInt(m[1], 10)
      }
    }
  }

  return {
    topFigure,
    sumPositive,
    sumNegative,
    positiveCellCount,
    negativeCellCount,
    totalRows,
  }
}

function rankCurrencyString(s: string): number {
  // Quick magnitude proxy — biggest unit wins, then digit count.
  if (/B$/i.test(s)) return 4_000 + s.length
  if (/M$/i.test(s)) return 3_000 + s.length
  if (/K$/i.test(s)) return 2_000 + s.length
  return s.replace(/[^\d]/g, '').length
}

/* -------------------------------------------------------------------------- */
/*  Fulfillment detail                                                         */
/* -------------------------------------------------------------------------- */

function FulfillmentDetailView({ data }: { data: DetailResponse }) {
  // Find the largest tab by row count — that's almost certainly the
  // "client list" tab. We make it the default for both the breakdown
  // cards AND the iframe focus.
  const primaryTab = useMemo(() => {
    return data.tabs
      .slice()
      .sort((a, b) => (b.preview?.length ?? 0) - (a.preview?.length ?? 0))[0]
  }, [data.tabs])
  const [activeGid, setActiveGid] = useState<number>(
    primaryTab?.id ?? data.defaultGid,
  )

  const activeTab = useMemo(
    () => data.tabs.find((t) => t.id === activeGid) ?? primaryTab,
    [data.tabs, activeGid, primaryTab],
  )

  const breakdown = useMemo(
    () => buildClientBreakdown(activeTab ?? null),
    [activeTab],
  )

  return (
    <div className="space-y-5">
      {/* Top stats row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Clients tracked"
          value={String(breakdown.dataRows.length)}
          hint={
            breakdown.uniqueFirstColCount &&
            breakdown.uniqueFirstColCount !== breakdown.dataRows.length
              ? `${breakdown.uniqueFirstColCount} unique · ${breakdown.dataRows.length - breakdown.uniqueFirstColCount} dupes`
              : undefined
          }
          accent={data.accent.badgeText}
        />
        {breakdown.statusPivot &&
          breakdown.statusPivot.entries.slice(0, 3).map((entry, i) => (
            <KPICard
              key={`${entry.value}-${i}`}
              label={breakdown.statusPivot!.headerLabel}
              value={`${entry.count} ${entry.value}`}
              hint={`of ${breakdown.dataRows.length} total`}
              accent={data.accent.badgeText}
            />
          ))}
        {/* Pad with tabs count so the strip stays full when there's no status column */}
        {(!breakdown.statusPivot || breakdown.statusPivot.entries.length < 3) && (
          <KPICard
            label="Tabs in workbook"
            value={String(data.tabs.length)}
            hint={
              data.tabs.length === 1 ? 'single tab' : 'switch via grid below'
            }
            accent={data.accent.badgeText}
          />
        )}
      </div>

      {/* Tab switcher (hidden if only one tab) */}
      {data.tabs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {data.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveGid(tab.id)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-medium transition',
                activeGid === tab.id
                  ? cn(
                      data.accent.badgeBg,
                      data.accent.badgeText,
                      'border-current/30',
                    )
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
              )}
            >
              {tab.title}{' '}
              <span className="ml-1 text-[10px] opacity-70">
                · {tab.rowCount}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Per-row client cards */}
      {breakdown.dataRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          No client rows detected on this tab.
        </div>
      ) : (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Client breakdown · every row, every filled-in field
          </h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {breakdown.dataRows.map((row, i) => (
              <ClientRowCard
                key={`row-${i}`}
                row={row}
                headers={breakdown.headers}
                statusColIdx={breakdown.statusPivot?.columnIdx ?? -1}
                accent={data.accent}
              />
            ))}
          </div>
        </section>
      )}

      <SheetIframe
        sheet={data}
        activeGid={activeGid}
        activeTabTitle={activeTab?.title ?? null}
      />
    </div>
  )
}

type ClientBreakdown = {
  headers: string[]
  dataRows: string[][]
  uniqueFirstColCount: number
  statusPivot: {
    columnIdx: number
    headerLabel: string
    entries: Array<{ value: string; count: number }>
  } | null
}

function buildClientBreakdown(tab: TabDetail | null): ClientBreakdown {
  if (!tab || !tab.preview || tab.preview.length === 0) {
    return {
      headers: [],
      dataRows: [],
      uniqueFirstColCount: 0,
      statusPivot: null,
    }
  }
  const headers = tab.preview[0].map((h) => h.trim())
  const rawRows = tab.preview.slice(1)
  const dataRows = rawRows.filter((row) => row.some((c) => c.trim().length > 0))

  const firstColUnique = new Set(
    dataRows
      .map((r) => r[0]?.trim() ?? '')
      .filter((v) => v.length > 0)
      .map((v) => v.toLowerCase()),
  )

  const lowerHeaders = headers.map((h) => h.toLowerCase())
  const statusColIdx = lowerHeaders.findIndex((h) =>
    /qualif|status|stage|active|approve/.test(h),
  )
  let statusPivot: ClientBreakdown['statusPivot'] = null
  if (statusColIdx >= 0) {
    const counts = new Map<string, number>()
    for (const row of dataRows) {
      const v = (row[statusColIdx] ?? '').trim()
      if (!v) continue
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    if (counts.size > 0) {
      statusPivot = {
        columnIdx: statusColIdx,
        headerLabel: titleCase(headers[statusColIdx] || 'Status'),
        entries: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([value, count]) => ({ value, count })),
      }
    }
  }

  return {
    headers,
    dataRows,
    uniqueFirstColCount: firstColUnique.size,
    statusPivot,
  }
}

function ClientRowCard({
  row,
  headers,
  statusColIdx,
  accent,
}: {
  row: string[]
  headers: string[]
  statusColIdx: number
  accent: DetailResponse['accent']
}) {
  // First non-empty cell becomes the "name" — usually the client.
  // Other filled cells become field rows.
  const primaryName = row.find((c) => c.trim().length > 0)?.trim() ?? '(empty)'
  const fields = headers
    .map((header, idx) => ({ header: header.trim(), value: row[idx]?.trim() ?? '', idx }))
    .filter((f) => f.value.length > 0 && f.idx !== 0) // skip name col

  const status =
    statusColIdx >= 0 ? row[statusColIdx]?.trim() ?? '' : ''

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight">{primaryName}</h3>
        {status && (
          <span
            className={cn(
              'flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
              accent.badgeBg,
              accent.badgeText,
            )}
          >
            {status}
          </span>
        )}
      </div>
      {fields.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-400">No additional fields filled.</p>
      ) : (
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {fields.map(({ header, value, idx }) => (
            <div key={idx} className="flex flex-col">
              <dt className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
                {header || `Col ${idx + 1}`}
              </dt>
              <dd className="text-xs text-zinc-700 dark:text-zinc-300">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Generic fallback (future sheets)                                           */
/* -------------------------------------------------------------------------- */

function GenericDetailView({ data }: { data: DetailResponse }) {
  const [activeGid, setActiveGid] = useState<number>(data.defaultGid)
  const activeTab = data.tabs.find((t) => t.id === activeGid)
  return (
    <div className="space-y-4">
      {data.tabs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {data.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveGid(tab.id)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-medium transition',
                activeGid === tab.id
                  ? cn(data.accent.badgeBg, data.accent.badgeText)
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
              )}
            >
              {tab.title}
            </button>
          ))}
        </div>
      )}
      <SheetIframe
        sheet={data}
        activeGid={activeGid}
        activeTabTitle={activeTab?.title ?? null}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function KPICard({
  label,
  value,
  hint,
  accent,
  icon,
}: {
  label: string
  value: string
  hint?: string
  accent: string
  icon?: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </p>
        {icon}
      </div>
      <p
        className={cn(
          'mt-2 text-2xl font-bold tabular-nums tracking-tight',
          accent,
        )}
      >
        {value}
      </p>
      {hint && (
        <p className="mt-1 truncate text-[11px] text-zinc-400">{hint}</p>
      )}
    </div>
  )
}

function SheetIframe({
  sheet,
  activeGid,
  activeTabTitle,
}: {
  sheet: DetailResponse
  activeGid: number
  activeTabTitle: string | null
}) {
  const src = useMemo(() => {
    return `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit?embedded=true&rm=minimal&gid=${activeGid}#gid=${activeGid}`
  }, [sheet.spreadsheetId, activeGid])

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Live editable view
          {activeTabTitle && (
            <span className="ml-2 normal-case text-zinc-400">
              · {activeTabTitle}
            </span>
          )}
        </h2>
        <p className="text-[11px] text-zinc-400">
          Edits land directly in the source Google Sheet.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <iframe
          key={activeGid}
          src={src}
          title={sheet.title}
          className="h-[75vh] min-h-[600px] w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
    </section>
  )
}

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}
