'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  AlertCircle,
  Headphones,
  PhoneCall,
  PhoneIncoming,
  Activity,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * /team/live-report — display-only mirror of the Vicidial admin
 * dashboard. Pulls from /api/team/vicidial/stats which scrapes the
 * admin.php page server-side via the Render IPs already whitelisted
 * by vicitel. 60s polling cadence; server-side cache de-dupes
 * concurrent viewers to one fetch per minute.
 *
 * Display-only by design: no controls, no edits, no admin actions.
 * Team #1 + admin/member can both reach this page; the URL works
 * the same regardless of who's viewing.
 */

type StatsResponse =
  | {
      ok: true
      stats: {
        agentsLoggedIn: number | null
        agentsInCalls: number | null
        activeCalls: number | null
        callsRinging: number | null
        systemSummary: {
          users: SummaryRow
          campaigns: SummaryRow
          lists: SummaryRow
          inGroups: SummaryRow
          dids: SummaryRow
        }
        today: TotalStatsRow
        yesterday: TotalStatsRow
      }
      fetchedAt: string
    }
  | { ok: false; error: string; fetchedAt: string }

type SummaryRow = {
  active: number | null
  inactive: number | null
  total: number | null
}

type TotalStatsRow = {
  totalCalls: number | null
  inboundCalls: number | null
  outboundCalls: number | null
  maxAgents: number | null
}

export default function LiveReportPage() {
  const query = useQuery<StatsResponse>({
    queryKey: ['team-vicidial-stats'],
    queryFn: async () => {
      const res = await fetch('/api/team/vicidial/stats')
      if (!res.ok) throw new Error('Failed to load')
      return res.json()
    },
    refetchInterval: 60_000,
    // Keep polling even when the tab is backgrounded — otherwise
    // Alex opens the tab in the morning and sees stat-data from
    // whenever he last had it focused. Default React Query
    // behavior suspends interval polls on hidden tabs.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    // Show stale data while the next poll is in flight so the page
    // doesn't flash a loading state every minute.
    placeholderData: (prev) => prev,
  })

  // Surface a "stale" warning when the displayed fetchedAt is more
  // than 2 minutes old — gives the user visible feedback that
  // polling stopped (network blip, server hiccup, etc.) instead of
  // silently displaying ancient numbers.
  const fetchedAtIso =
    query.data?.fetchedAt && typeof query.data.fetchedAt === 'string'
      ? query.data.fetchedAt
      : null
  const [, setNow] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 5_000)
    return () => clearInterval(t)
  }, [])
  const isStale =
    fetchedAtIso !== null &&
    Date.now() - Date.parse(fetchedAtIso) > 120_000

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link
        href="/team"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to dashboard
      </Link>

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Report</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Mirror of the Vicidial admin dashboard. Refreshes every minute.
          </p>
        </div>
        <RefreshIndicator
          fetchedAt={query.data?.fetchedAt}
          loading={query.isFetching}
        />
      </header>

      {isStale && (
        <div className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning border-warning/30 bg-warning/15 text-warning">
          ⚠ Data is more than 2 minutes old — the auto-refresh may have
          stalled. Try a hard refresh (Ctrl+Shift+R / Cmd+Shift+R).
        </div>
      )}

      {query.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading live data…
        </div>
      ) : !query.data?.ok ? (
        <FailureBanner
          message={
            query.data?.ok === false
              ? query.data.error
              : query.error instanceof Error
                ? query.error.message
                : 'Live data unavailable.'
          }
        />
      ) : (
        <LiveContent stats={query.data.stats} />
      )}
    </div>
  )
}

