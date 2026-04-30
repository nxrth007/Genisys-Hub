'use client'

import { Suspense, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { Loader2, Phone, PhoneForwarded, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Chip } from '@/components/ui/chip'

/**
 * Call Center → Callbacks tab. Stripped to the mockup: a simple
 * 1–4 column grid of callback cards, no filter bar / search /
 * bucket tabs / stat strip. Date range comes from the shared
 * layout's URL params; defaults to "all pending callbacks" if
 * nothing's set.
 *
 * Each card has the time on top, customer + phone, the reason or
 * notes line, then an action row with the booking agent's avatar +
 * a Call back pill (tel: link) + a Done check.
 */

type Callback = {
  id: string
  customerName: string
  customerPhone: string
  callbackAt: string
  notes: string | null
  reason?: string | null
  outcome?: string | null
  completedAt: string | null
  agent: { id: string; name: string | null; email: string }
}

export default function CallbacksPage() {
  return (
    <Suspense fallback={<CallbacksSkeleton />}>
      <CallbacksGrid />
    </Suspense>
  )
}

function CallbacksGrid() {
  const params = useSearchParams()
  const since = params.get('since')
  const until = params.get('until')

  const qc = useQueryClient()
  const query = useQuery<{ callbacks: Callback[] }>({
    queryKey: ['call-center-callbacks-grid', since, until],
    queryFn: async () => {
      const sp = new URLSearchParams({ bucket: 'pending' })
      if (since) sp.set('since', since)
      if (until) sp.set('until', until)
      const res = await fetch(`/api/call-center/callbacks?${sp.toString()}`)
      if (!res.ok) throw new Error('Failed to load callbacks')
      return res.json()
    },
  })

  // Sort overdue → due-soonest at the top so the most urgent rows
  // sit in the top-left of the grid where the eye lands first.
  const callbacks = useMemo(() => {
    const list = query.data?.callbacks ?? []
    return [...list].sort(
      (a, b) =>
        new Date(a.callbackAt).getTime() - new Date(b.callbackAt).getTime()
    )
  }, [query.data])

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6">
      <section className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-semibold tracking-tight">
            Callbacks scheduled
          </h2>
          <Chip tone="blue">
            {callbacks.length} pending
          </Chip>
        </div>

        {query.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : query.isError ? (
          <p className="py-12 text-center text-sm text-destructive">
            Couldn&apos;t load callbacks. Try refreshing.
          </p>
        ) : callbacks.length === 0 ? (
          <div className="py-12 text-center">
            <PhoneForwarded className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">
              No pending callbacks in this window.
            </p>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {callbacks.map((c) => (
              <CallbackCard key={c.id} cb={c} qc={qc} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function CallbackCard({
  cb,
  qc,
}: {
  cb: Callback
  qc: ReturnType<typeof useQueryClient>
}) {
  const [busy, setBusy] = useState<'done' | null>(null)
  const due = new Date(cb.callbackAt)
  const isOverdue = !isNaN(due.getTime()) && due.getTime() < Date.now()
  const display = cb.agent.name || cb.agent.email
  const phoneDigits = cb.customerPhone.replace(/\D/g, '')
  const reasonText = cb.reason || cb.notes || 'No reason logged'

  const completeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/call-center/callbacks/${cb.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      })
      if (!res.ok) throw new Error('Failed to mark done')
    },
    onMutate: async () => {
      setBusy('done')
      await qc.cancelQueries({ queryKey: ['call-center-callbacks-grid'] })
      const previous = qc.getQueriesData<{ callbacks: Callback[] }>({
        queryKey: ['call-center-callbacks-grid'],
      })
      // Optimistic remove from the active grid (it'll re-fetch the
      // canonical list on success too — the optimistic step just
      // makes the UI feel instant).
      for (const [key, data] of previous) {
        if (data) {
          qc.setQueryData(key, {
            ...data,
            callbacks: data.callbacks.filter((x) => x.id !== cb.id),
          })
        }
      }
      // Also drop from the Today follow-ups drawer so the count
      // reconciles without a manual refresh.
      qc.invalidateQueries({ queryKey: ['today-followups'] })
      return { previous }
    },
    onError: (_err, _v, ctx) => {
      setBusy(null)
      if (ctx?.previous) {
        for (const [key, data] of ctx.previous) qc.setQueryData(key, data)
      }
    },
    onSuccess: () => {
      setBusy(null)
      qc.invalidateQueries({ queryKey: ['call-center-callbacks-grid'] })
    },
  })

  return (
    <article
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4 shadow-soft transition',
        isOverdue
          ? 'border-rose-200 bg-rose-50/40 dark:border-rose-900/40 dark:bg-rose-950/20'
          : 'border-border-soft bg-surface-muted hover:bg-muted'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={cn(
            'text-xs font-semibold',
            isOverdue ? 'text-rose-600' : 'text-muted-foreground'
          )}
        >
          {isOverdue ? 'Overdue · ' : ''}
          {formatCallbackTime(due)}
        </p>
      </div>

      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{cb.customerName}</p>
        <p className="truncate text-xs text-muted-foreground">
          {cb.customerPhone}
        </p>
      </div>

      <p className="text-xs text-foreground/80 line-clamp-2 min-h-[2.4em]">
        {reasonText}
      </p>

      <div className="mt-1 flex items-center justify-between gap-2 border-t border-border-soft pt-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <Avatar name={display} email={cb.agent.email} size="xs" />
          <p className="truncate text-[10px] text-muted-foreground">
            {display}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => completeMutation.mutate()}
            disabled={busy === 'done'}
            title="Mark done"
            aria-label="Mark callback done"
            className="grid h-7 w-7 place-items-center rounded-full border border-border bg-card text-muted-foreground transition hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200 disabled:opacity-50 dark:hover:bg-emerald-950/40 dark:hover:border-emerald-900/40"
          >
            {busy === 'done' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
          </button>
          <a
            href={`tel:${phoneDigits}`}
            className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <Phone className="h-3 w-3" />
            Call back
          </a>
        </div>
      </div>
    </article>
  )
}

/* ---- Helpers ----------------------------------------------------------- */

/** Compact timestamp — same day shows just time, otherwise short
 *  date + time. Keeps the card tight while still telegraphing how
 *  far out the callback is. */
function formatCallbackTime(d: Date): string {
  if (isNaN(d.getTime())) return '—'
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  }
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

// Suppress unused-X warning — `X` is imported only to keep the
// optional close-button affordance available if we later add a
// "dismiss" gesture per row, matching the mockup's X icon.
void X

/** SSR-safe placeholder shown while Suspense resolves the
 *  useSearchParams hook in CallbacksGrid. */
function CallbacksSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="h-6 w-48 animate-pulse rounded-md bg-muted" />
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-[180px] animate-pulse rounded-xl border border-border-soft bg-surface-muted"
          />
        ))}
      </div>
    </div>
  )
}
