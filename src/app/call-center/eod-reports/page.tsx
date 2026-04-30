'use client'

import { Suspense, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { Loader2, ClipboardList } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Chip } from '@/components/ui/chip'

/**
 * Call Center → EOD Reports tab. Stripped to the mockup pattern: a
 * single rounded card holding agent EOD reports grouped by date, no
 * filter bar / stat strip / agent dropdown. Date range comes from
 * the shared layout's URL params; "Flagged" chip surfaces reports
 * that mentioned technical or organizational issues so they catch
 * the eye without needing a dedicated filter.
 */

type EodReport = {
  id: string
  reportDate: string
  dialsMade: number
  contactsReached: number
  appointmentsGenerated: number
  callbacksScheduled: number
  technicalIssueTags: string[]
  technicalIssueNotes: string | null
  organizationalIssues: string | null
  wins: string | null
  tomorrowFocus: string | null
  createdAt: string
  agent: { id: string; name: string | null; email: string }
}

export default function EodReportsPage() {
  return (
    <Suspense fallback={<EodReportsSkeleton />}>
      <EodReportsList />
    </Suspense>
  )
}

function EodReportsList() {
  const params = useSearchParams()
  const since = params.get('since')
  const until = params.get('until')

  const query = useQuery<{ reports: EodReport[] }>({
    queryKey: ['call-center-eod-reports', since, until],
    queryFn: async () => {
      const sp = new URLSearchParams()
      if (since) sp.set('since', isoToYmd(since))
      if (until) sp.set('until', isoToYmd(until))
      const res = await fetch(`/api/call-center/eod-reports?${sp.toString()}`)
      if (!res.ok) throw new Error('Failed to load EOD reports')
      return res.json()
    },
  })
  const reports = query.data?.reports ?? []

  // Bucket by reportDate, then sort buckets newest-first. Each
  // bucket already arrives in a deterministic order from the server
  // (createdAt asc), but we keep the local sort just in case.
  const grouped = useMemo(() => {
    const map = new Map<string, EodReport[]>()
    for (const r of reports) {
      const list = map.get(r.reportDate) ?? []
      list.push(r)
      map.set(r.reportDate, list)
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, list]) => ({
        date,
        list: list.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        ),
      }))
  }, [reports])

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-semibold tracking-tight">
            EOD reports
          </h2>
          <Chip tone="blue">
            {reports.length} report{reports.length === 1 ? '' : 's'}
          </Chip>
        </div>

        {query.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : query.isError ? (
          <p className="py-12 text-center text-sm text-destructive">
            Couldn&apos;t load reports. Try refreshing.
          </p>
        ) : grouped.length === 0 ? (
          <div className="py-12 text-center">
            <ClipboardList className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">
              No reports for the selected window.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-5">
            {grouped.map(({ date, list }) => (
              <div key={date}>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {formatReportDate(date)}
                </p>
                <ul className="mt-2 flex flex-col">
                  {list.map((r, i) => (
                    <ReportRow key={r.id} report={r} first={i === 0} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function ReportRow({ report, first }: { report: EodReport; first: boolean }) {
  const display = report.agent.name || report.agent.email
  const flagged =
    (report.technicalIssueTags?.length ?? 0) > 0 ||
    !!report.organizationalIssues
  const summary = pickSummary(report)
  const submittedAt = new Date(report.createdAt)
  return (
    <li
      className={
        first
          ? 'flex items-start gap-3 py-3.5 first:pt-2'
          : 'flex items-start gap-3 border-t border-border-soft py-3.5'
      }
    >
      <Avatar name={display} email={report.agent.email} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{display}</p>
          <span className="text-xs text-muted-foreground">
            ·{' '}
            {submittedAt.toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
          {flagged && (
            <Chip tone="pink" className="font-semibold">
              Flagged
            </Chip>
          )}
          <span className="ml-auto flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Stat label="Dials" value={report.dialsMade} />
            <Stat label="Appts" value={report.appointmentsGenerated} />
            <Stat label="Callbacks" value={report.callbacksScheduled} />
          </span>
        </div>
        {summary && (
          <p className="mt-1 text-sm text-foreground/80 line-clamp-3">
            {summary}
          </p>
        )}
      </div>
    </li>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-full border border-border-soft bg-surface-muted px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">
      <span className="font-semibold tabular-nums text-foreground">
        {value}
      </span>
      {label}
    </span>
  )
}

/* ---- Helpers ----------------------------------------------------------- */

/** Pick the most "headline-like" text on a report — wins first
 *  (most positive framing), tomorrowFocus second, then issues. */
function pickSummary(r: EodReport): string | null {
  if (r.wins?.trim()) return r.wins
  if (r.tomorrowFocus?.trim()) return `Tomorrow: ${r.tomorrowFocus.trim()}`
  if (r.organizationalIssues?.trim()) return r.organizationalIssues
  if (r.technicalIssueNotes?.trim()) return r.technicalIssueNotes
  return null
}

function formatReportDate(ymd: string): string {
  // The server returns YYYY-MM-DD strings — parse safely so the
  // weekday/month rendering uses the date the agent submitted on,
  // not whatever the viewer's UTC offset turns it into.
  const [y, m, d] = ymd.split('-').map((s) => parseInt(s, 10))
  if (!y || !m || !d) return ymd
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

/** The EOD reports endpoint expects YYYY-MM-DD; the layout writes
 *  full ISO strings. Take just the date part. */
function isoToYmd(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function EodReportsSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="h-6 w-32 animate-pulse rounded-md bg-muted" />
      <div className="mt-4 flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-xl border border-border-soft bg-surface-muted"
          />
        ))}
      </div>
    </div>
  )
}
