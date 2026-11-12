'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronRight, Clock, ImageIcon, Loader2, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CustomizeView } from '@/lib/ghl-customize/queue'

type QueueAnswer = { result: { ok: boolean; status: string; reason?: string }; view: CustomizeView | null }

const WORKFLOWS: { id: string; name: string }[] = [
  { id: 'missed-call', name: 'Auto Missed Call Text-Back' },
  { id: 'chat-widget', name: 'Website Chat Widget Form Submitted' },
  { id: 'quote-form', name: 'Website Quote Form Submitted' },
]

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''

/**
 * The Hub runs these prompts in GHL itself: Workflow AI edits each workflow,
 * the Hub checks every changed step against this copy, and only an exact
 * match is saved. Shows where that stands and lets staff start it now.
 */
export function CustomizePanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient()
  const key = ['automation-copy-customize', clientId]
  const q = useQuery({
    queryKey: key,
    queryFn: async (): Promise<CustomizeView> => {
      const res = await fetch(`/api/automation-copy/${clientId}/customize`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Couldn’t load it')
      return data
    },
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const s = query.state.data?.job?.status
      return s === 'queued' || s === 'running' ? 10_000 : false
    },
  })
  const [showLog, setShowLog] = useState(false)
  const run = useMutation({
    mutationFn: async (): Promise<QueueAnswer> => {
      const res = await fetch(`/api/automation-copy/${clientId}/customize`, { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as QueueAnswer & { error?: string }
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
  const busy = job?.status === 'queued' || (job?.status === 'running' && !job.stale)
  const answer = run.data?.result

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold">
            <Sparkles className="h-4 w-4 text-violet-500" /> Put it into GHL for me
          </h2>
          <p className="text-[12px] text-muted-foreground">
            The Hub opens each Incoming Lead workflow in the client’s sub-account, pastes the prompt into Workflow AI, checks every step it changed
            against this copy, and saves only an exact match. About a minute per workflow.
          </p>
        </div>
        <button
          type="button"
          onClick={() => run.mutate()}
          disabled={run.isPending || busy || !v?.client.locationId}
          title={!v?.client.locationId ? 'Link the client’s GHL sub-account first' : undefined}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {job?.status === 'succeeded' ? 'Run it again' : 'Customize in GHL now'}
        </button>
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
          {answer && !answer.ok && answer.status !== 'held' && <p className="text-[12px] text-amber-600 dark:text-amber-300">{answer.reason}</p>}
          {job && Object.keys(job.progress).length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {WORKFLOWS.map((w) => {
                const p = job.progress[w.id]
                return (
                  <li key={w.id} className="flex items-start gap-2 text-[12.5px]">
                    <StepIcon status={p?.status} />
                    <span className="min-w-0">
                      <span className="font-medium">{w.name}</span>
                      {p?.note && <span className="text-muted-foreground"> — {p.note}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            {v.auto ? (
              v.client.madeByHub ? (
                <>Runs by itself when the site link is added on the Clients page, and again if that link changes.</>
              ) : (
                <>This sub-account wasn’t created by the Hub, so it only runs when you press the button.</>
              )
            ) : (
              <>
                Automatic runs are off (
                <Link href="/settings#ghl-subaccounts" className="underline hover:text-foreground">
                  Settings → GHL sub-accounts
                </Link>
                ). The button still works.
              </>
            )}
            {v.mode !== 'create' && ' The worker is in dry-run mode, so nothing is saved.'}
          </p>
          {job && (
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
                          href={`/api/automation-copy/${clientId}/customize/shots/${s.id}`}
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

function Status({ view }: { view: CustomizeView }) {
  const job = view.job
  const box = 'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-snug'
  if (!view.client.locationId) {
    return <p className={cn(box, 'border-border bg-surface text-muted-foreground')}>No GHL sub-account is linked to this client yet.</p>
  }
  if (!job) {
    return <p className={cn(box, 'border-border bg-surface text-muted-foreground')}>Not run yet.</p>
  }
  if (job.status === 'running') {
    return (
      <p className={cn(box, job.stale ? 'border-amber-500/30 bg-amber-500/10' : 'border-violet-500/30 bg-violet-500/10')}>
        {job.stale ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /> : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-violet-500" />}
        {job.stale ? 'The last run stopped answering. It goes back on the queue within a few minutes.' : 'Running in GHL now: Workflow AI is editing the workflows.'}
      </p>
    )
  }
  if (job.status === 'queued') {
    return (
      <p className={cn(box, 'border-border bg-surface')}>
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        {new Date(job.nextAttemptAt).getTime() > Date.now() + 60_000
          ? `Queued to try again at ${when(job.nextAttemptAt)}.${job.detail ? ` ${job.detail}` : ''}`
          : 'Queued. The worker picks it up within a few minutes (a new sub-account being created goes first).'}
      </p>
    )
  }
  if (job.status === 'succeeded') {
    return (
      <p className={cn(box, 'border-emerald-500/30 bg-emerald-500/10')}>
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <span>
          Done {when(job.finishedAt)}. {job.detail}
        </span>
      </p>
    )
  }
  if (job.status === 'dry_run') {
    return <p className={cn(box, 'border-border bg-surface')}>{job.detail}</p>
  }
  return (
    <p className={cn(box, 'border-amber-500/30 bg-amber-500/10')}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <span>
        {job.status === 'held' ? '' : job.status === 'failed' ? 'Failed. ' : 'Needs you. '}
        {job.detail}
      </span>
    </p>
  )
}

function StepIcon({ status }: { status?: string }) {
  if (status === 'done' || status === 'already') return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
  if (status === 'needs_human' || status === 'error') return <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
  return <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
}
