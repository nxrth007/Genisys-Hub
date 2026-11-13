'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronRight, Clock, ImageIcon, Loader2, Phone, ShoppingCart } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NumberView } from '@/lib/ghl-number/queue'

type View = NumberView & { canBuy: boolean }
type Answer = { result: { ok: boolean; status?: string; reason?: string }; view: View | null }

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''

/** "+18554656514" → "(855) 465-6514". */
function pretty(n: string | null | undefined): string {
  const d = (n ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n ?? '')
}

/**
 * The client's toll-free number: Atlas asks in the Office, and on a Yes the
 * worker buys one in the number bank (Lead Genisys) and moves it into this
 * client's sub-account with GHL's Move Numbers, then points its calls at the
 * client's phone.
 */
export function NumberPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient()
  const key = ['client-ghl-number', clientId]
  const q = useQuery({
    queryKey: key,
    queryFn: async (): Promise<View> => {
      const res = await fetch(`/api/clients/${clientId}/ghl-number`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Couldn’t load it')
      return data
    },
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const s = query.state.data?.job?.status
      return s === 'queued' || s === 'running' || s === 'awaiting_approval' ? 10_000 : false
    },
  })
  const [showLog, setShowLog] = useState(false)
  const act = useMutation({
    mutationFn: async (action: 'ask' | 'buy'): Promise<Answer> => {
      const res = await fetch(`/api/clients/${clientId}/ghl-number`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = (await res.json().catch(() => ({}))) as Answer & { error?: string }
      if (!data.result) throw new Error(data.error || 'No answer from the Hub.')
      return data
    },
    onSuccess: (data) => {
      if (data.view) qc.setQueryData(key, data.view)
      else qc.invalidateQueries({ queryKey: key })
    },
  })

  const v = q.data
  const job = v?.job ?? null
  const inHand = job?.status === 'awaiting_approval' || job?.status === 'queued' || (job?.status === 'running' && !job.stale)
  const has = job?.status === 'succeeded'
  const noSub = !!v && !v.client.locationId
  const answer = act.data?.result

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold">
            <Phone className="h-4 w-4 text-emerald-500" /> Toll-free number
          </h2>
          <p className="text-[12px] text-muted-foreground">
            Bought in Lead Genisys (it has done GHL’s one-time ID check), then moved into this client’s sub-account with GHL’s Move Numbers. About
            $2.15/month. Atlas asks in the{' '}
            <Link href="/office" className="underline hover:text-foreground">
              Office
            </Link>{' '}
            first; nothing is bought without a Yes.
          </p>
        </div>
        {!has && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => act.mutate('ask')}
              disabled={act.isPending || inHand || noSub || !v}
              title={noSub ? 'Link the client’s GHL sub-account first' : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium transition hover:bg-muted disabled:opacity-50"
            >
              {act.isPending && act.variables === 'ask' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Ask in the Office
            </button>
            {v?.canBuy && (
              <button
                type="button"
                onClick={() => {
                  const j = v.job
                  const unfinished = !!j?.pickedNumber && !!j.buyStartedAt && !j.phoneNumber
                  const ask = unfinished
                    ? `An earlier run pressed Buy for ${pretty(j?.pickedNumber)} and it didn’t show up in Lead Genisys.\n\nCheck Lead Genisys’s numbers and GHL billing first. If it wasn’t bought, OK buys a new toll-free number (about $2.15/month) for ${v.client.name} and moves it to their sub-account. If it does turn up in Lead Genisys, the Hub uses it instead.`
                    : `Buy a toll-free number (about $2.15/month) for ${v.client.name} now and move it to their sub-account?`
                  if (window.confirm(ask)) act.mutate('buy')
                }}
                disabled={act.isPending || inHand || noSub}
                className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
              >
                {act.isPending && act.variables === 'buy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShoppingCart className="h-3.5 w-3.5" />}
                Buy and move now
              </button>
            )}
          </div>
        )}
      </div>

      {q.isLoading ? (
        <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
        </p>
      ) : q.error ? (
        <p className="text-[12.5px] text-destructive">{(q.error as Error).message}</p>
      ) : v ? (
        <>
          <Status view={v} />
          {answer && !answer.ok && <p className="text-[12px] text-amber-600 dark:text-amber-300">{answer.reason}</p>}
          {act.error && <p className="text-[12px] text-destructive">{(act.error as Error).message}</p>}
          <p className="text-[11.5px] text-muted-foreground">
            {v.ask ? (
              <>Atlas asks by itself when the Hub finishes a new sub-account.</>
            ) : (
              <>
                Asking for new sub-accounts is off (
                <Link href="/settings#ghl-subaccounts" className="underline hover:text-foreground">
                  Settings → GHL sub-accounts
                </Link>
                ). The buttons still work.
              </>
            )}
            {!v.workerOn && ' The GHL browser worker is switched off, so nothing runs until it’s back on.'}
            {v.mode !== 'create' && ' The worker is in dry-run mode, so nothing is bought.'}
          </p>
          {job && job.log.length > 0 && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowLog((s) => !s)}
                className="inline-flex w-fit items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
              >
                <ChevronRight className={cn('h-3.5 w-3.5 transition', showLog && 'rotate-90')} /> {showLog ? 'Hide' : 'Show'} what the worker did
              </button>
              {showLog && (
                <div className="flex flex-col gap-2">
                  {job.shots.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {job.shots.map((s) => (
                        <a
                          key={s.id}
                          href={`/api/clients/${clientId}/ghl-number/shots/${s.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[10.5px] text-muted-foreground hover:text-foreground"
                        >
                          <ImageIcon className="h-3 w-3" /> {s.step}
                        </a>
                      ))}
                    </div>
                  )}
                  <ol className="max-h-80 overflow-auto rounded-lg border border-border-soft bg-surface p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {job.log
                      .slice()
                      .reverse()
                      .map((entry, i) => {
                        const e = entry as { at?: string; msg?: string }
                        return (
                          <li key={i} className="whitespace-pre-wrap break-words border-b border-border-soft/60 py-1 last:border-0">
                            <span className="text-foreground/60">{when(e.at)}</span> {e.msg}
                          </li>
                        )
                      })}
                  </ol>
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}

function Status({ view }: { view: View }) {
  const job = view.job
  const box = 'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-snug'
  if (!view.client.locationId) {
    return <p className={cn(box, 'border-border bg-surface text-muted-foreground')}>No GHL sub-account is linked to this client yet.</p>
  }
  if (!job) {
    return <p className={cn(box, 'border-border bg-surface text-muted-foreground')}>No number yet, and nothing asked.</p>
  }
  if (job.status === 'awaiting_approval') {
    return (
      <p className={cn(box, 'border-emerald-500/30 bg-emerald-500/10')}>
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <span>
          Waiting for a Yes in the{' '}
          <Link href="/office" className="font-medium underline">
            Office
          </Link>
          {job.locationName ? <> to buy one for the sub-account “{job.locationName}”</> : null} (asked {when(job.updatedAt)}).
        </span>
      </p>
    )
  }
  if (job.status === 'running') {
    return (
      <p className={cn(box, job.stale ? 'border-amber-500/30 bg-amber-500/10' : 'border-emerald-500/30 bg-emerald-500/10')}>
        {job.stale ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /> : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-emerald-500" />}
        {job.stale
          ? 'The last run stopped answering. It goes back on the queue within a few minutes.'
          : job.phoneNumber
            ? `Bought ${pretty(job.phoneNumber)}. Moving it to the client’s sub-account now.`
            : 'Running in GHL now: buying the number in Lead Genisys.'}
      </p>
    )
  }
  if (job.status === 'queued') {
    return (
      <p className={cn(box, 'border-border bg-surface')}>
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        {new Date(job.nextAttemptAt).getTime() > Date.now() + 60_000
          ? `Approved. Queued to try again at ${when(job.nextAttemptAt)}.${job.detail ? ` ${job.detail}` : ''}`
          : 'Approved. The worker picks it up within a few minutes (a new sub-account being created goes first).'}
      </p>
    )
  }
  if (job.status === 'succeeded') {
    return (
      <p className={cn(box, 'border-emerald-500/30 bg-emerald-500/10')}>
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <span>
          {job.phoneNumber ? (
            <>
              <span className="font-semibold">{pretty(job.phoneNumber)}</span> is in the client’s sub-account
              {job.forwardsTo ? <> and rings {pretty(job.forwardsTo)}</> : null}. {when(job.finishedAt)}.
            </>
          ) : (
            <>Done {when(job.finishedAt)}. {job.detail}</>
          )}
        </span>
      </p>
    )
  }
  if (job.status === 'declined') {
    return <p className={cn(box, 'border-border bg-surface text-muted-foreground')}>{job.detail || 'Declined in the Office.'} Ask again any time.</p>
  }
  if (job.status === 'dry_run') {
    return <p className={cn(box, 'border-border bg-surface')}>{job.detail}</p>
  }
  return (
    <p className={cn(box, 'border-amber-500/30 bg-amber-500/10')}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <span>
        {job.status === 'failed' ? 'Failed. ' : 'Needs you. '}
        {job.detail}
      </span>
    </p>
  )
}
