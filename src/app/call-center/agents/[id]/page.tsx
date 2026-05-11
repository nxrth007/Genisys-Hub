'use client'

import { use, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Calendar,
  Headphones,
  Download,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Appointment = {
  id: string
  apptDateTime: string
  customerName: string
  customerPhone: string
  address: string | null
  email: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
  status: string
  estimatedDealValue: string | null
  notes: string | null
  callRecordingLink: string | null
  createdAt: string
  agent: { id: string; name: string | null; email: string }
}

type AgentSummary = {
  id: string
  name: string | null
  email: string
  approvedAt: string | null
  agentSheetTab: string | null
  _count: { appointments: number }
}

const STATUS_TONE: Record<string, string> = {
  booked: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  rescheduled: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  showed: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  no_show: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  cancelled: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
}

function parseMoney(raw: string | null): number {
  if (!raw) return 0
  const n = Number(raw.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export default function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [status, setStatus] = useState('all')
  const [days, setDays] = useState(30)

  const agentsQuery = useQuery<{ agents: AgentSummary[] }>({
    queryKey: ['call-center-agents'],
    queryFn: async () => {
      const res = await fetch('/api/call-center/agents')
      if (!res.ok) throw new Error('Failed to load agent')
      return res.json()
    },
  })

  const apptsQuery = useQuery<{ appointments: Appointment[] }>({
    queryKey: ['call-center-agent-appts', id, status],
    queryFn: async () => {
      const sp = new URLSearchParams({ agent: id })
      if (status !== 'all') sp.set('status', status)
      const res = await fetch(`/api/call-center/appointments?${sp.toString()}`)
      if (!res.ok) throw new Error('Failed to load appointments')
      return res.json()
    },
  })

  const agent = agentsQuery.data?.agents.find((a) => a.id === id)
  const appointments = useMemo(
    () => apptsQuery.data?.appointments ?? [],
    [apptsQuery.data]
  )

  const metrics = useMemo(() => {
    let showed = 0
    let noShow = 0
    let booked = 0
    let pipeline = 0
    for (const a of appointments) {
      // Won/lost are outcomes of a "sat down" appointment — count
      // them in showed so closing more deals doesn't lower this
      // agent's show rate.
      if (
        a.status === 'showed' ||
        a.status === 'won' ||
        a.status === 'lost'
      ) {
        showed++
      }
      if (a.status === 'no_show') noShow++
      if (a.status === 'booked') booked++
      // Pipeline = open deals only. Exclude already-resolved states
      // (cancelled, no_show, won, lost).
      if (
        a.status === 'booked' ||
        a.status === 'rescheduled' ||
        a.status === 'showed'
      ) {
        pipeline += parseMoney(a.estimatedDealValue)
      }
    }
    const completed = showed + noShow
    const showRate = completed > 0 ? Math.round((showed / completed) * 100) : null
    return {
      total: appointments.length,
      showed,
      noShow,
      booked,
      pipeline,
      showRate,
    }
  }, [appointments])

  // Daily bookings for the selected window (oldest → newest).
  const trend = useMemo(() => {
    const today = startOfToday()
    const buckets = Array.from({ length: days }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() - (days - 1 - i))
      return { date: d, count: 0 }
    })
    for (const a of appointments) {
      const created = startOfDay(new Date(a.createdAt))
      for (const b of buckets) {
        if (isSameDay(created, b.date)) {
          b.count++
          break
        }
      }
    }
    return buckets
  }, [appointments, days])

  function exportCsv() {
    if (!agent) return
    const headers = [
      'Appt Date',
      'Appt Time',
      'Customer Name',
      'Phone',
      'Address',
      'Email',
      'Monthly Bill',
      'Utility Provider',
      'Roof Type',
      'Roof Age',
      'Status',
      'Estimated Deal Value',
      'Notes',
      'Call Recording Link',
      'Logged At',
    ]
    const rows = appointments.map((a) => {
      const d = new Date(a.apptDateTime)
      const logged = new Date(a.createdAt)
      return [
        d.toLocaleDateString('en-US'),
        d.toLocaleTimeString('en-US', { hour12: true }),
        a.customerName,
        a.customerPhone,
        a.address || '',
        a.email || '',
        a.monthlyBill || '',
        a.utilityProvider || '',
        a.roofType || '',
        a.roofAge || '',
        a.status,
        a.estimatedDealValue || '',
        a.notes || '',
        a.callRecordingLink || '',
        logged.toLocaleString('en-US'),
      ]
    })
    const csv = [headers, ...rows]
      .map((row) =>
        row
          .map((cell) => {
            const s = String(cell)
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
          })
          .join(',')
      )
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().slice(0, 10)
    const slug = (agent.name || agent.email).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    a.download = `genisys-${slug}-${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (agentsQuery.isLoading || apptsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Link
          href="/call-center"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Call Center
        </Link>
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Agent not found.
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl space-y-6">
      <Link
        href="/call-center"
        className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Call Center
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 text-lg font-bold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {(agent.name || agent.email).charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              {agent.name || '(unnamed)'}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>{agent.email}</span>
              {agent.approvedAt && (
                <>
                  <span>·</span>
                  <span>
                    Approved {new Date(agent.approvedAt).toLocaleDateString()}
                  </span>
                </>
              )}
              {agent.agentSheetTab && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1">
                    <Headphones className="h-3 w-3" />
                    Sheet tab: {agent.agentSheetTab}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={exportCsv}
          disabled={appointments.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      {/* METRIC CARDS */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Calendar} label="Total bookings" value={metrics.total} />
        <StatCard
          icon={CheckCircle2}
          label="Show rate"
          value={metrics.showRate != null ? `${metrics.showRate}%` : '—'}
          tone={
            metrics.showRate != null
              ? metrics.showRate >= 70
                ? 'good'
                : metrics.showRate >= 40
                  ? 'warn'
                  : 'bad'
              : undefined
          }
        />
        <StatCard icon={Clock} label="Active" value={metrics.booked} />
        <StatCard
          icon={XCircle}
          label="No-shows"
          value={metrics.noShow}
          tone={metrics.noShow > 0 ? 'warn' : undefined}
        />
      </div>

      {/* PIPELINE $ + TREND CHART */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Activity</h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              Bookings logged per day over the last {days} days
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-green-50 px-3 py-1.5 text-sm dark:bg-green-950/40">
              <span className="font-semibold text-green-800 dark:text-green-300">
                ${metrics.pipeline.toLocaleString()}
              </span>
              <span className="ml-1.5 text-xs text-green-700/80 dark:text-green-400/80">
                active pipeline
              </span>
            </div>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
        </div>
        <TrendChart buckets={trend} />
      </section>

      {/* APPOINTMENT LIST WITH STATUS FILTER */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Appointments ({appointments.length})
          </h3>
          <div className="flex items-center gap-1 overflow-x-auto">
            {['all', 'booked', 'rescheduled', 'showed', 'no_show', 'cancelled'].map(
              (s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={cn(
                    'flex-shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    status === s
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
                  )}
                >
                  {s === 'all' ? 'All' : s.replace('_', '-')}
                </button>
              )
            )}
          </div>
        </div>
        {appointments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center text-sm text-zinc-500 dark:border-zinc-800">
            No appointments match.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/50">
                  <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    <th className="px-3 py-2.5">Appt</th>
                    <th className="px-3 py-2.5">Customer</th>
                    <th className="px-3 py-2.5">Phone</th>
                    <th className="px-3 py-2.5">Address</th>
                    <th className="px-3 py-2.5">Utility</th>
                    <th className="px-3 py-2.5">Bill</th>
                    <th className="px-3 py-2.5">Deal $</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Rec</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {appointments.map((a) => {
                    const when = new Date(a.apptDateTime)
                    return (
                      <tr
                        key={a.id}
                        className="align-top hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                      >
                        <td className="whitespace-nowrap px-3 py-2.5 text-zinc-600 dark:text-zinc-300">
                          <div className="font-medium">
                            {when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            {when.toLocaleTimeString('en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                              hour12: true,
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-medium">{a.customerName}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px]">
                          {a.customerPhone}
                        </td>
                        <td
                          className="max-w-[220px] truncate px-3 py-2.5 text-zinc-500"
                          title={a.address || ''}
                        >
                          {a.address || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-zinc-500">
                          {a.utilityProvider || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-zinc-500">
                          {a.monthlyBill ? `$${a.monthlyBill}` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-zinc-500">
                          {a.estimatedDealValue ? `$${a.estimatedDealValue}` : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                              STATUS_TONE[a.status] || 'bg-zinc-100 text-zinc-700'
                            )}
                          >
                            {a.status}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          {a.callRecordingLink ? (
                            <a
                              href={a.callRecordingLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={a.callRecordingLink}
                              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Play
                            </a>
                          ) : (
                            <span className="text-zinc-300">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

// ---- Subcomponents ------------------------------------------------------

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number
  tone?: 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-green-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'bad'
          ? 'text-red-600'
          : ''
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {label}
        </p>
        <Icon className="h-4 w-4 text-zinc-300" />
      </div>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', toneClass)}>
        {value}
      </p>
    </div>
  )
}

function TrendChart({ buckets }: { buckets: Array<{ date: Date; count: number }> }) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const height = 80
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {buckets.map((b, i) => {
        const h = b.count === 0 ? 2 : Math.max(4, (b.count / max) * height)
        const isFirst = i === 0
        const isLast = i === buckets.length - 1
        const isMonthBoundary = b.date.getDate() === 1
        return (
          <div
            key={i}
            className="group relative flex flex-1 flex-col items-center justify-end"
            title={`${b.date.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}: ${b.count} booking${b.count === 1 ? '' : 's'}`}
          >
            <div
              style={{ height: h }}
              className={cn(
                'w-full rounded-t transition-all',
                b.count > 0
                  ? 'bg-blue-500 group-hover:bg-blue-600'
                  : 'bg-zinc-100 dark:bg-zinc-800'
              )}
            />
            {(isFirst || isLast || isMonthBoundary) && (
              <span className="absolute -bottom-5 whitespace-nowrap text-[9px] text-zinc-400">
                {b.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
            {b.count > 0 && (
              <span className="pointer-events-none absolute -top-6 rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 dark:bg-zinc-100 dark:text-zinc-900">
                {b.count}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
