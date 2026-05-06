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
} from 'lucide-react'
import { cn } from '@/lib/utils'
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
  /** Nominal appt cap. null = unlimited (PPA / sit-down guarantee). */
  apptCap: number | null
  contactName: string | null
  contactRole: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  notes: string | null
  intakeFormUrl: string | null
  ghlSubaccountUrl: string | null
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

function stateTone(state: string | null): ChipTone {
  if (!state) return 'amber'
  const s = state.toLowerCase()
  if (s.includes('arizona') || s === 'az') return 'mint'
  if (s.includes('california') || s === 'ca') return 'blue'
  if (s.includes('utah') || s === 'ut') return 'violet'
  return 'amber'
}

function stateCode(state: string | null): string {
  if (!state) return '—'
  const s = state.toLowerCase()
  if (s.includes('arizona')) return 'AZ'
  if (s.includes('california')) return 'CA'
  if (s.includes('utah')) return 'UT'
  return state.slice(0, 2).toUpperCase()
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
    return list
  }, [clients, stateFilter, statusFilter, packageFilter])

  // Split pending clients off so they render in their own section
  // below the active list — Alex's spec: pending = self-onboarded,
  // not yet approved, shouldn't blend in with the live roster.
  const { activeClients, pendingClients } = useMemo(() => {
    const pending = filtered.filter((c) => c.lifecycle === 'pending')
    const rest = filtered.filter((c) => c.lifecycle !== 'pending')
    return { activeClients: rest, pendingClients: pending }
  }, [filtered])

  // Stats — all run over the unfiltered set so the cards show real
  // totals regardless of what's currently filtered.
  const totalAppts = clients.reduce((s, c) => s + c.total, 0)
  const activeCount = clients.filter(
    (c) => c.lifecycle === 'active' || c.lifecycle === 'onboarding'
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
            {/* Onboarding lives on its own page for Phase 1 — pending
                self-registrations + Credentials management sit there.
                Placed to the left of "New client" per Alex's spec. */}
            <Link
              href="/clients/onboarding"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
            >
              <UserPlus className="h-4 w-4" /> Onboarding
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
              : 'No clients match these filters.'}
          </p>
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-[2fr_90px_70px_90px_1.4fr_110px_110px] items-center gap-3 px-2 pb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Client</span>
            <span>Package</span>
            <span>Agents</span>
            <span>State</span>
            <span>Cap progress</span>
            <span>Last booking</span>
            <span>Status</span>
          </div>
          <ul>
            {activeClients.map((c) => (
              <ClientRow key={c.id} client={c} onOpen={setActive} />
            ))}
          </ul>

          {/* Pending review section. Self-onboarded clients land
              here until Alex approves them on /clients/onboarding.
              Visually separated from the active roster so they
              can't be mistaken for live clients receiving bookings.
              Hidden entirely when the active list also covers
              everything (i.e. nothing pending matches filters). */}
          {pendingClients.length > 0 && (
            <div className="mt-8">
              <div className="mb-3 flex items-center gap-3">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-dashed border-muted-foreground/60" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Pending review · {pendingClients.length}
                </h3>
                <Link
                  href="/clients/onboarding"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Approve or deny →
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
  // Sitdowns progress is the primary fulfillment metric — qualified
  // appointments against either the client's contracted cap (when
  // set) or the count of bookings (when uncapped). The bar
  // visualizes this ratio so admins can spot at a glance whether
  // a client is hitting fulfillment vs just booking volume.
  const cap = client.apptCap
  const sitdownDenom = cap && cap > 0 ? cap : client.total
  const sitdownPct =
    sitdownDenom > 0
      ? Math.round((client.sitdowns / sitdownDenom) * 100)
      : null
  const barWidth = sitdownPct ?? 0
  const barColor =
    sitdownPct == null
      ? 'bg-muted-foreground/30'
      : sitdownPct >= 100
        ? 'bg-emerald-600'
        : sitdownPct >= 75
          ? 'bg-emerald-500'
          : sitdownPct >= 40
            ? 'bg-amber-400'
            : sitdownPct > 0
              ? 'bg-rose-500'
              : 'bg-muted-foreground/30'

  // Pending = self-onboarded but not yet admin-approved. Renders
  // with a dashed grey ring + a faded interior so it reads as
  // "placeholder for an inactive client" instead of blending in
  // with the live roster.
  const isPending = client.lifecycle === 'pending'

  // Make the click open detail, but the inline status pill swallows
  // its own click so changing status doesn't also open the dialog.
  return (
    <li
      onClick={() => onOpen(client)}
      className={cn(
        'grid cursor-pointer grid-cols-[2fr_90px_70px_90px_1.4fr_110px_110px] items-center gap-3 border-t border-border-soft px-2 py-4 transition hover:bg-surface-muted',
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

      <span>
        <Chip tone={stateTone(client.state)}>{stateCode(client.state)}</Chip>
      </span>

      <div className="flex flex-col gap-1.5">
        {/* Top line — just the booked count. Cap (when set) gets
            implicitly surfaced via the sitdowns line below, where
            it's the meaningful denominator. */}
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {client.total > 0
            ? `${client.total} booked${cap && client.total >= cap ? ' (cap reached)' : ''}`
            : '—'}
        </span>
        {/* Bar — visualizes sitdowns/cap (or sitdowns/booked when
            uncapped). Empty grey rail when there's nothing to
            measure yet. Clamped at 100% on the rare overshoot. */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', barColor)}
            style={{ width: `${Math.min(barWidth, 100)}%` }}
          />
        </div>
        {/* Sitdowns — qualified appointments (Sitdown=Yes on Master
            Tracker). Denominator is the contracted cap when set
            (fulfillment vs commitment), otherwise the booked count
            (qualified rate). Hidden when there are no bookings yet
            so empty rows stay clean. */}
        {client.total > 0 && (
          <span
            className="text-[10px] tabular-nums text-muted-foreground"
            title="Appointments where the client actually met with the customer (Sitdown=Yes on Master Tracker). Set manually by admin. Denominator is the contracted appt cap when configured, otherwise the booked count."
          >
            {client.sitdowns}/{sitdownDenom} sitdowns
            {sitdownPct != null && ` · ${sitdownPct}%`}
          </span>
        )}
      </div>

      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarIcon className="h-3 w-3" />
        {formatDate(client.lastBookingAt)}
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

        {/* Status + package + last booking — three pills in one row.
            Package chip surfaces the contract tier; the cap label
            below the progress bar tracks delivery against the cap. */}
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={LIFECYCLE_TONE[client.lifecycle]} className="font-semibold">
            {LIFECYCLE_LABEL[client.lifecycle]}
          </Chip>
          <Chip tone={PACKAGE_TONE[client.package] ?? 'muted'} className="font-semibold">
            {PACKAGE_LABEL[client.package] ?? 'Custom'}
            {client.apptCap ? ` · ${client.apptCap}` : ' · no cap'}
          </Chip>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border-soft bg-surface-muted px-2.5 py-1 text-xs font-medium">
            <Clock className="h-3 w-3 text-muted-foreground" />
            Last booking: {formatDate(client.lastBookingAt)}
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
    contactName: c.contactName ?? '',
    contactRole: c.contactRole ?? '',
    contactEmail: c.contactEmail ?? '',
    contactPhone: c.contactPhone ?? '',
    address: c.address ?? '',
    notes: c.notes ?? '',
    intakeFormUrl: c.intakeFormUrl ?? '',
    ghlSubaccountUrl: c.ghlSubaccountUrl ?? '',
  }
}
