'use client'

import { Suspense, useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  CalendarCheck,
  CircleAlert,
  ClipboardList,
  Loader2,
  Phone,
  TrendingUp,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { StatCard } from '@/components/ui/stat-card'

/**
 * Call Center → Agents tab.
 *
 * Agent-first view (replaces the previous client-pod accordion). Each
 * approved agent gets a card showing:
 *   - status badge (active / quiet / stale / dormant) from
 *     last-activity recency across appointments + EOD + callbacks
 *   - bookings strip for the active window with show rate + pipeline $
 *   - EOD activity strip (dials / contacts / connect & booking rates +
 *     missing report days)
 *   - per-client breakdown bar — finally tells the truth that one
 *     agent books for many clients
 *   - 30-bucket daily trend sparkline
 *
 * Designed to stay scannable at N=1 (Mary) and scale to N=10+ as the
 * roster grows. Backed by /api/call-center/agents/overview.
 */

type Range = '7d' | '30d' | '90d' | 'all'
type ActivityStatus = 'active' | 'quiet' | 'stale' | 'dormant' | 'never'

type Bookings = {
  total: number
  booked: number
  rescheduled: number
  showed: number
  noShow: number
  cancelled: number
  upcoming: number
  showRate: number | null
  pipelineDollars: number
}
type Activity = {
  dials: number
  contacts: number
  apptsReported: number
  callbacks: number
  callbacksOpen: number
  connectRate: number | null
  bookingRate: number | null
  daysReported: number
  expectedDays: number | null
  missingDays: number | null
}
type PerClient = {
  clientId: string
  clientName: string
  clientColor: string
  count: number
  showRate: number | null
}
type AgentRow = {
  id: string
  name: string | null
  email: string
  approvedAt: string | null
  agentSheetTab: string | null
  lastActivityAt: string | null
  activityStatus: ActivityStatus
  /** Lifetime sheet rows attributed to this agent — useful for
   *  sanity-checking against the master tracker's total. */
  lifetimeTotal: number
  bookings: Bookings
  activity: Activity
  perClient: PerClient[]
  trend: Array<{ date: string; count: number }>
}
type ClientChip = {
  id: string
  name: string
  state: string | null
  color: string
}
type ApiResponse = {
  range: Range
  since: string | null
  until: string
  clientFilter: string
  activeOnly: boolean
  excludedHidden: number
  unattributedSheetRows: number
  totalSheetRowsConsidered: number
  summary: {
    activeAgents: number
    totalAgents: number
    bookingsThisWindow: number
    bookingsPriorWindow: number
    bookingsDelta: number | null
    pipelineDollars: number
    avgShowRate: number | null
    eodConsistency: number | null
  }
  agents: AgentRow[]
  clients: ClientChip[]
}

/**
 * Suspense wrapper — Next.js requires it whenever the page reads
 * useSearchParams(), otherwise `next build` fails the static-export
 * step ("missing-suspense-with-csr-bailout"). The fallback mirrors
 * the loading state of the real page so there's no visual flash.
 */
export default function CallCenterAgentsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-[1280px]">
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        </div>
      }
    >
      <CallCenterAgentsPageInner />
    </Suspense>
  )
}

