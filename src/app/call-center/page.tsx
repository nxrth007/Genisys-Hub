'use client'

import { Fragment, useState, useMemo, useEffect } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PhoneCall,
  Search,
  ExternalLink,
  Loader2,
  AlertCircle,
  Download,
  TrendingUp,
  DollarSign,
  Clock,
  CalendarClock,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Mail,
  MapPin,
  User as UserIcon,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CallCenterTabs } from '@/components/call-center/call-center-tabs'

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
  lastSyncedAt: string | null
  syncError: string | null
  createdAt: string
  agent: { id: string; name: string | null; email: string }
  client: { id: string; name: string; state: string | null; color: string } | null
}

type Client = {
  id: string
  name: string
  state: string | null
  color: string
}

type AgentSummary = {
  id: string
  name: string | null
  email: string
  approvedAt: string | null
  agentSheetTab: string | null
  _count: { appointments: number }
}

const STATUSES = [
  { value: 'all', label: 'All statuses' },
  { value: 'booked', label: 'Booked' },
  { value: 'rescheduled', label: 'Rescheduled' },
  { value: 'showed', label: 'Showed' },
  { value: 'no_show', label: 'No-show' },
  { value: 'cancelled', label: 'Cancelled' },
]

const STATUS_TONE: Record<string, string> = {
  booked: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  rescheduled: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  showed: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  no_show: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  cancelled: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
}

// Funnel layout from left (earliest in lifecycle) to right (terminal states).
const FUNNEL_ORDER: Array<{ status: string; label: string; barColor: string }> = [
  { status: 'booked', label: 'Booked', barColor: 'bg-blue-500' },
  { status: 'rescheduled', label: 'Rescheduled', barColor: 'bg-amber-500' },
  { status: 'showed', label: 'Showed', barColor: 'bg-green-500' },
  { status: 'no_show', label: 'No-show', barColor: 'bg-red-500' },
  { status: 'cancelled', label: 'Cancelled', barColor: 'bg-zinc-400' },
]

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

