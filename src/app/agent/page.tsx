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
import {
  AGENT_TIMEZONE,
  resolveCustomerTimezone,
  sameDayInTz,
} from '@/lib/timezone'

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

// Vocabulary: "Set today" = createdAt today (when Mary entered the
// row); "Booked today" = apptDateTime today (when the appointment is
// scheduled). The same naming is used on the Master Tracker chips.
type QuickFilter = null | 'set-today' | 'booked-today'

export default function AgentDashboardPage() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(null)

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
    if (quickFilter === 'set-today') {
      // When Mary actually entered the row. Anchored to her tz so
      // 11 PM Manila bookings don't roll over to "tomorrow" when Alex
      // (EST) loads the page hours later. createdAt for sheet-only
      // rows is synthesized from the Logged At cell server-side; rows
      // with no createdAt are excluded since we can't honestly say
      // when they were booked.
      const now = new Date()
      list = list.filter((a) => {
        if (!a.createdAt) return false
        const created = new Date(a.createdAt)
        return !isNaN(created.getTime()) && sameDayInTz(created, now, AGENT_TIMEZONE)
      })
    } else if (quickFilter === 'booked-today') {
      // When the appointment is scheduled to happen, in the CUSTOMER's
      // wall clock (per-row tz from address + client.state). A 9 PM
      // PT appointment on 5/3 stays "today" for the whole PT day even
      // though it's already 5/4 in Manila and Alex's EST wraps at
      // 5/4 midnight ET.
      const now = new Date()
      list = list.filter((a) => {
        const appt = new Date(a.apptDateTime)
        if (isNaN(appt.getTime())) return false
        const customerTz = resolveCustomerTimezone({
          address: a.address,
          clientState: a.client?.state ?? null,
        })
        return sameDayInTz(appt, now, customerTz)
      })
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
  }, [appointments, search, statusFilter, quickFilter])

  // Stat counters for Mary's dashboard. Kept tight to volume +
  // outcomes — anything else is admin-side noise that doesn't help
  // her booking workflow.
  //   - total     = every row regardless of status
  //   - thisMonth = appt date is in the current calendar month
  //   - showed    = status='showed'
  //   - noShow    = status='no_show'
  // (Removed the "Pending" card — it was just status='booked' = the
  // residual after subtracting outcomes, which is math not insight.)
  const stats = useMemo(() => {
    const total = appointments.length
    const thisMonth = appointments.filter((a) => {
      const d = new Date(a.apptDateTime)
      const now = new Date()
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    }).length
    const showed = appointments.filter((a) => a.status === 'showed').length
    const noShow = appointments.filter((a) => a.status === 'no_show').length
    return { total, thisMonth, showed, noShow }
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
        <StatCard label="Total" value={stats.total} />
        <StatCard label="This month" value={stats.thisMonth} />
        <StatCard label="Showed" value={stats.showed} />
        <StatCard label="No-show" value={stats.noShow} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Quick filter
        </span>
        <QuickFilterChip
          label="Set today"
          hint="Entered by Mary today (Manila clock)"
          active={quickFilter === 'set-today'}
          tone="emerald"
          onClick={() =>
            setQuickFilter(quickFilter === 'set-today' ? null : 'set-today')
          }
        />
        <QuickFilterChip
          label="Booked today"
          hint="Scheduled for today in the customer's tz"
          active={quickFilter === 'booked-today'}
          tone="blue"
          onClick={() =>
            setQuickFilter(quickFilter === 'booked-today' ? null : 'booked-today')
          }
        />
        {quickFilter && (
          <button
            type="button"
            onClick={() => setQuickFilter(null)}
            className="ml-1 text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Clear
          </button>
        )}
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

function QuickFilterChip({
  label,
  hint,
  active,
  tone,
  onClick,
}: {
  label: string
  hint: string
  active: boolean
  tone: 'emerald' | 'blue'
  onClick: () => void
}) {
  const activeTone =
    tone === 'emerald'
      ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'
      : 'border-blue-400 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-200'
  const idleTone =
    'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700'
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        'rounded-full border px-3 py-1 text-[11px] font-medium transition-colors',
        active ? activeTone : idleTone,
      )}
    >
      {label}
    </button>
  )
}

function AppointmentRow({ appt }: { appt: Appointment }) {
  const statusInfo = STATUS_LABELS[appt.status] || {
    label: appt.status,
    tone: 'bg-zinc-100 text-zinc-700',
  }
  const when = new Date(appt.apptDateTime)
  // Render the date/time in the CUSTOMER's wall clock, not the
  // viewer's browser. Same resolver the form + sheet sync use, so
  // the list, the master tracker, and the sheet all show identical
  // numbers regardless of who's looking (Mary in Manila, Alex in
  // EST, the customer in PDT).
  const customerTz = resolveCustomerTimezone({
    address: appt.address,
    clientState: appt.client?.state ?? null,
  })
  const monthLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: customerTz,
    month: 'short',
  }).format(when)
  const dayLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: customerTz,
    day: 'numeric',
  }).format(when)
  const timeLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: customerTz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(when)

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
          <div className="text-xs font-medium uppercase text-zinc-400">{monthLabel}</div>
          <div className="text-xl font-bold">{dayLabel}</div>
          <div className="text-xs text-zinc-500">{timeLabel}</div>
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
