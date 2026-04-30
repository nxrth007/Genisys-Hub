'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronRight,
  Loader2,
  Users,
  Building2,
  CalendarCheck,
  TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { StatCard } from '@/components/ui/stat-card'

/**
 * Call Center → Agents tab. Pod-accordion layout ported from Ethan's
 * mockup. Each pod (= a Genisys client) collapses by default; click
 * to expand into per-agent rows showing total bookings, show rate,
 * and last-booking timestamp.
 *
 * Pod membership is data-driven — each agent is grouped under the
 * client they've booked the most appointments for. Agents with no
 * bookings yet land in an "Unassigned" pod so they're still visible.
 */

type AgentRow = {
  id: string
  name: string | null
  email: string
  primaryClientId: string | null
  total: number
  showed: number
  noShow: number
  cancelled: number
  upcoming: number
  showRate: number | null
  lastBookingAt: string | null
}

type Pod = {
  id: string
  name: string
  state: string | null
  color: string
  agents: AgentRow[]
  totalAppts: number
}

type ApiResponse = {
  pods: Pod[]
  unassigned: AgentRow[]
  totals: { agents: number; pods: number; totalAppts: number }
}

export default function CallCenterAgentsPage() {
  const query = useQuery<ApiResponse>({
    queryKey: ['call-center-agents-by-pod'],
    queryFn: async () => {
      const res = await fetch('/api/call-center/agents/by-pod')
      if (!res.ok) throw new Error('Failed to load agents')
      return res.json()
    },
  })

  const data = query.data

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6">
      {/* Workspace summary cards — three at the top, mirrors the
          mockup's Agents-tab summary row. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Pods"
          value={data ? String(data.pods.length) : '—'}
          subtitle="one per active client"
          tone="blue"
        />
        <StatCard
          label="Agents"
          value={data ? String(data.totals.agents) : '—'}
          subtitle={
            data
              ? `${data.unassigned.length} unassigned`
              : 'loading roster…'
          }
          tone="indigo"
        />
        <StatCard
          label="Appts (lifetime)"
          value={data ? data.totals.totalAppts.toLocaleString() : '—'}
          subtitle="across every agent"
          tone="green"
        />
      </div>

      {/* Pod accordions */}
      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : query.isError ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-sm text-destructive">
          Couldn&apos;t load the agent list. Try refreshing.
        </div>
      ) : data && (data.pods.length === 0 && data.unassigned.length === 0) ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
          <Users className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No approved agents yet — approvals happen on the{' '}
            <Link href="/agents" className="text-primary hover:underline">
              Agents admin page
            </Link>
            .
          </p>
        </div>
      ) : data ? (
        <div className="flex flex-col gap-4">
          {data.pods.map((pod, i) => (
            <PodAccordion key={pod.id} pod={pod} defaultOpen={i === 0} />
          ))}
          {data.unassigned.length > 0 && (
            <UnassignedAccordion agents={data.unassigned} />
          )}
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function PodAccordion({
  pod,
  defaultOpen,
}: {
  pod: Pod
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)

  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-surface-muted"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
            style={{ backgroundColor: pod.color }}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{pod.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {pod.state || 'Multi-state'} · {pod.agents.length} agent
              {pod.agents.length === 1 ? '' : 's'} · {pod.totalAppts}{' '}
              {pod.totalAppts === 1 ? 'booking' : 'bookings'}
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          {/* Stack of avatars — at-a-glance roster preview without
              expanding the pod. Caps at 4 + a "+N" overflow chip. */}
          <AvatarStack agents={pod.agents} max={4} />
          <ChevronRight
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
        </div>
      </button>

      {open && (
        <ul className="border-t border-border-soft">
          {pod.agents.length === 0 ? (
            <li className="px-5 py-6 text-center text-xs text-muted-foreground">
              No agents primarily booking for this client yet.
            </li>
          ) : (
            pod.agents.map((agent) => <AgentRowItem key={agent.id} agent={agent} />)
          )}
        </ul>
      )}
    </article>
  )
}

function UnassignedAccordion({ agents }: { agents: AgentRow[] }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="overflow-hidden rounded-2xl border border-dashed border-border bg-card shadow-soft">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-surface-muted"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-muted-foreground/40"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Unassigned</p>
            <p className="truncate text-xs text-muted-foreground">
              {agents.length} agent{agents.length === 1 ? '' : 's'} with no
              bookings yet — they land in a real pod once they book for a
              client.
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          <AvatarStack agents={agents} max={4} />
          <ChevronRight
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
        </div>
      </button>
      {open && (
        <ul className="border-t border-border-soft">
          {agents.map((agent) => (
            <AgentRowItem key={agent.id} agent={agent} />
          ))}
        </ul>
      )}
    </article>
  )
}

function AgentRowItem({ agent }: { agent: AgentRow }) {
  const display = agent.name || agent.email
  return (
    <li>
      <Link
        href={`/call-center/agents/${agent.id}`}
        className="grid grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))] items-center gap-4 border-t border-border-soft bg-surface-muted/40 px-5 py-3.5 first:border-t-0 transition hover:bg-surface-muted"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={display} email={agent.email} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{display}</p>
            <p className="truncate text-xs text-muted-foreground">
              {agent.email}
            </p>
          </div>
        </div>
        <Stat
          icon={Building2}
          label="Bookings"
          value={agent.total.toLocaleString()}
        />
        <Stat
          icon={CalendarCheck}
          label="Upcoming"
          value={String(agent.upcoming)}
        />
        <Stat
          icon={TrendingUp}
          label="Show rate"
          value={agent.showRate != null ? `${agent.showRate}%` : '—'}
        />
      </Link>
    </li>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div>
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function AvatarStack({
  agents,
  max,
}: {
  agents: AgentRow[]
  max: number
}) {
  const visible = agents.slice(0, max)
  const overflow = agents.length - visible.length
  return (
    <div className="flex -space-x-2">
      {visible.map((a) => (
        <div
          key={a.id}
          className="rounded-full ring-2 ring-card"
          title={a.name || a.email}
        >
          <Avatar name={a.name || a.email} email={a.email} size="xs" />
        </div>
      ))}
      {overflow > 0 && (
        <div
          className="grid h-6 w-6 place-items-center rounded-full bg-muted text-[10px] font-semibold ring-2 ring-card"
          title={`${overflow} more`}
        >
          +{overflow}
        </div>
      )}
    </div>
  )
}
