'use client'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  PhoneCall,
  PhoneForwarded,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Search,
  Download,
  CalendarClock,
  User as UserIcon,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CallCenterTabs } from '@/components/call-center/call-center-tabs'

type Callback = {
  id: string
  customerName: string
  customerPhone: string
  callbackAt: string
  notes: string | null
  completedAt: string | null
  outcome: string | null
  createdAt: string
  agent: { id: string; name: string | null; email: string }
}

type AgentSummary = {
  id: string
  name: string | null
  email: string
}

type Bucket = 'all' | 'pending' | 'overdue' | 'due_today' | 'upcoming' | 'completed'

const BUCKETS: Array<{ value: Bucket; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'due_today', label: 'Due today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
]

function csvEscape(v: string): string {
  if (v == null) return ''
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export default function CallbacksReviewPage() {
  const [bucket, setBucket] = useState<Bucket>('pending')
  const [agent, setAgent] = useState('all')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const agentsQuery = useQuery<{ agents: AgentSummary[] }>({
    queryKey: ['call-center-agents'],
    queryFn: async () => {
      const res = await fetch('/api/call-center/agents')
      if (!res.ok) throw new Error('Failed to load agents')
      return res.json()
    },
  })

  const callbacksQuery = useQuery<{ callbacks: Callback[] }>({
    queryKey: ['call-center-callbacks', bucket, agent, submittedSearch],
    queryFn: async () => {
      const params = new URLSearchParams()
      params.set('bucket', bucket)
      if (agent !== 'all') params.set('agent', agent)
      if (submittedSearch) params.set('q', submittedSearch)
      const res = await fetch(`/api/call-center/callbacks?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to load callbacks')
      return res.json()
    },
  })

  const agents = useMemo(
    () => agentsQuery.data?.agents ?? [],
    [agentsQuery.data]
  )
  const callbacks = useMemo(
    () => callbacksQuery.data?.callbacks ?? [],
    [callbacksQuery.data]
  )

  // ---------------------------------------------------------------------
  // Top stats (always reflect the filtered dataset so the numbers match
  // what's in the table below).
  // ---------------------------------------------------------------------
  const stats = useMemo(() => {
    const now = new Date()
    let pending = 0
    let overdue = 0
    let dueToday = 0
    let completed = 0
    for (const c of callbacks) {
      if (c.completedAt) {
        completed++
      } else {
        pending++
        const when = new Date(c.callbackAt)
        if (when < now) overdue++
        else if (isSameDay(when, now)) dueToday++
      }
    }
    return { pending, overdue, dueToday, completed, total: callbacks.length }
  }, [callbacks])

  // ---------------------------------------------------------------------
  // Per-agent rollup — click a card to filter the table.
  // ---------------------------------------------------------------------
  type AgentMetrics = {
    id: string
    name: string | null
    email: string
    pending: number
    overdue: number
    dueToday: number
    completed: number
    lastActivity: string | null
  }
  const agentMetrics = useMemo<AgentMetrics[]>(() => {
    const now = new Date()
    const byAgent = new Map<string, AgentMetrics>()
    // Seed every approved agent so those with zero show up in the grid too.
    for (const a of agents) {
      byAgent.set(a.id, {
        id: a.id,
        name: a.name,
        email: a.email,
        pending: 0,
        overdue: 0,
        dueToday: 0,
        completed: 0,
        lastActivity: null,
      })
    }
    for (const c of callbacks) {
      const m = byAgent.get(c.agent.id)
      // Skip callbacks whose "agent" isn't in the approved-agent list
      // (e.g. staff testing via /agent) so they don't pollute the cards.
      if (!m) continue
      if (c.completedAt) {
        m.completed++
      } else {
        m.pending++
        const when = new Date(c.callbackAt)
        if (when < now) m.overdue++
        else if (isSameDay(when, now)) m.dueToday++
      }
      const latest = c.completedAt || c.createdAt
      if (!m.lastActivity || new Date(latest) > new Date(m.lastActivity)) {
        m.lastActivity = latest
      }
    }
    return Array.from(byAgent.values()).sort((a, b) => {
      // Sort: overdue first, then pending, then name
      if (a.overdue !== b.overdue) return b.overdue - a.overdue
      if (a.pending !== b.pending) return b.pending - a.pending
      return (a.name || a.email).localeCompare(b.name || b.email)
    })
  }, [agents, callbacks])

  function exportCsv() {
    const headers = [
      'Callback Date',
      'Callback Time',
      'Agent',
      'Email',
      'Customer',
      'Phone',
      'Notes',
      'Status',
      'Outcome',
      'Completed At',
      'Created At',
    ]
    const rows = callbacks.map((c) => {
      const when = new Date(c.callbackAt)
      return [
        when.toLocaleDateString('en-US'),
        when.toLocaleTimeString('en-US', { hour12: true }),
        c.agent.name || '',
        c.agent.email,
        c.customerName,
        c.customerPhone,
        c.notes || '',
        c.completedAt ? 'Completed' : new Date(c.callbackAt) < new Date() ? 'Overdue' : 'Pending',
        c.outcome || '',
        c.completedAt ? new Date(c.completedAt).toLocaleString('en-US') : '',
        new Date(c.createdAt).toLocaleString('en-US'),
      ]
    })
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => csvEscape(String(v))).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `genisys-callbacks-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
            <PhoneCall className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Call Center</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Every agent&apos;s callback list — follow-ups they&apos;ve logged to work later.
              Separate from appointments; use this to see each agent&apos;s pipeline.
            </p>
          </div>
        </div>
      </div>

      <CallCenterTabs />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Pending"
          value={stats.pending}
          icon={PhoneForwarded}
          tone={stats.pending > 0 ? 'purple' : 'zinc'}
        />
        <StatCard
          label="Overdue"
          value={stats.overdue}
          icon={AlertTriangle}
          tone={stats.overdue > 0 ? 'red' : 'zinc'}
        />
        <StatCard
          label="Due today"
          value={stats.dueToday}
          icon={Clock}
          tone={stats.dueToday > 0 ? 'amber' : 'zinc'}
        />
        <StatCard
          label="Completed"
          value={stats.completed}
          icon={CheckCircle2}
          tone="zinc"
        />
      </div>

      {/* Per-agent summary */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Agents ({agentMetrics.length})</h3>
          {agent !== 'all' && (
            <button
              onClick={() => setAgent('all')}
              className="text-xs text-purple-600 hover:underline"
            >
              Clear agent filter
            </button>
          )}
        </div>
        {agentMetrics.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800">
            No approved agents yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agentMetrics.map((m) => (
              <AgentCard
                key={m.id}
                metrics={m}
                active={agent === m.id}
                onClick={() => setAgent(m.id === agent ? 'all' : m.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Filter bar */}
      <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-1 border-b border-zinc-100 pb-3 dark:border-zinc-800">
          {BUCKETS.map((b) => {
            const active = bucket === b.value
            return (
              <button
                key={b.value}
                onClick={() => setBucket(b.value)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'bg-purple-600 text-white'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                )}
              >
                {b.label}
              </button>
            )
          })}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedSearch(search.trim())
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="relative min-w-[220px] flex-1">
            <label className="mb-1 block text-xs font-medium text-zinc-500">Search</label>
            <Search className="pointer-events-none absolute left-3 top-[30px] h-4 w-4 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, phone, notes…"
              className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
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
          <button
            type="submit"
            className="rounded-md bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={callbacks.length === 0}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </form>
      </div>

      {callbacksQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
        </div>
      ) : callbacks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <PhoneForwarded className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-500">
            No callbacks in this bucket.
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
                  <th className="px-3 py-2.5">Call back</th>
                  <th className="px-3 py-2.5">Agent</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Phone</th>
                  <th className="px-3 py-2.5">Notes</th>
                  <th className="px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {callbacks.map((c) => {
                  const when = new Date(c.callbackAt)
                  const now = new Date()
                  const done = !!c.completedAt
                  const isOverdue = !done && when < now
                  const isDueToday = !done && isSameDay(when, now)
                  const isExpanded = expandedId === c.id
                  return (
                    <Fragment key={c.id}>
                      <tr
                        className={cn(
                          'align-top transition-colors',
                          isExpanded
                            ? 'bg-purple-50/50 dark:bg-purple-950/20'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                        )}
                      >
                        <td className="px-2 py-2.5 align-middle">
                          {isOverdue && (
                            <AlertTriangle
                              className="h-3.5 w-3.5 text-red-500"
                              aria-label="Overdue"
                            />
                          )}
                          {isDueToday && (
                            <Clock
                              className="h-3.5 w-3.5 text-amber-500"
                              aria-label="Due today"
                            />
                          )}
                          {done && (
                            <CheckCircle2
                              className="h-3.5 w-3.5 text-green-500"
                              aria-label="Completed"
                            />
                          )}
                        </td>
                        <td className="px-1 py-2.5 align-middle">
                          <button
                            onClick={() =>
                              setExpandedId(isExpanded ? null : c.id)
                            }
                            title={isExpanded ? 'Collapse' : 'Show details'}
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
                            {when.toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            {when.toLocaleTimeString('en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                              hour12: true,
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Link
                            href={`/call-center/agents/${c.agent.id}`}
                            className="font-medium text-zinc-700 hover:text-purple-600 hover:underline dark:text-zinc-200"
                          >
                            {c.agent.name || '(unnamed)'}
                          </Link>
                          <div className="truncate text-[10px] text-zinc-400">
                            {c.agent.email}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-medium">{c.customerName}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px]">
                          {c.customerPhone}
                        </td>
                        <td
                          className="max-w-[260px] truncate px-3 py-2.5 text-zinc-500"
                          title={c.notes || ''}
                        >
                          {c.notes || '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusPill
                            done={done}
                            isOverdue={isOverdue}
                            isDueToday={isDueToday}
                          />
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-purple-50/30 dark:bg-purple-950/10">
                          <td
                            colSpan={8}
                            className="border-t border-purple-200/50 px-6 py-4 dark:border-purple-900/50"
                          >
                            <CallbackDetail callback={c} />
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

// ---- Subcomponents ------------------------------------------------------

function StatusPill({
  done,
  isOverdue,
  isDueToday,
}: {
  done: boolean
  isOverdue: boolean
  isDueToday: boolean
}) {
  if (done) {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700 dark:bg-green-950 dark:text-green-300">
        Completed
      </span>
    )
  }
  if (isOverdue) {
    return (
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">
        Overdue
      </span>
    )
  }
  if (isDueToday) {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        Due today
      </span>
    )
  }
  return (
    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700 dark:bg-purple-950 dark:text-purple-300">
      Upcoming
    </span>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  icon: React.ComponentType<{ className?: string }>
  tone: 'purple' | 'red' | 'amber' | 'zinc'
}) {
  const toneMap = {
    purple: {
      bg: 'bg-purple-50 dark:bg-purple-950/40',
      iconColor: 'text-purple-600',
      valueColor: 'text-purple-900 dark:text-purple-200',
    },
    red: {
      bg: 'bg-red-50 dark:bg-red-950/40',
      iconColor: 'text-red-600',
      valueColor: 'text-red-900 dark:text-red-200',
    },
    amber: {
      bg: 'bg-amber-50 dark:bg-amber-950/40',
      iconColor: 'text-amber-600',
      valueColor: 'text-amber-900 dark:text-amber-200',
    },
    zinc: {
      bg: 'bg-white dark:bg-zinc-900',
      iconColor: 'text-zinc-400',
      valueColor: 'text-zinc-700 dark:text-zinc-200',
    },
  }[tone]
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800',
        toneMap.bg
      )}
    >
      <Icon className={cn('h-5 w-5 flex-shrink-0', toneMap.iconColor)} />
      <div className="min-w-0">
        <p className={cn('text-2xl font-bold tabular-nums', toneMap.valueColor)}>
          {value}
        </p>
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {label}
        </p>
      </div>
    </div>
  )
}

type AgentMetrics = {
  id: string
  name: string | null
  email: string
  pending: number
  overdue: number
  dueToday: number
  completed: number
  lastActivity: string | null
}

function AgentCard({
  metrics,
  active,
  onClick,
}: {
  metrics: AgentMetrics
  active: boolean
  onClick: () => void
}) {
  return (
    <div
      className={cn(
        'group flex flex-col gap-3 rounded-xl border bg-white p-4 transition-all dark:bg-zinc-900',
        active
          ? 'border-purple-500 shadow-[0_0_0_1px_rgb(168_85_247)] dark:border-purple-400'
          : metrics.overdue > 0
            ? 'border-red-200 dark:border-red-900'
            : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={`/call-center/agents/${metrics.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block font-semibold hover:text-purple-600 hover:underline"
          >
            {metrics.name || '(unnamed)'}
          </Link>
          <p className="truncate text-xs text-zinc-500">{metrics.email}</p>
        </div>
        <button
          onClick={onClick}
          title={active ? 'Remove filter' : 'Filter table to this agent'}
          className={cn(
            'flex-shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors',
            active
              ? 'border-purple-600 bg-purple-600 text-white'
              : 'border-zinc-200 text-zinc-500 group-hover:border-purple-400 group-hover:text-purple-600 dark:border-zinc-800'
          )}
        >
          {active ? 'Filtered' : 'Filter'}
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <MiniStat label="Pending" value={metrics.pending} />
        <MiniStat
          label="Overdue"
          value={metrics.overdue}
          tone={metrics.overdue > 0 ? 'bad' : undefined}
        />
        <MiniStat
          label="Today"
          value={metrics.dueToday}
          tone={metrics.dueToday > 0 ? 'warn' : undefined}
        />
        <MiniStat label="Done" value={metrics.completed} />
      </div>

      {metrics.lastActivity && (
        <p className="text-[10px] text-zinc-400">
          Last activity {timeAgo(metrics.lastActivity)}
        </p>
      )}
    </div>
  )
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-green-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'bad'
          ? 'text-red-600'
          : 'text-zinc-900 dark:text-zinc-100'
  return (
    <div className="min-w-0 rounded-md bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/50">
      <p className="truncate text-[9px] font-medium uppercase tracking-wide text-zinc-400">
        {label}
      </p>
      <p className={cn('truncate text-sm font-bold tabular-nums', toneClass)}>
        {value}
      </p>
    </div>
  )
}

function CallbackDetail({ callback }: { callback: Callback }) {
  const created = new Date(callback.createdAt)
  const completed = callback.completedAt ? new Date(callback.completedAt) : null
  return (
    <div className="grid gap-x-8 gap-y-3 text-xs md:grid-cols-2">
      <DetailItem icon={UserIcon} label="Customer">
        <div className="font-medium text-zinc-800 dark:text-zinc-100">
          {callback.customerName}
        </div>
        <div className="font-mono text-zinc-500">{callback.customerPhone}</div>
      </DetailItem>

      <DetailItem icon={PhoneCall} label="Agent">
        <Link
          href={`/call-center/agents/${callback.agent.id}`}
          className="font-medium text-zinc-800 hover:text-purple-600 hover:underline dark:text-zinc-100"
        >
          {callback.agent.name || '(unnamed)'}
        </Link>
        <div className="text-zinc-500">{callback.agent.email}</div>
      </DetailItem>

      <DetailItem icon={CalendarClock} label="Timeline">
        <div>
          <span className="text-zinc-400">Logged:</span>{' '}
          <span className="text-zinc-800 dark:text-zinc-100">
            {created.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
        </div>
        <div>
          <span className="text-zinc-400">Call back on:</span>{' '}
          <span className="text-zinc-800 dark:text-zinc-100">
            {new Date(callback.callbackAt).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
        </div>
        {completed && (
          <div>
            <span className="text-zinc-400">Completed:</span>{' '}
            <span className="text-zinc-800 dark:text-zinc-100">
              {completed.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })}
            </span>
            {callback.outcome && (
              <span className="text-zinc-500"> · {callback.outcome}</span>
            )}
          </div>
        )}
      </DetailItem>

      {callback.notes && (
        <DetailItem icon={FileText} label="Notes">
          <div className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">
            {callback.notes}
          </div>
        </DetailItem>
      )}
    </div>
  )
}

function DetailItem({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="space-y-0.5 text-zinc-700 dark:text-zinc-300">{children}</div>
    </div>
  )
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffMs = now - then
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
