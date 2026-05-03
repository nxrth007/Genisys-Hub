'use client'

import { useEffect, useState, useMemo } from 'react'
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
  lifecycle: ClientLifecycle
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

const LIFECYCLE_TONE: Record<ClientLifecycle, ChipTone> = {
  active: 'mint',
  onboarding: 'amber',
  paused: 'blue',
  churned: 'pink',
}

const LIFECYCLE_LABEL: Record<ClientLifecycle, string> = {
  active: 'Active',
  onboarding: 'Onboarding',
  paused: 'Paused',
  churned: 'Churned',
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

export default function ClientsPage() {
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [packageFilter, setPackageFilter] = useState<PackageFilter>('all')
  const [active, setActive] = useState<ClientWithCounts | null>(null)
  const [editing, setEditing] = useState<ClientWithCounts | null>(null)
  const [creating, setCreating] = useState(false)

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
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New client
          </button>
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
            {filtered.map((c) => (
              <ClientRow key={c.id} client={c} onOpen={setActive} />
            ))}
          </ul>
        </div>
      )}

      <ClientDetailDialog
        client={active}
        onClose={() => setActive(null)}
        onEdit={(c) => {
          setActive(null)
          setEditing(c)
        }}
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
  // Cap progress is the new primary delivery metric — how many of
  // the client's nominal allotment we've delivered. Drives the bar.
  // When apptCap is null (PPA / sit-down guarantee / uncategorized
  // 'custom' deals) we fall back to the resolved-share metric so
  // the column doesn't go totally blank.
  const cap = client.apptCap
  const capPct = cap && cap > 0 ? Math.round((client.total / cap) * 100) : null
  const resolved = client.showed + client.noShow + client.cancelled
  const fallbackPct = client.progressPct ?? 0
  const pct = capPct ?? fallbackPct
  const barColor =
    capPct == null
      ? client.progressPct == null
        ? 'bg-primary'
        : fallbackPct >= 75
          ? 'bg-emerald-500'
          : fallbackPct >= 50
            ? 'bg-amber-400'
            : 'bg-rose-500'
      : capPct >= 100
        ? 'bg-emerald-600'
        : capPct >= 75
          ? 'bg-emerald-500'
          : capPct >= 40
            ? 'bg-amber-400'
            : 'bg-rose-500'

  // Make the click open detail, but the inline status pill swallows
  // its own click so changing status doesn't also open the dialog.
  return (
    <li
      onClick={() => onOpen(client)}
      className="grid cursor-pointer grid-cols-[2fr_90px_70px_90px_1.4fr_110px_110px] items-center gap-3 border-t border-border-soft px-2 py-4 transition hover:bg-surface-muted"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: client.color }}
        >
          {initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{client.name}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: client.color }}
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
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {capPct != null
            ? `${client.total}/${cap} booked · ${capPct}%${capPct >= 100 ? ' (over cap)' : ''}`
            : client.progressPct != null
              ? `${resolved}/${client.total} resolved · ${client.progressPct}%`
              : client.total > 0
                ? `0/${client.total} resolved`
                : '—'}
        </span>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', barColor)}
            // Clamp the visible bar at 100% so over-cap clients don't
            // overflow the rail; the "(over cap)" label above still
            // tells the story.
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        {/* Sitdowns — qualified appointments (Sitdown=Yes on Master
            Tracker). Surfaces the difference between "we booked
            something" and "the client actually met the customer".
            Hidden when there are no bookings yet so empty rows
            stay clean. */}
        {client.total > 0 && (
          <span
            className="text-[10px] tabular-nums text-muted-foreground"
            title="Appointments where the client actually met with the customer (Sitdown=Yes on Master Tracker). Set manually by admin."
          >
            {client.sitdowns}/{client.total} sitdowns
            {client.total > 0 &&
              ` · ${Math.round((client.sitdowns / client.total) * 100)}%`}
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
}: {
  client: ClientWithCounts | null
  onClose: () => void
  onEdit: (c: ClientWithCounts) => void
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
  return {
    id: c.id,
    name: c.name,
    state: c.state ?? '',
    color: c.color,
    lifecycle: c.lifecycle,
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