function CallCenterAgentsPageInner() {
  const router = useRouter()
  const sp = useSearchParams()
  const range = ((sp.get('range') as Range | null) || '30d') as Range
  const clientFilter = sp.get('client') || 'all'
  const activeOnly = (sp.get('activeOnly') ?? 'true') !== 'false'

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(sp.toString())
    if (value === null) params.delete(key)
    else params.set(key, value)
    router.replace(`/call-center/agents?${params.toString()}`, { scroll: false })
  }

  const query = useQuery<ApiResponse>({
    queryKey: ['call-center-agents-overview', range, clientFilter, activeOnly],
    queryFn: async () => {
      const qs = new URLSearchParams({
        range,
        client: clientFilter,
        activeOnly: String(activeOnly),
      })
      const res = await fetch(`/api/call-center/agents/overview?${qs.toString()}`)
      if (!res.ok) throw new Error('Failed to load agents')
      return res.json()
    },
  })
  const data = query.data

  const windowLabel = useMemo(() => {
    if (range === '7d') return 'last 7 days'
    if (range === '30d') return 'last 30 days'
    if (range === '90d') return 'last 90 days'
    return 'all time'
  }, [range])

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6">
      {/* Header — five at-a-glance tiles for "is the call center
          healthy right now?" Booking delta is the one that catches
          regressions fastest. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard
          label="Active agents"
          value={
            data ? `${data.summary.activeAgents}/${data.summary.totalAgents}` : '—'
          }
          subtitle={`signals in ${windowLabel}`}
          tone="indigo"
        />
        <BookingsDeltaCard data={data} windowLabel={windowLabel} />
        <StatCard
          label="Pipeline $"
          value={
            data ? `$${data.summary.pipelineDollars.toLocaleString()}` : '—'
          }
          subtitle="open deals only"
          tone="green"
        />
        <StatCard
          label="Avg show rate"
          value={
            data
              ? data.summary.avgShowRate != null
                ? `${data.summary.avgShowRate}%`
                : '—'
              : '—'
          }
          subtitle="showed ÷ resolved"
          tone="blue"
        />
        <StatCard
          label="EOD reporting"
          value={
            data
              ? data.summary.eodConsistency != null
                ? `${data.summary.eodConsistency}%`
                : '—'
              : '—'
          }
          subtitle="reports ÷ weekdays"
          tone="amber"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="flex items-center gap-1">
          {(['7d', '30d', '90d', 'all'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setParam('range', r === '30d' ? null : r)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition',
                range === r
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-muted text-muted-foreground hover:bg-surface-muted/80',
              )}
            >
              {r === 'all' ? 'All time' : r}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-border" />

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setParam('client', null)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition',
              clientFilter === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface-muted text-muted-foreground hover:bg-surface-muted/80',
            )}
          >
            All clients
          </button>
          {data?.clients.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setParam('client', c.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition',
                clientFilter === c.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-muted text-muted-foreground hover:bg-surface-muted/80',
              )}
              title={c.state ? `${c.name} (${c.state})` : c.name}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: c.color }}
                aria-hidden
              />
              {c.name}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) =>
                setParam('activeOnly', e.target.checked ? null : 'false')
              }
              className="h-3.5 w-3.5 rounded border-border accent-primary"
            />
            Active only
          </label>
          {data && data.excludedHidden > 0 && (
            <span
              className="text-[10px] text-muted-foreground/70"
              title="Test accounts hidden by the EXCLUDED_AGENT_EMAILS denylist on the server"
            >
              ({data.excludedHidden} test {data.excludedHidden === 1 ? 'account' : 'accounts'} hidden)
            </span>
          )}
        </div>
      </div>

      {/* Cards */}
      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : query.isError ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-sm text-destructive">
          Couldn&apos;t load the agent roster. Try refreshing.
        </div>
      ) : data && data.agents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
          <Users className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {activeOnly
              ? 'No active agents in this window. Toggle "Active only" off to include everyone.'
              : 'No approved agents yet — approvals happen on the Agents admin page.'}
          </p>
        </div>
      ) : data ? (
        <div className="flex flex-col gap-4">
          {data.unattributedSheetRows > 0 && (
            <UnattributedBanner
              count={data.unattributedSheetRows}
              total={data.totalSheetRowsConsidered}
            />
          )}
          {data.agents.map((a) => (
            <AgentCard key={a.id} agent={a} windowLabel={windowLabel} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function UnattributedBanner({
  count,
  total,
}: {
  count: number
  total: number
}) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs dark:border-amber-900 dark:bg-amber-950/40">
      <p className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>
          <strong>{count}</strong> of {total} master-tracker rows couldn&apos;t
          be attributed to a Hub agent. Usually means the sheet&apos;s{' '}
          <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">
            agent email
          </code>{' '}
          column is blank for those rows, or the email doesn&apos;t match any
          approved Hub agent. Fill it in to get accurate per-agent counts.
        </span>
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function BookingsDeltaCard({
  data,
  windowLabel,
}: {
  data: ApiResponse | undefined
  windowLabel: string
}) {
  if (!data) {
    return (
      <StatCard label="Bookings" value="—" subtitle={`in ${windowLabel}`} tone="blue" />
    )
  }
  const { bookingsThisWindow, bookingsDelta } = data.summary
  const subtitle =
    bookingsDelta === null
      ? `total in ${windowLabel}`
      : bookingsDelta === 0
        ? 'flat vs. prior window'
        : `${bookingsDelta > 0 ? '+' : ''}${bookingsDelta} vs. prior ${windowLabel}`
  return (
    <StatCard
      label="Bookings"
      value={String(bookingsThisWindow)}
      subtitle={subtitle}
      tone={
        bookingsDelta === null || bookingsDelta === 0
          ? 'blue'
          : bookingsDelta > 0
            ? 'green'
            : 'amber'
      }
    />
  )
}

function AgentCard({
  agent,
  windowLabel,
}: {
  agent: AgentRow
  windowLabel: string
}) {
  const display = agent.name || agent.email
  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
      {/* Row 1 — identity + status badge */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={display} email={agent.email} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{display}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="truncate">{agent.email}</span>
              {agent.approvedAt && (
                <>
                  <span>·</span>
                  <span>Approved {relativeDays(agent.approvedAt)}</span>
                </>
              )}
              {agent.agentSheetTab && (
                <>
                  <span>·</span>
                  <span>Sheet: {agent.agentSheetTab}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <StatusBadge status={agent.activityStatus} lastActivityAt={agent.lastActivityAt} />
          <Link
            href={`/call-center/agents/${agent.id}`}
            className="rounded-md border border-border bg-surface-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            View full detail →
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 px-5 py-4 lg:grid-cols-[1fr_1fr] xl:grid-cols-[1fr_1fr_1.2fr]">
        {/* Row 2 — bookings strip */}
        <section>
          <SectionLabel icon={CalendarCheck} label={`Bookings · ${windowLabel}`} />
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums">
              {agent.bookings.total}
            </span>
            <span className="text-xs text-muted-foreground">
              {agent.bookings.upcoming > 0
                ? `${agent.bookings.upcoming} upcoming`
                : 'no upcoming'}
            </span>
            {agent.lifetimeTotal > agent.bookings.total && (
              <span
                className="text-[10px] text-muted-foreground/80"
                title="Lifetime total across the master tracker (all time, all clients) — matches the count in /call-center/master-tracker."
              >
                · {agent.lifetimeTotal} lifetime
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <Tag dot="bg-blue-500" label={`${agent.bookings.booked} booked`} />
            <Tag dot="bg-amber-500" label={`${agent.bookings.rescheduled} resched`} />
            <Tag dot="bg-green-500" label={`${agent.bookings.showed} showed`} />
            <Tag dot="bg-red-500" label={`${agent.bookings.noShow} no-show`} />
            <Tag dot="bg-zinc-400" label={`${agent.bookings.cancelled} cancel`} />
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Show rate
              </p>
              <p
                className={cn(
                  'font-semibold tabular-nums',
                  agent.bookings.showRate == null
                    ? 'text-muted-foreground'
                    : agent.bookings.showRate >= 70
                      ? 'text-green-600'
                      : agent.bookings.showRate >= 40
                        ? 'text-amber-600'
                        : 'text-red-600',
                )}
              >
                {agent.bookings.showRate != null
                  ? `${agent.bookings.showRate}%`
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Pipeline
              </p>
              <p className="font-semibold tabular-nums text-green-700 dark:text-green-300">
                ${agent.bookings.pipelineDollars.toLocaleString()}
              </p>
            </div>
          </div>
        </section>

        {/* Row 3 — activity strip (EOD) */}
        <section>
          <SectionLabel icon={Phone} label="Activity · self-reported" />
          {agent.activity.daysReported === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No EOD reports filed in this window.
              {agent.activity.expectedDays && agent.activity.expectedDays > 0 && (
                <>
                  {' '}
                  <span className="text-amber-600">
                    ({agent.activity.expectedDays} expected weekday
                    {agent.activity.expectedDays === 1 ? '' : 's'})
                  </span>
                </>
              )}
            </p>
          ) : (
            <>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums">
                  {agent.activity.dials.toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">dials</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>{agent.activity.contacts} contacts</span>
                <span>·</span>
                <span>
                  {agent.activity.connectRate != null
                    ? `${agent.activity.connectRate}% connect`
                    : '— connect'}
                </span>
                <span>·</span>
                <span>
                  {agent.activity.bookingRate != null
                    ? `${agent.activity.bookingRate}% book`
                    : '— book'}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <span className="text-muted-foreground">
                  {agent.activity.daysReported} day
                  {agent.activity.daysReported === 1 ? '' : 's'} reported
                </span>
                {agent.activity.missingDays != null &&
                  agent.activity.missingDays > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      <CircleAlert className="h-3 w-3" />
                      {agent.activity.missingDays} missing
                    </span>
                  )}
                {agent.activity.callbacksOpen > 0 && (
                  <span className="text-muted-foreground">
                    {agent.activity.callbacksOpen} open callback
                    {agent.activity.callbacksOpen === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </>
          )}
        </section>

        {/* Row 4 — per-client breakdown */}
        <section className="xl:col-span-1">
          <SectionLabel icon={ClipboardList} label="Per-client breakdown" />
          {agent.perClient.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No client-attributed bookings in this window.
            </p>
          ) : (
            <PerClientBar perClient={agent.perClient} total={agent.bookings.total} />
          )}
        </section>
      </div>

      {/* Row 5 — sparkline trend */}
      <div className="border-t border-border-soft bg-surface-muted/30 px-5 py-3">
        <div className="mb-1 flex items-center justify-between">
          <SectionLabel icon={TrendingUp} label="Daily bookings created" />
          {agent.lastActivityAt && (
            <span className="text-[10px] text-muted-foreground">
              Last activity {relativeDays(agent.lastActivityAt)}
            </span>
          )}
        </div>
        <Sparkline buckets={agent.trend} />
      </div>
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/*  Small presentational helpers                                               */
/* -------------------------------------------------------------------------- */

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <p className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </p>
  )
}

function Tag({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} aria-hidden />
      {label}
    </span>
  )
}

function StatusBadge({
  status,
  lastActivityAt,
}: {
  status: ActivityStatus
  lastActivityAt: string | null
}) {
  const tone =
    status === 'active'
      ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
      : status === 'quiet'
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
        : status === 'stale'
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
          : status === 'dormant'
            ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
  const label =
    status === 'active'
      ? 'Active'
      : status === 'quiet'
        ? 'Quiet'
        : status === 'stale'
          ? 'Stale'
          : status === 'dormant'
            ? 'Dormant'
            : 'No activity'
  const title = lastActivityAt
    ? `Last activity: ${new Date(lastActivityAt).toLocaleString()}`
    : 'No appointments, EOD reports, or callbacks on record'
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold',
        tone,
      )}
    >
      {label}
    </span>
  )
}

function PerClientBar({
  perClient,
  total,
}: {
  perClient: PerClient[]
  total: number
}) {
  if (total === 0) return null
  return (
    <div className="mt-2 space-y-2">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-muted"
        role="img"
        aria-label={`Per-client booking breakdown across ${perClient.length} clients`}
      >
        {perClient.map((slot) => (
          <div
            key={slot.clientId}
            style={{
              width: `${(slot.count / total) * 100}%`,
              backgroundColor: slot.clientColor,
            }}
            title={`${slot.clientName}: ${slot.count} booking${
              slot.count === 1 ? '' : 's'
            }${slot.showRate != null ? ` · ${slot.showRate}% show rate` : ''}`}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        {perClient.map((slot) => (
          <li
            key={slot.clientId}
            className="flex items-center justify-between gap-2 truncate"
          >
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: slot.clientColor }}
                aria-hidden
              />
              <span className="truncate">{slot.clientName}</span>
            </span>
            <span className="flex-shrink-0 tabular-nums font-medium">
              {slot.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Sparkline({
  buckets,
}: {
  buckets: Array<{ date: string; count: number }>
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const height = 36
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {buckets.map((b, i) => {
        const h = b.count === 0 ? 2 : Math.max(3, (b.count / max) * height)
        return (
          <div
            key={i}
            className="group relative flex flex-1 flex-col items-center justify-end"
            title={`${new Date(b.date + 'T00:00:00Z').toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}: ${b.count} booking${b.count === 1 ? '' : 's'}`}
          >
            <div
              style={{ height: h }}
              className={cn(
                'w-full rounded-t transition-colors',
                b.count > 0
                  ? 'bg-primary group-hover:bg-primary/80'
                  : 'bg-surface-muted',
              )}
            />
          </div>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Date formatting                                                            */
/* -------------------------------------------------------------------------- */

function relativeDays(iso: string): string {
  const then = new Date(iso)
  const diffMs = Date.now() - then.getTime()
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000))
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return then.toLocaleDateString('en-US')
}

