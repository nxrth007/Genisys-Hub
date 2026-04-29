'use client'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  PhoneCall,
  Search,
  ExternalLink,
  Loader2,
  AlertCircle,
  Download,
  ChevronDown,
  ChevronRight,
  Building2,
  CalendarRange,
  CheckCircle2,
  TrendingUp,
  DollarSign,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CallCenterTabs } from '@/components/call-center/call-center-tabs'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'

/**
 * Master Tracker — Ethan's deliverable view of every booked appointment
 * the call center has produced, organized by client and exportable in
 * multiple slices (current view, per client, this week, this month,
 * custom range).
 *
 * Same source of truth as /call-center (the Appointment table); this
 * page wraps the data in a client-deliverable workflow instead of an
 * operations workflow.
 */

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
  showed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  no_show: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
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

function startOfThisWeek(): Date {
  const today = startOfDay(new Date())
  const dow = today.getDay() // 0=Sun
  const monOffset = dow === 0 ? -6 : 1 - dow // shift to Monday
  return new Date(today.getTime() + monOffset * 24 * 60 * 60 * 1000)
}

function startOfThisMonth(): Date {
  const d = startOfDay(new Date())
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function csvEscape(value: string): string {
  if (value == null) return ''
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const content = [headers, ...rows]
    .map((row) => row.map((c) => csvEscape(String(c ?? ''))).join(','))
    .join('\n')
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const EXPORT_HEADERS = [
  'Client',
  'Appt Date',
  'Appt Time',
  'Agent',
  'Customer Name',
  'Phone',
  'Email',
  'Address',
  'Utility Provider',
  'Monthly Bill',
  'Roof Type',
  'Roof Age',
  'Estimated Deal Value',
  'Status',
  'Notes',
  'Call Recording Link',
  'Logged At',
]

function appointmentToRow(a: Appointment): (string | number)[] {
  const d = new Date(a.apptDateTime)
  return [
    a.client?.name || '',
    d.toLocaleDateString('en-US'),
    d.toLocaleTimeString('en-US', { hour12: true }),
    a.agent.name || a.agent.email,
    a.customerName,
    a.customerPhone,
    a.email || '',
    a.address || '',
    a.utilityProvider || '',
    a.monthlyBill || '',
    a.roofType || '',
    a.roofAge || '',
    a.estimatedDealValue || '',
    a.status,
    a.notes || '',
    a.callRecordingLink || '',
    new Date(a.createdAt).toLocaleString('en-US'),
  ]
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function clientSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

export default function MasterTrackerPage() {
  // Filters
  const [client, setClient] = useState<string>('all') // 'all' | clientId | 'none'
  const [status, setStatus] = useState('all')
  const [agent, setAgent] = useState('all')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  // Queries
  const clientsQuery = useQuery<{ clients: Client[] }>({
    queryKey: ['clients'],
    queryFn: async () => {
      const res = await fetch('/api/clients')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
    staleTime: 60_000,
  })

  // Master Tracker reads from the live Master Table Google Sheet (not the
  // Hub's Postgres) — the call center is currently typing rows directly
  // into the sheet, so the sheet is the source of truth. The Hub's own
  // sync writes Hub-booked appointments into the same sheet, so reading
  // the sheet covers both flows without dedup.
  //
  // All filtering happens client-side over the full row set; the endpoint
  // returns everything. With current scale (10s of rows) this is fine.
  // Revisit if the sheet ever has thousands of rows.
  const apptsQuery = useQuery<{ appointments: Appointment[] }>({
    queryKey: ['master-tracker-sheet'],
    queryFn: async () => {
      const res = await fetch('/api/call-center/master-tracker')
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to load Master Table')
      }
      return res.json()
    },
    // 30-second stale time so navigating away/back is instant; longer
    // would risk showing stale data while the sheet is being edited.
    staleTime: 30_000,
  })

  const clients = useMemo(() => clientsQuery.data?.clients ?? [], [clientsQuery.data])
  const allAppointments = useMemo(
    () => apptsQuery.data?.appointments ?? [],
    [apptsQuery.data]
  )

  // Derive the agent dropdown from whoever actually appears in the sheet
  // rows — sheet rows have synthetic agent IDs based on email, so they
  // won't match the registered-Hub-agents list. Deriving from the data
  // means both sheet-only and Hub-booked rows show up correctly.
  const agents = useMemo<AgentSummary[]>(() => {
    const seen = new Map<string, AgentSummary>()
    for (const a of allAppointments) {
      if (!a.agent.id || seen.has(a.agent.id)) continue
      // Skip rows where the sheet had no agent name + email at all —
      // they'd otherwise show up as a single "(unnamed)" entry.
      if (!a.agent.name && !a.agent.email) continue
      seen.set(a.agent.id, {
        id: a.agent.id,
        name: a.agent.name,
        email: a.agent.email,
      })
    }
    return Array.from(seen.values()).sort((x, y) =>
      (x.name || x.email).localeCompare(y.name || y.email)
    )
  }, [allAppointments])

  // ---- Per-client counts (always the unfiltered set, so the switcher
  //      pills show real totals regardless of what's currently selected).
  const perClientCounts = useMemo(() => {
    const counts = new Map<string, number>()
    let unassigned = 0
    for (const a of allAppointments) {
      if (a.client?.id) {
        counts.set(a.client.id, (counts.get(a.client.id) || 0) + 1)
      } else {
        unassigned++
      }
    }
    return { counts, unassigned, total: allAppointments.length }
  }, [allAppointments])

  // ---- Apply client / status / agent / search / date filters to get the
  //      working set. All filtering is client-side because the sheet
  //      endpoint returns the full row set in one shot — no need to
  //      round-trip to the server when a filter changes.
  const filtered = useMemo(() => {
    let list = allAppointments
    if (client === 'none') list = list.filter((a) => !a.client)
    else if (client !== 'all') list = list.filter((a) => a.client?.id === client)
    if (status !== 'all') list = list.filter((a) => a.status === status)
    if (agent !== 'all') list = list.filter((a) => a.agent.id === agent)
    if (since) {
      const sinceDate = new Date(since)
      list = list.filter((a) => new Date(a.apptDateTime) >= sinceDate)
    }
    if (until) {
      const untilDate = new Date(until + 'T23:59:59')
      list = list.filter((a) => new Date(a.apptDateTime) <= untilDate)
    }
    if (submittedSearch) {
      const q = submittedSearch.toLowerCase()
      list = list.filter(
        (a) =>
          a.customerName.toLowerCase().includes(q) ||
          a.customerPhone.toLowerCase().includes(q) ||
          (a.address || '').toLowerCase().includes(q) ||
          (a.email || '').toLowerCase().includes(q) ||
          (a.notes || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [allAppointments, client, status, agent, since, until, submittedSearch])

  // ---- Stats over the working set
  const stats = useMemo(() => {
    let showed = 0
    let no_show = 0
    let pipeline = 0
    let thisWeek = 0
    let thisMonth = 0
    const weekStart = startOfThisWeek()
    const monthStart = startOfThisMonth()
    for (const a of filtered) {
      if (a.status === 'showed') showed++
      if (a.status === 'no_show') no_show++
      if (a.status !== 'cancelled' && a.status !== 'no_show') {
        pipeline += parseMoney(a.estimatedDealValue)
      }
      const ad = new Date(a.apptDateTime)
      if (ad >= weekStart) thisWeek++
      if (ad >= monthStart) thisMonth++
    }
    const completed = showed + no_show
    const showRate = completed > 0 ? Math.round((showed / completed) * 100) : null
    return {
      total: filtered.length,
      showed,
      showRate,
      pipeline,
      thisWeek,
      thisMonth,
    }
  }, [filtered])

  function clearFilters() {
    setSearch('')
    setSubmittedSearch('')
    setStatus('all')
    setAgent('all')
    setClient('all')
    setSince('')
    setUntil('')
  }
  const filterCleared =
    status === 'all' &&
    agent === 'all' &&
    client === 'all' &&
    !submittedSearch &&
    !since &&
    !until

  // ---- Exports ---------------------------------------------------------

  function exportRows(filename: string, rows: Appointment[]) {
    downloadCsv(
      filename,
      EXPORT_HEADERS,
      rows.map(appointmentToRow)
    )
    setExportMenuOpen(false)
  }

  function exportCurrent() {
    exportRows(`genisys-master-${todayStamp()}.csv`, filtered)
  }

  function exportPerClient(c: Client) {
    const rows = allAppointments.filter((a) => a.client?.id === c.id)
    exportRows(`${clientSlug(c.name)}-appointments-${todayStamp()}.csv`, rows)
  }

  function exportSinceDate(label: string, since: Date) {
    const rows = allAppointments.filter(
      (a) => new Date(a.apptDateTime) >= since
    )
    exportRows(`genisys-${label}-${todayStamp()}.csv`, rows)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        icon={PhoneCall}
        title="Call Center"
        subtitle="Master Tracker — every booked appointment, organized by client and ready to hand off."
      />

      <CallCenterTabs />

      {/* ---- Client switcher ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <ClientPill
          label="All clients"
          count={perClientCounts.total}
          active={client === 'all'}
          onClick={() => setClient('all')}
        />
        {clients.map((c) => (
          <ClientPill
            key={c.id}
            label={c.name}
            sublabel={c.state || undefined}
            count={perClientCounts.counts.get(c.id) || 0}
            active={client === c.id}
            color={c.color}
            onClick={() => setClient(c.id)}
          />
        ))}
        {perClientCounts.unassigned > 0 && (
          <ClientPill
            label="No client"
            count={perClientCounts.unassigned}
            active={client === 'none'}
            onClick={() => setClient('none')}
          />
        )}
      </div>

      {/* ---- Stat row ---- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={Building2}
          label="Total appointments"
          value={stats.total}
          tone="blue"
        />
        <StatCard
          icon={CheckCircle2}
          label="Showed"
          value={stats.showed}
          subtitle={stats.showRate != null ? `${stats.showRate}% show rate` : undefined}
          progress={stats.showRate ?? undefined}
          tone="green"
        />
        <StatCard
          icon={TrendingUp}
          label="This week"
          value={stats.thisWeek}
          subtitle={`${stats.thisMonth} this month`}
          tone="indigo"
        />
        <StatCard
          icon={DollarSign}
          label="Pipeline"
          value={`$${stats.pipeline.toLocaleString()}`}
          subtitle="excludes cancelled / no-show"
          tone="amber"
        />
      </div>

      {/* ---- Filters + export ---- */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedSearch(search.trim())
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="relative min-w-[220px] flex-1">
            <label className="mb-1 block text-xs font-medium text-zinc-500">
              Search
            </label>
            <Search className="pointer-events-none absolute left-3 top-[30px] h-4 w-4 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, phone, address, notes…"
              className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
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
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
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

          {/* Export menu — multiple slices, click outside or option to close. */}
          <div className="relative ml-auto">
            <button
              type="button"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={allAppointments.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Download className="h-3.5 w-3.5" />
              Export
              <ChevronDown className="h-3 w-3" />
            </button>
            {exportMenuOpen && (
              <>
                {/* Click-catcher to close the menu when the user taps outside */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setExportMenuOpen(false)}
                />
                <div className="absolute right-0 z-50 mt-1 w-72 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  <ExportSection title="Current view">
                    <ExportItem
                      label="Export filtered appointments"
                      hint={`${filtered.length} row${filtered.length === 1 ? '' : 's'}`}
                      onClick={exportCurrent}
                      disabled={filtered.length === 0}
                    />
                  </ExportSection>
                  <ExportSection title="Per client (full history)">
                    {clients.map((c) => {
                      const count = perClientCounts.counts.get(c.id) || 0
                      return (
                        <ExportItem
                          key={c.id}
                          label={c.name}
                          hint={`${count} row${count === 1 ? '' : 's'}`}
                          color={c.color}
                          onClick={() => exportPerClient(c)}
                          disabled={count === 0}
                        />
                      )
                    })}
                  </ExportSection>
                  <ExportSection title="Quick ranges (all clients)">
                    <ExportItem
                      label="This week"
                      onClick={() =>
                        exportSinceDate('this-week', startOfThisWeek())
                      }
                    />
                    <ExportItem
                      label="This month"
                      onClick={() =>
                        exportSinceDate('this-month', startOfThisMonth())
                      }
                    />
                  </ExportSection>
                </div>
              </>
            )}
          </div>
        </form>
        <p className="mt-2 text-[11px] text-zinc-500">
          <CalendarRange className="mr-1 inline-block h-3 w-3" />
          Date filter narrows the table + the &ldquo;Current view&rdquo; export.
          Per-client exports always include the full history for that client
          regardless of the date filter.
        </p>
      </div>

      {/* ---- Table ---- */}
      {apptsQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : filtered.length === 0 ? (
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
                  <th className="px-3 py-2.5">Appt</th>
                  <th className="px-3 py-2.5">Client</th>
                  <th className="px-3 py-2.5">Agent</th>
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
                {filtered.map((a) => {
                  const when = new Date(a.apptDateTime)
                  const isExpanded = expandedId === a.id
                  return (
                    <Fragment key={a.id}>
                      <tr
                        className={cn(
                          'align-top transition-colors',
                          isExpanded
                            ? 'bg-blue-50/40 dark:bg-blue-950/20'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                        )}
                      >
                        <td className="px-2 py-2.5 align-middle">
                          <button
                            onClick={() =>
                              setExpandedId(isExpanded ? null : a.id)
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
                            className="font-medium text-zinc-700 hover:text-blue-600 hover:underline dark:text-zinc-200"
                          >
                            {a.agent.name || '(unnamed)'}
                          </Link>
                          <div className="truncate text-[10px] text-zinc-400">
                            {a.agent.email}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-medium">{a.customerName}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px]">
                          {a.customerPhone}
                        </td>
                        <td
                          className="max-w-[200px] truncate px-3 py-2.5 text-zinc-500"
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
                          {a.estimatedDealValue
                            ? `$${a.estimatedDealValue}`
                            : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                              STATUS_TONE[a.status] ||
                                'bg-zinc-100 text-zinc-700'
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
                      {isExpanded && (
                        <tr className="bg-blue-50/20 dark:bg-blue-950/10">
                          <td
                            colSpan={12}
                            className="border-t border-blue-200/40 px-6 py-4 dark:border-blue-900/40"
                          >
                            <RowDetail appointment={a} />
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

      {apptsQuery.isError && (
        <div className="flex items-center gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          Failed to load appointments. Try refreshing.
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------

function ClientPill({
  label,
  sublabel,
  count,
  active,
  color,
  onClick,
}: {
  label: string
  sublabel?: string
  count: number
  active: boolean
  color?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all',
        active
          ? 'border-transparent text-white shadow-sm'
          : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
      )}
      style={
        active && color
          ? { backgroundColor: color }
          : active
            ? { backgroundColor: '#2563eb' }
            : undefined
      }
    >
      {!active && color && (
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      <span className="flex flex-col items-start leading-tight">
        <span>{label}</span>
        {sublabel && (
          <span
            className={cn(
              'text-[9px] font-normal',
              active ? 'text-white/80' : 'text-zinc-400'
            )}
          >
            {sublabel}
          </span>
        )}
      </span>
      <span
        className={cn(
          'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
          active
            ? 'bg-white/25 text-white'
            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
        )}
      >
        {count}
      </span>
    </button>
  )
}

function ExportSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
      <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </p>
      <div className="pb-1">{children}</div>
    </div>
  )
}

function ExportItem({
  label,
  hint,
  color,
  onClick,
  disabled,
}: {
  label: string
  hint?: string
  color?: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
        disabled
          ? 'cursor-not-allowed text-zinc-400'
          : 'text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800'
      )}
    >
      {color && (
        <span
          className="h-2 w-2 flex-shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-[10px] text-zinc-400">{hint}</span>}
      <Download className="h-3 w-3 text-zinc-400" />
    </button>
  )
}

function RowDetail({ appointment }: { appointment: Appointment }) {
  return (
    <div className="grid gap-x-8 gap-y-3 text-xs md:grid-cols-3">
      <DetailItem label="Customer">
        <div className="font-medium text-zinc-800 dark:text-zinc-100">
          {appointment.customerName}
        </div>
        <div className="font-mono text-zinc-500">{appointment.customerPhone}</div>
        {appointment.email && (
          <a
            href={`mailto:${appointment.email}`}
            className="text-blue-600 hover:underline"
          >
            {appointment.email}
          </a>
        )}
      </DetailItem>
      <DetailItem label="Address">
        {appointment.address || (
          <span className="text-zinc-400">Not provided</span>
        )}
      </DetailItem>
      <DetailItem label="Property">
        <div>
          <span className="text-zinc-400">Bill:</span>{' '}
          {appointment.monthlyBill ? `$${appointment.monthlyBill}/mo` : '—'}
        </div>
        <div>
          <span className="text-zinc-400">Utility:</span>{' '}
          {appointment.utilityProvider || '—'}
        </div>
        <div>
          <span className="text-zinc-400">Roof:</span>{' '}
          {appointment.roofType || '—'}
          {appointment.roofAge && ` · ${appointment.roofAge}`}
        </div>
        <div>
          <span className="text-zinc-400">Deal value:</span>{' '}
          {appointment.estimatedDealValue
            ? `$${appointment.estimatedDealValue}`
            : '—'}
        </div>
      </DetailItem>
      {appointment.notes && (
        <div className="md:col-span-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Notes
          </p>
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
            className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200"
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
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <div className="space-y-0.5 text-zinc-700 dark:text-zinc-300">
        {children}
      </div>
    </div>
  )
}
