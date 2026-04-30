'use client'

import { useEffect, useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Plus,
  Loader2,
  Building2,
  Users,
  Calendar as CalendarIcon,
  MapPin,
  Mail,
  Clock,
  ExternalLink,
  X,
  ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { Chip, type ChipTone } from '@/components/ui/chip'
import { DropdownPill } from '@/components/ui/dropdown-pill'

/**
 * Clients — table layout ported from Ethan's CRM mockup.
 *
 * Mockup columns (state column substitutes for "Package" since
 * Genisys doesn't sell packages — each client is a per-state
 * partnership, and the chip color tells them apart at a glance):
 *
 *   Client | Agents | Appts | State | Show rate | Last booking | Status
 *
 * Rows are clickable → opens a detail dialog with the client's
 * primary contact and Master Tracker shortcut.
 */

type ClientWithCounts = {
  id: string
  name: string
  state: string | null
  color: string
  total: number
  upcoming: number
  showed: number
  noShow: number
  cancelled: number
  showRate: number | null
  agents: number
  lastBookingAt: string | null
}

type StateFilter = 'all' | 'AZ' | 'CA' | 'UT' | 'other'

/** State → chip tone mapping. Same color scheme as mockup's package
 *  chips, but driven by client.state since that's the variable axis
 *  for Genisys. AZ=mint (Brighton green-ish), CA=blue (Energy
 *  Upgrade), UT=violet (Spring purple), anything else=amber. */
function stateTone(state: string | null): ChipTone {
  if (!state) return 'amber'
  const s = state.toLowerCase()
  if (s.includes('arizona') || s === 'az') return 'mint'
  if (s.includes('california') || s === 'ca') return 'blue'
  if (s.includes('utah') || s === 'ut') return 'violet'
  return 'amber'
}

/** Compact 2-letter state code for the filter dropdown + chip text. */
function stateCode(state: string | null): string {
  if (!state) return '—'
  const s = state.toLowerCase()
  if (s.includes('arizona')) return 'AZ'
  if (s.includes('california')) return 'CA'
  if (s.includes('utah')) return 'UT'
  return state.slice(0, 2).toUpperCase()
}

export default function ClientsPage() {
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [active, setActive] = useState<ClientWithCounts | null>(null)

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
    if (stateFilter === 'all') return clients
    return clients.filter((c) => stateCode(c.state) === stateFilter)
  }, [clients, stateFilter])

  // Stats — three summary cards mirroring the mockup
  const totalAppts = clients.reduce((s, c) => s + c.total, 0)
  const totalUpcoming = clients.reduce((s, c) => s + c.upcoming, 0)
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
            onClick={() => alert('Add the new client via Prisma Studio for now — the create flow ships in a follow-up.')}
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
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Active clients"
          value={String(clients.length)}
          sub={`${new Set(clients.map((c) => c.state).filter(Boolean)).size} state${
            new Set(clients.map((c) => c.state).filter(Boolean)).size === 1 ? '' : 's'
          } covered`}
        />
        <SummaryCard
          label="Appts delivered"
          value={totalAppts.toLocaleString()}
          sub={`${totalUpcoming} upcoming`}
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
              ? 'No clients registered yet. Add one via Prisma Studio or the seed migration.'
              : 'No clients match this filter.'}
          </p>
        </div>
      ) : (
        <div>
          {/* Header row — exact column proportions from the mockup */}
          <div className="grid grid-cols-[2fr_70px_100px_100px_1.2fr_120px_100px] items-center gap-4 px-2 pb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Client</span>
            <span>Agents</span>
            <span>Appts</span>
            <span>State</span>
            <span>Show rate</span>
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

      <ClientDetailDialog client={active} onClose={() => setActive(null)} />
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
  const pct = client.showRate ?? 0
  const barColor =
    client.showRate == null
      ? 'bg-primary'
      : pct >= 75
        ? 'bg-emerald-500'
        : pct >= 50
          ? 'bg-amber-400'
          : 'bg-rose-500'

  return (
    <li
      onClick={() => onOpen(client)}
      className="grid cursor-pointer grid-cols-[2fr_70px_100px_100px_1.2fr_120px_100px] items-center gap-4 border-t border-border-soft px-2 py-4 transition hover:bg-surface-muted"
    >
      {/* Client (avatar + name + state pod-dot) */}
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
              {client.state || 'Multi-state'} ·{' '}
              {client.agents} agent{client.agents === 1 ? '' : 's'} booking
            </p>
          </div>
        </div>
      </div>

      {/* Agents */}
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="tabular-nums">{client.agents}</span>
      </div>

      {/* Appts */}
      <span className="text-sm font-semibold tabular-nums">
        {client.total.toLocaleString()}
      </span>

      {/* State chip (substitutes for the mockup's Package chip) */}
      <span>
        <Chip tone={stateTone(client.state)}>{stateCode(client.state)}</Chip>
      </span>

      {/* Show rate progress */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {client.showRate != null ? `${client.showRate}% show rate` : '—'}
        </span>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', barColor)}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Last booking date */}
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarIcon className="h-3 w-3" />
        {formatDate(client.lastBookingAt)}
      </span>

      {/* Status */}
      <StatusBadge total={client.total} />
    </li>
  )
}

/* -------------------------------------------------------------------------- */

function ClientDetailDialog({
  client,
  onClose,
}: {
  client: ClientWithCounts | null
  onClose: () => void
}) {
  // Esc to close — same convention as SearchDialog.
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
  const pct = client.showRate ?? 0
  const completed = client.showed + client.noShow

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — avatar + name + state */}
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
                {client.state || 'Multi-state'} · serves the {stateCode(client.state)}{' '}
                market
              </p>
            </div>
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

        {/* Status + last booking */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge total={client.total} />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border-soft bg-surface-muted px-2.5 py-1 text-xs font-medium">
            <Clock className="h-3 w-3 text-muted-foreground" />
            Last booking: {formatDate(client.lastBookingAt)}
          </span>
        </div>

        {/* Fulfillment block */}
        <div className="rounded-xl border border-border-soft bg-surface-muted p-3">
          <div className="flex items-baseline justify-between">
            <p className="text-xs font-semibold text-muted-foreground">
              Show-rate fulfillment
            </p>
            <p className="text-sm font-semibold tabular-nums">
              {client.showed} / {completed}{' '}
              <span className="text-xs font-normal text-muted-foreground">
                ({client.showRate != null ? `${client.showRate}%` : '—'})
              </span>
            </p>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full',
                client.showRate == null
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
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
            <Stat label="Total" value={client.total} />
            <Stat label="Upcoming" value={client.upcoming} />
            <Stat label="Cancelled" value={client.cancelled} />
          </div>
        </div>

        {/* Resources */}
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Resources
          </p>
          <div className="flex flex-col gap-2">
            <a
              href={`/call-center/master-tracker?client=${client.id}`}
              className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition hover:bg-surface-muted"
            >
              <span className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-primary" />
                <span>
                  <span className="block font-semibold">
                    Master Tracker · {client.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Pre-filtered list of every booking for this client
                  </span>
                </span>
              </span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </a>
            <a
              href={`/call-center?client=${client.id}`}
              className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition hover:bg-surface-muted"
            >
              <span className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-primary" />
                <span>
                  <span className="block font-semibold">
                    Call Center pipeline
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Live attention strip + per-status filters
                  </span>
                </span>
              </span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </a>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground/80 transition hover:bg-muted"
          >
            Close
          </button>
          <a
            href={`/call-center/master-tracker?client=${client.id}`}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            Open Master Tracker
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function StatusBadge({ total }: { total: number }) {
  if (total === 0) {
    return (
      <Chip tone="amber" className="font-semibold">
        Onboarding
      </Chip>
    )
  }
  return (
    <Chip tone="mint" className="font-semibold">
      Active
    </Chip>
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
