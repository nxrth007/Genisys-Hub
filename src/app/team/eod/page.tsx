'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarCheck,
  ClipboardList,
  Loader2,
  MessageCircle,
  Phone,
  Plus,
  TriangleAlert,
} from 'lucide-react'
import { labelForTag } from '@/lib/eod-reports'

/**
 * /team/eod — Team #1 member's list of past EOD submissions.
 *
 * Mirror of /agent/eod for Mary. Same EodReport DB table; the only
 * difference is the API endpoint (/api/team/eod-reports, role-gated
 * to team_member) and the back-links pointing at /team/* instead
 * of /agent/*.
 *
 * Lives under /team/* so middleware lets team_member through.
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
}

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

export default function TeamEodListPage() {
  const query = useQuery<{ reports: EodReport[] }>({
    queryKey: ['team-eod-reports'],
    queryFn: async () => {
      const res = await fetch('/api/team/eod-reports')
      if (!res.ok) throw new Error('Failed to load reports')
      return res.json()
    },
  })

  const reports = useMemo(() => query.data?.reports ?? [], [query.data])
  const today = todayISO()
  const todaysReport = reports.find((r) => r.reportDate.slice(0, 10) === today)

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link
        href="/team"
        className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 transition hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My EOD Reports</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Submit a short recap at the end of each shift. Management reviews
            these daily to spot technical issues and unblock the team.
          </p>
        </div>
        {todaysReport ? (
          <Link
            href={`/team/eod/${todaysReport.id}`}
            className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300"
          >
            Edit today&apos;s report
          </Link>
        ) : (
          <Link
            href="/team/eod/new"
            className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Submit today&apos;s report
          </Link>
        )}
      </div>

      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <ClipboardList className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
          <h3 className="mt-3 text-sm font-semibold">No reports yet</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Submit your first EOD report when your shift wraps up.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {reports.map((r) => (
              <ReportRow key={r.id} report={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ReportRow({ report }: { report: EodReport }) {
  const date = new Date(report.reportDate)
  const hasIssues =
    report.technicalIssueTags.length > 0 ||
    !!report.technicalIssueNotes ||
    !!report.organizationalIssues

  return (
    <Link
      href={`/team/eod/${report.id}`}
      className="block px-4 py-4 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
    >
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 text-center" style={{ minWidth: '4.5rem' }}>
          <div className="text-xs font-medium uppercase text-zinc-400">
            {date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}
          </div>
          <div className="text-xl font-bold">{date.getUTCDate()}</div>
          <div className="text-[10px] text-zinc-400">
            {date.toLocaleDateString('en-US', {
              weekday: 'short',
              timeZone: 'UTC',
            })}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-600 dark:text-zinc-300">
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3 w-3 text-zinc-400" />
              <span className="font-semibold tabular-nums">{report.dialsMade}</span>
              dials
            </span>
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="h-3 w-3 text-zinc-400" />
              <span className="font-semibold tabular-nums">
                {report.contactsReached}
              </span>
              contacts
            </span>
            <span className="inline-flex items-center gap-1">
              <CalendarCheck className="h-3 w-3 text-zinc-400" />
              <span className="font-semibold tabular-nums">
                {report.appointmentsGenerated}
              </span>
              appts
            </span>
            {report.callbacksScheduled > 0 && (
              <span className="text-zinc-500">
                ·{' '}
                <span className="font-semibold tabular-nums">
                  {report.callbacksScheduled}
                </span>{' '}
                callbacks
              </span>
            )}
          </div>

          {report.technicalIssueTags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {report.technicalIssueTags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                >
                  {labelForTag(t)}
                </span>
              ))}
            </div>
          )}

          {(report.technicalIssueNotes || report.organizationalIssues) && (
            <p className="mt-1.5 line-clamp-2 text-xs text-zinc-500">
              {report.technicalIssueNotes || report.organizationalIssues}
            </p>
          )}
        </div>

        {hasIssues && (
          <TriangleAlert
            className="h-4 w-4 flex-shrink-0 text-amber-500"
            aria-label="Issues flagged"
          />
        )}
      </div>
    </Link>
  )
}
