'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  Send,
  Hash,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
// PageHeader + CallCenterTabs are provided by /call-center/layout.tsx.
import { StatCard } from '@/components/ui/stat-card'
import { parsePhoneEntries } from '@/lib/phone'
import {
  AGENT_TIMEZONE,
  resolveCustomerTimezone,
  sameDayInTz,
} from '@/lib/timezone'

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
  county: string | null
  email: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
  status: string
  /** Hub-only dispatch lifecycle (the Dispatch Status dropdown).
   *  not_dispatched | dispatched | confirmed | reschedule_requested |
   *  rescheduled | needs_review */
  dispatchStatus: string
  /** Manual hand-off flag — yes / no / unassigned. Goes away once
   *  the Slack auto-deliver workflow ships. */
  sentToClient: 'yes' | 'no' | 'unassigned'
  /** Optional explicit tz override Mary typed into the sheet's
   *  Timezone column. Empty / null = the row was parsed via address
   *  inference. Surfaced in the UI so admins can see exactly which
   *  source pinned this row's wall-clock time. */
  timezone: string | null
  /** IANA zone the row was actually parsed in (explicit when set,
   *  address-derived otherwise). The time column displays in this
   *  zone so the Master Tracker view always matches what the
   *  customer sees. */
  resolvedTimezone: string
  /** Slack channel delivery status for this row, surfaced from the
   *  SheetSlackDelivery ledger so the row can render a "Delivered ✓"
   *  pill or a manual "Deliver" button. Null = no delivery record
   *  exists yet (cron sync hasn't picked it up, or it was wiped). */
  slackDelivery?: {
    status: 'delivered' | 'backfilled' | 'failed' | string
    messageTs: string | null
    /** Slack permalink for the delivered message — set when the
     *  post was successfully verified via chat.getPermalink. Click
     *  to jump straight to the channel post and confirm visually. */
    permalink: string | null
    deliveredAt: string | null
    channelId: string
  } | null
  /** Sheet rowNumbers of other rows that look like the same booking
   *  (matching normalized phone + address). Empty when this row has
   *  no probable duplicates. Used to render a warning chip so admins
   *  can spot double-entries without us silently hiding real data. */
  possibleDuplicateRowIds?: number[]
  estimatedDealValue: string | null
  notes: string | null
  callRecordingLink: string | null
  /** Hub-signed proxy URL — playable from any IP. Null when the
   *  proxy isn't configured (RECORDING_PROXY_SECRET unset) or the
   *  host isn't allowlisted. The Play button prefers this when
   *  present and falls back to the raw callRecordingLink. */
  callRecordingProxyUrl?: string | null
  /** Free-form notes the agency CLIENT (not the homeowner) attached
   *  via their dashboard "Update Status" flow. Distinct from `notes`
   *  (Mary's notes) — surfaced separately so the master tracker
   *  shows both perspectives. */
  clientNotes?: string | null
  /** Timestamp of the client's most recent status update from their
   *  dashboard. Drives the small "Client updated X ago" hint on
   *  the row so admin can spot fresh activity without clicking in. */
  clientStatusUpdatedAt?: string | null
  createdAt: string
  /** Honest "Logged At" cell from the sheet — null when blank. The
   *  "Set today / Set this week" filters key off this exclusively so
   *  they don't accidentally match by appointment date when Logged At
   *  is empty. */
  loggedAt: string | null
  agent: { id: string; name: string | null; email: string }
  client: {
    id: string
    name: string
    state: string | null
    color: string
    contactName: string | null
  } | null
  /** True when the client was inferred from the address state (because
   *  the Client column in the sheet was blank). Surfaced in the UI as a
   *  small hint so Ethan can spot which rows still need the Client
   *  column filled in upstream. */
  clientInferred?: boolean
  /** Which sheet this row came from. Primary = main "Master Table"
   *  (Mary's sheet). Secondary = a registered partner-call-center
   *  sheet (Yassin's Forward Energy / Brighton Capital). Mary's view
   *  filters secondaries out server-side, so on /agent/master-tracker
   *  this will always be 'primary'. Used here on the admin view to
   *  render a small source badge so Alex / Ethan can see at a glance
   *  which rows came from where. */
  source?:
    | { kind: 'primary' }
    | {
        kind: 'secondary'
        label: string | null
        spreadsheetId: string
        tabTitle: string
      }
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

/**
 * Quick-filter chips above the table.
 *   - `set-*`    keys off the row's loggedAt cell (when Mary entered
 *                it into the sheet) — answers "what did we just log".
 *   - `booked-*` keys off the row's apptDateTime (when the customer
 *                meeting actually happens) — answers "who's coming in".
 *
 * The Booked↔Set vocabulary matches Alex's mental model: "booked" =
 * scheduled-for, "set" = entered-into-the-system. Earlier the labels
 * were swapped from this convention, which made "Booked today" look
 * like it should mean apptDateTime today; the current naming is the
 * fixed shape.
 */
type QuickFilter =
  | 'set-today'
  | 'set-this-week'
  | 'booked-today'
  | 'booked-this-week'
  | null

const STATUSES = [
  { value: 'all', label: 'All statuses' },
  { value: 'booked', label: 'Booked' },
  { value: 'rescheduled', label: 'Rescheduled' },
  { value: 'showed', label: 'Showed' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'no_show', label: 'No-show' },
  { value: 'cancelled', label: 'Cancelled' },
]

const STATUS_TONE: Record<string, string> = {
  booked: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  rescheduled: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  showed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  // won/lost are outcomes ON TOP of showing up. won = bolder green
  // than showed (signals "they sat down AND closed"); lost = warm
  // neutral (sat down but didn't close — distinct from cancelled's
  // zinc which means "never sat down").
  won: 'bg-green-200 text-green-900 dark:bg-green-900 dark:text-green-200',
  lost: 'bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-300',
  no_show: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  cancelled: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
}

// Hub-only Dispatch Status — its own dropdown, separate from the
// sheet-backed Status above. "Dispatched" is the automation gate: the
// moment a row is set to it, the client details + the four same-day
// customer reminders fire. The others are lifecycle markers.
const DISPATCH_STATUSES = [
  { value: 'not_dispatched', label: 'Not Dispatched' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'reschedule_requested', label: 'Reschedule Requested' },
  { value: 'rescheduled', label: 'Rescheduled' },
  { value: 'needs_review', label: 'Needs Review' },
]

const DISPATCH_TONE: Record<string, string> = {
  // Neutral grey = nothing has fired yet (the default holding state).
  not_dispatched: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  // Green = live, automations fired.
  dispatched: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  // Blue = all set / confirmed with the homeowner.
  confirmed: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  // Amber = customer asked to move it — needs action.
  reschedule_requested:
    'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  // Violet = rebooked to a new time.
  rescheduled: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  // Rose = flagged for a human to look at.
  needs_review: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
}

/**
 * Best-effort customer-tz lookup from a free-text address. Mirrors
 * lib/timezone.ts but kept inline so the master-tracker page (which
 * is a client component) doesn't have to drag the server-side lib
 * along. Covers Genisys's three current operating states cleanly;
 * everything else falls back to America/New_York which is the
 * project's baseline.
 */
const STATE_TO_TZ: Record<string, string> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  IA: 'America/Chicago',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  MA: 'America/New_York',
  MD: 'America/New_York',
  ME: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  MS: 'America/Chicago',
  MT: 'America/Denver',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  NE: 'America/Chicago',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NV: 'America/Los_Angeles',
  NY: 'America/New_York',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VA: 'America/New_York',
  VT: 'America/New_York',
  WA: 'America/Los_Angeles',
  WI: 'America/Chicago',
  WV: 'America/New_York',
  WY: 'America/Denver',
}
function customerTzFromAddress(address: string | null): string {
  if (!address) return 'America/New_York'
  // Two-letter postal code with word boundaries — same regex pattern
  // the server-side helper uses, just inlined.
  const m = address.match(/(?:^|[,\s])([A-Z]{2})(?=[\s,]|$|\s+\d{5})/)
  if (m && STATE_TO_TZ[m[1]]) return STATE_TO_TZ[m[1]]
  return 'America/New_York'
}

/** First name only from a client's contact ("Randall Smith" →
 *  "Randall"), shown in small text under the company name in the
 *  master-tracker Client column. */
