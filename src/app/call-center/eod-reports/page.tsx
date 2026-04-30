'use client'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  PhoneCall,
  ClipboardList,
  Loader2,
  ChevronDown,
  ChevronRight,
  TriangleAlert,
  Phone,
  MessageCircle,
  CalendarCheck,
  Download,
  Filter,
} from 'lucide-react'
import { cn } from '@/lib/utils'
// CallCenterTabs lives on the shared /call-center layout.
import { labelForTag } from '@/lib/eod-reports'
// PageHeader is provided by the shared /call-center layout.
import { StatCard } from '@/components/ui/stat-card'

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

type AgentSummary = {
  id: string
  name: string | null
  email: string
}

function csvEscape(v: string): string {
  if (v == null) return ''
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

export default function EodReportsPage() {
  const [agent, setAgent] = useState('all')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const agentsQuery = useQuery<{ agents: AgentSummary[] }>({
    queryKey: ['call-center-agents'],
    queryFn: async () => {
      const res = await fetch('/api/call-center/agents')
      if (!res.ok) throw new Error('Failed to load agents')
      return res.json()
    },
  })

  const reportsQuery = useQuery<{ reports: EodReport[] }>({
    queryKey: ['eod-reports-staff', agent, since, until, issuesOnly],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (agent !== 'all') params.set('agent', agent)
      if (since) params.set('since', since)
      if (until) params.set('until', until)
      if (issuesOnly) params.set('hasIssues', '1')
      const res = await fetch(`/api/call-center/eod-reports?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to load reports')
      return res.json()
    },
  })

  const agents = useMemo(() => agentsQuery.data?.agents ?? [], [agentsQuery.data])
  const reports = useMemo(() => reportsQuery.data?.reports ?? [], [reportsQuery.data])

  // Roll-up metrics over the currently-filtered window.
  const totals = useMemo(() => {
    let dials = 0
    let contacts = 0
    let appts = 0
    let callbacks = 0
    let withIssues = 0
    for (const r of reports) {
      dials += r.dialsMade
      contacts += r.contactsReached
      appts += r.appointmentsGenerated
      callbacks += r.callbacksScheduled
      if (
        r.technicalIssueTags.length > 0 ||
        r.technicalIssueNotes ||
        r.organizationalIssues
      ) {
        withIssues++
      }
    }
    return {
      dials,
      contacts,
      appts,
      callbacks,
      withIssues,
      connectRate:
        dials > 0 ? Math.round((contacts / dials) * 100) : null,
      bookingRate:
        contacts > 0 ? Math.round((appts / contacts) * 100) : null,
    }
  }, [reports])

  function clearFilters() {
    setAgent('all')
    setSince('')
    setUntil('')
    setIssuesOnly(false)
  }

  function exportCsv() {
    const headers = [
      'Date',
      'Agent',
      'Email',
      'Dials',
      'Live Contacts',
      'Appts Generated',
      'Callbacks',
      'Technical Issues',
      'Technical Notes',
      'Organizational Issues',
      'Wins',
      'Tomorrow Focus',
      'Submitted At',
    ]
    const rows = reports.map((r) => [
      r.reportDate.slice(0, 10),
      r.agent.name || '',
      r.agent.email,
      r.dialsMade,
      r.contactsReached,
      r.appointmentsGenerated,
      r.callbacksScheduled,
      r.technicalIssueTags.map(labelForTag).join('; '),
      r.technicalIssueNotes || '',
      r.organizationalIssues || '',
      r.wins || '',
      r.tomorrowFocus || '',
      new Date(r.createdAt).toLocaleString('en-US'),
    ])
    const csv = [headers, ...rows]
      .map((row) => row.map((c) => csvEscape(String(c))).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `genisys-eod-reports-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const filterCleared = agent === 'all' && !since && !until && !issuesOnly

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Dials" value={totals.dials} icon={Phone} tone="blue" />
        <StatCard
          label="Live contacts"
          value={totals.contacts}
          icon={MessageCircle}
          tone="indigo"
          progress={totals.connectRate ?? undefined}
          subtitle={
            totals.connectRate != null ? `${totals.connectRate}% connect` : undefined
          }
        />
        <StatCard
          label="Appts generated"
          value={totals.appts}
          icon={CalendarCheck}
          tone="green"
          progress={totals.bookingRate ?? undefined}
          subtitle={
            totals.bookingRate != null ? `${totals.bookingRate}% booking` : undefined
          }
        />
        <StatCard
          label="Callbacks"
          value={totals.callbacks}
          icon={ClipboardList}
          tone="blue"
        />
        <StatCard
          label="With issues"
          value={totals.withIssues}
          icon={TriangleAlert}
          tone={totals.withIssues > 0 ? 'amber' : 'zinc'}
        />
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Agent</label>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="all">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || a.email}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">From</label>
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">To</label>
            <input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950">
            <input
              type="checkbox"
              checked={issuesOnly}
              onChange={(e) => setIssuesOnly(e.target.checked)}
              className="h-3.5 w-3.5 rounded accent-amber-500"
            />
            <Filter className="h-3.5 w-3.5 text-amber-500" />
            Issues only
          </label>
          {!filterCleared && (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-md px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={exportCsv}
            disabled={reports.length === 0}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {reportsQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <ClipboardList className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-500">
            No EOD reports in this window.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/50">
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  <th className="w-6 px-2 py-2.5"></th>
                  <th className="w-6 px-1 py-2.5"></th>
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Agent</th>
                  <th className="px-3 py-2.5 text-right">Dials</th>
                  <th className="px-3 py-2.5 text-right">Contacts</th>
                  <th className="px-3 py-2.5 text-right">Appts</th>
                  <th className="px-3 py-2.5 text-right">Callbacks</th>
                  <th className="px-3 py-2.5">Issues</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {reports.map((r) => {
                  const isExpanded = expandedId === r.id
                  const hasIssues =
                    r.technicalIssueTags.length > 0 ||
                    !!r.technicalIssueNotes ||
                    !!r.organizationalIssues
                  const d = new Date(r.reportDate)
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className={cn(
                          'align-top transition-colors',
                          isExpanded
                            ? 'bg-blue-50/50 dark:bg-blue-950/20'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                        )}
                      >
                        <td className="px-2 py-2.5 align-middle">
                          {hasIssues && (
                            <TriangleAlert
                              className="h-3.5 w-3.5 text-amber-500"
                              aria-label="Issues flagged"
                            />
                          )}
                        </td>
                        <td className="px-1 py-2.5 align-middle">
                          <button
                            onClick={() =>
                              setExpandedId(isExpanded ? null : r.id)
                            }
                            title={isExpanded ? 'Collapse' : 'Show full report'}
                            className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <div className="font-medium">
                            {d.toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              timeZone: 'UTC',
                            })}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            {d.toLocaleDateString('en-US', {
                              weekday: 'short',
                              timeZone: 'UTC',
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Link
                            href={`/call-center/agents/${r.agent.id}`}
                            className="font-medium text-zinc-700 hover:text-blue-600 hover:underline dark:text-zinc-200"
                          >
                            {r.agent.name || '(unnamed)'}
                          </Link>
                          <div className="truncate text-[10px] text-zinc-400">
                            {r.agent.email}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                          {r.dialsMade}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                          {r.contactsReached}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                          {r.appointmentsGenerated}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                          {r.callbacksScheduled}
                        </td>
                        <td className="px-3 py-2.5">
                          {r.technicalIssueTags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {r.technicalIssueTags.slice(0, 3).map((t) => (
                                <span
                                  key={t}
                                  className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                                >
                                  {labelForTag(t)}
                                </span>
                              ))}
                              {r.technicalIssueTags.length > 3 && (
                                <span className="text-[10px] text-zinc-400">
                                  +{r.technicalIssueTags.length - 3}
                                </span>
                              )}
                            </div>
                          ) : r.organizationalIssues ? (
                            <span className="text-[10px] text-zinc-500">
                              Process issue
                            </span>
                          ) : (
                            <span className="text-zinc-300">—</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-blue-50/30 dark:bg-blue-950/10">
                          <td
                            colSpan={9}
                            className="border-t border-blue-200/50 px-6 py-4 dark:border-blue-900/50"
                          >
                            <ReportDetail report={r} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ReportDetail({ report }: { report: EodReport }) {
  return (
    <div className="grid gap-x-8 gap-y-4 text-xs md:grid-cols-2">
      {report.technicalIssueTags.length > 0 && (
        <div className="md:col-span-2">
          <DetailHeader>Technical issues</DetailHeader>
          <div className="flex flex-wrap gap-1.5">
            {report.technicalIssueTags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              >
                {labelForTag(t)}
              </span>
            ))}
          </div>
        </div>
      )}
      {report.technicalIssueNotes && (
        <div>
          <DetailHeader>Technical notes</DetailHeader>
          <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">
            {report.technicalIssueNotes}
          </p>
        </div>
      )}
      {report.organizationalIssues && (
        <div>
          <DetailHeader>Organizational / process</DetailHeader>
          <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">
            {report.organizationalIssues}
          </p>
        </div>
      )}
      {report.wins && (
        <div>
          <DetailHeader>Wins</DetailHeader>
          <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">
            {report.wins}
          </p>
        </div>
      )}
      {report.tomorrowFocus && (
        <div>
          <DetailHeader>Tomorrow focus</DetailHeader>
          <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">
            {report.tomorrowFocus}
          </p>
        </div>
      )}
      <div className="md:col-span-2 text-[10px] text-zinc-400">
        Submitted {new Date(report.createdAt).toLocaleString('en-US')}
      </div>
    </div>
  )
}

function DetailHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
      {children}
    </div>
  )
}
