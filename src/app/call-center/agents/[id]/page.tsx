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
  /** Which Genisys client this appointment is booked for. Null on
   *  legacy rows that pre-date the Client feature or rows whose
   *  routing was ambiguous at create time. */
  client: { id: string; name: string; state: string | null; color: string } | null
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
  booked: 'bg-primary-soft text-primary bg-primary-soft text-primary',
  rescheduled: 'bg-warning/15 text-warning bg-warning/15 text-warning',
  showed: 'bg-success/15 text-success bg-success/15 text-success',
  no_show: 'bg-destructive/10 text-destructive bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-foreground/85 bg-surface-muted text-foreground/85',
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
      // Sort by createdAt (when the agent typed it into the CRM) instead
      // of by apptDateTime. Mary's most-recent log work surfaces at the
      // top here so admin can spot "what did she just book?" at a glance.
      // Scoped to this view — the general /call-center page keeps the
      // default apptDateTime sort.
      sp.set('sort', 'createdAt')
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
      'Client',
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
        a.client?.name || '',
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
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Link
          href="/call-center/agents"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Agents
        </Link>
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
          Agent not found.
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl space-y-6">
      <Link
        href="/call-center/agents"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Agents
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-lg font-bold text-primary bg-primary-soft text-primary">
            {(agent.name || agent.email).charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              {agent.name || '(unnamed)'}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50 border-border bg-card text-foreground/85 hover:bg-muted"
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
      <section className="rounded-xl border border-border bg-card p-5 border-border bg-card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Activity</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bookings logged per day over the last {days} days
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-success/15 px-3 py-1.5 text-sm bg-success/15">
              <span className="font-semibold text-success">
                ${metrics.pipeline.toLocaleString()}
              </span>
              <span className="ml-1.5 text-xs text-green-700/80 dark:text-green-400/80">
                active pipeline
              </span>
            </div>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-md border border-border bg-card px-2 py-1.5 text-xs border-border bg-card"
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
            {['all', 'booked', 'rescheduled', 'showed', 'won', 'lost', 'no_show', 'cancelled'].map(
              (s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={cn(
                    'flex-shrink-0 rounded-md border px-3 py-1 text-xs font-medium transition-colors',
                    status === s
                      ? 'border-primary bg-foreground text-background'
                      : 'border-border bg-card text-muted-foreground hover:bg-muted border-border bg-card text-foreground/85 hover:bg-muted'
                  )}
                >
                  {s === 'all' ? 'All' : s.replace('_', '-')}
                </button>
              )
            )}
          </div>
        </div>
        {appointments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground border-border">
            No appointments match.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-border bg-surface-muted border-border bg-background/50">
                  <tr className="text-left eyebrow text-muted-foreground">
                    <th className="px-3 py-2.5">Logged</th>
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
                <tbody className="divide-y divide-border-soft">
                  {appointments.map((a) => {
                    const when = new Date(a.apptDateTime)
                    const logged = new Date(a.createdAt)
                    return (
                      <tr
                        key={a.id}
                        className="align-top hover:bg-muted hover:bg-muted/40"
                      >
                        <td
                          className="whitespace-nowrap px-3 py-2.5 text-muted-foreground text-foreground/85"
                          title={`Logged ${logged.toLocaleString()}`}
                        >
                          <div className="font-medium">
                            {logged.toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </div>
                          <div className="text-[10px] text-muted-foreground/70">
                            {loggedRelative(logged)}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground text-foreground/85">
                          <div className="font-medium">
                            {when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </div>
                          <div className="text-[10px] text-muted-foreground/70">
                            {when.toLocaleTimeString('en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                              hour12: true,
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-medium">
                          <div>{a.customerName}</div>
                          {a.client ? (
                            <span
                              className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground bg-surface-muted text-foreground/85"
                              title={
                                a.client.state
                                  ? `Booked for ${a.client.name} (${a.client.state})`
                                  : `Booked for ${a.client.name}`
                              }
                            >
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: a.client.color }}
                                aria-hidden
                              />
                              {a.client.name}
                            </span>
                          ) : (
                            <span
                              className="mt-0.5 inline-block text-[10px] text-muted-foreground/70"
                              title="No client linked to this booking — usually a pre-Client-feature row or one whose routing was ambiguous."
                            >
                              no client
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px]">
                          {a.customerPhone}
                        </td>
                        <td
                          className="max-w-[220px] truncate px-3 py-2.5 text-muted-foreground"
                          title={a.address || ''}
                        >
                          {a.address || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {a.utilityProvider || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {a.monthlyBill ? `$${a.monthlyBill}` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {a.estimatedDealValue ? `$${a.estimatedDealValue}` : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={cn(
                              'rounded-md px-2 py-0.5 text-[10px] font-semibold',
                              STATUS_TONE[a.status] || 'bg-muted text-foreground/85'
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
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Play
                            </a>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
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

/** Compact "when was this typed into the CRM" label for the Logged
 *  column. Mirrors the relativeDays helper on the overview page but
 *  drops to hour resolution for sub-day differences since Mary often
 *  enters several bookings per shift and "2h ago" reads more useful
 *  than just "today". Full timestamp lives on the cell's title attr. */
function loggedRelative(logged: Date): string {
  const diffMs = Date.now() - logged.getTime()
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return logged.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
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
      ? 'text-success'
      : tone === 'warn'
        ? 'text-warning'
        : tone === 'bad'
          ? 'text-destructive'
          : ''
  return (
    <div className="rounded-xl border border-border bg-card p-4 border-border bg-card">
      <div className="flex items-center justify-between">
        <p className="eyebrow text-muted-foreground">
          {label}
        </p>
        <Icon className="h-4 w-4 text-muted-foreground/50" />
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
                  ? 'bg-primary group-hover:bg-primary/90'
                  : 'bg-surface-muted'
              )}
            />
            {(isFirst || isLast || isMonthBoundary) && (
              <span className="absolute -bottom-5 whitespace-nowrap text-[9px] text-muted-foreground/70">
                {b.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
            {b.count > 0 && (
              <span className="pointer-events-none absolute -top-6 rounded bg-foreground px-1.5 py-0.5 text-[10px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 bg-muted text-background">
                {b.count}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
