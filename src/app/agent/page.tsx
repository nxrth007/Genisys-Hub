'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  Plus,
  Search,
  Calendar,
  Phone,
  User,
  MapPin,
  FileText,
  Loader2,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react'
import { CallbacksDuePanel } from '@/components/agent/callbacks-due-panel'
import { cn } from '@/lib/utils'

type Appointment = {
  id: string
  apptDateTime: string
  client: { id: string; name: string; state: string | null; color: string } | null
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
  /** Where this row originated. `hub` = saved through the agent
   *  booking form (full edit/delete affordances); `sheet` = typed
   *  directly into the master spreadsheet (edits route to the
   *  Master Tracker since this id isn't a DB primary key). */
  source?: 'hub' | 'sheet'
}

const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  booked: { label: 'Booked', tone: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
  rescheduled: {
    label: 'Rescheduled',
    tone: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  showed: {
    label: 'Showed',
    tone: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  no_show: { label: 'No-show', tone: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
  cancelled: {
    label: 'Cancelled',
    tone: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
}

export default function AgentDashboardPage() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const query = useQuery<{ appointments: Appointment[] }>({
    queryKey: ['agent-appointments'],
    queryFn: async () => {
      const res = await fetch('/api/agent/appointments')
      if (!res.ok) throw new Error('Failed to load appointments')
      return res.json()
    },
  })

  const appointments = useMemo(
    () => query.data?.appointments ?? [],
    [query.data]
  )

  const filtered = useMemo(() => {
    let list = appointments
    if (statusFilter !== 'all') {
      list = list.filter((a) => a.status === statusFilter)
    }
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (a) =>
          a.customerName.toLowerCase().includes(q) ||
          a.customerPhone.toLowerCase().includes(q) ||
          a.address?.toLowerCase().includes(q) ||
          a.email?.toLowerCase().includes(q) ||
          a.notes?.toLowerCase().includes(q)
      )
    }
    return list
  }, [appointments, search, statusFilter])

  const stats = useMemo(() => {
    const total = appointments.length
    const thisMonth = appointments.filter((a) => {
      const d = new Date(a.apptDateTime)
      const now = new Date()
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    }).length
    const showed = appointments.filter((a) => a.status === 'showed').length
    const booked = appointments.filter((a) => a.status === 'booked').length
    return { total, thisMonth, showed, booked }
  }, [appointments])

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Appointments</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Record your booked solar appointments here. Entries sync automatically to the
            shared Genisys master sheet.
          </p>
        </div>
        <Link
          href="/agent/appointments/new"
          className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          New appointment
        </Link>
      </div>

      <CallbacksDuePanel />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total booked" value={stats.total} />
        <StatCard label="This month" value={stats.thisMonth} />
        <StatCard label="Active" value={stats.booked} />
        <StatCard label="Showed" value={stats.showed} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, address, email…"
            className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <option value="all">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <CheckCircle2 className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
          <h3 className="mt-3 text-sm font-semibold">
            {appointments.length === 0 ? 'No appointments yet' : 'No matches'}
          </h3>
          <p className="mt-1 text-sm text-zinc-500">
            {appointments.length === 0
              ? 'Click "New appointment" to log your first booking.'
              : 'Try a different search or filter.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((appt) => (
              <AppointmentRow key={appt.id} appt={appt} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  )
}

function AppointmentRow({ appt }: { appt: Appointment }) {
  const statusInfo = STATUS_LABELS[appt.status] || {
    label: appt.status,
    tone: 'bg-zinc-100 text-zinc-700',
  }
  const when = new Date(appt.apptDateTime)

  // Sheet-only rows route edits to the Master Tracker (which can
  // edit by sheet rowNumber); the regular edit page only knows DB
  // ids. Hub-sourced rows keep the deep-link to /agent/appointments.
  const isSheetOnly = appt.source === 'sheet'
  const editHref = isSheetOnly
    ? '/agent/master-tracker'
    : `/agent/appointments/${appt.id}`

  return (
    <Link
      href={editHref}
      className="block px-4 py-4 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
    >
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 text-center" style={{ minWidth: '4.5rem' }}>
          <div className="text-xs font-medium uppercase text-zinc-400">
            {when.toLocaleDateString('en-US', { month: 'short' })}
          </div>
          <div className="text-xl font-bold">{when.getDate()}</div>
          <div className="text-xs text-zinc-500">
            {when.toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold">{appt.customerName}</p>
            <span
              className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', statusInfo.tone)}
            >
              {statusInfo.label}
            </span>
            {appt.client ? (
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                style={{ backgroundColor: appt.client.color }}
                title={appt.client.state || undefined}
              >
                {appt.client.name}
              </span>
            ) : (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                No client
              </span>
            )}
            {isSheetOnly && (
              <span
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                title="Typed straight into the master spreadsheet — edit it from the Master Tracker tab."
              >
                Sheet entry
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3 w-3" />
              {appt.customerPhone}
            </span>
            {appt.address && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                <span className="truncate">{appt.address}</span>
              </span>
            )}
            {appt.utilityProvider && (
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" />
                {appt.utilityProvider}
              </span>
            )}
            {appt.monthlyBill && (
              <span className="inline-flex items-center gap-1">
                <FileText className="h-3 w-3" />${appt.monthlyBill}/mo
              </span>
            )}
          </div>
          {appt.syncError && (
            <p className="mt-1 text-xs text-amber-600">
              Sync warning: {appt.syncError}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 text-xs text-zinc-400">
          {appt.callRecordingLink && (
            <span
              className="inline-flex items-center gap-1"
              title="Call recording attached"
            >
              <ExternalLink className="h-3 w-3" />
              Rec
            </span>
          )}
          <Calendar className="h-4 w-4" />
        </div>
      </div>
    </Link>
  )
}
