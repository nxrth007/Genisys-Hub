'use client'

import { useEffect, useRef, useState, useMemo } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Loader2,
  Building2,
  Users,
  Calendar as CalendarIcon,
  MapPin,
  Mail,
  Phone as PhoneIcon,
  Clock,
  ExternalLink,
  X,
  Pencil,
  FileText,
  StickyNote,
  Trash2,
  AlertTriangle,
  UserPlus,
  Receipt,
  ChevronDown,
  KeyRound,
  CheckCircle2,
  Hourglass,
  XCircle,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { STATE_NAME_TO_CODE } from '@/lib/address'
import { PageHeader } from '@/components/ui/page-header'
import { Chip, type ChipTone } from '@/components/ui/chip'
import { DropdownPill } from '@/components/ui/dropdown-pill'
import {
  ClientFormDialog,
  LIFECYCLE_OPTIONS,
  PACKAGE_OPTIONS,
  type ClientLifecycle,
  type ClientPackage,
  type ClientFormValues,
} from '@/components/clients/client-form'

/**
 * Clients — extended table view. Now a real CRM card per client:
 * primary contact, phone/email, address, notes, intake form, GHL
 * sub-account link, lifecycle status (active / onboarding / paused
 * / churned). Inline status select on each row for quick changes;
 * full edit dialog for everything else.
 */

type ClientWithCounts = {
  id: string
  name: string
  state: string | null
  color: string
  // Broader than ClientLifecycle because the API can return
  // "pending" / "denied" for self-onboarded clients. Those states
  // aren't admin-pickable through the form; they only enter via
  // /signin/client/register and exit via /clients/onboarding's
  // approve / deny actions.
  lifecycle: ClientLifecycle | 'pending' | 'denied'
  package: ClientPackage
  /** Nominal appt cap. null = unlimited (sit-down guarantee). */
  apptCap: number | null
  /** Manual override for the cap-fulfillment due date. Null falls
   *  back to the per-package computed default (PPA 14d, Growth 21d,
   *  Pro 28d, Custom = none). Set via the date picker in the edit form. */
  dueDate: string | null
  contactName: string | null
  contactRole: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  notes: string | null
  intakeFormUrl: string | null
  ghlSubaccountUrl: string | null
  /** Comma- or whitespace-separated zipcodes the client services.
   *  Captured during self-onboarding; admin can edit via the form. */
  servicingZipcodes: string | null
  /** Intake answers captured during self-onboarding (added
   *  2026-05-11). Nullable for legacy clients who registered before
   *  these fields existed; admin can fill them in after the fact
   *  via the edit dialog. */
  appointmentTypes: 'in_person' | 'virtual' | 'both' | null
  bookWeekends: boolean | null
  website: string | null
  providesBatteryBackup: boolean | null
  /** Long-form intake answers from the self-onboarding form. Both
   *  optional; admin can fill in / edit via the client edit dialog. */
  qualificationCriteria: string | null
  onboardingNotes: string | null
  /** When the Client row was created. ISO string. Used in the
   *  Additional info panel to show "Application date" for self-
   *  onboarded clients. */
  createdAt: string
  /** Linked /client login account, if any. Surfaced in the
   *  Additional info panel so admin can see whether a client
   *  actually signed in. Null = no login provisioned yet. */
  linkedLogin: {
    id: string
    email: string
    role: string
    mustChangePassword: boolean
    createdAt: string
    updatedAt: string
  } | null
  total: number
  upcoming: number
  booked: number
  showed: number
  noShow: number
  cancelled: number
  /** Sitdowns — appointments where the client actually met the
   *  customer (Sitdown=Yes on Master Tracker). The "qualified
   *  appointment" count, separate from raw bookings. */
  sitdowns: number
  /** Resolved (showed + no-show + cancelled) / total — the "appointment
   *  progress" metric Ethan asked for. Null when total is 0. */
  progressPct: number | null
  /** Legacy show-vs-no-show ratio. Kept for the detail dialog. */
  showRate: number | null
  agents: number
  lastBookingAt: string | null
}

type StateFilter = 'all' | 'AZ' | 'CA' | 'UT' | 'other'
type StatusFilter = 'all' | ClientLifecycle
type PackageFilter = 'all' | ClientPackage

/**
 * Estimated cap-fulfillment due date for a client, based on the
 * turnaround window per package (per Ethan, 2026-05-08):
 *
 *   ppa     → 14 days from createdAt (within 2 weeks)
 *   growth  → 21 days (within 3 weeks)
 *   pro     → 28 days (within 4 weeks)
 *   custom  → no due date (admin sets the timeline manually elsewhere)
 *
 * Anchored to createdAt because we don't have a contract-start
 * field yet — admin can refine the model later by setting an explicit
 * client.dueDate override via the edit form.
 *
 * Returns null when no turnaround window applies.
 */
function computeClientDueDate(
  clientPackage: string,
  createdAtIso: string,
): Date | null {
  const days = packageTurnaroundDays(clientPackage)
  if (days == null) return null
  const start = new Date(createdAtIso)
  if (isNaN(start.getTime())) return null
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000)
}

function packageTurnaroundDays(pkg: string): number | null {
  switch (pkg) {
    case 'ppa':
      return 14
    case 'growth':
      return 21
    case 'pro':
      return 28
    default:
      return null // "custom" or unknown — no automatic due date
  }
}

/** Convert a 3- or 6-char hex string to an rgba() at the given alpha.
 *  Used to render the state chip in a tint of the client's brand color
 *  instead of a fixed-by-state palette — that way the chip color
 *  matches what the admin set on the edit dialog (and the avatar /
 *  status dot) instead of being dictated by which US state. */
function hexToRgba(hex: string, alpha: number): string {
  const cleaned = (hex || '#3b82f6').replace('#', '')
  const expanded =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned
  const r = parseInt(expanded.slice(0, 2), 16) || 0
  const g = parseInt(expanded.slice(2, 4), 16) || 0
  const b = parseInt(expanded.slice(4, 6), 16) || 0
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Reuse the canonical state-name → code map from lib/address. The
// timezone resolver, sheet-routing brain, and now this page's chip
// renderer all share one source of truth — drift would be a bug.
const VALID_STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE))

