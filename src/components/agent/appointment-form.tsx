'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { ArrowLeft, Save, Trash2, AlertCircle, CheckCircle2, CalendarClock, Building2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppointmentDateTimePicker } from '@/components/agent/appointment-datetime-picker'
import { AddressFields } from '@/components/agent/address-fields'
import { AddressMapPreview } from '@/components/agent/address-map-preview'
import { PhoneEntriesField } from '@/components/agent/phone-entries-field'
import { SolarInsightsCard } from '@/components/agent/solar-insights-card'
import { parseAddress, STATE_NAME_TO_CODE } from '@/lib/address'
import { resolveCustomerTimezone, wallClockInTzToUtcIso } from '@/lib/timezone'

type Conflict = {
  id: string
  apptDateTime: string
  customerName: string
  customerPhone: string
  status: string
  agent: { id: string; name: string | null; email: string }
}

/** Strip everything but digits and take the last 10 — gives us a
 *  stable comparison key that doesn't care about formatting
 *  ("(603) 555-1234" vs "+16035551234" vs "603.555.1234" all match). */
function phoneDigits(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = String(raw).replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : digits
}

type Client = {
  id: string
  name: string
  state: string | null
  color: string
  contactName: string | null
}

export type AppointmentFormValues = {
  apptDateTime: string // ISO datetime-local format (YYYY-MM-DDTHH:mm)
  clientId: string
  customerName: string
  customerPhone: string
  address: string
  email: string
  monthlyBill: string
  utilityProvider: string
  roofType: string
  roofAge: string
  status: string
  estimatedDealValue: string
  notes: string
  callRecordingLink: string
  /** Free-text name of the call-center agent who took the call.
   *  Distinct from the Hub user submitting the form (Mary). When
   *  empty, displays + sheet sync fall back to the submitter's
   *  own name. */
  bookedByName: string
}

const EMPTY: AppointmentFormValues = {
  apptDateTime: '',
  clientId: '',
  customerName: '',
  customerPhone: '',
  address: '',
  email: '',
  monthlyBill: '',
  utilityProvider: '',
  roofType: '',
  roofAge: '',
  status: 'booked',
  estimatedDealValue: '',
  notes: '',
  callRecordingLink: '',
  bookedByName: '',
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'booked', label: 'Booked' },
  { value: 'rescheduled', label: 'Rescheduled' },
  { value: 'showed', label: 'Showed' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'no_show', label: 'No-show' },
  { value: 'cancelled', label: 'Cancelled' },
]

const ROOF_OPTIONS = ['Asphalt Shingle', 'Tile', 'Metal', 'Flat', 'Wood Shake', 'Other']

/**
 * Used for both creation (mode='create') and editing (mode='edit').
 * Caller provides initial values (empty or the fetched appointment). On
 * successful submit the form routes back to /agent.
 */
