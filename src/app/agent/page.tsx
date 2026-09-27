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
  Users,
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
  booked: { label: 'Booked', tone: 'bg-primary-soft text-primary bg-primary-soft text-primary' },
  rescheduled: {
    label: 'Rescheduled',
    tone: 'bg-warning/15 text-warning bg-warning/15 text-warning',
  },
  showed: {
    label: 'Showed',
    tone: 'bg-success/15 text-success bg-success/15 text-success',
  },
  no_show: { label: 'No-show', tone: 'bg-destructive/10 text-destructive bg-destructive/10 text-destructive' },
  cancelled: {
    label: 'Cancelled',
    tone: 'bg-muted text-foreground/85 bg-surface-muted text-foreground/85',
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
    // showed counts every "sat down" outcome: showed, won, lost.
    // Won/lost are deal results on top of showing up, so they should
    // count toward Mary's show stat.
    const showed = appointments.filter(
      (a) => a.status === 'showed' || a.status === 'won' || a.status === 'lost',
    ).length
    const noShow = appointments.filter((a) => a.status === 'no_show').length
    return { total, thisMonth, showed, noShow }
  }, [appointments])

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Appointments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Record your booked solar appointments here. Entries sync automatically to the
            shared Genisys master sheet.
          </p>
        </div>
        <Link
          href="/agent/appointments/new"
          className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:bg-foreground/90"
        >
          <Plus className="h-4 w-4" />
          New appointment
        </Link>
      </div>

      {/* Team-manager promotion banner. Renders only when admin has
          flipped User.managesTeamNumber on the current user — Mary
          sees this; other agents see nothing. Single small fetch
          on mount; no impact on render speed for non-managers. */}
      <TeamManagerBanner />

      <CallbacksDuePanel />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total" value={stats.total} />
        <StatCard label="This month" value={stats.thisMonth} />
        <StatCard label="Showed" value={stats.showed} />
        <StatCard label="No-show" value={stats.noShow} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 eyebrow text-muted-foreground">
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
          label="Booked for today"
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
            className="ml-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, address, email…"
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm focus:border-primary/50 focus:outline-none border-border bg-card"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm border-border bg-card"
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
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center border-border">
          <CheckCircle2 className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <h3 className="mt-3 text-sm font-semibold">
            {appointments.length === 0 ? 'No appointments yet' : 'No matches'}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {appointments.length === 0
              ? 'Click "New appointment" to log your first booking.'
              : 'Try a different search or filter.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card border-border bg-card">
          <div className="divide-y divide-border-soft">
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
    <div className="rounded-xl border border-border bg-card p-4 border-border bg-card">
      <p className="eyebrow text-muted-foreground">{label}</p>
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
      ? 'border-success bg-success/15 text-success border-success/30 bg-success/15 text-success'
      : 'border-primary bg-primary-soft text-primary border-primary/30 bg-primary-soft text-primary'
  const idleTone =
    'border-border bg-card text-muted-foreground hover:border-foreground/30 border-border bg-card text-foreground/85 hover:border-foreground/30'
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        'rounded-md border px-3 py-1 text-[11px] font-medium transition-colors',
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
    tone: 'bg-muted text-foreground/85',
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
      className="block px-4 py-4 transition-colors hover:bg-muted hover:bg-muted/50"
    >
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 text-center" style={{ minWidth: '4.5rem' }}>
          <div className="text-xs font-medium uppercase text-muted-foreground/70">{monthLabel}</div>
          <div className="text-xl font-bold">{dayLabel}</div>
          <div className="text-xs text-muted-foreground">{timeLabel}</div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold">{appt.customerName}</p>
            <span
              className={cn('rounded-md px-2 py-0.5 text-[10px] font-semibold', statusInfo.tone)}
            >
              {statusInfo.label}
            </span>
            {appt.client ? (
              <span
                className="rounded-md px-2 py-0.5 text-[10px] font-semibold text-white"
                style={{ backgroundColor: appt.client.color }}
                title={appt.client.state || undefined}
              >
                {appt.client.name}
              </span>
            ) : (
              <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground bg-surface-muted text-muted-foreground">
                No client
              </span>
            )}
            {isSheetOnly && (
              <span
                className="rounded-md bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning bg-warning/15 text-warning"
                title="Typed straight into the master spreadsheet — edit it from the Master Tracker tab."
              >
                Sheet entry
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
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
            <p className="mt-1 text-xs text-warning">
              Sync warning: {appt.syncError}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 text-xs text-muted-foreground/70">
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

/* -------------------------------------------------------------------------- */
/*  Team-manager banner (Mary)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Renders a "Manage Team #N" card when the current agent has been
 * flagged as a team manager via /agents → "Make Team #N mgr."
 * Hidden entirely for agents without the flag (most of the time
 * this returns null). Lightweight single-row fetch on mount.
 */
function TeamManagerBanner() {
  const { data } = useQuery<{ managesTeamNumber: number | null }>({
    queryKey: ['agent-manager-status'],
    queryFn: async () => {
      const res = await fetch('/api/agent/me/manager-status')
      if (!res.ok) return { managesTeamNumber: null }
      return res.json()
    },
    // Manager flag changes rarely — admin toggle from /agents is
    // the only path. Stale-while-revalidate on a 5-minute window
    // keeps the network quiet without leaving stale state for
    // ages.
    staleTime: 5 * 60_000,
  })
  const teamNumber = data?.managesTeamNumber
  if (!teamNumber) return null
  return (
    <Link
      href="/team/manage"
      className="group flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary-soft p-4 transition hover:border-primary/50 hover:bg-primary-soft border-primary/30 bg-primary-soft hover:bg-primary-soft"
    >
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-card p-2 bg-primary-soft">
          <Users className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-semibold text-primary">
            Manage Team #{teamNumber}
          </p>
          <p className="text-[11px] text-primary">
            Approve new registrations and assign call-center numbers
          </p>
        </div>
      </div>
      <ExternalLink className="h-4 w-4 text-primary transition group-hover:translate-x-0.5" />
    </Link>
  )
}