function clientContactFirst(contactName: string | null): string | null {
  const first = contactName?.trim().split(/\s+/)[0]
  return first || null
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

function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

/**
 * True if the appointment matches the chip the user has active. Pulled
 * out of the filter useMemo so the per-chip count helper can reuse the
 * same predicate without duplicating logic.
 *
 * Tz handling:
 *   - `set-today` → loggedAt within today in AGENT_TIMEZONE (US
 *     Pacific) so the filter matches the US calendar day Mary's
 *     customers see, regardless of who's viewing.
 *   - `booked-today` → apptDateTime within today in the CUSTOMER's tz
 *     (per-row, derived from address + client.state) so a 9 PM PT
 *     appointment stays "today" the whole PT day.
 *   - The "this week" predicates still use viewer-local week math —
 *     coarser range, edge cases matter less. Worth a follow-up if a
 *     row near the week boundary keeps slipping out for someone.
 */
function matchesQuickFilter(a: Appointment, q: QuickFilter): boolean {
  if (!q) return true
  const now = new Date()
  // `set-*` chips key off loggedAt strictly — rows whose Logged At
  // cell is blank in the sheet don't match (we genuinely don't know
  // when they were entered, so we can't honestly call them "set
  // today"). This avoids the gotcha where an empty Logged At would
  // make the filter fall through to apptDateTime and match by
  // appointment date instead.
  if (q === 'set-today') {
    if (!a.loggedAt) return false
    const created = new Date(a.loggedAt)
    return !isNaN(created.getTime()) && sameDayInTz(created, now, AGENT_TIMEZONE)
  }
  if (q === 'set-this-week') {
    if (!a.loggedAt) return false
    return new Date(a.loggedAt).getTime() >= startOfThisWeek().getTime()
  }
  if (q === 'booked-today') {
    const appt = new Date(a.apptDateTime)
    if (isNaN(appt.getTime())) return false
    // resolvedTimezone is the canonical zone the sheet reader pinned
    // this row to (explicit Timezone column wins, address inference
    // is the fallback). Falling back to client.state if a row arrived
    // without one is defensive — every row from readMasterTableRows
    // sets it.
    const customerTz =
      a.resolvedTimezone ||
      resolveCustomerTimezone({
        address: a.address,
        clientState: a.client?.state ?? null,
      })
    return sameDayInTz(appt, now, customerTz)
  }
  if (q === 'booked-this-week') {
    return new Date(a.apptDateTime).getTime() >= startOfThisWeek().getTime()
  }
  return true
}

/** Render a money-ish field consistently — strip an extra leading "$" if
 *  the source value already had one (defense in depth; the sheet reader
 *  already strips, but old DB values might not). */
function formatMoney(raw: string | null | undefined): string {
  if (!raw) return '—'
  const cleaned = raw.replace(/^\s*\$\s*/, '').trim()
  if (!cleaned) return '—'
  return `$${cleaned}`
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
  'County',
  'Utility Provider',
  'Monthly Bill',
  'Roof Type',
  'Roof Age',
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
    a.county || '',
    a.utilityProvider || '',
    a.monthlyBill || '',
    a.roofType || '',
    a.roofAge || '',
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
  // Quick-filter chip state — mutually exclusive with itself but stacks
  // on top of the regular filter form. Lets Ethan answer "what did we
  // book today / this week" and "who's coming in today / this week"
  // with one click instead of fiddling with date pickers.
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(null)

  const queryClient = useQueryClient()

  // PATCH a single row's status to the sheet, with optimistic cache
  // update so the pill changes immediately. Reverts on error so the UI
  // doesn't lie about a failed write.
  const statusMutation = useMutation({
    mutationFn: async (vars: { rowNumber: number; status: string }) => {
      const res = await fetch(
        `/api/call-center/master-tracker/${vars.rowNumber}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: vars.status }),
        }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update status')
      }
      return res.json()
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['master-tracker-sheet'] })
      const previous = queryClient.getQueryData<{
        appointments: Appointment[]
      }>(['master-tracker-sheet'])
      if (previous) {
        queryClient.setQueryData<{ appointments: Appointment[] }>(
          ['master-tracker-sheet'],
          {
            ...previous,
            appointments: previous.appointments.map((a) =>
              a.id === `sheet:${vars.rowNumber}`
                ? { ...a, status: vars.status }
                : a
            ),
          }
        )
      }
      return { previous }
    },
    onError: (err, _vars, context) => {
      // Roll back to the pre-mutation snapshot so the UI matches the
      // sheet again. The mutation's `error` is surfaced in StatusCell
      // via the `pendingRowNumber` check below.
      if (context?.previous) {
        queryClient.setQueryData(['master-tracker-sheet'], context.previous)
      }
      // Don't leave Mary / Alex staring at a red glow with no clue
      // what happened — surface the API's actual error message so
      // misconfiguration shows up loud instead of silently failing.
      window.alert(`Couldn't update status: ${(err as Error).message}`)
    },
  })

  // Same shape as statusMutation, just targets the Sent-to-Client
  // column. Kept as a separate hook so the optimistic update only
  // touches the field we're actually editing — sharing one mutation
  // would risk overwriting an in-flight status change with stale
  // sentToClient data.
  const sentToClientMutation = useMutation({
    mutationFn: async (vars: {
      rowNumber: number
      sentToClient: 'yes' | 'no' | 'unassigned'
    }) => {
      const res = await fetch(
        `/api/call-center/master-tracker/${vars.rowNumber}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sentToClient: vars.sentToClient }),
        }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update sent-to-client flag')
      }
      return res.json()
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['master-tracker-sheet'] })
      const previous = queryClient.getQueryData<{
        appointments: Appointment[]
      }>(['master-tracker-sheet'])
      if (previous) {
        queryClient.setQueryData<{ appointments: Appointment[] }>(
          ['master-tracker-sheet'],
          {
            ...previous,
            appointments: previous.appointments.map((a) =>
              a.id === `sheet:${vars.rowNumber}`
                ? { ...a, sentToClient: vars.sentToClient }
                : a
            ),
          }
        )
      }
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['master-tracker-sheet'], context.previous)
      }
      window.alert(`Couldn't update Sitdown: ${(err as Error).message}`)
    },
  })

  // Force-deliver a single row to its client's Slack channel.
  // Powers the per-row "Deliver" button — used to recover rows that
  // got stuck in the ledger as 'backfilled' / 'failed' / phantom-
  // 'delivered' and wouldn't be auto-delivered by the cron. Staff-
  // only on the server; the button is also hidden on /agent/* routes.
  // `force` lets admins resend a row that's already marked delivered
  // (used by the green pill's resend affordance to recover from
  // ghost-delivery cases where the ledger says 'delivered' but the
  // Slack channel doesn't actually have the message).
  const deliverRowMutation = useMutation({
    mutationFn: async (vars: { rowNumber: number; force?: boolean }) => {
      const res = await fetch('/api/admin/slack-delivery/deliver-row', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowNumber: vars.rowNumber, force: !!vars.force }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Delivery failed')
      }
      return data
    },
    onSuccess: () => {
      // Invalidate so the row's slackDelivery pill flips green.
      queryClient.invalidateQueries({ queryKey: ['master-tracker-sheet'] })
    },
  })

  // Wipe a row's SheetSlackDelivery records so the next cron tick
  // treats it as fresh and either auto-delivers or fails-loudly.
  // Used when testing auto-fire with a phone+time combo that's been
  // used in earlier tests — without this, the dedup ledger keeps
  // pinning the row to an ancient delivery record.
  const wipeRowMutation = useMutation({
    mutationFn: async (vars: { rowNumber: number }) => {
      const res = await fetch('/api/admin/slack-delivery/wipe-row', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowNumber: vars.rowNumber }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Wipe failed')
      }
      return data as { ok: true; deleted: number }
    },
    onSuccess: () => {
      // Refresh so the pill flips back to "Unassigned" until the
      // next cron tick re-evaluates the row.
      queryClient.invalidateQueries({ queryKey: ['master-tracker-sheet'] })
    },
  })

  // Hide the per-row Deliver button on the agent-facing route. The
  // /call-center/master-tracker page exports the same component to
  // /agent/master-tracker via re-export, so role-based gating has to
  // happen via pathname rather than a prop. Staff users always see
  // it; Mary's view stays read-only for delivery actions.
  const pathname = usePathname()
  const isStaffView = pathname?.startsWith('/call-center/') ?? false

  // Edit + Delete are admin-only. Pull the session role and gate the
  // UI affordances on `role === 'admin'` — this matches the server's
  // requireAdmin() check on the corresponding endpoints. Ethan
  // (member) can still inline-edit Status / Sent-to-Client; the row
  // delete and full-row edit stay Alex-only.
  const sessionQuery = useQuery<{
    user?: { email?: string | null; role?: string }
  }>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return {}
      return res.json()
    },
  })
  const userRole = sessionQuery.data?.user?.role ?? ''
  // Admin gating is role-based, not path-based: when Alex visits the
  // agent view (/agent/master-tracker, which re-exports this page),
  // he should still see admin actions like Edit + Delete. Previously
  // this was `isStaffView && admin`, which blanked admin tools on the
  // agent path even for admins.
  const isAdmin = userRole === 'admin'

  // Dispatch Status dropdown — Hub-only lifecycle field, DB-backed (not
  // the sheet). Setting it to "Dispatched" is the automation gate that
  // fires the client details + the four same-day customer reminders.
  // Optimistic update mirrors statusMutation.
  const dispatchStatusMutation = useMutation({
    mutationFn: async (vars: { rowNumber: number; dispatchStatus: string }) => {
      const res = await fetch('/api/call-center/dispatch-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok)
        throw new Error(d.error || 'Failed to update dispatch status')
      return d
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['master-tracker-sheet'] })
      const previous = queryClient.getQueryData<{
        appointments: Appointment[]
      }>(['master-tracker-sheet'])
      if (previous) {
        queryClient.setQueryData<{ appointments: Appointment[] }>(
          ['master-tracker-sheet'],
          {
            ...previous,
            appointments: previous.appointments.map((a) =>
              a.id === `sheet:${vars.rowNumber}`
                ? { ...a, dispatchStatus: vars.dispatchStatus }
                : a,
            ),
          },
        )
      }
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['master-tracker-sheet'], context.previous)
      }
      window.alert(`Couldn't update dispatch status: ${(err as Error).message}`)
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['master-tracker-sheet'] }),
  })

  // Edit-modal state. We track the currently-being-edited row by id
  // so the modal can pre-fill from the loaded appointments and the
  // mutation knows where to write.
  const [editingApptId, setEditingApptId] = useState<string | null>(null)

  // Surface what the server actually stored after a full-row edit.
  // Populated from the verify snapshot in the PATCH response so Alex
  // can see "saved as 6:00 PM PDT, 5/8/2026" in a toast — if the
  // round-trip ever shifts hours again, it surfaces immediately
  // instead of after a refresh-and-eyeball pass.
  const [editVerifyToast, setEditVerifyToast] = useState<{
    rowNumber: number
    apptDateCell: string | null
    apptTimeCell: string | null
    resolvedTimezone: string | null
    rawDateCell: string | null
    rawTimeCell: string | null
    rawDateTimeCell: string | null
    writeSkipped: string[]
  } | null>(null)

  // Single mutation handles both DELETE and full-row edit since they
  // share the route + invalidation. Each call site sets the right
  // `kind` so the toast / disable logic can target.
  const adminMutation = useMutation({
    mutationFn: async (vars: {
      kind: 'delete' | 'edit'
      rowNumber: number
      payload?: Record<string, string | null>
    }) => {
      const res = await fetch(
        `/api/call-center/master-tracker/${vars.rowNumber}`,
        {
          method: vars.kind === 'delete' ? 'DELETE' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:
            vars.kind === 'edit'
              ? JSON.stringify(vars.payload ?? {})
              : undefined,
        },
      )
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `${vars.kind} failed`)
      }
      return data
    },
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['master-tracker-sheet'] })
      // Stash the verify snapshot so the toast renders. Cleared
      // after a few seconds via the effect on editVerifyToast.
      if (vars.kind === 'edit' && data?.verify) {
        setEditVerifyToast({
          rowNumber: vars.rowNumber,
          apptDateCell: data.verify.apptDateCell ?? null,
          apptTimeCell: data.verify.apptTimeCell ?? null,
          resolvedTimezone: data.verify.resolvedTimezone ?? null,
          rawDateCell: data.verify.rawDateCell ?? null,
          rawTimeCell: data.verify.rawTimeCell ?? null,
          rawDateTimeCell: data.verify.rawDateTimeCell ?? null,
          writeSkipped: data.verify.writeSkipped ?? [],
        })
      }
    },
  })

  // Auto-dismiss the verify toast after 30s — long enough to read
  // the raw cell diagnostics carefully when something looks wrong.
  // Manual dismiss button still on the toast for clearing sooner.
  useEffect(() => {
    if (!editVerifyToast) return
    const t = setTimeout(() => setEditVerifyToast(null), 30000)
    return () => clearTimeout(t)
  }, [editVerifyToast])

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
    // Key by view so the agent + staff caches stay separate. The agent
    // view asks the API to drop partner (secondary-sheet) rows — those
    // are admin-only and shouldn't show even for admin-access agents
    // (Mary / Hannah) while they're working out of the /agent portal.
    queryKey: ['master-tracker-sheet', isStaffView],
    queryFn: async () => {
      const res = await fetch(
        isStaffView
          ? '/api/call-center/master-tracker'
          : '/api/call-center/master-tracker?view=agent',
      )
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
    if (quickFilter) list = list.filter((a) => matchesQuickFilter(a, quickFilter))
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
  }, [allAppointments, quickFilter, client, status, agent, since, until, submittedSearch])

  // Counts for each quick-filter chip, computed off the *unfiltered*
  // set so the chip counts reflect "how many would I see if I tapped
  // this" regardless of what's currently active.
  const quickCounts = useMemo(() => {
    let setToday = 0
    let setThisWeek = 0
    let bookedToday = 0
    let bookedThisWeek = 0
    for (const a of allAppointments) {
      if (matchesQuickFilter(a, 'set-today')) setToday++
      if (matchesQuickFilter(a, 'set-this-week')) setThisWeek++
      if (matchesQuickFilter(a, 'booked-today')) bookedToday++
      if (matchesQuickFilter(a, 'booked-this-week')) bookedThisWeek++
    }
    return { setToday, setThisWeek, bookedToday, bookedThisWeek }
  }, [allAppointments])

  // Diagnostic — when a "Booked..." chip shows 0, this tells Ethan
  // whether the issue is "no rows logged today" or "no rows have a
  // Logged At populated at all". Also surfaces the latest Logged At
  // value so it's obvious if e.g. nothing's been logged in 3 days.
  const loggedAtStats = useMemo(() => {
    let withLoggedAt = 0
    let latest: number | null = null
    for (const a of allAppointments) {
      if (a.loggedAt) {
        withLoggedAt++
        const t = new Date(a.loggedAt).getTime()
        if (!isNaN(t) && (latest == null || t > latest)) latest = t
      }
    }
    return {
      withLoggedAt,
      total: allAppointments.length,
      latest: latest ? new Date(latest) : null,
    }
  }, [allAppointments])

  // ---- Stats over the working set
  const stats = useMemo(() => {
    let showed = 0
    let no_show = 0
    let thisWeek = 0
    let thisMonth = 0
    const weekStart = startOfThisWeek()
    const monthStart = startOfThisMonth()
    for (const a of filtered) {
      // "Sat down" = showed, won, or lost. Won/lost are deal outcomes
      // ON TOP of the customer actually showing up to the appt, so
      // they should count as a successful show in the show-rate stat
      // (otherwise closing more deals would mysteriously LOWER the
      // show rate — which is backwards).
      if (
        a.status === 'showed' ||
        a.status === 'won' ||
        a.status === 'lost'
      ) {
        showed++
      }
      if (a.status === 'no_show') no_show++
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
    setQuickFilter(null)
  }
  const filterCleared =
    status === 'all' &&
    agent === 'all' &&
    client === 'all' &&
    !submittedSearch &&
    !since &&
    !until &&
    !quickFilter

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

  /** Export every row whose loggedAt falls in today (booking-entry
   *  date, not appointment-date) — the slice Ethan needs for end-of-
   *  day "what did Mary log today" reporting. */
  function exportSetToday() {
    const rows = allAppointments.filter((a) =>
      matchesQuickFilter(a, 'set-today')
    )
    exportRows(`genisys-set-today-${todayStamp()}.csv`, rows)
  }

  return (
    // max-w-screen-2xl (1536px) — wider than the 1280 the rest of the
    // Call Center tabs use because Master Tracker's table has 12
    // columns (APPT / CLIENT / AGENT / CUSTOMER / PHONE / ADDRESS /
    // UTILITY / BILL / DEAL / STATUS / SENT / REC). At 1280 the table
    // forces a horizontal scroll; at 1536 most desktops can see the
    // whole row at a glance.
    // min-w-0 + the inner overflow-x-auto on the table keep the
    // scroll contained when the viewport is narrower than max-width.
    <div className="mx-auto min-w-0 w-full max-w-screen-2xl space-y-5">
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
      </div>

      {/* ---- Quick-filter chips ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Quick filter
        </span>
        <QuickFilterChip
          label="Set today"
          count={quickCounts.setToday}
          active={quickFilter === 'set-today'}
          tone="emerald"
          onClick={() =>
            setQuickFilter(quickFilter === 'set-today' ? null : 'set-today')
          }
        />
        <QuickFilterChip
          label="Set this week"
          count={quickCounts.setThisWeek}
          active={quickFilter === 'set-this-week'}
          tone="emerald"
          onClick={() =>
            setQuickFilter(
              quickFilter === 'set-this-week' ? null : 'set-this-week'
            )
          }
        />
        <QuickFilterChip
          label="Booked for today"
          count={quickCounts.bookedToday}
          active={quickFilter === 'booked-today'}
          tone="blue"
          onClick={() =>
            setQuickFilter(quickFilter === 'booked-today' ? null : 'booked-today')
          }
        />
        <QuickFilterChip
          label="Booked for this week"
          count={quickCounts.bookedThisWeek}
          active={quickFilter === 'booked-this-week'}
          tone="blue"
          onClick={() =>
            setQuickFilter(
              quickFilter === 'booked-this-week' ? null : 'booked-this-week'
            )
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
      {(quickFilter === 'set-today' || quickFilter === 'set-this-week') && (
        <div className="-mt-3 space-y-0.5 text-[11px] text-zinc-500">
          <p>
            Counts rows by their{' '}
            <span className="font-medium">Logged At</span> column. Rows with
            a blank Logged At are excluded — fill that cell when typing into
            the sheet and they&apos;ll show up here.
          </p>
          <p className="text-zinc-400">
            Diagnostic:{' '}
            <span className="font-mono">
              {loggedAtStats.withLoggedAt}
            </span>{' '}
            of <span className="font-mono">{loggedAtStats.total}</span> rows
            have a Logged At populated.{' '}
            {loggedAtStats.latest ? (
              <>
                Latest:{' '}
                <span className="font-mono">
                  {loggedAtStats.latest.toLocaleString('en-US')}
                </span>
                .
              </>
            ) : (
              'No rows have any Logged At value yet.'
            )}
          </p>
        </div>
      )}

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
                      label="Set today"
                      hint={`${quickCounts.setToday} row${
                        quickCounts.setToday === 1 ? '' : 's'
                      }`}
                      onClick={exportSetToday}
                      disabled={quickCounts.setToday === 0}
                    />
                    <ExportItem
                      label="This week (appt date)"
                      onClick={() =>
                        exportSinceDate('this-week', startOfThisWeek())
                      }
                    />
                    <ExportItem
                      label="This month (appt date)"
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
                  <th className="px-2 py-2.5">Appt</th>
                  <th className="px-2 py-2.5">Client</th>
                  <th className="px-2 py-2.5">Agent</th>
                  <th className="px-2 py-2.5">Customer</th>
                  <th className="px-2 py-2.5">Phone</th>
                  <th className="px-2 py-2.5">Address</th>
                  <th className="w-px whitespace-nowrap px-2 py-2.5">County</th>
                  <th className="w-px whitespace-nowrap px-2 py-2.5 text-center">
                    Utility
                  </th>
                  <th className="w-px whitespace-nowrap px-2 py-2.5 text-center">
                    Bill
                  </th>
                  <th className="px-2 py-2.5">Status</th>
                  <th
                    className="px-2 py-2.5"
                    title="Hub dispatch lifecycle. Set to Dispatched to fire the client details + customer reminders."
                  >
                    Dispatch
                  </th>
                  <th
                    className="px-2 py-2.5"
                    title="Has the client met with the customer? Set manually by admin to mark whether the appointment is qualified / fulfilled."
                  >
                    Sitdown
                  </th>
                  <th className="px-2 py-2.5">Slack</th>
                  <th className="px-2 py-2.5">Rec</th>
                  {/* Actions pinned to the right edge so Pause / Edit /
                      Delete are always reachable without scrolling the
                      wide table sideways. */}
                  <th className="sticky right-0 z-20 bg-zinc-50 px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.15)] dark:bg-zinc-950/95">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {filtered.map((a) => {
                  const when = new Date(a.apptDateTime)
                  // Display the appointment in the CUSTOMER's local
                  // timezone — explicit Timezone-column override
                  // first, address-derived inference second. Means a
                  // "9 AM PT" booking shows as "9 AM" to Alex in NH
                  // and Mary in Manila alike, matching what's
                  // actually on the call-center sheet rather than
                  // shifting per-viewer.
                  const apptTz =
                    a.resolvedTimezone ||
                    customerTzFromAddress(a.address)
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
                            {new Intl.DateTimeFormat('en-US', {
                              timeZone: apptTz,
                              month: 'short',
                              day: 'numeric',
                            }).format(when)}
                          </div>
                          {/* Time + customer tz short label (e.g.
                              "9:00 AM PDT"). Removes the ambiguity
                              about whose clock the time is in — Mary
                              in Manila + Alex in NH + Ethan in LA all
                              now see the same string with the
                              customer's zone right next to it. */}
                          <div className="text-[10px] text-zinc-400">
                            {new Intl.DateTimeFormat('en-US', {
                              timeZone: apptTz,
                              hour: 'numeric',
                              minute: '2-digit',
                              hour12: true,
                              timeZoneName: 'short',
                            }).format(when)}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          {a.client ? (
                            // Color dot + name as plain table text reads
                            // calmer than a wide pill, and the long client
                            // names ("Home Energy Upgrade") don't get
                            // squeezed into an oval. The contact's first
                            // name sits directly under the company in small
                            // muted text. Inferred-from-address rows show a
                            // tiny ringed dot variant + the tooltip still
                            // explains the source so Ethan can spot rows
                            // that need their Client column filled upstream.
                            <span
                              className="inline-flex items-start gap-1.5 whitespace-nowrap text-xs font-medium text-zinc-700 dark:text-zinc-200"
                              title={
                                a.clientInferred
                                  ? `Inferred from address (${a.client.state || ''}) — Client column was blank in the sheet`
                                  : a.client.state || undefined
                              }
                            >
                              <span
                                className={cn(
                                  'mt-1 h-2 w-2 flex-shrink-0 rounded-full',
                                  a.clientInferred &&
                                    'ring-1 ring-offset-1 ring-zinc-400 ring-offset-white dark:ring-offset-zinc-900',
                                )}
                                style={{ backgroundColor: a.client.color }}
                                aria-hidden
                              />
                              <span className="flex flex-col leading-tight">
                                <span className="inline-flex flex-wrap items-center gap-1.5">
                                  {a.client.name}
                                  {/* Source badge for rows that came from a
                                      partner-call-center secondary sheet
                                      (Yassin's Forward Energy / Brighton
                                      Capital). Mary never sees this — the
                                      API filters secondaries out for her —
                                      so the badge is purely an admin "this
                                      came from elsewhere" indicator. */}
                                  {a.source?.kind === 'secondary' && (
                                    <span
                                      className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                                      title={
                                        a.source.label ??
                                        `Imported from ${a.source.tabTitle}`
                                      }
                                    >
                                      partner
                                    </span>
                                  )}
                                </span>
                                {clientContactFirst(a.client.contactName) && (
                                  <span className="mt-0.5 text-[10px] font-normal text-zinc-400 dark:text-zinc-500">
                                    ({clientContactFirst(a.client.contactName)})
                                  </span>
                                )}
                              </span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
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
                        <td className="px-2 py-2.5 font-medium">
                          <div className="flex items-center gap-1.5">
                            <span>{a.customerName}</span>
                            {a.possibleDuplicateRowIds &&
                              a.possibleDuplicateRowIds.length > 0 && (
                                <span
                                  className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                                  title={`Same phone + address as ${a.possibleDuplicateRowIds.length} other row${a.possibleDuplicateRowIds.length === 1 ? '' : 's'} on the sheet (row${a.possibleDuplicateRowIds.length === 1 ? '' : 's'} ${a.possibleDuplicateRowIds.join(', ')}). Likely a double-entry — keep the most complete one and delete the rest in Google Sheets.`}
                                >
                                  <AlertCircle className="h-2.5 w-2.5" />
                                  Dup
                                </span>
                              )}
                          </div>
                        </td>
                        <td className="px-2 py-2.5 font-mono text-[11px]">
                          <PhoneCell value={a.customerPhone} />
                        </td>
                        <td
                          className="px-2 py-2.5 text-zinc-500"
                          title={a.address || ''}
                          style={{ minWidth: '170px', maxWidth: '240px' }}
                        >
                          {a.address ? (
                            <span className="break-words">{a.address}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="w-px whitespace-nowrap px-3 py-2.5 text-zinc-500">
                          {a.county || '—'}
                        </td>
                        <td className="w-px whitespace-nowrap px-2 py-2.5 text-center text-zinc-500">
                          {a.utilityProvider || '—'}
                        </td>
                        <td className="w-px whitespace-nowrap px-2 py-2.5 text-center text-zinc-500">
                          {formatMoney(a.monthlyBill)}
                        </td>
                        <td className="px-2 py-2.5">
                          <StatusCell
                            status={a.status}
                            onChange={(newStatus) => {
                              const match = a.id.match(/^sheet:(\d+)$/)
                              if (!match) return
                              statusMutation.mutate({
                                rowNumber: Number(match[1]),
                                status: newStatus,
                              })
                            }}
                            pending={
                              statusMutation.isPending &&
                              statusMutation.variables?.rowNumber ===
                                Number(a.id.replace(/^sheet:/, ''))
                            }
                            errored={
                              statusMutation.isError &&
                              statusMutation.variables?.rowNumber ===
                                Number(a.id.replace(/^sheet:/, ''))
                            }
                          />
                        </td>
                        <td className="px-2 py-2.5">
                          <DispatchStatusCell
                            value={a.dispatchStatus}
                            onChange={(next) => {
                              const match = a.id.match(/^sheet:(\d+)$/)
                              if (!match) return
                              dispatchStatusMutation.mutate({
                                rowNumber: Number(match[1]),
                                dispatchStatus: next,
                              })
                            }}
                            pending={
                              dispatchStatusMutation.isPending &&
                              dispatchStatusMutation.variables?.rowNumber ===
                                Number(a.id.replace(/^sheet:/, ''))
                            }
                          />
                        </td>
                        <td className="px-2 py-2.5">
                          <SentToClientCell
                            value={a.sentToClient}
                            onChange={(next) => {
                              const match = a.id.match(/^sheet:(\d+)$/)
                              if (!match) return
                              sentToClientMutation.mutate({
                                rowNumber: Number(match[1]),
                                sentToClient: next,
                              })
                            }}
                            pending={
                              sentToClientMutation.isPending &&
                              sentToClientMutation.variables?.rowNumber ===
                                Number(a.id.replace(/^sheet:/, ''))
                            }
                            errored={
                              sentToClientMutation.isError &&
                              sentToClientMutation.variables?.rowNumber ===
                                Number(a.id.replace(/^sheet:/, ''))
                            }
                          />
                        </td>
                        <td className="px-2 py-2.5">
                          <SlackDeliveryCell
                            appointment={a}
                            staffMode={isStaffView}
                            pending={
                              (deliverRowMutation.isPending &&
                                deliverRowMutation.variables?.rowNumber ===
                                  Number(a.id.replace(/^sheet:/, ''))) ||
                              (wipeRowMutation.isPending &&
                                wipeRowMutation.variables?.rowNumber ===
                                  Number(a.id.replace(/^sheet:/, '')))
                            }
                            onDeliver={(force) => {
                              const match = a.id.match(/^sheet:(\d+)$/)
                              if (!match) return
                              const rowNumber = Number(match[1])
                              if (force) {
                                if (
                                  !window.confirm(
                                    `This row already shows as Delivered. Re-send to Slack anyway? Use this when the channel doesn't actually have the message (the original send may have silently failed).`,
                                  )
                                ) {
                                  return
                                }
                              }
                              deliverRowMutation.mutate({ rowNumber, force })
                            }}
                            onResetDelivery={() => {
                              const match = a.id.match(/^sheet:(\d+)$/)
                              if (!match) return
                              const rowNumber = Number(match[1])
                              if (
                                !window.confirm(
                                  `Wipe all Slack delivery records for this row? The next 5-min cron tick will treat it as fresh and either auto-deliver or fail with a reason. Use this to recover from a stuck "Delivered" pill or to retest auto-fire with a phone number you've used before.`,
                                )
                              ) {
                                return
                              }
                              wipeRowMutation.mutate(
                                { rowNumber },
                                {
                                  onSuccess: (data) => {
                                    window.alert(
                                      `Wiped ${data.deleted} delivery record${data.deleted === 1 ? '' : 's'} for row ${rowNumber}. The next cron tick (within 5 min) will re-evaluate.`,
                                    )
                                  },
                                  onError: (err) => {
                                    window.alert(
                                      `Wipe failed: ${(err as Error).message}`,
                                    )
                                  },
                                },
                              )
                            }}
                          />
                        </td>
                        <td className="px-2 py-2.5">
                          {a.callRecordingLink ? (
                            <a
                              // Prefer the Hub-signed proxy URL so
                              // the play works from any IP — falls
                              // back to the raw vicitel link for
                              // admins whose IP is already on the
                              // upstream allowlist (and as a
                              // safety net when the proxy isn't
                              // configured yet).
                              href={a.callRecordingProxyUrl || a.callRecordingLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={
                                a.callRecordingProxyUrl
                                  ? 'Streams through the Hub — works from any IP.'
                                  : 'Direct vicitel link — requires your IP to be on their allowlist.'
                              }
                              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Play
                            </a>
                          ) : (
                            <span className="text-zinc-300">—</span>
                          )}
                        </td>
                        <td className="sticky right-0 z-10 bg-white px-3 py-2.5 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)] dark:bg-zinc-900">
                          <RowActions
                            isAdmin={isAdmin}
                            adminPending={
                              adminMutation.isPending &&
                              adminMutation.variables?.rowNumber ===
                                Number(a.id.replace(/^sheet:/, ''))
                            }
                            onEdit={
                              isAdmin ? () => setEditingApptId(a.id) : undefined
                            }
                            onDelete={
                              isAdmin
                                ? () => {
                                    const match = a.id.match(/^sheet:(\d+)$/)
                                    if (!match) return
                                    const rowNumber = Number(match[1])
                                    if (
                                      !window.confirm(
                                        `Delete ${a.customerName}'s appointment from the master sheet? This removes the row entirely + cancels its pending reminders. Cannot be undone.`,
                                      )
                                    ) {
                                      return
                                    }
                                    adminMutation.mutate({
                                      kind: 'delete',
                                      rowNumber,
                                    })
                                  }
                                : undefined
                            }
                          />
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-blue-50/20 dark:bg-blue-950/10">
                          <td
                            colSpan={16}
                            className="border-t border-blue-200/40 px-6 py-4 dark:border-blue-900/40"
                          >
                            <RowDetail
                              appointment={a}
                              onEdit={
                                isAdmin
                                  ? () => setEditingApptId(a.id)
                                  : undefined
                              }
                            />
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

      {/* Admin row-edit modal — only mounts when an appointment is
          targeted. Sources the row's current data from the loaded
          appointments list so the form pre-fills, hands updates back
          via the same mutation that powers row delete. */}
      {isAdmin && editingApptId && (
        <AdminEditModal
          appointment={
            (apptsQuery.data?.appointments ?? []).find(
              (a) => a.id === editingApptId,
            ) ?? null
          }
          clients={clients}
          submitting={adminMutation.isPending}
          onCancel={() => setEditingApptId(null)}
          onSave={(payload) => {
            const appt = (apptsQuery.data?.appointments ?? []).find(
              (a) => a.id === editingApptId,
            )
            if (!appt) return
            const match = appt.id.match(/^sheet:(\d+)$/)
            if (!match) return
            const rowNumber = Number(match[1])
            adminMutation.mutate(
              { kind: 'edit', rowNumber, payload },
              { onSuccess: () => setEditingApptId(null) },
            )
          }}
        />
      )}

      {/* Verify toast — diagnostic. Shows the parsed display value
          (what the master-tracker will render) AND the literal cell
          contents from the sheet (Date / Time / Combined). If the
          parsed result looks wrong, the raw cell readout pinpoints
          which column is the liar in one screenshot. */}
      {editVerifyToast && (
        <div
          className="fixed bottom-6 right-6 z-50 max-w-md rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-pop dark:border-emerald-900 dark:bg-emerald-950/90"
          role="status"
        >
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
                Saved row {editVerifyToast.rowNumber}
              </p>
              <p className="mt-0.5 text-xs text-emerald-800 dark:text-emerald-200">
                {editVerifyToast.apptDateCell &&
                editVerifyToast.apptTimeCell ? (
                  <>
                    Stored as{' '}
                    <span className="font-semibold">
                      {editVerifyToast.apptDateCell} ·{' '}
                      {editVerifyToast.apptTimeCell}
                    </span>
                  </>
                ) : (
                  <>Sheet updated.</>
                )}
              </p>
              {/* Diagnostic block — exposes what's literally in each
                  sheet cell so a stale-cell / wrong-column bug is
                  obvious. */}
              <div className="mt-2 space-y-0.5 rounded-md bg-white/60 px-2 py-1.5 font-mono text-[10px] text-emerald-900 dark:bg-black/30 dark:text-emerald-100">
                <p>
                  Date cell:{' '}
                  <span className="font-semibold">
                    {editVerifyToast.rawDateCell !== null
                      ? `"${editVerifyToast.rawDateCell}"`
                      : '— (no column)'}
                  </span>
                </p>
                <p>
                  Time cell:{' '}
                  <span className="font-semibold">
                    {editVerifyToast.rawTimeCell !== null
                      ? `"${editVerifyToast.rawTimeCell}"`
                      : '— (no column)'}
                  </span>
                </p>
                <p>
                  Combined cell:{' '}
                  <span className="font-semibold">
                    {editVerifyToast.rawDateTimeCell !== null
                      ? `"${editVerifyToast.rawDateTimeCell}"`
                      : '— (no column)'}
                  </span>
                </p>
                {editVerifyToast.writeSkipped.length > 0 && (
                  <p className="mt-1 text-rose-700 dark:text-rose-300">
                    Skipped (no column): {editVerifyToast.writeSkipped.join(', ')}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEditVerifyToast(null)}
              className="rounded p-1 text-emerald-600 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
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

/**
 * Compact toggle chip for the quick-filter row. Active state uses a
 * tone-tinted fill (emerald for "booked-*" filters, blue for "appts-*"
 * filters) so the two categories read distinct at a glance.
 */
function QuickFilterChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  tone: 'emerald' | 'blue'
  onClick: () => void
}) {
  const activeStyles =
    tone === 'emerald'
      ? 'bg-emerald-600 text-white border-transparent shadow-sm'
      : 'bg-blue-600 text-white border-transparent shadow-sm'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? activeStyles
          : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
      )}
    >
      {label}
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

function RowDetail({
  appointment,
  onEdit,
}: {
  appointment: Appointment
  /** Optional admin-edit hook. When undefined (non-admin viewer), the
   *  Edit appointment button is hidden so the drawer's affordances
   *  match the row's admin column gating exactly. */
  onEdit?: () => void
}) {
  return (
    <div className="grid gap-x-8 gap-y-3 text-xs md:grid-cols-3">
      <DetailItem label="Customer">
        <div className="font-medium text-zinc-800 dark:text-zinc-100">
          {appointment.customerName}
        </div>
        <div className="font-mono text-zinc-500">
          <PhoneCell value={appointment.customerPhone} />
        </div>
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
          {formatMoney(appointment.monthlyBill)}
          {appointment.monthlyBill ? '/mo' : ''}
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
          <span className="text-zinc-400">Logged at:</span>{' '}
          {appointment.loggedAt ? (
            new Date(appointment.loggedAt).toLocaleString('en-US')
          ) : (
            <span className="italic text-rose-500">
              not set — Booked-today filter excludes this row
            </span>
          )}
        </div>
      </DetailItem>
      {appointment.notes && (
        <div className="md:col-span-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Notes (Mary)
          </p>
          <div className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-white p-3 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
            {appointment.notes}
          </div>
        </div>
      )}
      {/* Client-side notes — surfaced when the agency client has
          updated this appointment from their dashboard. Distinct
          from Mary's Notes above so neither perspective gets
          stomped. Yassin's secondary-sheet rows don't have a DB
          appointment behind them, so clientNotes stays null and
          this block stays hidden — matches Alex's "unless they're
          from a Partner" requirement automatically. */}
      {appointment.clientNotes && (
        <div className="md:col-span-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
              Notes (Client)
            </p>
            {appointment.clientStatusUpdatedAt && (
              <p
                className="text-[10px] text-zinc-400"
                title={new Date(appointment.clientStatusUpdatedAt).toLocaleString()}
              >
                Updated {new Date(appointment.clientStatusUpdatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </p>
            )}
          </div>
          <div className="whitespace-pre-wrap rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
            {appointment.clientNotes}
          </div>
        </div>
      )}
      {(appointment.callRecordingLink || onEdit) && (
        <div className="md:col-span-3 flex flex-wrap items-center gap-2">
          {appointment.callRecordingLink && (
            <a
              href={appointment.callRecordingLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200"
            >
              <ExternalLink className="h-3 w-3" />
              Play call recording
            </a>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              title="Edit this row's appointment details (date/time, customer, notes, etc.)"
            >
              <Pencil className="h-3 w-3" />
              Edit appointment
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Inline status editor — a colored pill that's also a native select.
 * Native select keeps keyboard / accessibility / mobile UX correct
 * without a custom popover. The chevron is a decorative overlay; the
 * select itself drives the click area.
 *
 * `pending` softens the pill while a write is in flight. `errored`
 * paints a rose ring + tooltip so a failed sheet write is obvious
 * (the cache revert makes the displayed value flip back, and this
 * tells the user *why* it flipped back).
 */

/**
 * Phone-cell renderer — uses parsePhoneEntries to handle the three
 * shapes our master sheet has historically held:
 *  1. Bare 10-digit string ("8585683555") → "(858) 568-3555"
 *  2. Dirty single number ("323 406 2186") → "(323) 406-2186"
 *  3. Multi-number with labels ("Mobile : 3107148845 /HOME 3106351431")
 *     → stacked list, each "Label: (XXX) XXX-XXXX" on its own line.
 *
 * If parsePhoneEntries returns no entries (the cell didn't contain
 * anything that looked like a phone), we render the raw text so we
 * never silently swallow notes the call center stashed there.
 */
function PhoneCell({ value }: { value: string }) {
  const { entries, raw } = parsePhoneEntries(value)
  if (entries.length === 0) {
    return raw ? <span className="whitespace-nowrap">{raw}</span> : <span>—</span>
  }
  if (entries.length === 1) {
    const e = entries[0]
    return (
      <span className="whitespace-nowrap">
        {e.label && (
          <span className="mr-1 text-[10px] uppercase tracking-wider text-zinc-400">
            {e.label}:
          </span>
        )}
        {e.number}
      </span>
    )
  }
  // Multiple numbers — stack them so each label/number pair gets its
  // own row instead of running on as one wrapped string.
  return (
    <div className="space-y-0.5">
      {entries.map((e, i) => (
        <div key={i} className="whitespace-nowrap">
          {e.label && (
            <span className="mr-1 text-[10px] uppercase tracking-wider text-zinc-400">
              {e.label}:
            </span>
          )}
          {e.number}
        </div>
      ))}
    </div>
  )
}

function StatusCell({
  status,
  onChange,
  pending,
  errored,
}: {
  status: string
  onChange: (newStatus: string) => void
  pending?: boolean
  errored?: boolean
}) {
  // STATUSES includes the "all" filter option — strip it for the editor.
  const options = STATUSES.filter((s) => s.value !== 'all')
  return (
    <div
      className="relative inline-block"
      title={errored ? 'Failed to write to the sheet — please retry.' : undefined}
    >
      <select
        value={status}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'appearance-none cursor-pointer rounded-full pl-2 pr-5 py-0.5 text-[10px] font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400/60',
          STATUS_TONE[status] || 'bg-zinc-100 text-zinc-700',
          pending && 'opacity-60',
          errored && 'ring-2 ring-rose-400'
        )}
      >
        {options.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 opacity-60" />
    </div>
  )
}

/**
 * Dispatch Status dropdown — the Hub-only lifecycle column. Same
 * chip-select shape as StatusCell, but DB-backed (not the sheet) with
 * its own option set. Setting it to "Dispatched" fires the client +
 * customer automations server-side.
 */
function DispatchStatusCell({
  value,
  onChange,
  pending,
}: {
  value: string
  onChange: (next: string) => void
  pending?: boolean
}) {
  return (
    <div className="relative inline-block">
      <select
        value={value}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'appearance-none cursor-pointer rounded-full pl-2 pr-5 py-0.5 text-[10px] font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400/60',
          DISPATCH_TONE[value] || 'bg-zinc-100 text-zinc-700',
          pending && 'opacity-60',
        )}
      >
        {DISPATCH_STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 opacity-60" />
    </div>
  )
}

/**
 * Inline Yes / No / Unassigned editor for the "Sitdown" column —
 * tracks whether the client actually met with the customer (i.e.
 * the appointment is qualified / fulfilled, not just booked).
 * Same shape as StatusCell — a chip-styled native select that
 * PATCHes the sheet on change with optimistic update + revert.
 *
 * Internal field is still `sentToClient` for backward compat with
 * the underlying sheet column + canonical aliases; the UI label
 * shifted to "Sitdown" to match Alex's vocabulary (sent ≠ met).
 *
 * Tone matches the meaning: Yes = emerald (sat down, qualified),
 * No = rose (no contact made, attention needed), Unassigned = grey.
 */
function SentToClientCell({
  value,
  onChange,
  pending,
  errored,
}: {
  value: 'yes' | 'no' | 'unassigned'
  onChange: (next: 'yes' | 'no' | 'unassigned') => void
  pending?: boolean
  errored?: boolean
}) {
  const tone =
    value === 'yes'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
      : value === 'no'
        ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
  return (
    <div
      className="relative inline-block"
      title={
        errored
          ? 'Failed to write to the sheet — please retry.'
          : 'Did the client actually sit down with the customer? Yes = qualified appointment.'
      }
    >
      <select
        value={value}
        disabled={pending}
        onChange={(e) =>
          onChange(e.target.value as 'yes' | 'no' | 'unassigned')
        }
        className={cn(
          'appearance-none cursor-pointer rounded-full pl-2 pr-5 py-0.5 text-[10px] font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400/60',
          tone,
          pending && 'opacity-60',
          errored && 'ring-2 ring-rose-400'
        )}
      >
        <option value="unassigned">Unassigned</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 opacity-60" />
    </div>
  )
}

function SlackDeliveryCell({
  appointment,
  staffMode,
  pending,
  onDeliver,
  onResetDelivery,
}: {
  appointment: Appointment
  /** True only on the staff /call-center route. Mary's /agent
   *  re-export hides the Deliver button so she can see status but
   *  not trigger sends. */
  staffMode: boolean
  pending: boolean
  /** Called with force=true when re-sending an already-delivered
   *  row. The parent shows a confirm() dialog before firing. */
  onDeliver: (force: boolean) => void
  /** Wipe this row's SheetSlackDelivery records so the next cron
   *  tick treats the row as fresh. Used to recover a stuck
   *  "Delivered" pill (typically a stale match against an old test
   *  delivery) or to retest auto-fire with reused phone+time data.
   *  Parent shows a confirm() dialog before firing. */
  onResetDelivery: () => void
}) {
  const delivery = appointment.slackDelivery
  const status = delivery?.status

  // Small icon button that wipes the row's delivery records. Shared
  // across the delivered/failed/backfilled pills since the recovery
  // story is the same for all three: the ledger is wrong (stale,
  // failed, or test data) and the row should be re-evaluated fresh.
  const resetBtn = staffMode ? (
    <button
      type="button"
      onClick={onResetDelivery}
      disabled={pending}
      className="inline-flex items-center rounded-md border border-zinc-200 px-1 py-0.5 text-[10px] text-zinc-500 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
      title="Reset: wipe this row's delivery ledger so the next cron tick re-evaluates from scratch."
    >
      {pending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <X className="h-3 w-3" />
      )}
    </button>
  ) : null

  // Delivered → green pill. Clickable for staff (force re-send) so
  // admins can recover from ghost-delivery cases where the ledger
  // says 'delivered' but the channel doesn't actually have the
  // message — happens occasionally when Slack's API silently
  // accepts a post without it actually landing.
  if (status === 'delivered') {
    const tooltip = delivery?.deliveredAt
      ? `Posted to Slack ${new Date(delivery.deliveredAt).toLocaleString()}.${staffMode ? ' Click to re-send if it never landed.' : ''}`
      : 'Posted to the client Slack channel'
    // Wrap the pill in a permalink anchor when we have one — admins
    // get a one-click verify path so they can confirm the post is
    // actually visible in the channel rather than trusting the
    // ledger blindly. Uses a span when no permalink exists (older
    // delivered rows from before the permalink-verification rollout).
    const PillContent = (
      <>
        <CheckCircle2 className="h-3 w-3" />
        Delivered
      </>
    )
    const pillCls =
      'inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 transition hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900'
    return (
      <div className="inline-flex items-center gap-1.5">
        {delivery?.permalink ? (
          <a
            href={delivery.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className={pillCls}
            title={`${tooltip} Click to open the Slack post in a new tab.`}
            onClick={(e) => e.stopPropagation()}
          >
            {PillContent}
          </a>
        ) : (
          <span className={pillCls} title={tooltip}>
            {PillContent}
          </span>
        )}
        {staffMode && (
          <button
            type="button"
            onClick={() => onDeliver(true)}
            disabled={pending}
            className="inline-flex items-center rounded-md border border-zinc-200 px-1 py-0.5 text-[10px] text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Re-send this appointment to the channel (use only when the original post never landed)."
          >
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </button>
        )}
        {resetBtn}
      </div>
    )
  }

  // Failed → red pill with a retry button (staff only).
  if (status === 'failed') {
    return (
      <div className="inline-flex items-center gap-1.5">
        <span
          className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-950 dark:text-rose-300"
          title="Last delivery attempt failed — click Retry to send again."
        >
          Failed
        </span>
        {staffMode && (
          <button
            type="button"
            onClick={() => onDeliver(false)}
            disabled={pending}
            className="inline-flex items-center gap-0.5 rounded-md border border-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Retry
          </button>
        )}
        {resetBtn}
      </div>
    )
  }

  // Backfilled → grey pill, with a Deliver button so admins can
  // rescue rows that got stuck during a buggy backfill or a config
  // toggle. Tooltip explains why.
  if (status === 'backfilled') {
    return (
      <div className="inline-flex items-center gap-1.5">
        <span
          className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
          title="Marked backfilled — won't auto-deliver. Click Deliver to send manually."
        >
          Backfilled
        </span>
        {staffMode && (
          <button
            type="button"
            onClick={() => onDeliver(false)}
            disabled={pending}
            className="inline-flex items-center gap-0.5 rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-50 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300"
          >
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Deliver
          </button>
        )}
        {resetBtn}
      </div>
    )
  }

  // No delivery record at all — the cron hasn't picked it up yet,
  // OR no client routing matched, OR the matched client has no
  // Slack channel set. Staff get a manual Deliver button to nudge
  // it through; agents see a neutral pending pill.
  return (
    <div className="inline-flex items-center gap-1.5">
      {staffMode ? (
        <button
          type="button"
          onClick={() => onDeliver(false)}
          disabled={pending}
          className="inline-flex items-center gap-0.5 rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-50 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300"
          title="Force this row to post to its client Slack channel now."
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Hash className="h-3 w-3" />
          )}
          Deliver
        </button>
      ) : (
        <span
          className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          title="Pending delivery — the next cron tick will post this to the client's Slack channel."
        >
          Pending
        </span>
      )}
    </div>
  )
}

/**
 * Pencil + trash icon buttons at the end of each Master Tracker
 * row. Mounts only for admin users (Alex). Edit opens the row-edit
 * modal; Delete shows a confirm() dialog and then DELETEs the sheet
 * row + cleans up downstream ledger records.
 */
/**
 * Pinned per-row actions — Edit + Delete, admin only. Lives in the
 * sticky right-edge column so they're reachable without scrolling the
 * wide table sideways. (Customer-alert control moved to the Dispatch
 * Status dropdown column.)
 */
function RowActions({
  isAdmin,
  adminPending,
  onEdit,
  onDelete,
}: {
  isAdmin: boolean
  adminPending: boolean
  onEdit?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      {isAdmin && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          disabled={adminPending}
          className="grid h-6 w-6 place-items-center rounded-md border border-zinc-200 text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-800 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          title="Edit this row"
          aria-label="Edit row"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {isAdmin && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={adminPending}
          className="grid h-6 w-6 place-items-center rounded-md border border-rose-200 text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900/50 dark:text-rose-400 dark:hover:bg-rose-950/40"
          title="Delete this row from the master sheet"
          aria-label="Delete row"
        >
          {adminPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </button>
      )}
    </div>
  )
}

/**
 * Modal that lets admin edit any field on a Master Tracker row.
 * Pre-fills from the currently-loaded appointment, sends only the
 * changed fields on save (so an empty Note field doesn't accidentally
 * clear an existing note unless the admin explicitly changed it).
 *
 * Status + Sent-to-Client stay inline-editable on the table itself;
 * this modal handles everything else (customer name, phone, address,
 * notes, financial fields, etc.). apptDateTime gets a datetime-local
 * picker so admin can move appointments without typing ISO strings.
 */
function AdminEditModal({
  appointment,
  clients,
  submitting,
  onSave,
  onCancel,
}: {
  appointment: Appointment | null
  /** Registered clients — drives the Client dropdown so admin can
   *  pick one instead of typing the name. */
  clients: Client[]
  submitting: boolean
  onSave: (payload: Record<string, string | null>) => void
  onCancel: () => void
}) {
  // Customer tz the row was parsed in — explicit Timezone-column
  // override first, address-state inference second. Used to populate
  // the datetime-local input in the right zone so 5 PM PDT actually
  // shows as 17:00 in the picker (not 20:00 in browser EDT).
  const customerTz =
    appointment?.resolvedTimezone ||
    customerTzFromAddress(appointment?.address ?? null)
  const initial = appointment
    ? {
        customerName: appointment.customerName ?? '',
        customerPhone: appointment.customerPhone ?? '',
        address: appointment.address ?? '',
        email: appointment.email ?? '',
        monthlyBill: appointment.monthlyBill ?? '',
        utilityProvider: appointment.utilityProvider ?? '',
        roofType: appointment.roofType ?? '',
        roofAge: appointment.roofAge ?? '',
        estimatedDealValue: appointment.estimatedDealValue ?? '',
        notes: appointment.notes ?? '',
        callRecordingLink: appointment.callRecordingLink ?? '',
        agentName: appointment.agent?.name ?? '',
        agentEmail: appointment.agent?.email ?? '',
        client: appointment.client?.name ?? '',
        timezone: appointment.timezone ?? '',
        // datetime-local in the CUSTOMER's tz so the displayed time
        // matches the hint ("Time is read at the customer's clock")
        // and matches what's on Master Tracker. Was browser-tz; that
        // mismatch was Alex's "showing 8PM" bug — 5 PM PDT in EDT
        // browser displayed as 8 PM in the picker.
        apptDateTime: appointment.apptDateTime
          ? toLocalDateTimeInput(appointment.apptDateTime, customerTz)
          : '',
      }
    : null
  const [values, setValues] = useState<Record<string, string>>(
    () => initial ?? {},
  )

  // When the modal opens for a different row, re-seed the form so
  // it doesn't show stale data from a prior row's edit. Keyed on
  // appointment.id so re-renders for the same row don't wipe
  // in-progress edits.
  const apptId = appointment?.id ?? null
  useEffect(() => {
    if (initial) setValues(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apptId])

  if (!appointment || !initial) return null

  function set(key: string, value: string) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  function buildDiff(): Record<string, string | null> {
    const diff: Record<string, string | null> = {}
    const initRecord = initial as Record<string, string>
    for (const [k, v] of Object.entries(values)) {
      const init = initRecord[k] ?? ''
      if (v !== init) {
        // Empty string clears the cell — preserve that intent.
        diff[k] = v
      }
    }
    // apptDateTime needs special handling. The picker gives us a
    // wall-clock string ("YYYY-MM-DDTHH:mm") in the customer's tz.
    // We split it into separate apptDate + apptTime fields and send
    // BOTH to the server as the canonical write targets — no
    // combined apptDateTime string, no server-side parsing, no
    // round-trip through `new Date()`. The sheet stores literal
    // text via RAW input, so what we send is what gets read back.
    //
    // Why we abandon the combined apptDateTime field on the wire:
    // every previous attempt to round-trip "M/D/YYYY h:mm AM/PM"
    // through the server + Sheets layer surfaced a new way for
    // hours or days to silently shift (sheet tz reparsing, locale
    // differences, comma quirks in toLocaleString output). Sending
    // discrete pieces removes all of that — the wall-clock the
    // user typed is exactly the wall-clock that lands in the cell.
    if (diff.apptDateTime !== undefined) {
      const raw = diff.apptDateTime ?? ''
      const m = raw.match(
        /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/,
      )
      if (m) {
        const Y = parseInt(m[1], 10)
        const M = parseInt(m[2], 10)
        const D = parseInt(m[3], 10)
        let h = parseInt(m[4], 10)
        const mn = parseInt(m[5], 10)
        const ampm = h >= 12 ? 'PM' : 'AM'
        h = h % 12
        if (h === 0) h = 12
        const dateStr = `${M}/${D}/${Y}`
        const timeStr = `${h}:${String(mn).padStart(2, '0')} ${ampm}`
        // Send ALL THREE forms so every possible sheet schema gets
        // updated. updateMasterTableCells silently skips canonicals
        // whose column isn't in the schema, so:
        //   - sheets with separate Date + Time → those two get written
        //   - sheets with a combined "Date and Time" → that gets written
        //   - sheets with all three → all three stay in sync (which
        //     matters because the read used to pick the combined cell
        //     and ignore fresh discrete edits)
        diff.apptDate = dateStr
        diff.apptTime = timeStr
        diff.apptDateTime = `${dateStr} ${timeStr}`
      } else if (raw === '') {
        // User cleared the time — clear all three so no stale value
        // can win on the next read.
        diff.apptDate = ''
        diff.apptTime = ''
        diff.apptDateTime = ''
      }
    }
    return diff
  }

  const diff = buildDiff()
  const hasChanges = Object.keys(diff).length > 0

  return (
    // Backdrop intentionally NOT click-to-close — same drag-out bug
    // Alex hit on the New/Edit client modal: text-selecting inside
    // the form, releasing outside, would close the dialog mid-edit.
    // X-button + Cancel-button are the close affordances.
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-12">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <div>
            <h3 className="text-base font-semibold">
              Edit appointment
            </h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              Sheet row {appointment.id.replace(/^sheet:/, '')} ·{' '}
              {appointment.customerName}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
          <EditField
            label="Customer name"
            value={values.customerName}
            onChange={(v) => set('customerName', v)}
          />
          <EditField
            label="Customer phone"
            value={values.customerPhone}
            onChange={(v) => set('customerPhone', v)}
          />
          <div>
            <EditField
              label="Appointment date / time"
              type="datetime-local"
              value={values.apptDateTime}
              onChange={(v) => set('apptDateTime', v)}
            />
            {/* Inline tz hint — explicit Timezone field below wins
                if set; otherwise we infer from the address. */}
            {(() => {
              const tzFromExplicit = values.timezone?.trim()
                ? values.timezone.trim()
                : null
              // parseTimezoneInput is the same one drive.ts uses on
              // sheet read, so what's shown here matches what gets
              // stored.
              let tz: string
              if (tzFromExplicit) {
                // Quick local resolution — the abbreviation map is
                // small enough to inline so we don't have to ship
                // it from server code.
                const upper = tzFromExplicit.toUpperCase().replace(/[^A-Z]/g, '')
                const ABBR: Record<string, string> = {
                  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
                  MT: 'America/Denver', MST: 'America/Phoenix', MDT: 'America/Denver',
                  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
                  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
                  HT: 'Pacific/Honolulu', HST: 'Pacific/Honolulu',
                  AKT: 'America/Anchorage', AKST: 'America/Anchorage', AKDT: 'America/Anchorage',
                }
                tz = ABBR[upper] ?? tzFromExplicit
              } else {
                tz = customerTzFromAddress(values.address || null)
              }
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
              // Preview the actual moment we'll save — formats the
              // input value as a wall-clock in the customer's tz, the
              // same tz the next sheet read will use to interpret it.
              // Lets Alex see "Saving as: Friday, May 8, 2026 at 6:00
              // PM PDT" before clicking Save so any AM/PM mistake or
              // off-by-12 surfaces here, not after a round-trip.
              const previewLabel = (() => {
                if (!values.apptDateTime) return null
                const m = values.apptDateTime.match(
                  /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})/,
                )
                if (!m) return null
                const Y = parseInt(m[1], 10)
                const M = parseInt(m[2], 10)
                const D = parseInt(m[3], 10)
                const h = parseInt(m[4], 10)
                const mn = parseInt(m[5], 10)
                let hour12 = h % 12
                if (hour12 === 0) hour12 = 12
                const ampm = h >= 12 ? 'PM' : 'AM'
                // Day-of-week in customer tz: build a Date from the
                // pretended UTC and format in target tz, since we
                // can't easily get the weekday otherwise without the
                // full tz round-trip.
                let weekday: string
                try {
                  weekday = new Intl.DateTimeFormat('en-US', {
                    weekday: 'long',
                    timeZone: tz,
                  }).format(new Date(Date.UTC(Y, M - 1, D, 12, 0)))
                } catch {
                  weekday = ''
                }
                return `${weekday ? weekday + ', ' : ''}${
                  [
                    'January','February','March','April','May','June',
                    'July','August','September','October','November','December',
                  ][M - 1]
                } ${D}, ${Y} at ${hour12}:${String(mn).padStart(2, '0')} ${ampm} ${shortLabel}`
              })()
              return (
                <>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Time is read at the customer&apos;s clock —{' '}
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                      {shortLabel}
                    </span>{' '}
                    <span className="text-zinc-400">
                      (
                      {tzFromExplicit
                        ? `from Timezone field`
                        : values.address?.trim()
                          ? `from address`
                          : `default — pick a tz or add an address`}
                      ).
                    </span>
                  </p>
                  {previewLabel && (
                    <p className="mt-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
                      Saving as: <span className="font-semibold">{previewLabel}</span>
                    </p>
                  )}
                </>
              )
            })()}
          </div>
          <EditField
            label="Timezone (optional)"
            value={values.timezone}
            onChange={(v) => set('timezone', v)}
            placeholder="PT / ET / CT / MT — overrides address"
          />
          {/* Client picker — dropdown of registered clients instead
              of free text. Many existing rows lost their explicit
              Client value when the routing brain switched away from
              state inference (multiple clients per state made the
              inference ambiguous), so admin needs to backfill. The
              dropdown surfaces every active client from /clients
              alphabetically. Falls back to a "current value as
              option" when the row has a name that doesn't match any
              registered client (legacy typos, churned clients, etc.)
              so saving doesn't accidentally clear it. */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Client
            </label>
            <select
              value={values.client}
              onChange={(e) => set('client', e.target.value)}
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="">— No client —</option>
              {[...clients]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                    {c.state ? ` · ${c.state}` : ''}
                  </option>
                ))}
              {values.client &&
                !clients.some((c) => c.name === values.client) && (
                  <option value={values.client}>
                    {values.client} (unrecognized)
                  </option>
                )}
            </select>
          </div>
          <div className="sm:col-span-2">
            <EditField
              label="Address"
              value={values.address}
              onChange={(v) => set('address', v)}
            />
          </div>
          <EditField
            label="Email"
            type="email"
            value={values.email}
            onChange={(v) => set('email', v)}
          />
          <EditField
            label="Utility provider"
            value={values.utilityProvider}
            onChange={(v) => set('utilityProvider', v)}
          />
          <EditField
            label="Monthly bill"
            value={values.monthlyBill}
            onChange={(v) => set('monthlyBill', v)}
          />
          <EditField
            label="Roof type"
            value={values.roofType}
            onChange={(v) => set('roofType', v)}
          />
          <EditField
            label="Roof age"
            value={values.roofAge}
            onChange={(v) => set('roofAge', v)}
          />
          <EditField
            label="Booked by (agent name)"
            value={values.agentName}
            onChange={(v) => set('agentName', v)}
          />
          <EditField
            label="Agent email"
            type="email"
            value={values.agentEmail}
            onChange={(v) => set('agentEmail', v)}
          />
          <div className="sm:col-span-2">
            <EditField
              label="Notes"
              value={values.notes}
              onChange={(v) => set('notes', v)}
              multiline
            />
          </div>
          <div className="sm:col-span-2">
            <EditField
              label="Call recording link"
              value={values.callRecordingLink}
              onChange={(v) => set('callRecordingLink', v)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <p className="text-[11px] text-zinc-500">
            {hasChanges
              ? `${Object.keys(diff).length} field${Object.keys(diff).length === 1 ? '' : 's'} will be updated.`
              : 'No changes yet.'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(diff)}
              disabled={!hasChanges || submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save changes
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function EditField({
  label,
  value,
  onChange,
  type = 'text',
  multiline,
  placeholder,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  type?: string
  multiline?: boolean
  placeholder?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder={placeholder}
          className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
        />
      )}
    </label>
  )
}

/**
 * Convert a stored ISO instant into the `YYYY-MM-DDTHH:mm` form that
 * `<input type="datetime-local">` expects, formatted in the
 * **customer's** timezone (not the editor's browser).
 *
 * Why customer-tz instead of browser-tz: Alex in EDT opening a row
 * stored as 5 PM PDT used to see "08:00 PM" in the input (5 PM PDT
 * = 8 PM EDT). The hint right below the input correctly says
 * "PDT" — so the input said one thing and the hint said another.
 * That mismatch was the source of "wait, what time is this even
 * supposed to be?" on every edit. Now both display in the
 * customer's clock, which is also the clock the wall-clock string
 * will be re-interpreted in on the next sheet read.
 */
function toLocalDateTimeInput(iso: string, timezone?: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  // Browser-tz fallback for backwards compatibility with callers
  // that haven't been migrated yet — same shape the old impl
  // returned.
  if (!timezone) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  // Format each component in the target tz via Intl. hourCycle:'h23'
  // gives 0-23 hours which is what datetime-local wants.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(d)
  const pick = (t: string) =>
    parts.find((p) => p.type === t)?.value ?? '00'
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`
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