export function AppointmentForm({
  mode,
  appointmentId,
  initial = EMPTY,
  initialSolarSummary = null,
}: {
  mode: 'create' | 'edit'
  appointmentId?: string
  initial?: AppointmentFormValues
  /** Snapshotted Solar API summary loaded from the appointment row
   *  (edit mode only). Lets the SolarInsightsCard render the saved
   *  result immediately instead of the "Check solar potential"
   *  button. Null on create — no snapshot exists yet. */
  initialSolarSummary?: unknown
}) {
  const router = useRouter()
  // Edit-mode prefill: PhoneEntriesField runs its own parser
  // (parsePhoneEntries) over the saved string, splitting it back into
  // labeled rows. Don't run formatPhoneInput here — it strips
  // non-digit context including labels + line breaks, which would
  // collapse "(555) 111 Mobile\n(555) 222 Home" into just one
  // mangled number. The parse-then-reformat happens row-by-row inside
  // PhoneEntriesField now.
  const [values, setValues] = useState<AppointmentFormValues>(() => ({
    ...initial,
  }))
  const [submitting, setSubmitting] = useState(false)

  // Clients available for booking (Brighton Capital Solar, Spring Solar, …).
  // Stable across the session; short staleTime keeps the picker fresh if
  // staff adds a client via SQL while the form is open.
  const clientsQuery = useQuery<{ clients: Client[] }>({
    queryKey: ['clients'],
    queryFn: async () => {
      const res = await fetch('/api/clients')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
    staleTime: 60_000,
  })
  const clients = clientsQuery.data?.clients ?? []
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overrideConflict, setOverrideConflict] = useState(false)
  /** Conflict IDs the agent has explicitly acknowledged by ticking
   *  "Book anyway". Sent to the server so it can distinguish "you
   *  accepted these" from "a new conflict appeared mid-submit". */
  const [acknowledgedIds, setAcknowledgedIds] = useState<string[]>([])
  /** If the server returns 409 with fresh conflicts (race detected),
   *  store them here so the warning panel renders the latest state. */
  const [raceConflicts, setRaceConflicts] = useState<Conflict[] | null>(null)
  /** Timestamp when raceConflicts was set. Used to decide whether the
   *  background query has run since — if so, its data is fresher and we
   *  drop the race snapshot. Avoids a setState-in-effect pattern. */
  const [raceSetAt, setRaceSetAt] = useState(0)

  function set<K extends keyof AppointmentFormValues>(key: K, val: AppointmentFormValues[K]) {
    setValues((v) => ({ ...v, [key]: val }))
    // Any time the date/time changes, the prior "I accept the conflict"
    // choice no longer applies — the agent should see conflicts again.
    if (key === 'apptDateTime') {
      setOverrideConflict(false)
      setAcknowledgedIds([])
      setRaceConflicts(null)
    }
  }

  // Auto-pick the client based on the address state. Each Genisys
  // client serves a distinct state (Brighton=AZ, Spring=UT,
  // Energy Upgrade=CA), so the address state code is enough to know
  // which one this booking is for. Only kicks in when the parsed
  // state actually changes — that way once the agent manually picks
  // a different client, our follow-up renders don't fight them.
  // Edit mode opts out so a saved appointment's clientId is never
  // silently rewritten by an address re-parse on load.
  const lastAutoStateRef = useRef<string>('')
  useEffect(() => {
    if (mode !== 'create') return
    if (clients.length === 0) return
    const parsedState = parseAddress(values.address).state
    if (!parsedState) return
    if (parsedState === lastAutoStateRef.current) return
    const match = clients.find((c) => {
      if (!c.state) return false
      const code = STATE_NAME_TO_CODE[c.state.toLowerCase()] || c.state.toUpperCase()
      return code === parsedState
    })
    lastAutoStateRef.current = parsedState
    if (match && match.id !== values.clientId) {
      set('clientId', match.id)
    }
    // We intentionally don't depend on values.clientId — that would
    // re-fire the effect after we set it and risk a loop. Same reason
    // for omitting `set` (a fresh closure each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.address, clients, mode])

  // Conflict check — runs as soon as the agent picks a date/time. Uses
  // TanStack Query's dedup/caching so repeated date picks don't hammer
  // the API. Skips when the datetime is empty or invalid.
  const isoCandidate = (() => {
    if (!values.apptDateTime) return null
    const d = new Date(values.apptDateTime)
    return isNaN(d.getTime()) ? null : d.toISOString()
  })()

  const conflictsQuery = useQuery<{ conflicts: Conflict[] }>({
    queryKey: ['agent-appt-conflicts', isoCandidate, values.clientId, appointmentId ?? null],
    queryFn: async () => {
      const sp = new URLSearchParams({ at: isoCandidate!, clientId: values.clientId })
      if (appointmentId) sp.set('exclude', appointmentId)
      const res = await fetch(`/api/agent/appointments/conflicts?${sp.toString()}`)
      if (!res.ok) throw new Error('Failed to check conflicts')
      return res.json()
    },
    // Conflicts are per-client (different closers / calendars), so we
    // can't check until a client is picked. The form blocks submit on
    // missing clientId separately.
    enabled: !!isoCandidate && !!values.clientId,
    // Short stale to catch bookings from other agents happening in parallel
    staleTime: 5_000,
  })
  // Race conflicts (from a server 409) take precedence over the background
  // check until the background query actually refetches past the race
  // moment. dataUpdatedAt bumps on every refetch (even when data is
  // unchanged), so comparing it to raceSetAt cleanly tells us when the
  // race snapshot has been superseded by fresh live data. Derived on
  // render — no setState-in-effect needed.
  const liveUpdatedAt = conflictsQuery.dataUpdatedAt
  const raceSnapshotStillAuthoritative =
    raceConflicts !== null && liveUpdatedAt < raceSetAt
  const conflicts = raceSnapshotStillAuthoritative
    ? raceConflicts!
    : conflictsQuery.data?.conflicts ?? []
  const hasConflicts = conflicts.length > 0

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // Defensive: browser can fire onSubmit twice if the user presses Enter
    // in quick succession — the button's `disabled` attribute only reflects
    // the previous render, so this early-return protects the network call.
    if (submitting) return
    setError(null)

    // Hard gate: new appointments must identify a Genisys client. Existing
    // (pre-feature) appointments can be edited without reassignment.
    if (mode === 'create' && !values.clientId) {
      setError('Please pick which client this appointment is for.')
      return
    }

    // Street is now mandatory — the HTML5 `required` on the street
    // input catches empty submits in the browser, but we double-check
    // here so a paste-then-edit flow that ends up with city/state but
    // no street still gets a clear error message instead of silently
    // saving a half-empty address.
    if (!parseAddress(values.address).street.trim()) {
      setError('Please enter a street address for the appointment.')
      return
    }

    // Hard gate: if there's a known conflict and the agent hasn't explicitly
    // acknowledged it, refuse submit. The override checkbox below the
    // warning flips overrideConflict and re-enables the Save button.
    if (hasConflicts && !overrideConflict) {
      setError(
        'Time conflicts with existing booking(s). Review below and tick "Book anyway" to override.'
      )
      return
    }

    // Client-side URL scheme check on the call recording link. Server
    // should also validate, but reject javascript:/data: etc. here to
    // prevent obvious XSS payloads from reaching the DB.
    if (values.callRecordingLink.trim()) {
      const link = values.callRecordingLink.trim()
      if (!/^https?:\/\//i.test(link)) {
        setError(
          'Call recording link must start with http:// or https://'
        )
        return
      }
    }

    setSubmitting(true)

    const url =
      mode === 'create'
        ? '/api/agent/appointments'
        : `/api/agent/appointments/${appointmentId}`
    const method = mode === 'create' ? 'POST' : 'PATCH'

    // Interpret the date/time picker's value as wall-clock in the
    // CUSTOMER's timezone, not Mary's browser. Mary in the Philippines
    // typing "9 AM" for a California customer means "9 AM California
    // time" — without this, JS's default parser interprets it as
    // "9 AM Manila" which is ~16 hours off. See wallClockInTzToUtcIso
    // for the exact mechanic.
    //
    // Tz lookup falls back through three tiers: address → selected
    // client's state → default (NY). The client-state fallback is
    // belt-and-suspenders — even if the address is briefly empty
    // (form just opened, Mary editing the address, etc.) we still
    // pin the time to the right zone via the picked client.
    const selectedClient = clients.find((c) => c.id === values.clientId)
    const customerTz = resolveCustomerTimezone({
      address: values.address,
      clientState: selectedClient?.state ?? null,
    })
    const apptIso = values.apptDateTime
      ? wallClockInTzToUtcIso(values.apptDateTime, customerTz) ??
        // Fallback to default-tz interpretation if parsing somehow
        // fails — keeps the form submittable rather than throwing.
        new Date(values.apptDateTime).toISOString()
      : null

    const body = {
      apptDateTime: apptIso,
      clientId: values.clientId || null,
      customerName: values.customerName,
      customerPhone: values.customerPhone,
      address: values.address || null,
      email: values.email || null,
      monthlyBill: values.monthlyBill || null,
      utilityProvider: values.utilityProvider || null,
      roofType: values.roofType || null,
      roofAge: values.roofAge || null,
      status: values.status,
      estimatedDealValue: values.estimatedDealValue || null,
      notes: values.notes || null,
      callRecordingLink: values.callRecordingLink || null,
      bookedByName: values.bookedByName.trim() || null,
      acknowledgedConflictIds: acknowledgedIds,
    }

    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setSubmitting(false)

    if (!res.ok) {
      // 409 with CONFLICT_RACE means another booking landed in the same
      // slot between the agent's acknowledgment and their save. Refresh
      // the warning panel with the server's current conflict list and
      // make the agent re-acknowledge. No data was saved.
      if (res.status === 409 && data.code === 'CONFLICT_RACE') {
        setRaceConflicts((data.conflicts as Conflict[]) || [])
        setRaceSetAt(Date.now())
        setOverrideConflict(false)
        setAcknowledgedIds([])
        setError(
          'There\'s a conflict at this time slot that needs your attention. Scroll up, review the warning, and either click "Edit this one" if it\'s the same customer — or re-tick "Book anyway" if you still want to create a separate record.'
        )
        return
      }
      setError(data.error || 'Failed to save appointment.')
      return
    }

    router.push('/agent')
    router.refresh()
  }

  async function onDelete() {
    if (!appointmentId) return
    if (!confirm('Delete this appointment? This cannot be undone.')) return
    setDeleting(true)
    const res = await fetch(`/api/agent/appointments/${appointmentId}`, {
      method: 'DELETE',
    })
    setDeleting(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to delete.')
      return
    }
    router.push('/agent')
    router.refresh()
  }

  // Compute the picked client once per render so the address
  // autocomplete (and any future component) can lean on the same
  // lookup the form-submit handler already does on line ~289.
  const selectedClient = clients.find((c) => c.id === values.clientId) ?? null

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center justify-between">
        <Link
          href="/agent"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-blue-600"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-xl font-bold">
          {mode === 'create' ? 'New appointment' : 'Edit appointment'}
        </h1>
      </div>

      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
      >
        {/* Client picker — required on create. Sits at the top because
            choosing the right client is the first branching decision an
            agent has to make before anything else makes sense. */}
        <Field label="Booking for which client?" required>
          {clientsQuery.isLoading ? (
            <div className="text-xs text-zinc-400">Loading clients…</div>
          ) : clients.length === 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              No clients configured yet. Contact an admin.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {clients.map((c) => {
                const active = values.clientId === c.id
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => set('clientId', c.id)}
                    disabled={submitting}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border-2 px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-50',
                      active
                        ? 'border-transparent text-white shadow-md'
                        : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-zinc-900'
                    )}
                    style={active ? { backgroundColor: c.color } : undefined}
                  >
                    <Building2 className="h-4 w-4 flex-shrink-0" />
                    <span className="flex flex-col items-start leading-tight">
                      <span>{c.name}</span>
                      {c.state && (
                        <span
                          className={cn(
                            'text-[10px] font-normal',
                            active ? 'text-white/80' : 'text-zinc-400'
                          )}
                        >
                          {c.state}
                        </span>
                      )}
                      {c.contactName && (
                        <span
                          className={cn(
                            'text-[10px] font-normal',
                            active ? 'text-white/70' : 'text-zinc-400'
                          )}
                        >
                          {c.contactName}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </Field>

        <Field label="Appointment date & time" required>
          <AppointmentDateTimePicker
            value={values.apptDateTime}
            onChange={(next) => set('apptDateTime', next)}
            disabled={submitting}
          />
          {/* Customer-tz hint — same resolver the submit uses, so
              what Mary sees here is exactly what gets stored. Tz is
              derived from address first (most specific), then from
              the selected client's state as a fallback so the hint
              is useful even when she's still typing the address. */}
          {(() => {
            const selected = clients.find((c) => c.id === values.clientId)
            const tz = resolveCustomerTimezone({
              address: values.address,
              clientState: selected?.state ?? null,
            })
            const shortLabel = (() => {
              try {
                const parts = new Intl.DateTimeFormat('en-US', {
                  timeZone: tz,
                  timeZoneName: 'short',
                }).formatToParts(new Date())
                return (
                  parts.find((p) => p.type === 'timeZoneName')?.value ?? tz
                )
              } catch {
                return tz
              }
            })()
            const sourceLabel = values.address?.trim()
              ? 'from the address'
              : selected?.state
                ? `from ${selected.name} (${selected.state})`
                : 'default — pick a client or add an address'
            return (
              <p className="mt-1.5 text-[11px] text-zinc-500">
                Time is read at the customer&apos;s clock —{' '}
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {shortLabel}
                </span>{' '}
                ({tz}).{' '}
                <span className="text-zinc-400">{sourceLabel}.</span>
              </p>
            )
          })()}
          {isoCandidate && hasConflicts && (() => {
            // Compare each conflict's customerPhone against what the
            // agent typed — if they match (last 10 digits), this is the
            // same customer rebooking and the right action is to edit
            // the existing appointment, not create a duplicate.
            const typedDigits = phoneDigits(values.customerPhone)
            const isSameCustomer = (c: Conflict) =>
              typedDigits.length === 10 &&
              phoneDigits(c.customerPhone) === typedDigits
            const sameCustomerConflicts = conflicts.filter(isSameCustomer)
            const otherConflicts = conflicts.filter((c) => !isSameCustomer(c))
            const hasSameCustomer = sameCustomerConflicts.length > 0
            // Sort so same-customer rows render at the top (most
            // actionable), then everything else.
            const orderedConflicts = [
              ...sameCustomerConflicts,
              ...otherConflicts,
            ]
            return (
            <div
              className={cn(
                'mt-2 rounded-md border p-3 text-xs',
                hasSameCustomer
                  ? 'border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950'
                  : 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950',
              )}
            >
              <div
                className={cn(
                  'flex items-start gap-2',
                  hasSameCustomer
                    ? 'text-rose-900 dark:text-rose-200'
                    : 'text-amber-900 dark:text-amber-200',
                )}
              >
                <CalendarClock className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  {hasSameCustomer ? (
                    <>
                      <p className="font-semibold">
                        This customer already has an appointment.
                      </p>
                      <p className="mt-0.5 text-rose-800 dark:text-rose-300">
                        Don&apos;t create a duplicate — open the existing
                        appointment and update its date/time + notes
                        instead. Use the &quot;Edit this one&quot; button
                        below.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold">
                        Time conflicts with {conflicts.length} existing
                        booking{conflicts.length === 1 ? '' : 's'}
                      </p>
                      <p className="mt-0.5 text-amber-800 dark:text-amber-300">
                        This client already has something booked within an
                        hour of this slot — the closer can&apos;t take two
                        at once. Bookings for other clients in the same
                        timeframe are fine and won&apos;t show up here.
                      </p>
                    </>
                  )}
                  <ul className="mt-2 space-y-1.5">
                    {orderedConflicts.map((c) => {
                      const when = new Date(c.apptDateTime)
                      const same = isSameCustomer(c)
                      return (
                        <li
                          key={c.id}
                          className="flex flex-wrap items-start gap-x-2 gap-y-1"
                        >
                          <span
                            className={cn(
                              'mt-0.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full',
                              same ? 'bg-rose-500' : 'bg-amber-500',
                            )}
                          />
                          <span className="flex-1 min-w-0">
                            <span className="font-medium">
                              {when.toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                                hour12: true,
                              })}
                            </span>
                            {' — '}
                            {c.customerName} ({c.customerPhone})
                            {same && (
                              <span className="ml-1.5 rounded-full bg-rose-200 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-800 dark:bg-rose-900 dark:text-rose-200">
                                Same customer
                              </span>
                            )}
                            {c.agent.name && (
                              <span
                                className={cn(
                                  'ml-1',
                                  same
                                    ? 'text-rose-700 dark:text-rose-400'
                                    : 'text-amber-700 dark:text-amber-400',
                                )}
                              >
                                · booked by {c.agent.name}
                              </span>
                            )}
                            <span
                              className={cn(
                                'ml-2 rounded-full px-1.5 py-0.5 text-[9px] font-semibold',
                                c.status === 'booked'
                                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                                  : c.status === 'showed'
                                    ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                                    : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
                              )}
                            >
                              {c.status}
                            </span>
                          </span>
                          {/* Edit-this-one shortcut: takes the agent
                              straight to the existing appointment's
                              edit page so they can update date/time
                              + notes instead of creating a duplicate.
                              Mary's main blocker per Ethan, 2026-05-08. */}
                          <Link
                            href={`/agent/appointments/${c.id}`}
                            className={cn(
                              'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold transition',
                              same
                                ? 'bg-rose-600 text-white hover:bg-rose-700'
                                : 'border border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900',
                            )}
                            title="Open this appointment to edit its date/time and notes instead of creating a duplicate."
                          >
                            {same ? 'Edit this one →' : 'Edit →'}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                  <label
                    className={cn(
                      'mt-3 flex items-center gap-2',
                      hasSameCustomer
                        ? 'text-rose-900 dark:text-rose-200'
                        : 'text-amber-900 dark:text-amber-200',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={overrideConflict}
                      onChange={(e) => {
                        setOverrideConflict(e.target.checked)
                        // Snapshot the current conflict IDs. Server re-checks
                        // these at save time — any newer conflict the agent
                        // didn't acknowledge triggers a 409 re-prompt.
                        setAcknowledgedIds(
                          e.target.checked ? conflicts.map((c) => c.id) : []
                        )
                        // Clear the race-only list once the user re-acks so
                        // the form drops back to the background query's data.
                        if (e.target.checked) setRaceConflicts(null)
                      }}
                      className={cn(
                        'h-3.5 w-3.5 rounded text-blue-600 focus:ring-blue-500',
                        hasSameCustomer ? 'border-rose-400' : 'border-amber-400',
                      )}
                    />
                    <span className="text-xs font-medium">
                      {hasSameCustomer
                        ? 'Book anyway — I know this is the same customer and I want a second record'
                        : "Book anyway — there's a reason to double-book this slot"}
                    </span>
                  </label>
                </div>
              </div>
            </div>
            )
          })()}
          {conflictsQuery.isFetching && !hasConflicts && isoCandidate && (
            <p className="mt-1 text-[10px] text-zinc-400">Checking for conflicts…</p>
          )}
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Customer's name" required>
            <input
              type="text"
              value={values.customerName}
              onChange={(e) => set('customerName', e.target.value)}
              required
              className={inputCls}
            />
          </Field>

          <Field label="Customer's phone number(s)" required>
            {/* Multi-row entry so Mary can label Mobile vs Home when
                a customer hands over both. Underneath it serializes
                to a single string ("(555) 111 Mobile\n(555) 222
                Home") matching parsePhoneEntries' format — Master
                Tracker + reminder dispatch already speak that shape. */}
            <PhoneEntriesField
              value={values.customerPhone}
              onChange={(combined) => set('customerPhone', combined)}
              required
              disabled={submitting}
              inputClassName={inputCls}
            />
          </Field>
        </div>

        {/* "Booked by" — free-text agent name. Mary records which of
            her call-center agents actually took this call. The Hub
            user submitting the form (her) is captured separately as
            agentUserId; this field is what gets surfaced to clients
            on the master sheet's Agent Name column. */}
        <Field label="Booked by (call-center agent)">
          <input
            type="text"
            value={values.bookedByName}
            onChange={(e) => set('bookedByName', e.target.value)}
            placeholder="e.g., John Smith"
            autoComplete="off"
            className={inputCls}
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            Optional. Leave blank to use your own name.
          </p>
        </Field>

        {/* Four-field address with OSM autocomplete. The component
            translates between its own parts and a single combined
            string here, so values.address stays a flat string and the
            DB / sheet schema doesn't have to change. Street is the
            only mandatory part — city / state / zip are nice-to-have
            but the appointment is still useful with just a street. */}
        <Field label="Address" required>
          {/* Bias autocomplete to the picked client's state so e.g.
              when Mary picks "Sunny Sky Solar" (NJ) and types
              "123 Main St", suggestions narrow to NJ addresses
              instead of every "123 Main St" in the country. Same
              behavior the client onboarding form has. Falls through
              to unbiased nationwide when no client is picked yet. */}
          <AddressFields
            value={values.address}
            onChange={(combined) => set('address', combined)}
            disabled={submitting}
            requireStreet
            stateBias={selectedClient?.state ?? null}
          />
          {/* Embedded Google Maps preview lights up once a vault
              entry named "Google Maps Key" is configured. Until
              then it renders nothing (503 from the API → silent),
              so this can ship ahead of the key landing. */}
          <AddressMapPreview address={values.address} />
          {/* Manual "Check solar potential" button — Mary clicks
              when she wants Google's roof analysis for the customer.
              Cached per address so re-checks are free. Hides itself
              quietly if the same vault key isn't configured.
              Edit mode passes the snapshotted summary from the
              appointment row so the result renders immediately. */}
          <SolarInsightsCard
            address={values.address}
            initialSummary={
              initialSolarSummary as React.ComponentProps<
                typeof SolarInsightsCard
              >['initialSummary']
            }
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
            className={inputCls}
          />
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Monthly bill">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">
                $
              </span>
              <input
                type="text"
                value={values.monthlyBill}
                onChange={(e) => set('monthlyBill', e.target.value)}
                placeholder="150"
                className={cn(inputCls, 'pl-6')}
              />
            </div>
          </Field>

          <Field label="Utility provider">
            <input
              type="text"
              value={values.utilityProvider}
              onChange={(e) => set('utilityProvider', e.target.value)}
              placeholder="PG&E, Eversource, etc."
              className={inputCls}
            />
          </Field>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Roof type">
            <select
              value={values.roofType}
              onChange={(e) => set('roofType', e.target.value)}
              className={inputCls}
            >
              <option value="">—</option>
              {ROOF_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Roof age"
            // Server normalizes shorthand on save: "5" → "5 years",
            // "5-10" → "5-10 years", "10+" → "10+ years". The hint
            // tells agents they don't need to type "years" themselves.
            hint='Just a number works — "5", "5-10", or "10+" all become "… years" on the sheet.'
          >
            <input
              type="text"
              value={values.roofAge}
              onChange={(e) => set('roofAge', e.target.value)}
              placeholder="e.g. 5, 5-10, or 10+"
              className={inputCls}
            />
          </Field>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Appointment status">
            <select
              value={values.status}
              onChange={(e) => set('status', e.target.value)}
              className={inputCls}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Estimated deal value">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">
                $
              </span>
              <input
                type="text"
                value={values.estimatedDealValue}
                onChange={(e) => set('estimatedDealValue', e.target.value)}
                placeholder="Optional"
                className={cn(inputCls, 'pl-6')}
              />
            </div>
          </Field>
        </div>

        <Field label="Notes">
          <textarea
            value={values.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={4}
            placeholder="Anything the closer should know before the appointment…"
            className={cn(inputCls, 'font-normal leading-relaxed')}
          />
        </Field>

        <Field label="Call recording link (optional)">
          <input
            // type=text (not url) so agents can paste anything — partial URLs,
            // internal paths, or leave it blank — without browser validation
            // rejecting the submit.
            type="text"
            value={values.callRecordingLink}
            onChange={(e) => set('callRecordingLink', e.target.value)}
            placeholder="https://microtalk.dialler.net/RECORDINGS/..."
            className={cn(inputCls, 'font-mono text-xs')}
          />
        </Field>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          {mode === 'edit' ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting || submitting}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:bg-red-950/20 dark:hover:bg-red-950/40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            <Link
              href="/agent"
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={submitting || deleting || (hasConflicts && !overrideConflict)}
              title={
                hasConflicts && !overrideConflict
                  ? 'Resolve the time conflict above, or tick "Book anyway" to override'
                  : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {mode === 'create' ? <Save className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {submitting ? 'Saving…' : mode === 'create' ? 'Save appointment' : 'Save changes'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950'

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  /** Optional helper text shown under the input — used to telegraph
   *  server-side normalization (e.g. "5" becomes "5 years"). */
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] text-zinc-500 dark:text-zinc-500">
          {hint}
        </span>
      )}
    </label>
  )
}