function stateCode(state: string | null): string {
  if (!state) return '—'
  const trimmed = state.trim()
  if (!trimmed) return '—'
  const lower = trimmed.toLowerCase()
  // Direct full-name match (handles "New Jersey", "New Hampshire",
  // "West Virginia", etc.).
  const mapped = STATE_NAME_TO_CODE[lower]
  if (mapped) return mapped
  // Already a 2-letter code? Return as-is (uppercased).
  if (trimmed.length === 2) {
    const upper = trimmed.toUpperCase()
    if (VALID_STATE_CODES.has(upper)) return upper
  }
  // Last-resort fallback — first 2 chars uppercased. Worse than the
  // map but better than crashing on a legit unknown / typo.
  return trimmed.slice(0, 2).toUpperCase()
}

// Tone + label maps cover both the admin-pickable lifecycles AND
// the self-onboarding states (pending / denied). The latter aren't
// in LIFECYCLE_OPTIONS — they're not flippable via the inline
// dropdown — but they still need labels and chip tones for display.
const LIFECYCLE_TONE: Record<string, ChipTone> = {
  active: 'mint',
  onboarding: 'amber',
  paused: 'blue',
  churned: 'pink',
  pending: 'muted',
  denied: 'pink',
}

const LIFECYCLE_LABEL: Record<string, string> = {
  active: 'Active',
  onboarding: 'Onboarding',
  paused: 'Paused',
  churned: 'Churned',
  pending: 'Pending review',
  denied: 'Denied',
}

/** Tone per package tier — lets the badge color hint at the
 *  commitment level at a glance (PPA = neutral, Growth/Pro = warm
 *  brand colors, Custom = muted). */
const PACKAGE_TONE: Record<ClientPackage, ChipTone> = {
  ppa: 'blue',
  growth: 'mint',
  pro: 'violet',
  custom: 'amber',
}

const PACKAGE_LABEL: Record<ClientPackage, string> = {
  ppa: 'PPA',
  growth: 'Growth',
  pro: 'Pro',
  custom: 'Custom',
}

/**
 * Email allowed to delete clients. Hardcoded to mirror the server-
 * side gate in /api/clients/[id] DELETE — keeping them in sync by
 * convention rather than a shared constant since the server check
 * is the security boundary; this client-side check is purely UX
 * (show/hide the Delete button).
 */
const CLIENT_DELETE_AUTHORIZED_EMAIL = 'alex@leadgenisys.com'

