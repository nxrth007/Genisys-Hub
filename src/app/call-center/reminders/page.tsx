'use client'

import { Suspense, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import {
  Loader2,
  MessagesSquare,
  Search,
  Send,
  Ban,
  Play,
  RotateCcw,
  AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Chip } from '@/components/ui/chip'
import { DropdownPill } from '@/components/ui/dropdown-pill'
import { StatCard } from '@/components/ui/stat-card'
import {
  REMINDER_LABELS,
  REMINDER_TYPES,
  type ReminderType,
} from '@/lib/reminders-constants'

/**
 * Call Center → Reminders tab. Browse + filter every queued /
 * sent / failed SMS reminder. Per-row admin actions (Cancel / Send
 * Now) on appropriate statuses. The Settings panel hosts the master
 * enable + templates editor; this page is the operational view —
 * "what's about to fire", "what failed", "who got what."
 */

type Reminder = {
  id: string
  reminderType: string
  scheduledFor: string
  status: string
  sentAt: string | null
  errorMessage: string | null
  customerName: string
  customerPhone: string
  customerTimezone: string
  apptDateTime: string
  clientId: string | null
  clientName: string | null
  client: { id: string; name: string; color: string } | null
  address: string | null
  agentName: string | null
  messageBody: string | null
}

type ApiResponse = {
  reminders: Reminder[]
  counts: Record<string, number>
  stats: {
    pendingNext24h: number
    sentPast7d: number
    failedPast7d: number
    successRate: number | null
  }
}

type StatusFilter =
  | 'all'
  | 'pending'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'backfilled'

export default function CallCenterRemindersPage() {
  return (
    <Suspense fallback={<RemindersSkeleton />}>
      <RemindersView />
    </Suspense>
  )
}

function RemindersView() {
  const params = useSearchParams()
  const initialStatus = (params.get('status') as StatusFilter) || 'all'
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus)
  const [typeFilter, setTypeFilter] = useState<'all' | ReminderType>('all')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const query = useQuery<ApiResponse>({
    queryKey: [
      'call-center-reminders',
      statusFilter,
      typeFilter,
      submittedSearch,
    ],
    queryFn: async () => {
      const sp = new URLSearchParams()
      if (statusFilter !== 'all') sp.set('status', statusFilter)
      if (typeFilter !== 'all') sp.set('reminderType', typeFilter)
      if (submittedSearch) sp.set('q', submittedSearch)
      const res = await fetch(`/api/call-center/reminders?${sp.toString()}`)
      if (!res.ok) throw new Error('Failed to load reminders')
      return res.json()
    },
    refetchInterval: 30_000,
  })

  const reminders = query.data?.reminders ?? []
  const counts = query.data?.counts ?? {}
  const stats = query.data?.stats
  const totalAll =
    (counts.pending ?? 0) +
    (counts.sent ?? 0) +
    (counts.failed ?? 0) +
    (counts.skipped ?? 0) +
    (counts.cancelled ?? 0) +
    (counts.backfilled ?? 0)

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6">
      {/* At-a-glance stats — operational health regardless of which
          slice is currently filtered. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Pending next 24h"
          value={stats?.pendingNext24h ?? 0}
          subtitle="reminders due to fire"
          tone="blue"
        />
        <StatCard
          label="Sent past 7 days"
          value={stats?.sentPast7d ?? 0}
          subtitle={
            stats?.failedPast7d
              ? `${stats.failedPast7d} failed in same window`
              : 'all delivered'
          }
          tone="green"
        />
        <StatCard
          label="Success rate"
          value={stats?.successRate != null ? `${stats.successRate}%` : '—'}
          subtitle="sent / (sent + failed) past 7d"
          tone={
            stats?.successRate == null
              ? 'zinc'
              : stats.successRate >= 95
                ? 'green'
                : stats.successRate >= 80
                  ? 'amber'
                  : 'red'
          }
          progress={stats?.successRate ?? null}
        />
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          label="All"
          count={totalAll}
          active={statusFilter === 'all'}
          onClick={() => setStatusFilter('all')}
        />
        <StatusChip
          label="Pending"
          count={counts.pending ?? 0}
          active={statusFilter === 'pending'}
          tone="blue"
          onClick={() => setStatusFilter('pending')}
        />
        <StatusChip
          label="Sent"
          count={counts.sent ?? 0}
          active={statusFilter === 'sent'}
          tone="emerald"
          onClick={() => setStatusFilter('sent')}
        />
        <StatusChip
          label="Failed"
          count={counts.failed ?? 0}
          active={statusFilter === 'failed'}
          tone="rose"
          onClick={() => setStatusFilter('failed')}
        />
        <StatusChip
          label="Skipped (past)"
          count={counts.skipped ?? 0}
          active={statusFilter === 'skipped'}
          onClick={() => setStatusFilter('skipped')}
        />
        <StatusChip
          label="Cancelled"
          count={counts.cancelled ?? 0}
          active={statusFilter === 'cancelled'}
          onClick={() => setStatusFilter('cancelled')}
        />
        <StatusChip
          label="Backfilled"
          count={counts.backfilled ?? 0}
          active={statusFilter === 'backfilled'}
          onClick={() => setStatusFilter('backfilled')}
        />
      </div>

      {/* Type filter + search */}
      <div className="flex flex-wrap items-end gap-3">
        <DropdownPill
          value={typeFilter}
          options={[
            { id: 'all', label: 'All windows' },
            ...REMINDER_TYPES.map((t) => ({ id: t, label: REMINDER_LABELS[t] })),
          ]}
          onChange={(v) => setTypeFilter(v)}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedSearch(search.trim())
          }}
          className="relative flex-1 min-w-[260px] max-w-md"
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
            className="w-full rounded-full border border-border bg-card py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none"
          />
        </form>
      </div>

      {/* Table / list */}
      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : query.isError ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-sm text-destructive">
          Couldn&apos;t load reminders. Try refreshing.
        </div>
      ) : reminders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
          <MessagesSquare className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No reminders match these filters.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border-soft overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          {reminders.map((r) => (
            <ReminderRow
              key={r.id}
              reminder={r}
              expanded={expandedId === r.id}
              onToggleExpand={() =>
                setExpandedId((prev) => (prev === r.id ? null : r.id))
              }
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function ReminderRow({
  reminder,
  expanded,
  onToggleExpand,
}: {
  reminder: Reminder
  expanded: boolean
  onToggleExpand: () => void
}) {
  const qc = useQueryClient()

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/reminders/${reminder.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Cancel failed')
      return data
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['call-center-reminders'] }),
    onError: (err) => window.alert((err as Error).message),
  })

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/reminders/${reminder.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Resume failed')
      return data
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['call-center-reminders'] }),
    onError: (err) => window.alert((err as Error).message),
  })

  const sendNowMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/reminders/${reminder.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'send-now' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Send failed')
      return data
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['call-center-reminders'] }),
    onError: (err) => window.alert((err as Error).message),
  })

  const display = reminder.customerName
  const scheduled = new Date(reminder.scheduledFor)
  const sent = reminder.sentAt ? new Date(reminder.sentAt) : null
  const apptDate = new Date(reminder.apptDateTime)

  const canCancel = reminder.status === 'pending'
  // Resume is the symmetric un-pause for paused / mass-on-enable /
  // past-due-but-still-future statuses. Server enforces the "future
  // scheduledFor" gate; we mirror it here so the button hides
  // (instead of showing then 400-ing) when the schedule has passed.
  const futureScheduled = scheduled.getTime() > Date.now()
  const canResume =
    futureScheduled &&
    (reminder.status === 'cancelled' ||
      reminder.status === 'backfilled' ||
      reminder.status === 'skipped')
  const canSendNow =
    reminder.status === 'pending' ||
    reminder.status === 'failed' ||
    reminder.status === 'skipped'

  return (
    <li className="px-5 py-4 transition hover:bg-surface-muted">
      <div className="flex items-center gap-4">
        {/* Customer column */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar name={display} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {display}
              <span className="ml-2 font-normal text-muted-foreground">
                · {reminder.customerPhone}
              </span>
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {reminder.clientName ?? '—'} ·{' '}
              {REMINDER_LABELS[reminder.reminderType as ReminderType] ??
                reminder.reminderType}{' '}
              · appt {formatTime(apptDate, reminder.customerTimezone)}
            </p>
          </div>
        </div>

        {/* Schedule + status */}
        <div className="hidden w-44 flex-shrink-0 sm:block">
          <p className="text-xs font-semibold tabular-nums">
            {formatRel(scheduled)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {scheduled.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </p>
        </div>

        <StatusBadge status={reminder.status} error={reminder.errorMessage} />

        {/* Actions */}
        <div className="flex flex-shrink-0 items-center gap-1">
          {canCancel && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    `Pause this reminder for ${reminder.customerName}? It won't fire. Resume later if you change your mind.`,
                  )
                ) {
                  cancelMutation.mutate()
                }
              }}
              disabled={cancelMutation.isPending}
              title="Pause — cancel this pending reminder so it doesn't fire."
              className="rounded p-1.5 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-950/40"
            >
              <Ban className="h-3.5 w-3.5" />
            </button>
          )}
          {canResume && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    `Resume this reminder for ${reminder.customerName}? It will fire at its scheduled time.`,
                  )
                ) {
                  resumeMutation.mutate()
                }
              }}
              disabled={resumeMutation.isPending}
              title="Resume — flip back to pending. Dispatcher will pick it up at scheduledFor."
              className="rounded p-1.5 text-muted-foreground hover:bg-blue-50 hover:text-blue-600 disabled:opacity-50 dark:hover:bg-blue-950/40"
            >
              {resumeMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {canSendNow && (
            <button
              type="button"
              onClick={() => sendNowMutation.mutate()}
              disabled={sendNowMutation.isPending}
              title="Send now"
              className="rounded p-1.5 text-muted-foreground hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-50 dark:hover:bg-emerald-950/40"
            >
              {sendNowMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : reminder.status === 'failed' ? (
                <RotateCcw className="h-3.5 w-3.5" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onToggleExpand}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted"
            title="Show message body"
          >
            <MessagesSquare className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 grid gap-3 rounded-xl border border-border-soft bg-surface-muted p-3 text-xs sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sent at
            </p>
            <p className="mt-0.5 tabular-nums">
              {sent
                ? sent.toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })
                : '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Customer timezone
            </p>
            <p className="mt-0.5">{reminder.customerTimezone}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Message body
            </p>
            <p className="mt-0.5 whitespace-pre-wrap rounded-md border border-border-soft bg-card p-2 font-mono">
              {reminder.messageBody ||
                '(not yet rendered — body is captured at send time)'}
            </p>
          </div>
          {reminder.errorMessage && (
            <div className="sm:col-span-2">
              <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-rose-600">
                <AlertCircle className="h-3 w-3" />
                Error
              </p>
              <p className="mt-0.5 rounded-md border border-rose-200 bg-rose-50 p-2 text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/40 dark:text-rose-300">
                {reminder.errorMessage}
              </p>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/* -------------------------------------------------------------------------- */

function StatusChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  tone?: 'emerald' | 'blue' | 'rose'
  onClick: () => void
}) {
  const activeTone =
    tone === 'emerald'
      ? 'bg-emerald-600 text-white'
      : tone === 'rose'
        ? 'bg-rose-600 text-white'
        : tone === 'blue'
          ? 'bg-blue-600 text-white'
          : 'bg-zinc-700 text-white'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
        active
          ? `${activeTone} border-transparent shadow-soft`
          : 'border-border bg-card text-foreground/80 hover:bg-muted'
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
          active ? 'bg-white/25 text-white' : 'bg-muted text-muted-foreground'
        )}
      >
        {count}
      </span>
    </button>
  )
}

