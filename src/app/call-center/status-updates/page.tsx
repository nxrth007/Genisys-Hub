'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Inbox,
  Loader2,
  Play,
  Search,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * /call-center/status-updates — admin triage page for every client-
 * reported appointment outcome. Built around the dataflow:
 *
 *   /api/call-center/status-updates  →  per-client sections
 *     ├─ Updated bucket   ← appointments the client has touched
 *     └─ Pending bucket   ← appointments still awaiting their input
 *
 * Each updated card has a "View update" button that opens a modal
 * with the full client notes + before/after status + a Mark-Reviewed
 * toggle. Reviewed updates dim slightly and gain a checkmark; new
 * client edits reset the reviewed state on the server so a re-update
 * pops the row back into the unreviewed queue.
 *
 * URL contract:
 *   ?reviewStatus=all|unreviewed|reviewed   (default: all)
 *   ?outcome=showed,no_show,won,lost        (comma-sep multi-select)
 *   ?q=<search>                              (fuzzy across multiple fields)
 *   ?clientId=<id>                           (single-client scope)
 *   ?focus=<appointmentId>                   (auto-open the modal —
 *                                              used by the Slack alert
 *                                              deep-link)
 */

type Appointment = {
  id: string
  /** True when backed by a DB Appointment. Sheet-only rows
   *  (typically partner-sheet bookings) are read-only here — no
   *  Mark Reviewed toggle, no View Update modal. */
  hasDbRow: boolean
  apptDateTime: string
  customerName: string
  customerPhone: string
  address: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  status: string
  notes: string | null
  bookedByName: string | null
  clientNotes: string | null
  clientStatusUpdatedAt: string | null
  clientStatusReviewedAt: string | null
  clientStatusReviewedBy: { id: string; name: string } | null
  previousStatus: string | null
  createdAt: string
  recordingUrl: string | null
  /** primary = main Master Table sheet row; secondary = partner
   *  sheet row (Yassin's Forward Energy etc.); db-only = Hub-form
   *  booking that hasn't synced to the sheet yet. */
  sourceKind: 'primary' | 'secondary' | 'db-only'
}

type Section = {
  client: { id: string; name: string; color: string; state: string | null }
  updated: Appointment[]
  pending: Appointment[]
  counts: { updated: number; pending: number }
}

type StatusUpdatesResponse = {
  sections: Section[]
  summary: {
    totalUpdated: number
    totalUnreviewed: number
    countsByOutcome: Record<string, number>
  }
  /** Surfaced when the Google Sheets read fails — UI shows a
   *  warning banner so admin knows the page is showing DB-only
   *  results until the integration recovers. */
  sheetReadError: string | null
}

/* -------------------------------------------------------------------------- */
/*  Page shell                                                                */
/* -------------------------------------------------------------------------- */

export default function StatusUpdatesPage() {
  return (
    // useSearchParams forces a Suspense boundary in app-router pages.
    // The inner content drives all data fetching; the shell just
    // renders the layout chrome above so the fallback feels like
    // partial loading instead of a blank screen.
    <Suspense fallback={<PageSkeleton />}>
      <StatusUpdatesInner />
    </Suspense>
  )
}

function PageSkeleton() {
  // The call-center layout already renders the tabs above this
  // page, so the skeleton only fills in the body region.
  return (
    <div className="space-y-6">
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading status updates…
      </div>
    </div>
  )
}