export default function ClientsPage() {
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [packageFilter, setPackageFilter] = useState<PackageFilter>('all')
  // Free-text search — composes with the filter pills above. Multi-
  // token (whitespace-split): every token must match at least one
  // searchable field, so "spring solar" returns only rows where
  // both words land somewhere. Case-insensitive, substring match,
  // searches across name + contact (name/role/email/phone) + state
  // (full + 2-letter) + package + lifecycle, and notes. That gives
  // Alex a single bar that finds clients by basically any field
  // they remember.
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<ClientWithCounts | null>(null)
  const [editing, setEditing] = useState<ClientWithCounts | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ClientWithCounts | null>(null)

  // Session — used purely to decide whether to render the Delete
  // button. Server still independently enforces the email gate, so
  // a curious user spoofing the session locally would still get a
  // 403 from /api/clients/[id] DELETE.
  const sessionQuery = useQuery<{
    user?: { email?: string | null }
  }>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return {}
      return res.json()
    },
  })
  const sessionEmail = (
    sessionQuery.data?.user?.email ?? ''
  ).toLowerCase()
  const canDeleteClients =
    sessionEmail === CLIENT_DELETE_AUTHORIZED_EMAIL.toLowerCase()

  const query = useQuery<{ clients: ClientWithCounts[] }>({
    queryKey: ['clients-with-counts'],
    queryFn: async () => {
      const res = await fetch('/api/clients/with-counts')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
  })
  const clients = useMemo(() => query.data?.clients ?? [], [query.data])

  const filtered = useMemo(() => {
    let list = clients
    if (stateFilter !== 'all') {
      list = list.filter((c) =>
        stateFilter === 'other'
          ? !['AZ', 'CA', 'UT'].includes(stateCode(c.state))
          : stateCode(c.state) === stateFilter
      )
    }
    if (statusFilter !== 'all') {
      list = list.filter((c) => c.lifecycle === statusFilter)
    }
    if (packageFilter !== 'all') {
      list = list.filter((c) => c.package === packageFilter)
    }
    // Free-text search — multi-token AND. Build the searchable haystack
    // once per client by joining every field a human might remember,
    // lowercase, then check that EVERY token from the query appears
    // somewhere in that haystack. Cheap because the client list is
    // tiny and the work is only redone when search/state/etc change.
    const tokens = search
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    if (tokens.length > 0) {
      list = list.filter((c) => {
        const haystack = [
          c.name,
          c.contactName,
          c.contactRole,
          c.contactEmail,
          // Phone normalized to digits-only too so a query like "555"
          // matches "+1 (555) 803-4828" the same as "(555) 803-4828".
          c.contactPhone,
          (c.contactPhone ?? '').replace(/\D/g, ''),
          c.state,
          stateCode(c.state),
          c.package,
          c.lifecycle,
          c.address,
          c.notes,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return tokens.every((t) => haystack.includes(t))
      })
    }
    return list
  }, [clients, stateFilter, statusFilter, packageFilter, search])

  // Split clients-not-yet-fully-set-up off so they render in their
  // own gray section below the active list. Two sub-states sit in
  // this bucket and read visually identical so admin sees one
  // "still in the funnel" stack instead of having to track two:
  //   1. lifecycle === 'pending'                     — self-registered,
  //      hasn't been approved yet (payment still in flight or admin
  //      hasn't reviewed). Approve / Deny / Delete lives on
  //      /clients/onboarding.
  //   2. lifecycle === 'onboarding' && !contactName  — already
  //      approved (admin clicked Approve) but the client hasn't
  //      submitted the full onboarding form yet, so we still have
  //      no contact info / address / qualification criteria. They
  //      can sign in, see the embedded form on /client, and lift
  //      themselves into 'active' by submitting.
  // Existing 'onboarding' clients that admin pre-filled manually
  // (contactName non-null) stay in the active list — those have
  // all the data needed to take real bookings.
  const { activeClients, pendingClients } = useMemo(() => {
    const pending = filtered.filter(awaitsSetup)
    const rest = filtered.filter((c) => !awaitsSetup(c))
    return { activeClients: rest, pendingClients: pending }
  }, [filtered])

  // Stats — all run over the unfiltered set so the cards show real
  // totals regardless of what's currently filtered.
  const totalAppts = clients.reduce((s, c) => s + c.total, 0)
  const activeCount = clients.filter(
    (c) =>
      (c.lifecycle === 'active' || c.lifecycle === 'onboarding') &&
      !awaitsSetup(c),
  ).length
  const completed = clients.reduce((s, c) => s + c.showed + c.noShow, 0)
  const showed = clients.reduce((s, c) => s + c.showed, 0)
  const avgShowRate = completed > 0 ? Math.round((showed / completed) * 100) : null

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="Clients"
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Clients' }]}
        actions={
          <div className="flex items-center gap-2">
            {/* Client SMS — opens the dedicated /settings/client-alerts
                focused view (master toggle, sender number, per-client
                routing, Recent activity feed with retry/cancel, test
                sends). Per Alex 2026-05-11 this lives at its own
                route, not as an anchor into the full Settings page,
                so admin only sees the SMS controls without the rest
                of Settings coming along. */}
            <Link
              href="/settings/client-alerts"
              className="inline-flex items-center gap-2 rounded-full bg-orange-500 px-4 py-2 text-sm font-semibold text-white shadow-soft transition hover:bg-orange-600"
            >
              <PhoneIcon className="h-4 w-4" /> Client SMS
            </Link>
            {/* Onboarding lives on its own page for Phase 1 — pending
                self-registrations + Credentials management sit there.
                Placed to the left of "New client" per Alex's spec. */}
            <Link
              href="/clients/onboarding"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
            >
              <UserPlus className="h-4 w-4" /> Onboarding
            </Link>
            {/* Invoices history — surfaces the audit trail for the
                PPA bi-weekly automation. Admin/member can scan past
                cycles, copy payment links, retry failed deliveries. */}
            <Link
              href="/clients/invoices"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
            >
              <Receipt className="h-4 w-4" /> Invoices
            </Link>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> New client
            </button>
          </div>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <DropdownPill
          value={stateFilter}
          options={[
            { id: 'all', label: 'All states' },
            { id: 'AZ', label: 'Arizona (Brighton)' },
            { id: 'CA', label: 'California (Energy Upgrade)' },
            { id: 'UT', label: 'Utah (Spring Solar)' },
            { id: 'other', label: 'Other' },
          ]}
          onChange={setStateFilter}
          icon={MapPin}
        />
        <DropdownPill
          value={statusFilter}
          options={[
            { id: 'all', label: 'All statuses' },
            { id: 'active', label: 'Active' },
            { id: 'onboarding', label: 'Onboarding' },
            { id: 'paused', label: 'Paused' },
            { id: 'churned', label: 'Churned' },
          ]}
          onChange={setStatusFilter}
        />
        <DropdownPill
          value={packageFilter}
          options={[
            { id: 'all', label: 'All packages' },
            { id: 'ppa', label: 'PPA' },
            { id: 'growth', label: 'Growth' },
            { id: 'pro', label: 'Pro' },
            { id: 'custom', label: 'Custom' },
          ]}
          onChange={setPackageFilter}
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Active clients"
          value={String(activeCount)}
          sub={`${clients.length - activeCount} on hold or churned`}
        />
        <SummaryCard
          label="Appts booked"
          value={totalAppts.toLocaleString()}
          sub={`across ${clients.length} client${clients.length === 1 ? '' : 's'}`}
        />
        <SummaryCard
          label="Avg show rate"
          value={avgShowRate != null ? `${avgShowRate}%` : '—'}
          sub="across completed bookings"
        />
      </div>

      {/* Search — composes with the pill filters above. Searches
          across every human-memorable field (name, contact info,
          state in either form, package, lifecycle, address, notes)
          and uses multi-token AND so "spring solar" only matches
          rows containing both words. The match-count chip on the
          right is always visible when a query is active so admin
          knows whether they accidentally narrowed too far. */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by client name, contact, email, phone, state…"
          aria-label="Search clients"
          className="w-full rounded-full border border-border bg-card py-2.5 pl-11 pr-28 text-sm shadow-soft transition focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        {search.trim() && (
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
              {filtered.length} {filtered.length === 1 ? 'match' : 'matches'}
            </span>
            <button
              type="button"
              onClick={() => setSearch('')}
              className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : query.isError ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-sm text-destructive">
          Couldn&apos;t load the client list. Try refreshing.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
          <Building2 className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {clients.length === 0
              ? 'No clients yet — click "New client" to add one.'
              : search.trim()
                ? `No clients match "${search.trim()}".`
                : 'No clients match these filters.'}
          </p>
          {(search.trim() ||
            stateFilter !== 'all' ||
            statusFilter !== 'all' ||
            packageFilter !== 'all') &&
            clients.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSearch('')
                  setStateFilter('all')
                  setStatusFilter('all')
                  setPackageFilter('all')
                }}
                className="mt-3 text-xs font-medium text-primary hover:underline"
              >
                Clear all filters
              </button>
            )}
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-[2fr_90px_70px_90px_1.4fr_100px_100px_110px] items-center gap-3 px-2 pb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Client</span>
            <span>Package</span>
            <span>Agents</span>
            <span>State</span>
            <span>Cap progress</span>
            <span>Last booking</span>
            <span>Due date</span>
            <span>Status</span>
          </div>
          <ul>
            {activeClients.map((c) => (
              <ClientRow key={c.id} client={c} onOpen={setActive} />
            ))}
          </ul>

          {/* Pending section. Two sub-states share this bucket:
              self-registered clients who haven't been approved yet,
              and approved-but-no-form-yet clients waiting on the
              client to fill out their onboarding details. Both stay
              here until they have a complete profile + non-null
              contactName — at which point they move into the active
              list above. */}
          {pendingClients.length > 0 && (
            <div className="mt-8">
              <div className="mb-3 flex items-center gap-3">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-dashed border-muted-foreground/60" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Pending · {pendingClients.length}
                </h3>
                <Link
                  href="/clients/onboarding"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Approval queue →
                </Link>
              </div>
              <ul>
                {pendingClients.map((c) => (
                  <ClientRow key={c.id} client={c} onOpen={setActive} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ClientDetailDialog
        client={active}
        onClose={() => setActive(null)}
        onEdit={(c) => {
          setActive(null)
          setEditing(c)
        }}
        canDelete={canDeleteClients}
        onDelete={(c) => {
          setActive(null)
          setDeleting(c)
        }}
      />
      <DeleteClientDialog
        client={deleting}
        onClose={() => setDeleting(null)}
      />
      <ClientFormDialog
        open={creating}
        onOpenChange={setCreating}
        mode="create"
      />
      <ClientFormDialog
        open={!!editing}
        onOpenChange={(v) => {
          if (!v) setEditing(null)
        }}
        mode="edit"
        initial={editing ? toFormValues(editing) : undefined}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function ClientRow({
  client,
  onOpen,
}: {
  client: ClientWithCounts
  onOpen: (c: ClientWithCounts) => void
}) {
  const initials = clientInitials(client.name)
  // Per Ethan: the bar should track BOOKED APPOINTMENTS toward the
  // contracted cap, not sit-downs. Sit-downs are the qualification
  // outcome (was the rep actually able to meet the customer?), but
  // the operational "are we delivering" question is "how many of
  // the X appointments we promised have we booked?" Sit-downs get
  // a small caption underneath as additional context.
  const cap = client.apptCap
  const bookedPct =
    cap && cap > 0 ? Math.round((client.total / cap) * 100) : null
  const barWidth = bookedPct ?? 0
  // Per Ethan: a single gradient-green bar for every client
  // regardless of progress %. The previous red/amber/emerald
  // gradient-by-percent was visually noisy; green for everyone keeps
  // the column scannable and reserves color for status / state chips.
  // Empty / no-cap rows still render a neutral rail so the column
  // doesn't go ghost.
  const showBar = bookedPct != null && bookedPct > 0
  const barClass = 'bg-gradient-to-r from-emerald-400 to-emerald-600'

  // Due date — manual override on the Client record wins; otherwise
  // fall back to the package-default heuristic. Per Ethan: PPA 14d,
  // Growth 21d, Pro 28d, Custom = none.
  const dueDate = client.dueDate
    ? new Date(client.dueDate)
    : computeClientDueDate(client.package, client.createdAt)
  const dueDateIsOverride = !!client.dueDate

  // "Pending" visual = client isn't fully set up yet. Two paths in:
  //   - lifecycle === 'pending' (self-registered, not yet approved)
  //   - lifecycle === 'onboarding' && !contactName (approved but
  //     hasn't submitted the full onboarding form yet, so we have
  //     no real contact data on them)
  // Both render with a dashed grey ring + faded interior so they
  // read as "placeholder for an inactive client" instead of blending
  // in with the live roster. See awaitsSetup() at the bottom of this
  // file for the canonical predicate.
  const isPending = awaitsSetup(client)

  // Make the click open detail, but the inline status pill swallows
  // its own click so changing status doesn't also open the dialog.
  return (
    <li
      onClick={() => onOpen(client)}
      className={cn(
        'grid cursor-pointer grid-cols-[2fr_90px_70px_90px_1.4fr_100px_100px_110px] items-center gap-3 border-t border-border-soft px-2 py-4 transition hover:bg-surface-muted',
        isPending && 'opacity-80',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold',
            isPending
              ? 'border-2 border-dashed border-muted-foreground/60 bg-muted text-muted-foreground'
              : 'text-white',
          )}
          style={isPending ? undefined : { backgroundColor: client.color }}
        >
          {initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{client.name}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                isPending && 'border border-dashed border-muted-foreground/60',
              )}
              style={
                isPending
                  ? { backgroundColor: 'transparent' }
                  : { backgroundColor: client.color }
              }
              aria-hidden
            />
            <p className="truncate text-xs text-muted-foreground">
              {client.state || 'Multi-state'}
              {client.contactName && ` · ${client.contactName}`}
            </p>
          </div>
        </div>
      </div>

      {/* Package badge — colored chip shows tier at a glance,
          plus the cap number underneath so admins can see the
          commitment without opening the row. */}
      <div className="flex flex-col items-start gap-0.5">
        <Chip tone={PACKAGE_TONE[client.package] ?? 'muted'}>
          {PACKAGE_LABEL[client.package] ?? 'Custom'}
        </Chip>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {client.apptCap ? `${client.apptCap} appt cap` : 'No cap'}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="tabular-nums">{client.agents}</span>
      </div>

      {/* State chip — tinted with the client's own brand color
          (set on the edit form) so the column reads as a
          mini-color-key matching the avatar and status dot. */}
      <span>
        <ClientStateChip client={client} />
      </span>

      <div className="flex flex-col gap-1.5">
        {/* Top line — booked / cap fraction (or just booked when
            uncapped). Replaces the previous "X booked (cap reached)"
            string with a clearer "7/20" headline that matches what
            the bar below visualizes. */}
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {cap && cap > 0
            ? `${client.total}/${cap} booked${client.total >= cap ? ' · cap reached' : ''}`
            : client.total > 0
              ? `${client.total} booked`
              : '—'}
        </span>
        {/* Bar — booked appointments toward the contracted cap.
            Single gradient green for every client (Ethan, 2026-05-08);
            muted rail when no cap or no bookings yet. */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          {showBar && (
            <div
              className={cn('h-full rounded-full', barClass)}
              style={{ width: `${Math.min(barWidth, 100)}%` }}
            />
          )}
        </div>
        {/* Sit-downs — informational caption only, not the bar's
            denominator. "X sitdowns" instead of the previous
            "X/Y sitdowns" fraction. Always renders so empty rows
            still telegraph "0 sitdowns" rather than going silent. */}
        <span
          className="text-[10px] tabular-nums text-muted-foreground"
          title="Appointments where the rep actually met with the customer (Sitdown=Yes on Master Tracker). Set manually by admin."
        >
          {client.sitdowns} sitdown{client.sitdowns === 1 ? '' : 's'}
        </span>
      </div>

      {/* Last booking — when the most recent appointment for this
          client landed. Anchored on Master Tracker bookings. */}
      <span
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        title="Most recent appointment booked for this client."
      >
        <CalendarIcon className="h-3 w-3" />
        {client.lastBookingAt ? formatDate(client.lastBookingAt) : '—'}
      </span>

      {/* Due date — manual override on the Client record wins;
          otherwise falls back to the package-default heuristic
          (PPA 14d, Growth 21d, Pro 28d, Custom none). Italics
          telegraph "this is the package default, not a custom
          deadline" so admin can spot which clients have an
          explicit override vs the inherited turnaround. */}
      <span
        className={cn(
          'flex items-center gap-1.5 text-xs',
          dueDateIsOverride
            ? 'text-foreground'
            : 'italic text-muted-foreground',
        )}
        title={
          dueDate
            ? dueDateIsOverride
              ? 'Manually set in the edit form.'
              : `Default for ${client.package.toUpperCase()} (set a manual override in the edit form to change).`
            : 'No turnaround window — set a manual deadline in the edit form if needed.'
        }
      >
        <CalendarIcon className="h-3 w-3" />
        {dueDate ? formatDate(dueDate.toISOString()) : '—'}
      </span>

      <div onClick={(e) => e.stopPropagation()}>
        <InlineStatusSelect client={client} />
      </div>
    </li>
  )
}

/* -------------------------------------------------------------------------- */

/** Native <select> styled as a chip — same pattern as the Master
 *  Tracker status editor. Optimistic update + revert on error. */
function InlineStatusSelect({ client }: { client: ClientWithCounts }) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (lifecycle: ClientLifecycle) => {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lifecycle }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update status')
      }
      return lifecycle
    },
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ['clients-with-counts'] })
      const previous = qc.getQueryData<{ clients: ClientWithCounts[] }>([
        'clients-with-counts',
      ])
      if (previous) {
        qc.setQueryData<{ clients: ClientWithCounts[] }>(
          ['clients-with-counts'],
          {
            ...previous,
            clients: previous.clients.map((c) =>
              c.id === client.id ? { ...c, lifecycle: next } : c
            ),
          }
        )
      }
      return { previous }
    },
    onError: (_err, _next, context) => {
      if (context?.previous) {
        qc.setQueryData(['clients-with-counts'], context.previous)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] })
    },
  })

  // Pending / denied lifecycles aren't admin-pickable from this
  // dropdown. Self-onboarded clients enter "pending" via
  // /signin/client/register and exit via the approve/deny buttons
  // on /clients/onboarding — letting an admin manually flip another
  // client TO pending here would be confusing and could orphan a
  // linked User account. Show a static chip instead.
  if (client.lifecycle === 'pending' || client.lifecycle === 'denied') {
    return (
      <Chip tone={LIFECYCLE_TONE[client.lifecycle] ?? 'muted'}>
        {LIFECYCLE_LABEL[client.lifecycle] ?? client.lifecycle}
      </Chip>
    )
  }

  const tone = LIFECYCLE_TONE[client.lifecycle] ?? 'muted'
  const toneClass =
    tone === 'mint'
      ? 'chip-mint'
      : tone === 'amber'
        ? 'chip-amber'
        : tone === 'blue'
          ? 'chip-blue'
          : tone === 'pink'
            ? 'chip-pink'
            : 'bg-muted text-muted-foreground'

  return (
    <select
      value={client.lifecycle}
      disabled={mutation.isPending}
      onChange={(e) => mutation.mutate(e.target.value as ClientLifecycle)}
      className={cn(
        'cursor-pointer appearance-none rounded-full px-2.5 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary/40',
        toneClass,
        mutation.isPending && 'opacity-60'
      )}
      title="Change status"
    >
      {LIFECYCLE_OPTIONS.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/* -------------------------------------------------------------------------- */

function ClientDetailDialog({
  client,
  onClose,
  onEdit,
  canDelete,
  onDelete,
}: {
  client: ClientWithCounts | null
  onClose: () => void
  onEdit: (c: ClientWithCounts) => void
  /** True when the session belongs to the email allowed to delete
   *  clients. Server independently enforces the same check; this
   *  prop only controls whether the Delete button renders. */
  canDelete: boolean
  onDelete: (c: ClientWithCounts) => void
}) {
  useEffect(() => {
    if (!client) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [client, onClose])

  if (!client) return null

  const initials = clientInitials(client.name)
  const pct = client.progressPct ?? 0
  const resolved = client.showed + client.noShow + client.cancelled
  const completed = client.showed + client.noShow

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 place-items-center rounded-full text-sm font-semibold text-white"
              style={{ backgroundColor: client.color }}
            >
              {initials}
            </span>
            <div>
              <p className="text-base font-semibold">{client.name}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: client.color }}
                  aria-hidden
                />
                {client.state || 'Multi-state'} ·{' '}
                {LIFECYCLE_LABEL[client.lifecycle]}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* + Add appointment lives in the same action row as Edit /
                Delete (per Alex's screenshot). Both alex@ and ethan@
                hit /clients so we don't need a per-email gate here —
                middleware already keeps agents out of /clients. The
                link lands on /agent/appointments/new with the client
                pre-selected; from there it's the same booking flow
                Mary uses, just attributed to whoever's signed in. */}
            <Link
              href={`/agent/appointments/new?clientId=${client.id}`}
              title={`Add a new appointment for ${client.name}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" /> Add appointment
            </Link>
            <button
              type="button"
              onClick={() => onEdit(client)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold transition hover:bg-muted"
              title="Edit client"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={() => onDelete(client)}
                className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70"
                title="Delete this client (admin password required)"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Status + package + due date — three pills in one row.
            Package chip surfaces the contract tier; the due-date
            pill tells admin when the contracted cap should be hit
            based on the package turnaround window. */}
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={LIFECYCLE_TONE[client.lifecycle]} className="font-semibold">
            {LIFECYCLE_LABEL[client.lifecycle]}
          </Chip>
          <Chip tone={PACKAGE_TONE[client.package] ?? 'muted'} className="font-semibold">
            {PACKAGE_LABEL[client.package] ?? 'Custom'}
            {client.apptCap ? ` · ${client.apptCap}` : ' · no cap'}
          </Chip>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-border-soft bg-surface-muted px-2.5 py-1 text-xs font-medium"
            title={
              client.dueDate
                ? 'Manually set in the edit form.'
                : computeClientDueDate(client.package, client.createdAt)
                  ? `Default for ${client.package.toUpperCase()} (set a manual override in the edit form to change).`
                  : 'No turnaround window for the custom package.'
            }
          >
            <Clock className="h-3 w-3 text-muted-foreground" />
            Due: {(() => {
              const d = client.dueDate
                ? new Date(client.dueDate)
                : computeClientDueDate(client.package, client.createdAt)
              return d ? formatDate(d.toISOString()) : '—'
            })()}
          </span>
        </div>

        {/* Appointment progress — resolved share is the primary metric
            now. Show rate (showed / completed) sits below as a secondary
            number for admins who still want to track it. */}
        <div className="rounded-xl border border-border-soft bg-surface-muted p-3">
          <div className="flex items-baseline justify-between">
            <p className="text-xs font-semibold text-muted-foreground">
              Appointment progress
            </p>
            <p className="text-sm font-semibold tabular-nums">
              {resolved} / {client.total}{' '}
              <span className="text-xs font-normal text-muted-foreground">
                ({client.progressPct != null ? `${client.progressPct}%` : '—'})
              </span>
            </p>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full',
                client.progressPct == null
                  ? 'bg-primary'
                  : pct >= 75
                    ? 'bg-emerald-500'
                    : pct >= 50
                      ? 'bg-amber-400'
                      : 'bg-rose-500'
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {client.showRate != null
              ? `Show rate: ${client.showed}/${completed} (${client.showRate}%)`
              : 'Show rate: not enough resolved appointments yet'}
          </p>
          <div className="mt-3 grid grid-cols-4 gap-2 text-[11px] text-muted-foreground">
            <Stat label="Total" value={client.total} />
            <Stat label="Upcoming" value={client.upcoming} />
            <Stat label="Showed" value={client.showed} />
            <Stat label="No-show" value={client.noShow} />
          </div>
        </div>

        {/* Primary contact — only renders if there's at least one
            field populated, so empty cards don't bloat the dialog. */}
        {(client.contactName ||
          client.contactRole ||
          client.contactEmail ||
          client.contactPhone ||
          client.address) && (
          <Section label="Primary contact">
            <div className="flex flex-col gap-1 rounded-xl border border-border-soft bg-card p-3 text-sm">
              {client.contactName && (
                <p className="text-sm font-semibold">
                  {client.contactName}
                  {client.contactRole && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      · {client.contactRole}
                    </span>
                  )}
                </p>
              )}
              {client.contactEmail && (
                <a
                  href={`mailto:${client.contactEmail}`}
                  className="flex items-center gap-2 text-sm text-foreground/80 hover:text-primary"
                >
                  <Mail className="h-3.5 w-3.5" /> {client.contactEmail}
                </a>
              )}
              {client.contactPhone && (
                <a
                  href={`tel:${client.contactPhone.replace(/\D/g, '')}`}
                  className="flex items-center gap-2 text-sm text-foreground/80 hover:text-primary"
                >
                  <PhoneIcon className="h-3.5 w-3.5" /> {client.contactPhone}
                </a>
              )}
              {client.address && (
                <p className="flex items-start gap-2 text-sm text-foreground/80">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {client.address}
                </p>
              )}
            </div>
          </Section>
        )}

        {/* Notes */}
        {client.notes && (
          <Section label="Notes">
            <div className="flex items-start gap-3 rounded-xl border border-border-soft bg-card p-3 text-sm">
              <StickyNote className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <p className="whitespace-pre-wrap text-foreground/85">
                {client.notes}
              </p>
            </div>
          </Section>
        )}

        {/* Additional info — foldable so the dialog stays compact
            for clients where these fields are empty. Always renders
            (createdAt is always populated) but defaults closed. */}
        <AdditionalInfo client={client} />

        {/* Resources — Master Tracker shortcut + intake form +
            GoHighLevel sub-account if any are configured. */}
        <Section label="Resources">
          <div className="flex flex-col gap-2">
            <ResourceLink
              href={`/call-center/master-tracker?client=${client.id}`}
              icon={Building2}
              label={`Master Tracker · ${client.name}`}
              hint="Pre-filtered list of every booking for this client"
            />
            {client.intakeFormUrl && (
              <ResourceLink
                href={client.intakeFormUrl}
                external
                icon={FileText}
                label="Client intake form"
                hint={client.intakeFormUrl}
              />
            )}
            {client.ghlSubaccountUrl && (
              <ResourceLink
                href={client.ghlSubaccountUrl}
                external
                icon={ExternalLink}
                label="GoHighLevel sub-account"
                hint={client.ghlSubaccountUrl}
              />
            )}
          </div>
        </Section>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground/80 transition hover:bg-muted"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => onEdit(client)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            <Pencil className="h-4 w-4" /> Edit client
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Password-gated delete confirmation. Two-step UX so a misclick
 * never silently nukes a client + every appointment, sitdown
 * record, and reminder template attached to it.
 *
 * Server-side, /api/clients/[id] DELETE checks BOTH the session
 * email AND the password. The UI's password input is purely the
 * "extra friction so a misclick can't fire" layer; the actual
 * security boundary is the vault-comparison on the server.
 */
function DeleteClientDialog({
  client,
  onClose,
}: {
  client: ClientWithCounts | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset state every time the dialog opens for a new client so a
  // previous failed attempt's typo doesn't carry over.
  useEffect(() => {
    if (client) {
      setPassword('')
      setError(null)
      // Auto-focus the password input on open. setTimeout 0 yields
      // to React's render so the input is mounted before .focus()
      // tries to grab it.
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [client])

  // Esc closes — keyboard users need an out since the backdrop is
  // intentionally non-dismissive (see backdrop comment below).
  useEffect(() => {
    if (!client) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [client, onClose])

  const deleteMutation = useMutation({
    mutationFn: async (vars: {
      clientId: string
      password: string
    }): Promise<{ ok: true; deleted: { id: string; name: string } }> => {
      const res = await fetch(`/api/clients/${vars.clientId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: vars.password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `Delete failed (${res.status})`)
      }
      return data
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['clients-with-counts'] })
      window.alert(
        `Deleted "${data.deleted.name}". Any existing appointments for that client are now unassigned (you can re-assign or delete them from the Master Tracker).`,
      )
      onClose()
    },
    onError: (err) => {
      setError((err as Error).message)
    },
  })

  if (!client) return null

  return (
    // Backdrop intentionally NOT click-to-close — same fix as the
    // ClientFormDialog. Losing a half-typed password to an accidental
    // click-drag is worse than the convenience of click-outside-to-
    // close. Esc + the X button stay as close affordances.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[10vh] backdrop-blur-sm"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!password.trim()) {
            setError('Password is required.')
            return
          }
          deleteMutation.mutate({
            clientId: client.id,
            password: password.trim(),
          })
        }}
        className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-rose-200 bg-popover p-6 text-popover-foreground shadow-pop dark:border-rose-900/50"
      >
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-rose-50 p-2 dark:bg-rose-950">
            <AlertTriangle className="h-5 w-5 text-rose-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold">
              Delete &ldquo;{client.name}&rdquo;?
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              This is permanent. The client record disappears from{' '}
              <code>/clients</code> and all routing config (Slack
              channel, Client Alerts phone) goes with it.
            </p>
            <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground">
              <li>
                Appointments for this client become &ldquo;no
                client&rdquo; — they stay in the Master Tracker and
                can be re-assigned or deleted manually.
              </li>
              <li>Per-client reminder templates are deleted.</li>
              <li>
                Slack delivery + Client Alert history records keep
                their channel/phone info but lose the client link.
              </li>
            </ul>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">
            Admin password
          </label>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              if (error) setError(null)
            }}
            placeholder="From the vault entry &quot;Client Delete Password&quot;"
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-rose-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            autoComplete="off"
          />
          {error && (
            <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={deleteMutation.isPending}
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password.trim() || deleteMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50"
          >
            {deleteMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Deleting…
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5" /> Delete client
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/** State chip styled in the client's own brand color (the one Alex
 *  picks on the edit form). Matches the avatar + status-dot color
 *  so each client reads as a single visual identity across the row.
 *
 *  Tint approach: 14% alpha background + 30% alpha border in the
 *  client's hex color, with the saturated color used for the chip
 *  text. Works across light + dark mode without per-theme tweaks
 *  because the alpha values keep things readable on either bg.
 *
 *  Pending clients (lifecycle=pending) get a muted grey treatment
 *  matching the dashed-circle avatar, so the chip can't be confused
 *  with a real active client at a glance. */
function ClientStateChip({ client }: { client: ClientWithCounts }) {
  const code = stateCode(client.state)
  const isPending = awaitsSetup(client)

  if (isPending) {
    return (
      <span className="inline-flex items-center justify-center rounded-full border border-dashed border-muted-foreground/40 bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
        {code}
      </span>
    )
  }

  const color = client.color || '#3b82f6'
  return (
    <span
      className="inline-flex items-center justify-center rounded-full border px-2.5 py-1 text-xs font-semibold"
      style={{
        backgroundColor: hexToRgba(color, 0.14),
        borderColor: hexToRgba(color, 0.3),
        color,
      }}
      title={client.state ?? undefined}
    >
      {code}
    </span>
  )
}

/* -------------------------------------------------------------------------- */

/** Foldable "Additional info" panel on the client detail dialog.
 *  Holds fields that don't belong in the always-visible top of the
 *  dialog: servicing zipcodes (captured during self-onboarding),
 *  application date, and the linked /client login (if any).
 *
 *  Defaults closed so the dialog stays compact. State is local — the
 *  panel re-collapses every time the dialog opens, which is the
 *  desired behavior for an info-dump that admin only needs
 *  occasionally. */
function AdditionalInfo({ client }: { client: ClientWithCounts }) {
  const [open, setOpen] = useState(false)
  const login = client.linkedLogin

  return (
    <div className="rounded-xl border border-border-soft bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left transition hover:bg-surface-muted"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Additional info
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-border-soft px-3 py-3">
          <DetailRow
            icon={MapPin}
            label="Servicing zipcodes"
            value={client.servicingZipcodes}
            empty="Not provided"
          />
          {client.contactRole && (
            <DetailRow
              icon={Users}
              label="Contact role"
              value={client.contactRole}
            />
          )}
          {/* Intake answers from the self-onboarding form (2026-05-11).
              All four are nullable for legacy clients; render
              "Not provided" so admin can spot the gap and fill it
              in via the edit dialog. */}
          <DetailRow
            icon={CalendarIcon}
            label="Appointment types"
            value={formatAppointmentTypes(client.appointmentTypes)}
            empty="Not provided"
          />
          <DetailRow
            icon={CalendarIcon}
            label="Books weekends"
            value={formatYesNo(client.bookWeekends)}
            empty="Not provided"
          />
          <DetailRow
            icon={CheckCircle2}
            label="Battery backup installs"
            value={formatYesNo(client.providesBatteryBackup)}
            empty="Not provided"
          />
          {client.website ? (
            <DetailRow
              icon={ExternalLink}
              label="Website"
              value={
                <a
                  href={withProtocol(client.website)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {client.website}
                </a>
              }
            />
          ) : (
            <DetailRow
              icon={ExternalLink}
              label="Website"
              value={null}
              empty="Not provided"
            />
          )}
          {/* Long-form intake answers — preserve newlines so a
              client's bulleted list still reads as one. Both fields
              hide entirely when empty (no "Not provided" placeholder)
              since they're optional and there's nothing actionable
              about a missing answer. */}
          {client.qualificationCriteria && (
            <DetailRow
              icon={FileText}
              label="Qualification criteria"
              value={
                <span className="whitespace-pre-wrap">
                  {client.qualificationCriteria}
                </span>
              }
            />
          )}
          {client.onboardingNotes && (
            <DetailRow
              icon={StickyNote}
              label="Additional notes"
              value={
                <span className="whitespace-pre-wrap">
                  {client.onboardingNotes}
                </span>
              }
            />
          )}
          <DetailRow
            icon={CalendarIcon}
            label="Application date"
            value={formatDate(client.createdAt)}
          />
          <LoginDetailRow login={login} />
        </div>
      )}
    </div>
  )
}

/** Single label / value row in the AdditionalInfo panel. `empty`
 *  controls what renders when value is null/undefined/empty —
 *  surfacing "Not provided" is more useful than hiding the row
 *  (admin can tell the field exists but isn't filled in). Pass
 *  `empty={null}` to hide the row entirely instead. */
function DetailRow({
  icon: Icon,
  label,
  value,
  empty = 'Not provided',
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  /** Can be a string (renders as text) or React node (e.g. a link).
   *  Strings are checked for "is this empty?"; nodes always render
   *  as-is. Pass null to fall through to the `empty` placeholder. */
  value: string | null | undefined | React.ReactNode
  empty?: string | null
}) {
  const isStringy = value == null || typeof value === 'string'
  const filled = isStringy
    ? !!value && String(value).trim().length > 0
    : true
  if (!filled && empty === null) return null
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            'mt-0.5 break-words text-sm',
            filled ? 'text-foreground/85' : 'italic text-muted-foreground/70',
          )}
        >
          {filled ? value : empty}
        </p>
      </div>
    </div>
  )
}