function startOfToday(): Date {
  return startOfDay(new Date())
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export default function CallCenterPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('all')
  const [agent, setAgent] = useState('all')
  const [client, setClient] = useState('all')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  // Track which row is expanded (id of the appointment) so the table can
  // show a detail panel inline without navigating away.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Track which rows are mid-save so we can show a spinner on them. A Set
  // (not a single id) so two concurrent status edits don't clobber each
  // other's spinner — otherwise the first edit's spinner vanishes the
  // moment a second row is clicked.
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())

  const agentsQuery = useQuery<{ agents: AgentSummary[] }>({
    queryKey: ['call-center-agents'],
    queryFn: async () => {
      const res = await fetch('/api/call-center/agents')
      if (!res.ok) throw new Error('Failed to load agents')
      return res.json()
    },
  })

  const clientsQuery = useQuery<{ clients: Client[] }>({
    queryKey: ['clients'],
    queryFn: async () => {
      const res = await fetch('/api/clients')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
    staleTime: 60_000,
  })

  const apptsQuery = useQuery<{ appointments: Appointment[] }>({
    queryKey: ['call-center-appts', status, agent, client, submittedSearch, since, until],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (status !== 'all') params.set('status', status)
      if (agent !== 'all') params.set('agent', agent)
      if (client !== 'all') params.set('client', client)
      if (submittedSearch) params.set('q', submittedSearch)
      if (since) params.set('since', new Date(since).toISOString())
      if (until) params.set('until', new Date(until + 'T23:59:59').toISOString())
      const res = await fetch(`/api/call-center/appointments?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to load appointments')
      return res.json()
    },
  })

  const agents = useMemo(
    () => agentsQuery.data?.agents ?? [],
    [agentsQuery.data]
  )
  const clients = useMemo(
    () => clientsQuery.data?.clients ?? [],
    [clientsQuery.data]
  )
  const appointments = useMemo(
    () => apptsQuery.data?.appointments ?? [],
    [apptsQuery.data]
  )

  // Close a stale expanded row when filters hide it. Otherwise clearing
  // the filter later re-reveals the old expanded state unexpectedly.
  useEffect(() => {
    if (expandedId && !appointments.some((a) => a.id === expandedId)) {
      setExpandedId(null)
    }
  }, [appointments, expandedId])

  /** Staff edit — typically status or notes directly from the table. */
  const patchMutation = useMutation({
    mutationFn: async (params: {
      id: string
      fields: Record<string, unknown>
    }) => {
      setSavingIds((prev) => {
        const next = new Set(prev)
        next.add(params.id)
        return next
      })
      try {
        const res = await fetch(`/api/call-center/appointments/${params.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params.fields),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Update failed')
        return { ...data, id: params.id }
      } finally {
        setSavingIds((prev) => {
          const next = new Set(prev)
          next.delete(params.id)
          return next
        })
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['call-center-appts'] })
    },
  })

  // ---------------------------------------------------------------------
  // Attention cards — Today / Upcoming / Overdue
  // "Overdue" = appointment datetime is in the past but status is still
  // 'booked' (never got updated post-appointment). Most actionable signal.
  // ---------------------------------------------------------------------
  const attention = useMemo(() => {
    const now = new Date()
    const today = startOfToday()
    const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)

    let todayCount = 0
    let upcoming7 = 0
    let overdue = 0
    for (const a of appointments) {
      const d = new Date(a.apptDateTime)
      if (isSameDay(d, now)) todayCount++
      if (d >= today && d < in7Days) upcoming7++
      if (d < now && a.status === 'booked') overdue++
    }
    return { todayCount, upcoming7, overdue }
  }, [appointments])

  // ---------------------------------------------------------------------
  // Status funnel + conversion rates + total pipeline $
  // ---------------------------------------------------------------------
  const funnel = useMemo(() => {
    const byStatus: Record<string, number> = {}
    let pipelineDollars = 0
    for (const a of appointments) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1
      // Pipeline $ = sum of estimated deal value for non-cancelled/no_show
      if (a.status !== 'cancelled' && a.status !== 'no_show') {
        pipelineDollars += parseMoney(a.estimatedDealValue)
      }
    }
    const total = appointments.length
    const showed = byStatus['showed'] ?? 0
    const noShow = byStatus['no_show'] ?? 0
    const completed = showed + noShow
    const showRate = completed > 0 ? Math.round((showed / completed) * 100) : null
    return { byStatus, pipelineDollars, total, showRate }
  }, [appointments])

  // ---------------------------------------------------------------------
  // Per-agent aggregated metrics (from the currently-loaded appointments)
  // ---------------------------------------------------------------------
  type AgentMetrics = {
    id: string
    name: string | null
    email: string
    total: number
    showed: number
    noShow: number
    booked: number
    pipelineDollars: number
    lastBookingAt: string | null
    // Bookings count per day for the last 7 days (oldest → newest)
    last7Days: number[]
  }
  const agentMetrics = useMemo<AgentMetrics[]>(() => {
    const today = startOfToday()
    const last7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() - (6 - i))
      return d
    })

    const byAgent = new Map<string, AgentMetrics>()
    // Seed every approved agent so agents with zero bookings still appear.
    for (const a of agents) {
      byAgent.set(a.id, {
        id: a.id,
        name: a.name,
        email: a.email,
        total: 0,
        showed: 0,
        noShow: 0,
        booked: 0,
        pipelineDollars: 0,
        lastBookingAt: null,
        last7Days: last7.map(() => 0),
      })
    }

    for (const a of appointments) {
      let m = byAgent.get(a.agent.id)
      if (!m) {
        m = {
          id: a.agent.id,
          name: a.agent.name,
          email: a.agent.email,
          total: 0,
          showed: 0,
          noShow: 0,
          booked: 0,
          pipelineDollars: 0,
          lastBookingAt: null,
          last7Days: last7.map(() => 0),
        }
        byAgent.set(a.agent.id, m)
      }
      m.total++
      if (a.status === 'showed') m.showed++
      if (a.status === 'no_show') m.noShow++
      if (a.status === 'booked') m.booked++
      if (a.status !== 'cancelled' && a.status !== 'no_show') {
        m.pipelineDollars += parseMoney(a.estimatedDealValue)
      }
      if (
        !m.lastBookingAt ||
        new Date(a.createdAt) > new Date(m.lastBookingAt)
      ) {
        m.lastBookingAt = a.createdAt
      }
      const created = startOfDay(new Date(a.createdAt))
      for (let i = 0; i < last7.length; i++) {
        if (isSameDay(created, last7[i])) {
          m.last7Days[i]++
          break
        }
      }
    }

    return Array.from(byAgent.values()).sort((a, b) => b.total - a.total)
  }, [agents, appointments])

  const filterCleared =
    status === 'all' &&
    agent === 'all' &&
    client === 'all' &&
    !submittedSearch &&
    !since &&
    !until

  function clearFilters() {
    setSearch('')
    setSubmittedSearch('')
    setStatus('all')
    setAgent('all')
    setClient('all')
    setSince('')
    setUntil('')
  }

  function exportCsv() {
    const headers = [
      'Appt Date',
      'Appt Time',
      'Client',
      'Agent Name',
      'Agent Email',
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
        a.agent.name || '',
        a.agent.email,
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
      .map((row) => row.map((cell) => csvEscape(String(cell))).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().slice(0, 10)
    a.download = `genisys-call-center-${stamp}.csv`
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
              Live view of all agents, bookings, and fulfillment progress. Aggregations
              reflect whatever filters are applied below.
            </p>
          </div>
        </div>
      </div>

      <CallCenterTabs />

      {/* ATTENTION STRIP — what needs eyes right now */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <AttentionCard
          tone="blue"
          icon={Clock}
          label="Today"
          value={attention.todayCount}
          hint="appointments scheduled today"
        />
        <AttentionCard
          tone="purple"
          icon={CalendarClock}
          label="Next 7 days"
          value={attention.upcoming7}
          hint="upcoming bookings"
        />
        <AttentionCard
          tone={attention.overdue > 0 ? 'red' : 'zinc'}
          icon={AlertTriangle}
          label="Overdue"
          value={attention.overdue}
          hint='past date, still "booked" status'
        />
      </div>

      {/* PIPELINE $ + FUNNEL */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Fulfillment funnel</h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              {funnel.total} {funnel.total === 1 ? 'appointment' : 'appointments'} in view
              {funnel.showRate != null ? ` · ${funnel.showRate}% show rate` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg bg-green-50 px-3 py-1.5 dark:bg-green-950/40">
            <DollarSign className="h-4 w-4 text-green-600" />
            <span className="text-sm font-semibold text-green-800 dark:text-green-300">
              ${funnel.pipelineDollars.toLocaleString()}
            </span>
            <span className="text-xs text-green-700/80 dark:text-green-400/80">
              active pipeline
            </span>
          </div>
        </div>
        <StatusFunnel byStatus={funnel.byStatus} total={funnel.total} />
      </section>

      {/* AGENT LEADERBOARD — click a card to drill in */}
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

      {/* FILTERS + CSV EXPORT */}
      <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedSearch(search.trim())
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="relative min-w-[200px] flex-1">
            <label className="mb-1 block text-xs font-medium text-zinc-500">Search</label>
            <Search className="pointer-events-none absolute left-3 top-[30px] h-4 w-4 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, phone, address, notes…"
              className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Client</label>
            <select
              value={client}
              onChange={(e) => setClient(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="all">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="none">(No client assigned)</option>
            </select>
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
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
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
          <button
            type="submit"
            className="rounded-md bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700"
          >
            Apply
          </button>
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
            disabled={appointments.length === 0}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="Download the currently-filtered rows as CSV"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </form>
      </div>

      {apptsQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
        </div>
      ) : appointments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <PhoneCall className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-500">
            No appointments match these filters.
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
                  <th className="px-3 py-2.5">Appt</th>
                  <th className="px-3 py-2.5">Client</th>
                  <th className="px-3 py-2.5">Agent</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Phone</th>
                  <th className="px-3 py-2.5">Email</th>
                  <th className="px-3 py-2.5">Address</th>
                  <th className="px-3 py-2.5">Utility</th>
                  <th className="px-3 py-2.5">Bill</th>
                  <th className="px-3 py-2.5">Roof</th>
                  <th className="px-3 py-2.5">Deal $</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Rec</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {appointments.map((a) => {
                  const when = new Date(a.apptDateTime)
                  const missing = missingDataFlags(a)
                  const isExpanded = expandedId === a.id
                  const isSaving = savingIds.has(a.id)
                  return (
                    <Fragment key={a.id}>
                      <tr
                        className={cn(
                          'align-top transition-colors',
                          isExpanded
                            ? 'bg-purple-50/50 dark:bg-purple-950/20'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                        )}
                      >
                        <td className="px-2 py-2.5 align-middle">
                          {missing.length > 0 && (
                            <span
                              title={`Missing: ${missing.join(', ')}`}
                              className="inline-block h-2 w-2 rounded-full bg-amber-400"
                            />
                          )}
                        </td>
                        <td className="px-1 py-2.5 align-middle">
                          <button
                            onClick={() =>
                              setExpandedId(isExpanded ? null : a.id)
                            }
                            title={isExpanded ? 'Collapse' : 'Show full details'}
                            className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </td>
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
                        <td className="px-3 py-2.5">
                          {a.client ? (
                            <span
                              className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                              style={{ backgroundColor: a.client.color }}
                              title={a.client.state || undefined}
                            >
                              {a.client.name}
                            </span>
                          ) : (
                            <span className="text-[10px] text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <Link
                            href={`/call-center/agents/${a.agent.id}`}
                            className="font-medium text-zinc-700 hover:text-purple-600 hover:underline dark:text-zinc-200"
                          >
                            {a.agent.name || '(unnamed)'}
                          </Link>
                          <div className="truncate text-[10px] text-zinc-400">{a.agent.email}</div>
                        </td>
                        <td className="px-3 py-2.5 font-medium">{a.customerName}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px]">
                          {a.customerPhone}
                        </td>
                        <td
                          className="max-w-[180px] truncate px-3 py-2.5 text-zinc-500"
                          title={a.email || ''}
                        >
                          {a.email ? (
                            <a
                              href={`mailto:${a.email}`}
                              className="text-zinc-600 hover:text-purple-600 hover:underline dark:text-zinc-300"
                            >
                              {a.email}
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td
                          className="max-w-[200px] truncate px-3 py-2.5 text-zinc-500"
                          title={a.address || ''}
                        >
                          {a.address || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-zinc-500">{a.utilityProvider || '—'}</td>
                        <td className="px-3 py-2.5 text-zinc-500">
                          {a.monthlyBill ? `$${a.monthlyBill}` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-zinc-500">
                          {a.roofType || '—'}
                          {a.roofAge && <span className="text-zinc-400"> · {a.roofAge}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-zinc-500">
                          {a.estimatedDealValue ? `$${a.estimatedDealValue}` : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <InlineStatusSelect
                            value={a.status}
                            onChange={(next) =>
                              patchMutation.mutate({
                                id: a.id,
                                fields: { status: next },
                              })
                            }
                            saving={isSaving}
                          />
                          {a.syncError && (
                            <div
                              className="mt-1 inline-flex items-center gap-1 text-[10px] text-amber-600"
                              title={a.syncError}
                            >
                              <AlertCircle className="h-3 w-3" />
                              sync
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {a.callRecordingLink ? (
                            <a
                              href={a.callRecordingLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={a.callRecordingLink}
                              className="inline-flex items-center gap-1 text-purple-600 hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Play
                            </a>
                          ) : (
                            <span className="text-zinc-300">—</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-purple-50/30 dark:bg-purple-950/10">
                          <td
                            colSpan={15}
                            className="border-t border-purple-200/50 px-6 py-4 dark:border-purple-900/50"
                          >
                            <AppointmentDetail appointment={a} />
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

function AttentionCard({
  tone,
  icon: Icon,
  label,
  value,
  hint,
}: {
  tone: 'blue' | 'purple' | 'red' | 'zinc'
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number
  hint: string
}) {
  const toneMap = {
    blue: {
      bg: 'bg-blue-50 dark:bg-blue-950/40',
      iconBg: 'bg-blue-100 dark:bg-blue-900',
      iconColor: 'text-blue-600',
      valueColor: 'text-blue-900 dark:text-blue-200',
    },
    purple: {
      bg: 'bg-purple-50 dark:bg-purple-950/40',
      iconBg: 'bg-purple-100 dark:bg-purple-900',
      iconColor: 'text-purple-600',
      valueColor: 'text-purple-900 dark:text-purple-200',
    },
    red: {
      bg: 'bg-red-50 dark:bg-red-950/40',
      iconBg: 'bg-red-100 dark:bg-red-900',
      iconColor: 'text-red-600',
      valueColor: 'text-red-900 dark:text-red-200',
    },
    zinc: {
      bg: 'bg-white dark:bg-zinc-900',
      iconBg: 'bg-zinc-100 dark:bg-zinc-800',
      iconColor: 'text-zinc-400',
      valueColor: 'text-zinc-700 dark:text-zinc-200',
    },
  }[tone]

  return (
    <div className={cn('flex items-center gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800', toneMap.bg)}>
      <div className={cn('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg', toneMap.iconBg)}>
        <Icon className={cn('h-5 w-5', toneMap.iconColor)} />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <p className={cn('text-2xl font-bold tabular-nums', toneMap.valueColor)}>{value}</p>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        </div>
        <p className="text-xs text-zinc-500">{hint}</p>
      </div>
    </div>
  )
}

function StatusFunnel({
  byStatus,
  total,
}: {
  byStatus: Record<string, number>
  total: number
}) {
  if (total === 0) {
    return (
      <p className="text-xs text-zinc-400">
        No appointments to chart.
      </p>
    )
  }
  return (
    <div className="space-y-2">
      {FUNNEL_ORDER.map(({ status, label, barColor }) => {
        const count = byStatus[status] ?? 0
        const pct = total > 0 ? (count / total) * 100 : 0
        return (
          <div key={status} className="flex items-center gap-3">
            <div className="w-28 flex-shrink-0 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              {label}
            </div>
            <div className="relative flex-1 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
              <div
                className={cn('h-6 rounded-md transition-all', barColor)}
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
              <div className="absolute inset-0 flex items-center px-2 text-[11px] font-semibold tabular-nums">
                <span className="mix-blend-difference text-white">
                  {count} {count > 0 ? `· ${Math.round(pct)}%` : ''}
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

type AgentMetrics = {
  id: string
  name: string | null
  email: string
  total: number
  showed: number
  noShow: number
  booked: number
  pipelineDollars: number
  lastBookingAt: string | null
  last7Days: number[]
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
  const completed = metrics.showed + metrics.noShow
  const showRate = completed > 0 ? Math.round((metrics.showed / completed) * 100) : null

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-3 rounded-xl border bg-white p-4 transition-all dark:bg-zinc-900',
        active
          ? 'border-purple-500 shadow-[0_0_0_1px_rgb(168_85_247)] dark:border-purple-400'
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
        <MiniStat label="Total" value={metrics.total} />
        <MiniStat
          label="Show %"
          value={showRate != null ? `${showRate}%` : '—'}
          tone={
            showRate != null
              ? showRate >= 70
                ? 'good'
                : showRate >= 40
                  ? 'warn'
                  : 'bad'
              : undefined
          }
        />
        <MiniStat label="Active" value={metrics.booked} />
        <MiniStat
          label="Pipeline"
          value={
            metrics.pipelineDollars > 0
              ? `$${(metrics.pipelineDollars / 1000).toFixed(1)}k`
              : '$0'
          }
        />
      </div>

      <div className="flex items-end justify-between gap-3">
        <Sparkline counts={metrics.last7Days} />
        <div className="flex-shrink-0 text-right">
          <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
            <TrendingUp className="h-3 w-3" />
            Last 7d
          </p>
          <p className="text-sm font-bold tabular-nums">
            {metrics.last7Days.reduce((a, b) => a + b, 0)}
          </p>
        </div>
      </div>

      {metrics.lastBookingAt && (
        <p className="text-[10px] text-zinc-400">
          Last booking {timeAgo(metrics.lastBookingAt)}
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
          : 'text-zinc-900 dark:text-zinc-100'
  return (
    <div className="min-w-0 rounded-md bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/50">
      <p className="truncate text-[9px] font-medium uppercase tracking-wide text-zinc-400">
        {label}
      </p>
      <p className={cn('truncate text-sm font-bold tabular-nums', toneClass)}>{value}</p>
    </div>
  )
}

function Sparkline({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts)
  const width = 140
  const height = 28
  const barWidth = width / counts.length
  return (
    <svg
      width={width}
      height={height}
      className="flex-1"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      {counts.map((c, i) => {
        const h = c === 0 ? 2 : Math.max(2, (c / max) * height)
        return (
          <rect
            key={i}
            x={i * barWidth + 1}
            y={height - h}
            width={Math.max(barWidth - 2, 1)}
            height={h}
            rx={1}
            className={c > 0 ? 'fill-purple-500' : 'fill-zinc-200 dark:fill-zinc-700'}
          />
        )
      })}
    </svg>
  )
}

function InlineStatusSelect({
  value,
  onChange,
  saving,
}: {
  value: string
  onChange: (next: string) => void
  saving: boolean
}) {
  const tone = STATUS_TONE[value] || 'bg-zinc-100 text-zinc-700'
  return (
    <div className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={saving}
        className={cn(
          'appearance-none rounded-full px-2.5 py-0.5 pr-5 text-[10px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500',
          tone,
          saving && 'opacity-60'
        )}
      >
        {FUNNEL_ORDER.map(({ status, label }) => (
          <option key={status} value={status}>
            {label}
          </option>
        ))}
      </select>
      {saving ? (
        <Loader2 className="pointer-events-none absolute right-1 h-2.5 w-2.5 animate-spin opacity-60" />
      ) : (
        <ChevronDown className="pointer-events-none absolute right-1 h-2.5 w-2.5 opacity-60" />
      )}
    </div>
  )
}

function AppointmentDetail({ appointment }: { appointment: Appointment }) {
  const logged = new Date(appointment.createdAt)
  const lastSynced = appointment.lastSyncedAt ? new Date(appointment.lastSyncedAt) : null
  return (
    <div className="grid gap-x-8 gap-y-3 text-xs md:grid-cols-3">
      <DetailItem icon={UserIcon} label="Customer">
        <div className="font-medium text-zinc-800 dark:text-zinc-100">
          {appointment.customerName}
        </div>
        <div className="font-mono text-zinc-500">{appointment.customerPhone}</div>
        {appointment.email && (
          <a
            href={`mailto:${appointment.email}`}
            className="text-purple-600 hover:underline"
          >
            {appointment.email}
          </a>
        )}
      </DetailItem>

      <DetailItem icon={MapPin} label="Address">
        {appointment.address ? (
          <span className="text-zinc-800 dark:text-zinc-100">{appointment.address}</span>
        ) : (
          <span className="text-zinc-400">Not provided</span>
        )}
      </DetailItem>

      <DetailItem icon={PhoneCall} label="Agent">
        <Link
          href={`/call-center/agents/${appointment.agent.id}`}
          className="font-medium text-zinc-800 hover:text-purple-600 hover:underline dark:text-zinc-100"
        >
          {appointment.agent.name || '(unnamed)'}
        </Link>
        <div className="text-zinc-500">{appointment.agent.email}</div>
      </DetailItem>

      <DetailItem icon={DollarSign} label="Financials">
        <div className="space-y-0.5">
          <div>
            <span className="text-zinc-400">Monthly bill:</span>{' '}
            <span className="text-zinc-800 dark:text-zinc-100">
              {appointment.monthlyBill ? `$${appointment.monthlyBill}` : '—'}
            </span>
          </div>
          <div>
            <span className="text-zinc-400">Utility:</span>{' '}
            <span className="text-zinc-800 dark:text-zinc-100">
              {appointment.utilityProvider || '—'}
            </span>
          </div>
          <div>
            <span className="text-zinc-400">Deal value:</span>{' '}
            <span className="text-zinc-800 dark:text-zinc-100">
              {appointment.estimatedDealValue
                ? `$${appointment.estimatedDealValue}`
                : '—'}
            </span>
          </div>
        </div>
      </DetailItem>

      <DetailItem icon={FileText} label="Roof">
        <div>
          <span className="text-zinc-400">Type:</span>{' '}
          <span className="text-zinc-800 dark:text-zinc-100">
            {appointment.roofType || '—'}
          </span>
        </div>
        <div>
          <span className="text-zinc-400">Age:</span>{' '}
          <span className="text-zinc-800 dark:text-zinc-100">
            {appointment.roofAge || '—'}
          </span>
        </div>
      </DetailItem>

      <DetailItem icon={Clock} label="Sync & audit">
        <div>
          <span className="text-zinc-400">Logged:</span>{' '}
          <span className="text-zinc-800 dark:text-zinc-100">
            {logged.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
        </div>
        <div>
          <span className="text-zinc-400">Last sheet sync:</span>{' '}
          <span className="text-zinc-800 dark:text-zinc-100">
            {lastSynced
              ? lastSynced.toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })
              : 'never'}
          </span>
        </div>
        {appointment.syncError && (
          <div className="mt-1 rounded border border-amber-200 bg-amber-50 p-1.5 text-[10px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <AlertCircle className="mr-1 inline-block h-3 w-3" />
            {appointment.syncError}
          </div>
        )}
      </DetailItem>

      {appointment.notes && (
        <div className="md:col-span-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            <Mail className="h-3 w-3" />
            Notes
          </div>
          <div className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-white p-3 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
            {appointment.notes}
          </div>
        </div>
      )}

      {appointment.callRecordingLink && (
        <div className="md:col-span-3">
          <a
            href={appointment.callRecordingLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-200"
          >
            <ExternalLink className="h-3 w-3" />
            Play call recording
          </a>
        </div>
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

function missingDataFlags(a: Appointment): string[] {
  const missing: string[] = []
  if (!a.callRecordingLink) missing.push('Call recording')
  if (!a.utilityProvider) missing.push('Utility provider')
  if (!a.estimatedDealValue) missing.push('Deal value')
  if (!a.monthlyBill) missing.push('Monthly bill')
  return missing
}

function csvEscape(value: string): string {
  if (value == null) return ''
  // Wrap in quotes if contains comma/quote/newline; double internal quotes.
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
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