function StatusBadge({
  status,
  error,
}: {
  status: string
  error: string | null
}) {
  const tone =
    status === 'sent'
      ? 'mint'
      : status === 'pending'
        ? 'blue'
        : status === 'failed'
          ? 'pink'
          : status === 'backfilled'
            ? 'amber'
            : 'muted'
  // Status-specific tooltip when error isn't set, so admin doesn't
  // have to memorize what 'backfilled' means vs 'cancelled'.
  const meaning =
    error ||
    (status === 'backfilled'
      ? 'Pre-existing reminder neutralized when the master Reminders toggle was first flipped on. Won’t fire. Resume from the action button if you want it to.'
      : status === 'cancelled'
        ? 'Manually paused or auto-cancelled when the source row was removed. Won’t fire. Resume from the action button if scheduled time is still in the future.'
        : status === 'skipped'
          ? 'Past-due at sync time — never attempted. Use Send-now to fire it manually if still relevant.'
          : status === 'pending'
            ? 'Queued. Will fire on the dispatcher tick after scheduledFor.'
            : status === 'sent'
              ? 'Successfully delivered.'
              : status === 'failed'
                ? 'Last attempt failed. Use Send-now to retry once the underlying issue is fixed.'
                : undefined)
  return (
    <Chip tone={tone} className="font-semibold">
      <span title={meaning}>{status}</span>
    </Chip>
  )
}

/** Friendly relative time — "in 2h", "in 3d", "5m ago" — alongside
 *  the absolute date in the row. */
function formatRel(d: Date): string {
  const diff = d.getTime() - Date.now()
  const abs = Math.abs(diff)
  const sign = diff < 0 ? -1 : 1
  const min = 60_000
  const hr = 60 * min
  const day = 24 * hr
  if (abs < min) return sign < 0 ? 'just now' : 'now'
  if (abs < hr) return sign < 0 ? `${Math.round(abs / min)}m ago` : `in ${Math.round(abs / min)}m`
  if (abs < day) return sign < 0 ? `${Math.round(abs / hr)}h ago` : `in ${Math.round(abs / hr)}h`
  return sign < 0 ? `${Math.round(abs / day)}d ago` : `in ${Math.round(abs / day)}d`
}

function formatTime(d: Date, timezone: string): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  })
}

function RemindersSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6">
      <div className="h-9 w-full animate-pulse rounded-full bg-muted" />
      <div className="h-64 animate-pulse rounded-2xl border border-border bg-card shadow-soft" />
    </div>
  )
}