function LiveContent({ stats }: { stats: Extract<StatsResponse, { ok: true }>['stats'] }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <BigStat
          label="Agents logged in"
          value={stats.agentsLoggedIn}
          icon={<Headphones className="h-5 w-5" />}
          tone="blue"
        />
        <BigStat
          label="Agents in calls"
          value={stats.agentsInCalls}
          icon={<Activity className="h-5 w-5" />}
          tone="emerald"
        />
        <BigStat
          label="Active calls"
          value={stats.activeCalls}
          icon={<PhoneCall className="h-5 w-5" />}
          tone="amber"
        />
        <BigStat
          label="Calls ringing"
          value={stats.callsRinging}
          icon={<PhoneIncoming className="h-5 w-5" />}
          tone="rose"
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card border-border bg-card">
        <h2 className="border-b border-border bg-surface-muted px-4 py-2 eyebrow text-muted-foreground border-border bg-background text-foreground/85">
          System summary
        </h2>
        <table className="w-full text-sm">
          <thead className="border-b border-border-soft bg-surface-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground border-border bg-background">
            <tr>
              <th className="px-4 py-2 text-left font-semibold">Records</th>
              <th className="px-4 py-2 text-right font-semibold">Active</th>
              <th className="px-4 py-2 text-right font-semibold">Inactive</th>
              <th className="px-4 py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            <SummaryTableRow label="Users" row={stats.systemSummary.users} />
            <SummaryTableRow label="Campaigns" row={stats.systemSummary.campaigns} />
            <SummaryTableRow label="Lists" row={stats.systemSummary.lists} />
            <SummaryTableRow label="In-Groups" row={stats.systemSummary.inGroups} />
            <SummaryTableRow label="DIDs" row={stats.systemSummary.dids} />
          </tbody>
        </table>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <TotalStatsCard title="Today" row={stats.today} />
        <TotalStatsCard title="Yesterday" row={stats.yesterday} />
      </div>

      <p className="text-center text-[10px] text-muted-foreground/70">
        Display only. To make changes, sign in to Vicidial directly.
      </p>
    </div>
  )
}

function BigStat({
  label,
  value,
  icon,
  tone,
}: {
  label: string
  value: number | null
  icon: React.ReactNode
  tone: 'blue' | 'emerald' | 'amber' | 'rose'
}) {
  const toneClass =
    tone === 'blue'
      ? 'border-primary/30 bg-primary-soft text-primary border-primary/30 bg-primary-soft text-primary'
      : tone === 'emerald'
        ? 'border-success/30 bg-success/15 text-success border-success/30 bg-success/15 text-success'
        : tone === 'amber'
          ? 'border-warning/30 bg-warning/15 text-warning border-warning/30 bg-warning/15 text-warning'
          : 'border-destructive/30 bg-destructive/10 text-destructive border-destructive/30 bg-destructive/10 text-destructive'
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl border p-4',
        toneClass,
      )}
    >
      <div>
        <p className="eyebrow opacity-70">
          {label}
        </p>
        <p className="mt-1 text-3xl font-bold tabular-nums">
          {value === null ? '—' : value.toLocaleString()}
        </p>
      </div>
      <div className="rounded-lg bg-card/60 p-2 dark:bg-black/20">{icon}</div>
    </div>
  )
}

function SummaryTableRow({ label, row }: { label: string; row: SummaryRow }) {
  return (
    <tr className="border-b border-border-soft last:border-0 border-border">
      <td className="px-4 py-2.5 font-medium">{label}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {row.active === null ? '—' : row.active.toLocaleString()}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
        {row.inactive === null ? '—' : row.inactive.toLocaleString()}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
        {row.total === null ? '—' : row.total.toLocaleString()}
      </td>
    </tr>
  )
}

function TotalStatsCard({
  title,
  row,
}: {
  title: string
  row: TotalStatsRow
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card border-border bg-card">
      <h3 className="border-b border-border bg-surface-muted px-4 py-2 eyebrow text-muted-foreground border-border bg-background text-foreground/85">
        Total stats — {title}
      </h3>
      <div className="grid grid-cols-2 gap-4 p-4 text-sm">
        <Stat label="Total calls" value={row.totalCalls} />
        <Stat label="Inbound" value={row.inboundCalls} />
        <Stat label="Outbound" value={row.outboundCalls} />
        <Stat label="Max agents" value={row.maxAgents} />
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <p className="eyebrow text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums">
        {value === null ? '—' : value.toLocaleString()}
      </p>
    </div>
  )
}

function RefreshIndicator({
  fetchedAt,
  loading,
}: {
  fetchedAt: string | undefined
  loading: boolean
}) {
  // Tick once per second so the "X seconds ago" copy updates without
  // a full re-render of the page.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  if (!fetchedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <RefreshCw className="h-3 w-3" />
        Connecting…
      </span>
    )
  }
  const secondsAgo = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(fetchedAt)) / 1000),
  )
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {loading ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <RefreshCw className="h-3 w-3" />
      )}
      Updated {secondsAgo}s ago
    </span>
  )
}

function FailureBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/15 p-4 border-warning/30 bg-warning/15">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
        <div>
          <p className="text-sm font-semibold text-warning">
            Live data unavailable
          </p>
          <p className="mt-1 text-xs text-warning">
            {message}
          </p>
          <p className="mt-2 text-[11px] text-warning">
            The page will keep retrying every minute. If this persists, check
            the Vicidial Admin credentials in the Hub vault.
          </p>
        </div>
      </div>
    </div>
  )
}
