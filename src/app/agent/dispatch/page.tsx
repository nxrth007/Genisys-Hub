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
    'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  dispatched: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  confirmed: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  reschedule_requested:
    'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  needs_review: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
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
          <Send className="h-5 w-5 text-blue-600" />
          Dispatch
          {dispatched.length > 0 && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-sm font-semibold tabular-nums text-blue-700 dark:bg-blue-950 dark:text-blue-300">
              {dispatched.length}
            </span>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">
          Appointments set to{' '}
          <span className="font-semibold">Dispatched</span> — in progress, not
          yet confirmed. Move one to{' '}
          <span className="font-semibold text-green-700 dark:text-green-300">
            Confirmed
          </span>{' '}
          to fire the client details + customer reminders.
        </p>
      </header>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
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
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          <Inbox className="mx-auto mb-2 h-6 w-6 text-zinc-400" />
          Nothing is dispatched right now. Rows you mark{' '}
          <span className="font-medium">Dispatched</span> on the Master Tracker
          show up here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-xs">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/50">
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
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {dispatched.map((a) => {
                const match = a.id.match(/^sheet:(\d+)$/)
                const rowNumber = match ? Number(match[1]) : null
                const pending =
                  mutation.isPending &&
                  mutation.variables?.rowNumber === rowNumber
                return (
                  <tr
                    key={a.id}
                    className="bg-white transition hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-950/40"
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
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-medium">
                      {a.customerName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                      {a.customerPhone}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-zinc-500">
                      {a.county || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-500 capitalize">
                      {a.status.replace(/_/g, ' ')}
                    </td>
                    <td className="px-3 py-2.5">
                      {rowNumber === null ? (
                        <span className="text-[10px] text-zinc-400">
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
                              'appearance-none cursor-pointer rounded-full pl-2 pr-5 py-0.5 text-[10px] font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400/60',
                              DISPATCH_TONE[a.dispatchStatus] ||
                                'bg-zinc-100 text-zinc-700',
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
