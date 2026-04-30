'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  Building2,
  Loader2,
  Calendar,
  CheckCircle2,
  XCircle,
  ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { Chip, type ChipTone } from '@/components/ui/chip'

/**
 * Clients — table view ported from Ethan's CRM mockup.
 *
 *   [avatar+name (state · color stripe)]  [Bookings]  [Upcoming]  [Show rate progress]  [Status]
 *
 * Data comes from /api/clients/with-counts (single client.findMany +
 * one appointment scan, bucketed in JS). Each row links into Master
 * Tracker pre-filtered to that client.
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
}

export default function ClientsPage() {
  const query = useQuery<{ clients: ClientWithCounts[] }>({
    queryKey: ['clients-with-counts'],
    queryFn: async () => {
      const res = await fetch('/api/clients/with-counts')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
  })

  const clients = query.data?.clients ?? []
  const totalBookings = clients.reduce((s, c) => s + c.total, 0)
  const totalUpcoming = clients.reduce((s, c) => s + c.upcoming, 0)
  // Average show rate weighted by completed appointments — gives a
  // truer picture than averaging the per-client percentages, which
  // would over-weight low-volume clients.
  const completedTotal = clients.reduce(
    (s, c) => s + c.showed + c.noShow,
    0
  )
  const showedTotal = clients.reduce((s, c) => s + c.showed, 0)
  const avgShowRate =
    completedTotal > 0 ? Math.round((showedTotal / completedTotal) * 100) : null

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="Clients"
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Clients' }]}
        subtitle="Active engagements with appointment fulfillment by state."
      />

      {/* Stats — three compact cards mirroring the mockup */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Active clients"
          value={String(clients.length)}
          sub={
            clients.length === 1
              ? 'across all Genisys states'
              : `across ${new Set(clients.map((c) => c.state).filter(Boolean)).size} state${
                  new Set(clients.map((c) => c.state).filter(Boolean)).size === 1 ? '' : 's'
                }`
          }
        />
        <SummaryCard
          label="Bookings to date"
          value={totalBookings.toLocaleString()}
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
      ) : clients.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
          <Building2 className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No clients registered yet. Add one via the database (Prisma
            Studio) or the seed migration.
          </p>
        </div>
      ) : (
        <div>
          {/* Column headers */}
          <div className="grid grid-cols-[2fr_100px_100px_minmax(0,1fr)_120px_100px] items-center gap-4 px-2 pb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Client</span>
            <span>Bookings</span>
            <span>Upcoming</span>
            <span>Show rate</span>
            <span>Status</span>
            <span className="text-right">Open</span>
          </div>
          <ul>
            {clients.map((c) => (
              <ClientRow key={c.id} client={c} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function ClientRow({ client }: { client: ClientWithCounts }) {
  const initials = clientInitials(client.name)
  // Bar color follows show-rate health: <50% rose, 50–74% amber,
  // ≥75% emerald. Falls back to primary blue when no completed
  // bookings yet (showRate is null).
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
    <li>
      <Link
        href={`/call-center/master-tracker?client=${client.id}`}
        className="grid grid-cols-[2fr_100px_100px_minmax(0,1fr)_120px_100px] items-center gap-4 border-t border-border-soft px-2 py-4 transition hover:bg-surface-muted"
      >
        {/* Client cell — color avatar + name + state pill */}
        <div className="flex items-center gap-3 min-w-0">
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
              </p>
            </div>
          </div>
        </div>

        {/* Bookings */}
        <span className="text-sm font-semibold tabular-nums">
          {client.total.toLocaleString()}
        </span>

        {/* Upcoming */}
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="tabular-nums">{client.upcoming}</span>
        </span>

        {/* Show rate progress bar */}
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
          <span className="text-[10px] text-muted-foreground/80">
            <span className="inline-flex items-center gap-0.5">
              <CheckCircle2 className="h-2.5 w-2.5" />
              {client.showed}
            </span>
            <span className="mx-1.5 opacity-50">·</span>
            <span className="inline-flex items-center gap-0.5">
              <XCircle className="h-2.5 w-2.5" />
              {client.noShow}
            </span>
          </span>
        </div>

        {/* Status */}
        <StatusBadge total={client.total} />

        {/* Open arrow */}
        <span className="flex items-center justify-end text-muted-foreground">
          <ArrowRight className="h-4 w-4" />
        </span>
      </Link>
    </li>
  )
}

function StatusBadge({ total }: { total: number }) {
  // Lightweight signal: any client with bookings is "Active";
  // zero-bookings clients render as "Onboarding" so the row doesn't
  // suggest a problem. Real lifecycle states (Churned, etc.) come
  // when we have a Client.lifecycle column.
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
  tone,
}: {
  label: string
  value: string
  sub: string
  tone?: ChipTone
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-soft">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">{label}</p>
        {tone && <Chip tone={tone}>·</Chip>}
      </div>
      <p className="mt-2 text-[26px] font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}

/** Two-letter initials from a multi-word client name. Falls back to
 *  the first two characters for single-word names. */
function clientInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}