/** Translate the appointmentTypes enum into the human label admin
 *  sees in the Additional info panel. Null falls through to the
 *  DetailRow's "Not provided" placeholder. */
function formatAppointmentTypes(
  v: 'in_person' | 'virtual' | 'both' | null | undefined,
): string | null {
  if (!v) return null
  if (v === 'in_person') return 'In-person'
  if (v === 'virtual') return 'Virtual'
  if (v === 'both') return 'In-person or virtual'
  return null
}

/** Boolean → "Yes" / "No". Null/undefined returns null so the
 *  DetailRow's empty placeholder shows instead of "No" (those two
 *  read very differently to admin). */
function formatYesNo(v: boolean | null | undefined): string | null {
  if (v == null) return null
  return v ? 'Yes' : 'No'
}

/** Ensure a URL has a protocol so <a href> doesn't treat
 *  "example.com" as a relative path. */
function withProtocol(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  return `https://${url}`
}

/** Specialized row for the linked /client login — translates the
 *  raw role + mustChangePassword fields into a human-readable status
 *  with an appropriate icon. Hidden cleanly when nothing's linked. */
function LoginDetailRow({
  login,
}: {
  login: ClientWithCounts['linkedLogin']
}) {
  if (!login) {
    return (
      <DetailRow
        icon={KeyRound}
        label="Client login"
        value={null}
        empty="No login provisioned yet"
      />
    )
  }

  const { role, email, mustChangePassword, createdAt, updatedAt } = login
  let statusIcon: React.ComponentType<{ className?: string }> = CheckCircle2
  let statusText = 'Active login'
  let tone = 'text-emerald-600 dark:text-emerald-400'

  if (role === 'client_pending') {
    statusIcon = Hourglass
    statusText = 'Self-registered · awaiting onboarding form'
    tone = 'text-amber-600 dark:text-amber-400'
  } else if (role === 'client_onboarding') {
    statusIcon = Hourglass
    statusText = 'Application submitted · awaiting review'
    tone = 'text-amber-600 dark:text-amber-400'
  } else if (role === 'client_denied') {
    statusIcon = XCircle
    statusText = 'Login denied'
    tone = 'text-rose-600 dark:text-rose-400'
  } else if (role === 'client_active' && mustChangePassword) {
    statusIcon = Hourglass
    statusText = 'Active · awaiting first sign-in (temp password sent)'
    tone = 'text-amber-600 dark:text-amber-400'
  }

  const StatusIcon = statusIcon
  // Use updatedAt for the activity timestamp — it bumps on password
  // change, role flip, and credential reset. createdAt is the
  // initial provisioning date.
  const provisioned = formatDate(createdAt)
  const lastChange = formatDate(updatedAt)

  return (
    <div className="flex items-start gap-2 text-sm">
      <KeyRound className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Client login
        </p>
        <p className="mt-0.5 break-all text-sm text-foreground/85">{email}</p>
        <p
          className={cn(
            'mt-1 inline-flex items-center gap-1.5 text-xs font-medium',
            tone,
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {statusText}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Provisioned {provisioned}
          {lastChange !== provisioned && ` · Last change ${lastChange}`}
        </p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  )
}

function ResourceLink({
  href,
  icon: Icon,
  label,
  hint,
  external,
}: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  hint: string
  external?: boolean
}) {
  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition hover:bg-surface-muted"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 flex-shrink-0 text-primary" />
        <span className="min-w-0">
          <span className="block font-semibold">{label}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {hint}
          </span>
        </span>
      </span>
      <ExternalLink className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </a>
  )
}

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-soft">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="mt-2 text-[26px] font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {value.toLocaleString()}
      </span>
    </div>
  )
}

function clientInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** Canonical "this client isn't ready for prime time yet" predicate.
 *  Two reasons a client lives in the gray Pending section instead of
 *  the live roster:
 *
 *    1. lifecycle === 'pending' — self-registered through the funnel
 *       but admin hasn't approved them yet (payment confirmation
 *       still pending).
 *    2. lifecycle === 'onboarding' && contactName == null — admin
 *       approved them but they haven't submitted the full onboarding
 *       form yet, so we still have no contact details / address /
 *       qualification criteria. They sit here until they submit
 *       /api/client/onboarding-form, which flips lifecycle to 'active'.
 *
 *  Note the contactName guard. Admin can manually create or edit a
 *  client into 'onboarding' lifecycle as a tracking signal ("I'm
 *  setting up this account") — those have contactName filled in and
 *  belong in the active list, not here. The predicate only catches
 *  the self-registered + post-approval-pre-form path. */
function awaitsSetup(c: ClientWithCounts): boolean {
  if (c.lifecycle === 'pending') return true
  if (c.lifecycle === 'onboarding' && !c.contactName) return true
  return false
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Hydrate the form from a row — empty string for null fields so
 *  controlled inputs don't blow up. */
function toFormValues(c: ClientWithCounts): ClientFormValues {
  // The edit form only knows the four admin-pickable lifecycles —
  // coerce pending/denied to "onboarding" so the dropdown has a
  // valid selection. Saving the form would then move the client
  // out of the self-onboarding queue into the regular onboarding
  // state, which is a sensible admin override path.
  const lifecycle: ClientLifecycle =
    c.lifecycle === 'pending' || c.lifecycle === 'denied'
      ? 'onboarding'
      : c.lifecycle
  return {
    id: c.id,
    name: c.name,
    state: c.state ?? '',
    color: c.color,
    lifecycle,
    package: c.package,
    apptCap: c.apptCap == null ? '' : String(c.apptCap),
    // dueDate is an ISO timestamp on the wire; the <input type="date">
    // wants a YYYY-MM-DD string. Slice the date portion (the override
    // is stored at UTC midnight on the server so this never shifts).
    dueDate: c.dueDate ? c.dueDate.slice(0, 10) : '',
    // Intake answers — empty string = "not answered yet" so the form's
    // YesNoToggle shows neither button as selected, matching the
    // legacy / no-answer case.
    appointmentTypes: c.appointmentTypes ?? '',
    bookWeekends:
      c.bookWeekends === true ? 'yes' : c.bookWeekends === false ? 'no' : '',
    website: c.website ?? '',
    providesBatteryBackup:
      c.providesBatteryBackup === true
        ? 'yes'
        : c.providesBatteryBackup === false
          ? 'no'
          : '',
    qualificationCriteria: c.qualificationCriteria ?? '',
    onboardingNotes: c.onboardingNotes ?? '',
    contactName: c.contactName ?? '',
    contactRole: c.contactRole ?? '',
    contactEmail: c.contactEmail ?? '',
    contactPhone: c.contactPhone ?? '',
    address: c.address ?? '',
    notes: c.notes ?? '',
    intakeFormUrl: c.intakeFormUrl ?? '',
    ghlSubaccountUrl: c.ghlSubaccountUrl ?? '',
    servicingZipcodes: c.servicingZipcodes ?? '',
  }
}