function StatusUpdatesInner() {
  const searchParams = useSearchParams()
  const reviewStatus = (searchParams.get('reviewStatus') || 'all').toLowerCase()
  const outcomeRaw = searchParams.get('outcome') || ''
  const clientFilter = searchParams.get('clientId') || ''
  const initialSearch = searchParams.get('q') || ''
  const focusId = searchParams.get('focus') || ''

  const [searchInput, setSearchInput] = useState(initialSearch)
  // Debounce search input → search param. Keeps the API quiet while
  // the user is mid-typing.
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const queryParams = useMemo(() => {
    const p = new URLSearchParams()
    if (reviewStatus !== 'all') p.set('reviewStatus', reviewStatus)
    if (outcomeRaw) p.set('outcome', outcomeRaw)
    if (clientFilter) p.set('clientId', clientFilter)
    if (debouncedSearch) p.set('q', debouncedSearch)
    return p.toString()
  }, [reviewStatus, outcomeRaw, clientFilter, debouncedSearch])

  const { data, isLoading, isError, error } = useQuery<StatusUpdatesResponse>({
    queryKey: ['status-updates', queryParams],
    queryFn: async () => {
      const res = await fetch(
        `/api/call-center/status-updates${queryParams ? `?${queryParams}` : ''}`,
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load status updates')
      }
      return res.json()
    },
  })

  // Currently-open update modal. Drives the View-Update detail flow.
  const [openApptId, setOpenApptId] = useState<string | null>(null)
  // Deep-link from the Slack alert: when ?focus=<id> is present in
  // the URL AND we've finished loading, auto-open that appointment's
  // modal. Once it's open we clear focusId so a subsequent close
  // doesn't bounce back open.
  const handledFocus = useRef(false)
  useEffect(() => {
    if (handledFocus.current) return
    if (!focusId) return
    if (!data) return
    const exists = data.sections.some((s) =>
      s.updated.some((a) => a.id === focusId),
    )
    if (exists) {
      setOpenApptId(focusId)
      handledFocus.current = true
    }
  }, [focusId, data])

  const openAppt = useMemo(() => {
    if (!openApptId || !data) return null
    for (const s of data.sections) {
      const hit = s.updated.find((a) => a.id === openApptId)
      if (hit) return { client: s.client, appointment: hit }
    }
    return null
  }, [openApptId, data])

  return (
    // Call-center layout wraps this page in its breadcrumb + tabs +
    // date-range chrome. The page only renders its own header and
    // body inside that frame — no extra padding wrapper.
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Status Updates</h1>
        <p className="text-sm text-muted-foreground">
          Outcomes your clients have reported from their dashboards. Click
          <span className="mx-1 inline-flex items-center gap-1 rounded-md border border-yellow-400 bg-yellow-50 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-800 dark:border-yellow-500 dark:bg-yellow-950 dark:text-yellow-300">
            View update
          </span>
          on any row to read what the client said, then mark it reviewed once
          you've handled it.
        </p>
      </header>

      <SummaryStrip summary={data?.summary} loading={isLoading} />

      <FiltersBar
        reviewStatus={reviewStatus}
        outcomeRaw={outcomeRaw}
        clientFilter={clientFilter}
        clientOptions={(data?.sections ?? []).map((s) => s.client)}
        searchInput={searchInput}
        onSearchInput={setSearchInput}
      />

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error instanceof Error ? error.message : 'Failed to load'}
        </div>
      )}

      {/* Sheets-degraded banner — appears when the Google Sheets
          read fails. The page still renders with whatever DB rows
          we have, but the user needs to know they're not seeing
          the full sheet-side pipeline. */}
      {data?.sheetReadError && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <div>
            <p className="font-semibold">Sheet read degraded</p>
            <p className="mt-0.5">
              Showing Hub-booked appointments only. Sheet-only rows are
              temporarily hidden — try refreshing in a minute. Detail:{' '}
              <span className="font-mono">{data.sheetReadError}</span>
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : data && data.sections.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          <Inbox className="mx-auto mb-2 h-6 w-6 text-zinc-400" />
          No appointments match these filters.
        </div>
      ) : (
        <div className="space-y-4">
          {data?.sections.map((section) => (
            <ClientSection
              key={section.client.id}
              section={section}
              onView={setOpenApptId}
              focusedId={openApptId}
            />
          ))}
        </div>
      )}

      {openAppt && (
        <ViewUpdateModal
          client={openAppt.client}
          appointment={openAppt.appointment}
          onClose={() => setOpenApptId(null)}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Summary strip                                                             */
/* -------------------------------------------------------------------------- */

function SummaryStrip({
  summary,
  loading,
}: {
  summary?: StatusUpdatesResponse['summary']
  loading: boolean
}) {
  const items: Array<{
    label: string
    value: number | string
    tone: 'neutral' | 'green' | 'red' | 'amber' | 'rose'
  }> = [
    {
      label: 'Total updates',
      value: summary?.totalUpdated ?? '—',
      tone: 'neutral',
    },
    {
      label: 'Showed',
      value: summary?.countsByOutcome?.showed ?? 0,
      tone: 'green',
    },
    {
      label: 'No-show',
      value: summary?.countsByOutcome?.no_show ?? 0,
      tone: 'red',
    },
    {
      label: 'Won',
      value: summary?.countsByOutcome?.won ?? 0,
      tone: 'green',
    },
    {
      label: 'Lost',
      value: summary?.countsByOutcome?.lost ?? 0,
      tone: 'amber',
    },
    {
      label: 'Unreviewed',
      value: summary?.totalUnreviewed ?? 0,
      tone: 'rose',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((item) => (
        <div
          key={item.label}
          className={cn(
            'rounded-xl border p-3 transition',
            toneClasses(item.tone),
          )}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            {item.label}
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {loading ? '—' : item.value}
          </p>
        </div>
      ))}
    </div>
  )
}

function toneClasses(tone: 'neutral' | 'green' | 'red' | 'amber' | 'rose') {
  switch (tone) {
    case 'green':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
    case 'red':
      return 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
    case 'amber':
      return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
    case 'rose':
      return 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
    default:
      return 'border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200'
  }
}

/* -------------------------------------------------------------------------- */
/*  Filters bar                                                               */
/* -------------------------------------------------------------------------- */

function FiltersBar({
  reviewStatus,
  outcomeRaw,
  clientFilter,
  clientOptions,
  searchInput,
  onSearchInput,
}: {
  reviewStatus: string
  outcomeRaw: string
  clientFilter: string
  clientOptions: Array<{ id: string; name: string }>
  searchInput: string
  onSearchInput: (v: string) => void
}) {
  // URL helpers — every filter update mutates the current URL so the
  // state is shareable + back-button-friendly.
  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(window.location.search)
    if (value) p.set(key, value)
    else p.delete(key)
    const url = `${window.location.pathname}${p.toString() ? `?${p.toString()}` : ''}`
    window.history.replaceState(null, '', url)
    // Force React Query to refetch by triggering a soft navigation event.
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <FilterSelect
        label="Review"
        value={reviewStatus}
        onChange={(v) => setParam('reviewStatus', v === 'all' ? null : v)}
        options={[
          { value: 'all', label: 'All' },
          { value: 'unreviewed', label: 'Unreviewed' },
          { value: 'reviewed', label: 'Reviewed' },
        ]}
      />
      <FilterSelect
        label="Outcome"
        value={outcomeRaw}
        onChange={(v) => setParam('outcome', v || null)}
        options={[
          { value: '', label: 'All' },
          { value: 'showed', label: 'Showed' },
          { value: 'no_show', label: 'No-show' },
          { value: 'won', label: 'Won' },
          { value: 'lost', label: 'Lost' },
        ]}
      />
      <FilterSelect
        label="Client"
        value={clientFilter}
        onChange={(v) => setParam('clientId', v || null)}
        options={[
          { value: '', label: 'All clients' },
          ...clientOptions.map((c) => ({ value: c.id, label: c.name })),
        ]}
      />
      <div className="flex flex-1 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-800">
        <Search className="h-3.5 w-3.5 text-zinc-400" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => onSearchInput(e.target.value)}
          placeholder="Search name, phone, address, notes…"
          className="w-full bg-transparent text-xs outline-none placeholder:text-zinc-400"
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => onSearchInput('')}
            className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 focus:border-blue-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/* -------------------------------------------------------------------------- */
/*  Per-client section                                                        */
/* -------------------------------------------------------------------------- */

function ClientSection({
  section,
  onView,
  focusedId,
}: {
  section: Section
  onView: (id: string) => void
  focusedId: string | null
}) {
  const [open, setOpen] = useState(true)
  // Auto-expand the section that contains the focused appointment
  // when ?focus= is set. Otherwise we'd open the modal but the
  // backing card in the page would be hidden under a collapsed
  // section, which is jarring.
  useEffect(() => {
    if (!focusedId) return
    if (section.updated.some((a) => a.id === focusedId)) {
      setOpen(true)
    }
  }, [focusedId, section.updated])

  const hasUpdates = section.updated.length > 0
  const hasPending = section.pending.length > 0

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-950/40"
      >
        <div className="flex min-w-0 items-center gap-3">
          {open ? (
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-zinc-400" />
          ) : (
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-zinc-400" />
          )}
          <span
            className="h-3 w-3 flex-shrink-0 rounded-full"
            style={{ backgroundColor: section.client.color }}
            aria-hidden
          />
          <h2 className="truncate text-sm font-semibold">{section.client.name}</h2>
          {section.client.state && (
            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {section.client.state}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-zinc-500">
          <span>
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">
              {section.counts.updated}
            </span>{' '}
            updated
          </span>
          <span>·</span>
          <span>
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">
              {section.counts.pending}
            </span>{' '}
            awaiting
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-zinc-100 dark:border-zinc-800">
          {hasUpdates && (
            <div>
              <SubHeader label="Updated" tone="emerald" />
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {section.updated.map((a) => (
                  <UpdatedRow
                    key={a.id}
                    appointment={a}
                    onView={() => onView(a.id)}
                  />
                ))}
              </ul>
            </div>
          )}
          {hasPending && (
            <div>
              <SubHeader label="Awaiting client review" tone="zinc" />
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {section.pending.map((a) => (
                  <PendingRow key={a.id} appointment={a} />
                ))}
              </ul>
            </div>
          )}
          {!hasUpdates && !hasPending && (
            <p className="px-4 py-6 text-center text-xs text-zinc-500">
              No matching appointments for this client.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function SubHeader({
  label,
  tone,
}: {
  label: string
  tone: 'emerald' | 'zinc'
}) {
  return (
    <div
      className={cn(
        'border-b px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider',
        tone === 'emerald'
          ? 'border-emerald-100 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300'
          : 'border-zinc-100 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400',
      )}
    >
      {label}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Updated row                                                               */
/* -------------------------------------------------------------------------- */

function UpdatedRow({
  appointment,
  onView,
}: {
  appointment: Appointment
  onView: () => void
}) {
  const reviewed = !!appointment.clientStatusReviewedAt
  const tone = outcomeTone(appointment.status)

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-3 px-4 py-3 transition',
        reviewed
          ? 'bg-white dark:bg-zinc-900'
          : 'bg-amber-50/40 dark:bg-amber-950/15',
      )}
    >
      <div
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
          tone.chipClass,
        )}
      >
        {tone.icon}
        {tone.label}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-semibold">
          {appointment.customerName}
        </p>
        <p className="truncate text-[11px] text-zinc-500">
          {formatDateTime(appointment.apptDateTime)}
          {appointment.address && ` · ${appointment.address}`}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 text-right text-[10px] text-zinc-500">
        <span
          title={
            appointment.clientStatusUpdatedAt
              ? new Date(appointment.clientStatusUpdatedAt).toLocaleString()
              : undefined
          }
        >
          Updated {formatRelative(appointment.clientStatusUpdatedAt)}
        </span>
        {reviewed && appointment.clientStatusReviewedBy && (
          <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-2.5 w-2.5" />
            Reviewed by {appointment.clientStatusReviewedBy.name}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onView}
        className="inline-flex items-center gap-1 rounded-md border border-yellow-400 bg-yellow-50 px-2.5 py-1 text-[11px] font-medium text-yellow-800 transition hover:bg-yellow-100 dark:border-yellow-500 dark:bg-yellow-950 dark:text-yellow-300 dark:hover:bg-yellow-900"
      >
        View update
      </button>
    </li>
  )
}

function PendingRow({ appointment }: { appointment: Appointment }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-xs text-zinc-600 dark:text-zinc-400">
      <span
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
        title={
          appointment.hasDbRow
            ? "Client hasn't reported back yet"
            : 'Sheet-only row — no client login path to update this one'
        }
      >
        <Clock className="h-2.5 w-2.5" />
        {appointment.status}
      </span>
      <div className="min-w-0 flex-1 truncate">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          {appointment.customerName}
        </span>
        <span className="text-zinc-400">
          {' '}
          · {formatDateTime(appointment.apptDateTime)}
        </span>
      </div>
      {appointment.sourceKind === 'secondary' && (
        <span
          className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-700 dark:bg-violet-950 dark:text-violet-300"
          title="Imported from a partner secondary sheet (Yassin's pipeline)"
        >
          partner
        </span>
      )}
      {!appointment.hasDbRow && appointment.sourceKind !== 'secondary' && (
        <span
          className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          title="Sheet row without a Hub appointment — clients can't update this one from their dashboard"
        >
          sheet
        </span>
      )}
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/*  Modal                                                                     */
/* -------------------------------------------------------------------------- */

function ViewUpdateModal({
  client,
  appointment,
  onClose,
}: {
  client: { id: string; name: string; color: string }
  appointment: Appointment
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const reviewed = !!appointment.clientStatusReviewedAt
  const tone = outcomeTone(appointment.status)

  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await fetch(
        `/api/call-center/status-updates/${appointment.id}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewed: next }),
        },
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to update')
      }
      return res.json()
    },
    onSuccess: () => {
      // Refresh both the list and the badge count.
      queryClient.invalidateQueries({ queryKey: ['status-updates'] })
      queryClient.invalidateQueries({ queryKey: ['status-updates-summary'] })
    },
  })

  // Close on Escape — small UX touch but essential for keyboard
  // navigation through a triage backlog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: client.color }}
                aria-hidden
              />
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {client.name}
              </span>
            </div>
            <h2 className="text-xl font-bold">{appointment.customerName}</h2>
            <p className="text-sm text-zinc-500">
              {formatDateTime(appointment.apptDateTime)}
              {appointment.address && ` · ${appointment.address}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <div
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-bold uppercase tracking-wider',
              tone.chipClass,
            )}
          >
            {tone.icon}
            {tone.label}
          </div>
          {appointment.previousStatus && (
            <span className="text-xs text-zinc-500">
              was{' '}
              <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {appointment.previousStatus}
              </span>
            </span>
          )}
          <span
            className="text-xs text-zinc-400"
            title={
              appointment.clientStatusUpdatedAt
                ? new Date(appointment.clientStatusUpdatedAt).toLocaleString()
                : undefined
            }
          >
            · {formatRelative(appointment.clientStatusUpdatedAt)}
          </span>
        </div>

        {appointment.clientNotes && (
          <div className="mt-5">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
              What the client said
            </p>
            <div className="whitespace-pre-wrap rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
              {appointment.clientNotes}
            </div>
          </div>
        )}

        {appointment.notes && (
          <div className="mt-4">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              Notes from the call (Mary)
            </p>
            <div className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
              {appointment.notes}
            </div>
          </div>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <DetailItem label="Customer phone">
            <span className="font-mono">{appointment.customerPhone}</span>
          </DetailItem>
          <DetailItem label="Booked by">
            {appointment.bookedByName || '—'}
          </DetailItem>
          <DetailItem label="Bill">
            {appointment.monthlyBill ? `$${appointment.monthlyBill}/mo` : '—'}
          </DetailItem>
          <DetailItem label="Utility">
            {appointment.utilityProvider || '—'}
          </DetailItem>
        </dl>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          {appointment.recordingUrl && (
            <a
              href={appointment.recordingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200 dark:hover:bg-blue-900"
            >
              <Play className="h-3 w-3" />
              Listen to call
            </a>
          )}
          <a
            href={`/call-center/master-tracker?focus=${encodeURIComponent(appointment.id)}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ExternalLink className="h-3 w-3" />
            Open in Master Tracker
          </a>
          <button
            type="button"
            onClick={() => mutation.mutate(!reviewed)}
            disabled={mutation.isPending}
            className={cn(
              'ml-auto inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition disabled:opacity-60',
              reviewed
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/40'
                : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800',
            )}
          >
            {mutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : reviewed ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : null}
            {reviewed ? 'Reviewed · click to unmark' : 'Mark as reviewed'}
          </button>
        </div>
        {mutation.isError && (
          <p className="mt-2 text-right text-xs text-rose-600 dark:text-rose-400">
            {(mutation.error as Error).message}
          </p>
        )}
      </div>
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
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-zinc-700 dark:text-zinc-300">{children}</dd>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function outcomeTone(status: string): {
  label: string
  icon: React.ReactNode
  chipClass: string
} {
  switch (status.toLowerCase()) {
    case 'showed':
      return {
        label: 'Showed',
        icon: <CheckCircle2 className="h-3 w-3" />,
        chipClass:
          'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
      }
    case 'no_show':
      return {
        label: 'No-show',
        icon: <X className="h-3 w-3" />,
        chipClass:
          'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
      }
    case 'won':
      return {
        label: 'Won',
        icon: <CheckCircle2 className="h-3 w-3" />,
        chipClass:
          'border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
      }
    case 'lost':
      return {
        label: 'Lost',
        icon: <X className="h-3 w-3" />,
        chipClass:
          'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
      }
    default:
      return {
        label: status,
        icon: <Clock className="h-3 w-3" />,
        chipClass:
          'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
      }
  }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return iso
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'just now'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'just now'
  const diff = Date.now() - then
  if (diff < 60_000) return 'just now'
  if (diff < 60 * 60_000) {
    const m = Math.round(diff / 60_000)
    return `${m}m ago`
  }
  if (diff < 24 * 60 * 60_000) {
    const h = Math.round(diff / (60 * 60_000))
    return `${h}h ago`
  }
  const d = Math.round(diff / (24 * 60 * 60_000))
  return `${d}d ago`
}
