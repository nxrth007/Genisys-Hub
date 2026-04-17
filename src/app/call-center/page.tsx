'use client'

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  PhoneCall,
  Search,
  ExternalLink,
  Loader2,
  Calendar,
  Users,
  CheckCircle2,
  XCircle,
  AlertCircle,
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
  notes: string | null
  callRecordingLink: string | null
  lastSyncedAt: string | null
  syncError: string | null
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

export default function CallCenterPage() {
  const [status, setStatus] = useState('all')
  const [agent, setAgent] = useState('all')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')

  const agentsQuery = useQuery<{ agents: AgentSummary[] }>({
    queryKey: ['call-center-agents'],
    queryFn: async () => {
      const res = await fetch('/api/call-center/agents')
      if (!res.ok) throw new Error('Failed to load agents')
      return res.json()
    },
  })

  const apptsQuery = useQuery<{ appointments: Appointment[] }>({
    queryKey: ['call-center-appts', status, agent, submittedSearch, since, until],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (status !== 'all') params.set('status', status)
      if (agent !== 'all') params.set('agent', agent)
      if (submittedSearch) params.set('q', submittedSearch)
      if (since) params.set('since', new Date(since).toISOString())
      if (until) params.set('until', new Date(until + 'T23:59:59').toISOString())
      const res = await fetch(`/api/call-center/appointments?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to load appointments')
      return res.json()
    },
  })

  const agents = agentsQuery.data?.agents ?? []
  const appointments = useMemo(
    () => apptsQuery.data?.appointments ?? [],
    [apptsQuery.data]
  )

  const stats = useMemo(() => {
    const total = appointments.length
    const byStatus = appointments.reduce<Record<string, number>>((acc, a) => {
      acc[a.status] = (acc[a.status] ?? 0) + 1
      return acc
    }, {})
    const agentCount = new Set(appointments.map((a) => a.agent.id)).size
    return { total, byStatus, agentCount }
  }, [appointments])

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
              All booked solar appointments across every agent, live from the Hub. Syncs
              automatically to the shared master sheet.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Appointments" value={stats.total} icon={Calendar} />
        <StatCard label="Active agents" value={stats.agentCount} icon={Users} />
        <StatCard label="Showed" value={stats.byStatus['showed'] ?? 0} icon={CheckCircle2} />
        <StatCard label="No-show" value={stats.byStatus['no_show'] ?? 0} icon={XCircle} />
      </div>

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
          {(submittedSearch || status !== 'all' || agent !== 'all' || since || until) && (
            <button
              type="button"
              onClick={() => {
                setSearch('')
                setSubmittedSearch('')
                setStatus('all')
                setAgent('all')
                setSince('')
                setUntil('')
              }}
              className="rounded-md px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Clear
            </button>
          )}
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
                  <th className="px-3 py-2.5">Appt</th>
                  <th className="px-3 py-2.5">Agent</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Phone</th>
                  <th className="px-3 py-2.5">Address</th>
                  <th className="px-3 py-2.5">Utility</th>
                  <th className="px-3 py-2.5">Bill</th>
                  <th className="px-3 py-2.5">Roof</th>
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
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-zinc-700 dark:text-zinc-200">
                          {a.agent.name || '(unnamed)'}
                        </div>
                        <div className="truncate text-[10px] text-zinc-400">{a.agent.email}</div>
                      </td>
                      <td className="px-3 py-2.5 font-medium">{a.customerName}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px]">
                        {a.customerPhone}
                      </td>
                      <td className="max-w-[220px] truncate px-3 py-2.5 text-zinc-500" title={a.address || ''}>
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
                      <td className="px-3 py-2.5">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                            STATUS_TONE[a.status] || 'bg-zinc-100 text-zinc-700'
                          )}
                        >
                          {a.status}
                        </span>
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

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        <Icon className="h-4 w-4 text-zinc-300" />
      </div>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  )
}
