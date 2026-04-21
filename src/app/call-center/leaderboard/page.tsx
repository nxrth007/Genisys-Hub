'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  PhoneCall,
  Trophy,
  Loader2,
  Crown,
  Medal,
  TrendingUp,
  DollarSign,
  Phone,
  MessageCircle,
  CalendarCheck,
  Target,
  Percent,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CallCenterTabs } from '@/components/call-center/call-center-tabs'

type Row = {
  agent: { id: string; name: string | null; email: string }
  appointments: {
    total: number
    booked: number
    showed: number
    noShow: number
    cancelled: number
    rescheduled: number
    showRate: number | null
    pipelineDollars: number
  }
  activity: {
    dials: number
    contacts: number
    apptsReported: number
    callbacks: number
    connectRate: number | null
    bookingRate: number | null
    daysReported: number
  }
}

type Client = {
  id: string
  name: string
  state: string | null
  color: string
}

type Range = '7d' | '30d' | '90d' | 'all'

const RANGES: Array<{ value: Range; label: string }> = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
]

type Metric =
  | 'appointments'
  | 'showRate'
  | 'pipeline'
  | 'dials'
  | 'consistency'

const METRICS: Array<{
  value: Metric
  label: string
  icon: React.ComponentType<{ className?: string }>
  hint: string
}> = [
  {
    value: 'appointments',
    label: 'Appointments',
    icon: CalendarCheck,
    hint: 'Who is booking the most.',
  },
  {
    value: 'showRate',
    label: 'Show rate',
    icon: Target,
    hint: 'Quality — highest % of appts that actually showed.',
  },
  {
    value: 'pipeline',
    label: 'Pipeline $',
    icon: DollarSign,
    hint: 'Active pipeline dollars generated.',
  },
  {
    value: 'dials',
    label: 'Dials',
    icon: Phone,
    hint: 'Who is grinding the phones hardest (from EOD reports).',
  },
  {
    value: 'consistency',
    label: 'Consistency',
    icon: TrendingUp,
    hint: 'Most EOD reports submitted in the window.',
  },
]

function valueFor(row: Row, metric: Metric): number {
  switch (metric) {
    case 'appointments':
      return row.appointments.total
    case 'showRate':
      return row.appointments.showRate ?? -1 // no completed appts ranks last
    case 'pipeline':
      return row.appointments.pipelineDollars
    case 'dials':
      return row.activity.dials
    case 'consistency':
      return row.activity.daysReported
  }
}

function formatValue(row: Row, metric: Metric): string {
  switch (metric) {
    case 'appointments':
      return row.appointments.total.toLocaleString()
    case 'showRate':
      return row.appointments.showRate != null
        ? `${row.appointments.showRate}%`
        : '—'
    case 'pipeline':
      return `$${row.appointments.pipelineDollars.toLocaleString()}`
    case 'dials':
      return row.activity.dials.toLocaleString()
    case 'consistency':
      return `${row.activity.daysReported} day${row.activity.daysReported === 1 ? '' : 's'}`
  }
}

