'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PhoneCall,
  CheckCircle2,
  Circle,
  Clock,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Top-of-dashboard panel that surfaces callbacks the agent needs to make:
 * anything overdue, plus anything scheduled for today. Hidden when the
 * bucket is empty so the dashboard stays clean when there's nothing due.
 */

type Callback = {
  id: string
  customerName: string
  customerPhone: string
  callbackAt: string
  notes: string | null
  completedAt: string | null
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function CallbacksDuePanel() {
  const qc = useQueryClient()
  const query = useQuery<{ callbacks: Callback[] }>({
    queryKey: ['agent-callbacks'],
    queryFn: async () => {
      const res = await fetch('/api/agent/callbacks')
      if (!res.ok) throw new Error('Failed to load callbacks')
      return res.json()
    },
  })

  const { overdue, dueToday } = useMemo(() => {
    const callbacks = query.data?.callbacks ?? []
    const now = new Date()
    const overdueList: Callback[] = []
    const dueList: Callback[] = []
    for (const c of callbacks) {
      if (c.completedAt) continue
      const when = new Date(c.callbackAt)
      if (when < now) overdueList.push(c)
      else if (isSameDay(when, now)) dueList.push(c)
    }
    // Soonest first within each bucket.
    overdueList.sort(
      (a, b) => new Date(a.callbackAt).getTime() - new Date(b.callbackAt).getTime()
    )
    dueList.sort(
      (a, b) => new Date(a.callbackAt).getTime() - new Date(b.callbackAt).getTime()
    )
    return { overdue: overdueList, dueToday: dueList }
  }, [query.data])

  const toggleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/agent/callbacks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      })
      if (!res.ok) throw new Error('Failed to update')
      return res.json()
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['agent-callbacks'] }),
  })

  // Render nothing when there's no action to take — keeps the dashboard clean.
  if (overdue.length === 0 && dueToday.length === 0) return null

  const rows = [...overdue, ...dueToday]

  return (
    <section
      className={cn(
        'rounded-xl border p-4',
        overdue.length > 0
          ? 'border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20'
          : 'border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20'
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PhoneCall
            className={cn(
              'h-4 w-4',
              overdue.length > 0 ? 'text-red-600' : 'text-blue-600'
            )}
          />
          <h3 className="text-sm font-semibold">
            Callbacks{' '}
            {overdue.length > 0 ? (
              <span className="text-red-600">
                ({overdue.length} overdue
                {dueToday.length > 0 ? `, ${dueToday.length} due today` : ''})
              </span>
            ) : (
              <span className="text-blue-600">({dueToday.length} due today)</span>
            )}
          </h3>
        </div>
        <Link
          href="/agent/callbacks"
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
        >
          View all
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
        {rows.slice(0, 5).map((c) => {
          const when = new Date(c.callbackAt)
          const isOverdue = when < new Date()
          return (
            <div key={c.id} className="flex items-center gap-3 py-2">
              <button
                onClick={() => toggleMutation.mutate(c.id)}
                title="Mark as done"
                className="flex-shrink-0 rounded-full transition-transform hover:scale-110"
              >
                <Circle
                  className={cn(
                    'h-5 w-5',
                    isOverdue
                      ? 'text-red-400 hover:text-red-600'
                      : 'text-blue-400 hover:text-blue-600'
                  )}
                />
              </button>
              <Link
                href={`/agent/callbacks/${c.id}`}
                className="min-w-0 flex-1"
              >
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{c.customerName}</p>
                  {isOverdue ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      Overdue
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                      <Clock className="h-2.5 w-2.5" />
                      {when.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                      })}
                    </span>
                  )}
                </div>
                <p className="truncate font-mono text-[11px] text-zinc-500">
                  {c.customerPhone}
                  {c.notes && ` · ${c.notes}`}
                </p>
              </Link>
              <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-transparent" />
            </div>
          )
        })}
      </div>

      {rows.length > 5 && (
        <p className="mt-2 text-center text-[11px] text-zinc-500">
          +{rows.length - 5} more on the{' '}
          <Link href="/agent/callbacks" className="underline">
            callbacks page
          </Link>
        </p>
      )}
    </section>
  )
}
