'use client'

import { Suspense, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import {
  Loader2,
  Trophy,
  Crown,
  Medal,
  Award,
  Sparkles,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'

/**
 * Call Center → Leaderboard tab. Apple/liquid-glass mockup pattern:
 *
 *   1. Frosted gradient banner at the top with the trophy icon and
 *      a one-line incentive line. Stays generic for now since
 *      Genisys doesn't have a configured monthly challenge yet —
 *      reads "Top performers this period · Date range applied".
 *   2. Podium of the top 3 performers, ordered 2nd-1st-3rd so the
 *      tallest card sits in the middle.
 *   3. Clean ranking list of every agent with rank chip, avatar,
 *      name + email, progress bar, and the metric value at the
 *      right edge.
 *
 * The metric is fixed to "appointments" — Ethan's mockup didn't
 * show a metric switcher, and "appts set" is the canonical
 * leaderboard metric anyway. Date range comes from the shared
 * layout's URL params (?since=&until=); the API already supports
 * range=custom + since/until.
 */

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

export default function LeaderboardPage() {
  return (
    <Suspense fallback={<LeaderboardSkeleton />}>
      <LeaderboardView />
    </Suspense>
  )
}

function LeaderboardView() {
  const params = useSearchParams()
  const since = params.get('since')
  const until = params.get('until')

  const query = useQuery<{ rows: Row[] }>({
    queryKey: ['call-center-leaderboard', since, until],
    queryFn: async () => {
      const sp = new URLSearchParams()
      if (since && until) {
        sp.set('range', 'custom')
        sp.set('since', since)
        sp.set('until', until)
      } else {
        sp.set('range', '30d')
      }
      const res = await fetch(
        `/api/call-center/leaderboard?${sp.toString()}`
      )
      if (!res.ok) throw new Error('Failed to load leaderboard')
      return res.json()
    },
  })

  const rows = useMemo(() => {
    const list = query.data?.rows ?? []
    return [...list].sort(
      (a, b) => b.appointments.total - a.appointments.total
    )
  }, [query.data])

  const podium = rows.slice(0, 3)
  const max = podium[0]?.appointments.total ?? 0
  const dateLabel = formatRangeLabel(since, until)

  return (
    <div className="flex flex-col gap-6">
      {/* ---- Incentive banner ---- */}
      <div className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-br from-primary-soft via-card to-amber-50 p-6 shadow-card backdrop-blur-xl dark:to-amber-950/20">
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/40" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-soft">
              <Trophy className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-primary">
                Top performers
              </p>
              <p className="text-base font-semibold tracking-tight">
                {rows.length === 0
                  ? 'No bookings logged in this window yet.'
                  : `${rows[0].agent.name || rows[0].agent.email.split('@')[0]} leads with ${rows[0].appointments.total} appt${rows[0].appointments.total === 1 ? '' : 's'}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="rounded-full border border-border/40 bg-card/70 px-3 py-1 text-xs font-semibold backdrop-blur">
              {dateLabel}
            </span>
            <span className="text-muted-foreground">
              <Users className="mr-1 inline h-3.5 w-3.5" />
              {rows.length} agent{rows.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>

      {/* ---- Podium ---- */}
      {query.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : query.isError ? (
        <p className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-destructive shadow-soft">
          Couldn&apos;t load the leaderboard. Try refreshing.
        </p>
      ) : podium.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center shadow-soft">
          <Trophy className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">
            No agents have booked appointments in this window.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-3">
            {/* sm:order swaps the visual order so 1st sits center,
                tallest, with 2nd on the left and 3rd on the right —
                same trick the mockup uses. */}
            {podium[1] && (
              <div className="sm:order-1">
                <PodiumCard rank={2} row={podium[1]} />
              </div>
            )}
            {podium[0] && (
              <div className="sm:order-2">
                <PodiumCard rank={1} row={podium[0]} />
              </div>
            )}
            {podium[2] && (
              <div className="sm:order-3">
                <PodiumCard rank={3} row={podium[2]} />
              </div>
            )}
          </div>

          {/* ---- Full ranking ---- */}
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
            <div className="flex items-center justify-between border-b border-border-soft px-5 py-4">
              <h2 className="text-[15px] font-semibold tracking-tight">
                Full ranking
              </h2>
              <span className="text-xs text-muted-foreground">
                {rows.length} agent{rows.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul>
              {rows.map((r, i) => {
                const value = r.appointments.total
                const pct = max > 0 ? (value / max) * 100 : 0
                const isTop3 = i < 3
                return (
                  <li
                    key={r.agent.id}
                    className="grid grid-cols-[40px_auto_1fr_180px_90px] items-center gap-4 border-b border-border-soft px-5 py-4 transition last:border-b-0 hover:bg-surface-muted"
                  >
                    <span
                      className={cn(
                        'grid h-8 w-8 place-items-center rounded-full text-sm font-bold tabular-nums',
                        i === 0 && 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200',
                        i === 1 && 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700/40 dark:text-zinc-200',
                        i === 2 && 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200',
                        !isTop3 && 'bg-muted text-foreground/60'
                      )}
                    >
                      {i + 1}
                    </span>
                    <Avatar
                      name={r.agent.name || r.agent.email}
                      email={r.agent.email}
                      size="sm"
                    />
                    <div>
                      <p className="text-sm font-semibold">
                        {r.agent.name || r.agent.email}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {r.appointments.showRate != null
                          ? `${r.appointments.showRate}% show`
                          : 'no completions yet'}
                        {r.appointments.pipelineDollars > 0 &&
                          ` · $${(r.appointments.pipelineDollars / 1000).toFixed(0)}k pipeline`}
                      </p>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          i === 0 ? 'bg-amber-400' : 'bg-primary'
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-right text-sm font-semibold tabular-nums">
                      {value}{' '}
                      <span className="text-xs font-normal text-muted-foreground">
                        appts
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function PodiumCard({ rank, row }: { rank: 1 | 2 | 3; row: Row }) {
  const meta = {
    1: {
      icon: Crown,
      glow: 'from-amber-200/70 via-amber-100/40 to-transparent',
      ring: 'ring-amber-300/70',
      iconColor: 'text-amber-500',
      pill: 'bg-amber-400/90 text-amber-950',
      label: '1st',
      height: 'h-[280px]',
      prize: 'Top performer',
    },
    2: {
      icon: Medal,
      glow: 'from-zinc-200/60 via-zinc-100/30 to-transparent',
      ring: 'ring-zinc-300/70',
      iconColor: 'text-zinc-500',
      pill: 'bg-zinc-300/90 text-zinc-900',
      label: '2nd',
      height: 'h-[252px]',
      prize: 'Runner-up',
    },
    3: {
      icon: Award,
      glow: 'from-orange-200/60 via-orange-100/30 to-transparent',
      ring: 'ring-orange-300/70',
      iconColor: 'text-orange-500',
      pill: 'bg-orange-400/90 text-orange-950',
      label: '3rd',
      height: 'h-[230px]',
      prize: 'Bronze',
    },
  }[rank]
  const Icon = meta.icon
  const display = row.agent.name || row.agent.email

  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-end overflow-hidden rounded-3xl border border-border/60 bg-card/70 px-5 pb-6 pt-8 shadow-card backdrop-blur-xl',
        meta.height
      )}
    >
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 h-2/3 bg-gradient-to-b',
          meta.glow
        )}
      />
      <div className="pointer-events-none absolute inset-0 rounded-3xl ring-1 ring-inset ring-white/40" />

      <span
        className={cn(
          'absolute right-4 top-4 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider shadow-sm backdrop-blur',
          meta.pill
        )}
      >
        {meta.label}
      </span>

      <Icon className={cn('mb-3 h-8 w-8', meta.iconColor)} strokeWidth={2} />

      <div
        className={cn(
          'rounded-full ring-4 ring-offset-2 ring-offset-card/0',
          meta.ring
        )}
      >
        <Avatar name={display} email={row.agent.email} size="lg" />
      </div>

      <p className="mt-4 text-[15px] font-semibold tracking-tight text-foreground">
        {display}
      </p>
      <p className="text-xs text-muted-foreground">
        {row.appointments.showRate != null
          ? `${row.appointments.showRate}% show rate`
          : 'no completions yet'}
      </p>

      <p className="mt-3 text-[34px] font-bold leading-none tracking-tight tabular-nums text-foreground">
        {row.appointments.total}
      </p>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        appts set
      </p>

      <div className="relative z-10 mt-4 inline-flex items-center gap-1.5 rounded-full border border-border/40 bg-card/80 px-3 py-1.5 text-[11px] font-semibold text-foreground shadow-sm backdrop-blur">
        <Sparkles className="h-3 w-3 text-primary" />
        {meta.prize}
      </div>
    </div>
  )
}

/* ---- Helpers ----------------------------------------------------------- */

function formatRangeLabel(since: string | null, until: string | null): string {
  if (!since || !until) return 'Last 30 days'
  const a = new Date(since)
  const b = new Date(until)
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 'Custom range'
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(a)} — ${fmt(b)}`
}

function LeaderboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="h-24 animate-pulse rounded-3xl border border-border bg-card shadow-soft" />
      <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-3">
        <div className="h-[252px] animate-pulse rounded-3xl border border-border bg-card shadow-soft" />
        <div className="h-[280px] animate-pulse rounded-3xl border border-border bg-card shadow-soft" />
        <div className="h-[230px] animate-pulse rounded-3xl border border-border bg-card shadow-soft" />
      </div>
      <div className="h-64 animate-pulse rounded-2xl border border-border bg-card shadow-soft" />
    </div>
  )
}