export default function LeaderboardPage() {
  const [range, setRange] = useState<Range>('30d')
  const [client, setClient] = useState('all')
  const [metric, setMetric] = useState<Metric>('appointments')

  const clientsQuery = useQuery<{ clients: Client[] }>({
    queryKey: ['clients'],
    queryFn: async () => {
      const res = await fetch('/api/clients')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
    staleTime: 60_000,
  })

  const leaderboardQuery = useQuery<{ rows: Row[]; since: string | null; until: string }>({
    queryKey: ['leaderboard', range, client],
    queryFn: async () => {
      const params = new URLSearchParams()
      params.set('range', range)
      if (client !== 'all') params.set('client', client)
      const res = await fetch(`/api/call-center/leaderboard?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to load leaderboard')
      return res.json()
    },
  })

  const rows = useMemo(() => leaderboardQuery.data?.rows ?? [], [leaderboardQuery.data])
  const clients = useMemo(() => clientsQuery.data?.clients ?? [], [clientsQuery.data])

  // Rank by the selected metric, descending. Agents with zero activity
  // drop to the bottom naturally since valueFor returns 0 (or -1 for
  // showRate when nothing's completed yet).
  const ranked = useMemo(
    () => [...rows].sort((a, b) => valueFor(b, metric) - valueFor(a, metric)),
    [rows, metric]
  )

  const hasAnyData = ranked.some((r) => valueFor(r, metric) > 0)
  const podium = ranked.slice(0, 3)

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
            <PhoneCall className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Call Center</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Top performers across the team. Switch the metric to celebrate
              different kinds of wins — volume, quality, effort, consistency.
            </p>
          </div>
        </div>
      </div>

      <CallCenterTabs />

      {/* Period + client filter */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                range === r.value
                  ? 'bg-purple-600 text-white'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            Client
          </label>
          <select
            value={client}
            onChange={(e) => setClient(e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <option value="all">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Metric selector */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {METRICS.map((m) => {
            const Icon = m.icon
            const active = metric === m.value
            return (
              <button
                key={m.value}
                onClick={() => setMetric(m.value)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-all',
                  active
                    ? 'border-purple-600 bg-purple-600 text-white shadow-sm'
                    : 'border-zinc-200 bg-white text-zinc-700 hover:border-purple-300 hover:bg-purple-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-purple-700 dark:hover:bg-purple-950/40'
                )}
              >
                <Icon className="h-4 w-4" />
                {m.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-zinc-500">
          {METRICS.find((m) => m.value === metric)?.hint}
        </p>
      </div>

      {leaderboardQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
        </div>
      ) : ranked.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <Trophy className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-500">
            No approved agents yet — once agents are approved and start
            booking, they&apos;ll appear here.
          </p>
        </div>
      ) : !hasAnyData ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <Trophy className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-500">
            No activity in this window yet for the selected metric.
          </p>
        </div>
      ) : (
        <>
          {/* Podium — top 3 cards */}
          {podium.length >= 2 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {podium.map((row, i) => (
                <PodiumCard
                  key={row.agent.id}
                  rank={i + 1}
                  row={row}
                  metric={metric}
                />
              ))}
            </div>
          )}

          {/* Full ranked table */}
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/50">
                  <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    <th className="w-12 px-3 py-2.5 text-center">#</th>
                    <th className="px-3 py-2.5">Agent</th>
                    <th className="px-3 py-2.5 text-right">Appts</th>
                    <th className="px-3 py-2.5 text-right">Show %</th>
                    <th className="px-3 py-2.5 text-right">Pipeline</th>
                    <th className="px-3 py-2.5 text-right">Dials</th>
                    <th className="px-3 py-2.5 text-right">Contacts</th>
                    <th className="px-3 py-2.5 text-right">Connect %</th>
                    <th className="px-3 py-2.5 text-right">Book %</th>
                    <th className="px-3 py-2.5 text-right">Reports</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {ranked.map((row, i) => (
                    <LeaderboardRow
                      key={row.agent.id}
                      rank={i + 1}
                      row={row}
                      metric={metric}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------

function PodiumCard({ rank, row, metric }: { rank: number; row: Row; metric: Metric }) {
  // Gold, silver, bronze accents. Gold gets the crown, others get medals.
  const tone =
    rank === 1
      ? {
          bg: 'bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950/40 dark:to-yellow-950/40',
          border: 'border-amber-300 dark:border-amber-700',
          icon: Crown,
          iconColor: 'text-amber-500',
          badge: 'bg-amber-500 text-white',
          label: '1st',
        }
      : rank === 2
        ? {
            bg: 'bg-gradient-to-br from-zinc-50 to-slate-50 dark:from-zinc-950/40 dark:to-slate-950/40',
            border: 'border-zinc-300 dark:border-zinc-600',
            icon: Medal,
            iconColor: 'text-zinc-400',
            badge: 'bg-zinc-400 text-white',
            label: '2nd',
          }
        : {
            bg: 'bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-950/40 dark:to-amber-950/40',
            border: 'border-orange-300 dark:border-orange-800',
            icon: Medal,
            iconColor: 'text-orange-500',
            badge: 'bg-orange-500 text-white',
            label: '3rd',
          }
  const Icon = tone.icon

  return (
    <div
      className={cn(
        'relative flex flex-col gap-3 rounded-xl border-2 p-4',
        tone.bg,
        tone.border
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
            tone.badge
          )}
        >
          {tone.label}
        </span>
        <Icon className={cn('h-6 w-6', tone.iconColor)} />
      </div>

      <div>
        <Link
          href={`/call-center/agents/${row.agent.id}`}
          className="block font-semibold hover:text-purple-600 hover:underline"
        >
          {row.agent.name || '(unnamed)'}
        </Link>
        <p className="truncate text-xs text-zinc-500">{row.agent.email}</p>
      </div>

      <div>
        <p className="text-3xl font-bold tabular-nums">{formatValue(row, metric)}</p>
        <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
          {METRICS.find((m) => m.value === metric)?.label}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <MiniTag label="Show" value={row.appointments.showRate != null ? `${row.appointments.showRate}%` : '—'} />
        <MiniTag label="Pipeline" value={`$${(row.appointments.pipelineDollars / 1000).toFixed(1)}k`} />
        <MiniTag label="Dials" value={row.activity.dials.toLocaleString()} />
      </div>
    </div>
  )
}

function MiniTag({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-white/60 px-2 py-1 text-center dark:bg-zinc-900/60">
      <p className="text-[9px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="text-xs font-bold tabular-nums">{value}</p>
    </div>
  )
}

function LeaderboardRow({
  rank,
  row,
  metric,
}: {
  rank: number
  row: Row
  metric: Metric
}) {
  const isTop = rank <= 3
  const rankDisplay =
    rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank

  return (
    <tr
      className={cn(
        'transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
        isTop && 'bg-purple-50/30 dark:bg-purple-950/10'
      )}
    >
      <td className="px-3 py-2.5 text-center font-bold tabular-nums">
        {rankDisplay}
      </td>
      <td className="px-3 py-2.5">
        <Link
          href={`/call-center/agents/${row.agent.id}`}
          className="font-medium text-zinc-700 hover:text-purple-600 hover:underline dark:text-zinc-200"
        >
          {row.agent.name || '(unnamed)'}
        </Link>
        <div className="truncate text-[10px] text-zinc-400">{row.agent.email}</div>
      </td>
      <HighlightCell highlight={metric === 'appointments'}>
        {row.appointments.total.toLocaleString()}
      </HighlightCell>
      <HighlightCell highlight={metric === 'showRate'}>
        {row.appointments.showRate != null ? `${row.appointments.showRate}%` : '—'}
      </HighlightCell>
      <HighlightCell highlight={metric === 'pipeline'}>
        {row.appointments.pipelineDollars > 0
          ? `$${row.appointments.pipelineDollars.toLocaleString()}`
          : '—'}
      </HighlightCell>
      <HighlightCell highlight={metric === 'dials'}>
        {row.activity.dials > 0 ? row.activity.dials.toLocaleString() : '—'}
      </HighlightCell>
      <HighlightCell>
        {row.activity.contacts > 0 ? row.activity.contacts.toLocaleString() : '—'}
      </HighlightCell>
      <HighlightCell>
        {row.activity.connectRate != null ? `${row.activity.connectRate}%` : '—'}
      </HighlightCell>
      <HighlightCell>
        {row.activity.bookingRate != null ? `${row.activity.bookingRate}%` : '—'}
      </HighlightCell>
      <HighlightCell highlight={metric === 'consistency'}>
        {row.activity.daysReported}
      </HighlightCell>
    </tr>
  )
}

function HighlightCell({
  highlight,
  children,
}: {
  highlight?: boolean
  children: React.ReactNode
}) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 text-right font-medium tabular-nums',
        highlight && 'bg-purple-100/40 font-bold text-purple-700 dark:bg-purple-950/30 dark:text-purple-300'
      )}
    >
      {children}
    </td>
  )
}
