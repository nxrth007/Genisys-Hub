'use client'

import { useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Send, Loader2, Inbox, ChevronDown, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * /agent/dispatch — focused worklist of every appointment currently in
 * the "Dispatched" stage (dispatchStatus === 'dispatched'): dispatched
 * but not yet Confirmed. Agents work this list and advance a row to
 * "Confirmed" right from the dropdown — which is what fires the client
 * details + the four same-day customer reminders.
 *
 * Reads the same master-tracker feed as the agent Master Tracker tab
 * (?view=agent → partner rows filtered out), sharing its React Query
 * cache so the two stay in sync.
 */

type DispatchRow = {
  id: string
  apptDateTime: string
  resolvedTimezone: string
  customerName: string
  customerPhone: string
  address: string | null
  county: string | null
  status: string
  dispatchStatus: string
  client: { name: string; color: string; contactName: string | null } | null
}

const DISPATCH_STATUSES = [
  { value: 'not_dispatched', label: 'Not Dispatched' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'reschedule_requested', label: 'Reschedule Requested' },
  { value: 'needs_review', label: 'Needs Review' },
]

const DISPATCH_TONE: Record<string, string> = {
  not_dispatched:
    'bg-muted text-muted-foreground bg-surface-muted text-muted-foreground',
  dispatched: 'bg-primary-soft text-primary bg-primary-soft text-primary',
  confirmed: 'bg-success/15 text-success bg-success/15 text-success',
  reschedule_requested:
    'bg-warning/15 text-warning bg-warning/15 text-warning',
  needs_review: 'bg-destructive/10 text-destructive bg-destructive/10 text-destructive',
}

function fmtDateTime(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: tz || undefined,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return iso
  }
}

export default function AgentDispatchPage() {
  const queryClient = useQueryClient()

  // Same key + URL the agent Master Tracker uses (view=agent → isStaffView
  // false), so the two share one cache and one fetch.
  const { data, isLoading, isError, error } = useQuery<{
    appointments: DispatchRow[]
  }>({
    queryKey: ['master-tracker-sheet', false],
    queryFn: async () => {
      const res = await fetch('/api/call-center/master-tracker?view=agent')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load dispatch list')
      }
      return res.json()
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const dispatched = useMemo(
    () =>
      (data?.appointments ?? []).filter(
        (a) => a.dispatchStatus === 'dispatched',
      ),
    [data],
  )

  const mutation = useMutation({
    mutationFn: async (vars: { rowNumber: number; dispatchStatus: string }) => {
      const res = await fetch('/api/call-center/dispatch-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok)
        throw new Error(d.error || 'Failed to update dispatch status')
      return d
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['master-tracker-sheet'] }),
    onError: (err) =>
      window.alert(`Couldn't update dispatch status: ${(err as Error).message}`),
  })

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Send className="h-5 w-5 text-primary" />
          Dispatch
          {dispatched.length > 0 && (
            <span className="rounded-lg bg-primary-soft px-2 py-0.5 text-sm font-semibold tabular-nums text-primary bg-primary-soft text-primary">
              {dispatched.length}
            </span>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">
          Appointments set to{' '}
          <span className="font-semibold">Dispatched</span> — in progress, not
          yet confirmed. Move one to{' '}
          <span className="font-semibold text-success">
            Confirmed
          </span>{' '}
          to fire the client details + customer reminders.
        </p>
      </header>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error instanceof Error ? error.message : 'Failed to load'}
        </div>
      )}

      {isLoading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : dispatched.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-muted p-8 text-center text-sm text-muted-foreground border-border bg-card text-muted-foreground">
          <Inbox className="mx-auto mb-2 h-6 w-6 text-muted-foreground/70" />
          Nothing is dispatched right now. Rows you mark{' '}
          <span className="font-medium">Dispatched</span> on the Master Tracker
          show up here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-surface-muted text-left eyebrow text-muted-foreground border-border bg-background/50">
              <tr>
                <th className="px-3 py-2.5">Appt</th>
                <th className="px-3 py-2.5">Client</th>
                <th className="px-3 py-2.5">Customer</th>
                <th className="px-3 py-2.5">Phone</th>
                <th className="px-3 py-2.5">County</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Dispatch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {dispatched.map((a) => {
                const match = a.id.match(/^sheet:(\d+)$/)
                const rowNumber = match ? Number(match[1]) : null
                const pending =
                  mutation.isPending &&
                  mutation.variables?.rowNumber === rowNumber
                return (
                  <tr
                    key={a.id}
                    className="bg-card transition hover:bg-muted bg-card dark:hover:bg-zinc-950/40"
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 font-medium">
                      {fmtDateTime(a.apptDateTime, a.resolvedTimezone)}
                    </td>
                    <td className="px-3 py-2.5">
                      {a.client ? (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <span
                            className="h-2 w-2 flex-shrink-0 rounded-full"
                            style={{ backgroundColor: a.client.color }}
                            aria-hidden
                          />
                          <span className="font-medium">{a.client.name}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground/70">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-medium">
                      {a.customerName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-muted-foreground text-foreground/85">
                      {a.customerPhone}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                      {a.county || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground capitalize">
                      {a.status.replace(/_/g, ' ')}
                    </td>
                    <td className="px-3 py-2.5">
                      {rowNumber === null ? (
                        <span className="text-[10px] text-muted-foreground/70">
                          sheet-only
                        </span>
                      ) : (
                        <div className="relative inline-block">
                          <select
                            value={a.dispatchStatus}
                            disabled={pending}
                            onChange={(e) =>
                              mutation.mutate({
                                rowNumber,
                                dispatchStatus: e.target.value,
                              })
                            }
                            className={cn(
                              'appearance-none cursor-pointer rounded-md pl-2 pr-5 py-0.5 text-[10px] font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400/60',
                              DISPATCH_TONE[a.dispatchStatus] ||
                                'bg-muted text-foreground/85',
                              pending && 'opacity-60',
                            )}
                          >
                            {DISPATCH_STATUSES.map((s) => (
                              <option key={s.value} value={s.value}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 opacity-60" />
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
