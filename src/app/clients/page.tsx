'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  Building2,
  Loader2,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Calendar,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Clients — the list of Genisys agency clients (Brighton Capital
 * Solar / Spring Solar / Energy Upgrade) with appointment-stats
 * cards. Phase 1 of the reskin: surface the data we already have so
 * Ethan can see "how each client is doing" at a glance from the
 * sidebar. Per-client deep-link views come later.
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

  return (
    <div className="mx-auto max-w-screen-xl space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
            Clients
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The agencies Genisys is booking appointments for. Each card
            shows how that client is performing across all bookings.
          </p>
        </div>
      </header>

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clients.map((c) => (
            <ClientCard key={c.id} client={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClientCard({ client }: { client: ClientWithCounts }) {
  return (
    <Link
      href={`/call-center/master-tracker?client=${client.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-soft transition hover:shadow-card"
    >
      {/* Brand stripe — same color the appointment badges use, so a
          glance is enough to know "this is the Brighton card". */}
      <div className="h-2 w-full" style={{ backgroundColor: client.color }} />

      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {client.state || 'Multi-state'}
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-tight">
              {client.name}
            </h2>
          </div>
          <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
        </div>

        {/* Headline number — total bookings, big, above the fold. */}
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">
            {client.total.toLocaleString()}
          </span>
          <span className="text-xs text-muted-foreground">
            total bookings
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Stat
            icon={Calendar}
            label="Upcoming"
            value={client.upcoming}
            tone="blue"
          />
          <Stat
            icon={CheckCircle2}
            label="Showed"
            value={client.showed}
            tone="mint"
          />
          <Stat
            icon={XCircle}
            label="No-show"
            value={client.noShow}
            tone="pink"
          />
        </div>

        <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2 text-xs">
          <span className="text-muted-foreground">Show rate</span>
          <span className="font-mono font-semibold tabular-nums">
            {client.showRate != null ? `${client.showRate}%` : '—'}
          </span>
        </div>
      </div>
    </Link>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number
  tone: 'blue' | 'mint' | 'pink'
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg px-2.5 py-2',
        tone === 'blue' && 'chip-blue',
        tone === 'mint' && 'chip-mint',
        tone === 'pink' && 'chip-pink'
      )}
    >
      <span className="flex items-center gap-1 opacity-80">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <span className="text-base font-semibold tabular-nums leading-none">
        {value}
      </span>
    </div>
  )
}
