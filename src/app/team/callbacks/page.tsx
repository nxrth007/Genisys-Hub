'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Phone,
  Loader2,
  CheckCircle2,
  Circle,
  PhoneCall,
  Clock,
  AlertTriangle,
  Search,
  Undo2,
  ArrowLeft,
  Play,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * /team/callbacks — Team #1 member's callback list. Mirror of
 * /agent/callbacks (Mary's page) routed through /api/team/callbacks
 * so middleware permits team_member access. Same Callback DB table
 * the agent flow writes to.
 */

type Callback = {
  id: string
  customerName: string
  customerPhone: string
  callbackAt: string
  notes: string | null
  callRecordingLink: string | null
  /** Signed proxy URL set by the server when callRecordingLink is
   *  on the row — UI uses this in <a href> so the browser never
   *  sees the raw IP-gated vicidial URL. Null when no recording
   *  is attached OR when RECORDING_PROXY_SECRET isn't configured. */
  recordingUrl: string | null
  completedAt: string | null
  outcome: string | null
  createdAt: string
}

type Bucket = 'due' | 'upcoming' | 'overdue' | 'completed' | 'all'

const TABS: Array<{ value: Bucket; label: string }> = [
  { value: 'due', label: 'Due today' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
]

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export default function TeamCallbacksPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Bucket>('due')
  const [search, setSearch] = useState('')

  const query = useQuery<{ callbacks: Callback[] }>({
    queryKey: ['team-callbacks'],
    queryFn: async () => {
      const res = await fetch('/api/team/callbacks')
      if (!res.ok) throw new Error('Failed to load callbacks')
      return res.json()
    },
  })

  const callbacks = useMemo(() => query.data?.callbacks ?? [], [query.data])

  const { due, upcoming, overdue, completed } = useMemo(() => {
    const now = new Date()
    const dueList: Callback[] = []
    const upcomingList: Callback[] = []
    const overdueList: Callback[] = []
    const completedList: Callback[] = []
    for (const c of callbacks) {
      if (c.completedAt) {
        completedList.push(c)
        continue
      }
      const when = new Date(c.callbackAt)
      if (when < now) overdueList.push(c)
      else if (isSameDay(when, now)) dueList.push(c)
      else upcomingList.push(c)
    }
    return {
      due: dueList,
      upcoming: upcomingList,
      overdue: overdueList,
      completed: completedList,
    }
  }, [callbacks])

  const counts: Record<Bucket, number> = {
    due: due.length,
    upcoming: upcoming.length,
    overdue: overdue.length,
    completed: completed.length,
    all: callbacks.length,
  }

  let visible: Callback[] =
    tab === 'due'
      ? due
      : tab === 'upcoming'
        ? upcoming
        : tab === 'overdue'
          ? overdue
          : tab === 'completed'
            ? completed
            : callbacks

  const q = search.trim().toLowerCase()
  if (q) {
    visible = visible.filter(
      (c) =>
        c.customerName.toLowerCase().includes(q) ||
        c.customerPhone.toLowerCase().includes(q) ||
        c.notes?.toLowerCase().includes(q),
    )
  }

  const toggleMutation = useMutation({
    mutationFn: async (params: { id: string; completed: boolean }) => {
      const res = await fetch(`/api/team/callbacks/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed: params.completed }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update')
      }
      return res.json()
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['team-callbacks'] }),
  })

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link
        href="/team"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Callbacks</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Prospects who asked you to call them back. Overdue + due-today
            show up first.
          </p>
        </div>
        <Link
          href="/team/callbacks/new"
          className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:bg-foreground/90"
        >
          <Plus className="h-4 w-4" />
          New callback
        </Link>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => {
          const active = tab === t.value
          const count = counts[t.value]
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                active
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground',
              )}
            >
              {t.label}
              {count > 0 && (
                <span
                  className={cn(
                    'rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                    active
                      ? 'bg-primary-soft text-primary bg-primary-soft text-primary'
                      : t.value === 'overdue'
                        ? 'bg-destructive/10 text-destructive bg-destructive/10 text-destructive'
                        : 'bg-muted text-muted-foreground bg-surface-muted text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, phone, notes…"
          className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm focus:border-primary/50 focus:outline-none border-border bg-card"
        />
      </div>

      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center border-border">
          <PhoneCall className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <h3 className="mt-3 text-sm font-semibold">
            {callbacks.length === 0
              ? 'No callbacks yet'
              : 'Nothing in this bucket'}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {callbacks.length === 0
              ? 'Click "New callback" to schedule your first follow-up.'
              : 'Try a different tab or clear your search.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card border-border bg-card">
          <div className="divide-y divide-border-soft">
            {visible.map((c) => (
              <CallbackRow
                key={c.id}
                callback={c}
                onToggle={(completed) =>
                  toggleMutation.mutate({ id: c.id, completed })
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function CallbackRow({
  callback,
  onToggle,
}: {
  callback: Callback
  onToggle: (completed: boolean) => void
}) {
  const when = new Date(callback.callbackAt)
  const now = new Date()
  const isOverdue = !callback.completedAt && when < now
  const isDueToday = !callback.completedAt && isSameDay(when, now)
  const done = !!callback.completedAt

  return (
    <div
      className={cn(
        'group flex items-start gap-3 px-4 py-3 transition-colors',
        done
          ? 'bg-surface-muted/50 bg-background/30'
          : isOverdue
            ? 'bg-destructive/10 hover:bg-destructive/10 bg-destructive/10 hover:bg-destructive/10'
            : 'hover:bg-muted hover:bg-muted/50',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(!done)}
        title={done ? 'Mark as not done' : 'Mark as done'}
        className="mt-0.5 flex-shrink-0 rounded-lg transition-transform hover:scale-110"
      >
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-success" />
        ) : (
          <Circle
            className={cn(
              'h-5 w-5',
              isOverdue
                ? 'text-destructive hover:text-destructive'
                : 'text-muted-foreground/50 hover:text-primary text-muted-foreground/50',
            )}
          />
        )}
      </button>

      <Link
        href={`/team/callbacks/${callback.id}`}
        className="block min-w-0 flex-1"
      >
        <div className="flex items-center gap-2">
          <p
            className={cn(
              'truncate text-sm font-semibold',
              done && 'text-muted-foreground/70 line-through text-muted-foreground/70',
            )}
          >
            {callback.customerName}
          </p>
          {isOverdue && (
            <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive bg-destructive/10 text-destructive">
              <AlertTriangle className="h-2.5 w-2.5" />
              Overdue
            </span>
          )}
          {isDueToday && !isOverdue && (
            <span className="inline-flex items-center gap-1 rounded-md bg-primary-soft px-2 py-0.5 text-[10px] font-semibold text-primary bg-primary-soft text-primary">
              <Clock className="h-2.5 w-2.5" />
              Today
            </span>
          )}
        </div>

        <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-mono">
            <Phone className="h-3 w-3" />
            {callback.customerPhone}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {when.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
        </div>

        {callback.notes && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {callback.notes}
          </p>
        )}

        {callback.recordingUrl && (
          <a
            href={callback.recordingUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary-soft px-2 py-0.5 text-[10px] font-medium text-primary transition hover:bg-primary-soft border-primary/30 bg-primary-soft text-primary"
          >
            <Play className="h-2.5 w-2.5" />
            Listen to call
          </a>
        )}
      </Link>

      {done && (
        <button
          onClick={() => onToggle(false)}
          title="Undo completion"
          className="flex-shrink-0 rounded p-1 text-muted-foreground/70 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 hover:bg-muted hover:text-foreground"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
