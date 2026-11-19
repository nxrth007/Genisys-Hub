'use client'

/**
 * Client tracker: every onboarding step for every client, read from what the
 * Hub knows (src/lib/tracker/derive.ts): Stripe, the onboarding form, Genisys
 * OS, Forge's site build, numbers, texting registration, automations, the
 * Google profile board and the SEO engine. Nothing here is ticked by hand
 * except the five sheet-era steps, and a hand mark shows as one. Staff only.
 *
 * Click any cell to open the client's row: every step with its evidence, its
 * date and a link to where to act. "Status link" copies the client's read-only
 * status page to the clipboard; nothing is sent to the client.
 */
import { Fragment, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { cn } from '@/lib/utils'
import { shortDate } from '@/lib/stripe-billing-plan'
import {
  CORE_STEPS,
  STATE_WORD,
  STEP_MEANS,
  STEP_TITLE,
  STUCK_AFTER_DAYS,
  TRACK_STEPS,
  isManualStep,
  type StepState,
  type StepView,
  type TrackStep,
  type TrackerRow,
  type TrackerSummary,
} from '@/lib/tracker/derive'

type ListResponse = {
  rows: TrackerRow[]
  summary: TrackerSummary
  billing: { asOf: string | null; error: string | null; account: { id: string | null; name: string | null } | null }
  asOf: string
  sheetSync: { enabled: boolean; last: { at: string; counts: Record<string, number>; error: string | null } | null }
}
type SyncResponse = { dryRun: boolean; counts: Record<string, number>; missingHeaders: string[]; error: string | null; ops: { kind: string; sheetRow: number; label?: string; reason?: string }[] }
type Show = 'all' | 'working' | 'stuck' | 'blocked' | 'complete'

const GLYPH: Record<StepState, string> = { done: '✓', in_progress: '◐', blocked: '✕', pending: '○', not_needed: '–', none: '·' }
const MARK: Record<StepState, string> = {
  done: 'chip-mint',
  in_progress: 'chip-blue',
  blocked: 'chip-pink',
  pending: 'bg-muted text-muted-foreground',
  not_needed: 'bg-muted text-muted-foreground/70',
  none: 'border border-dashed border-border text-muted-foreground/60',
}
const TONE: Record<string, string> = { mint: 'chip-mint', blue: 'chip-blue', amber: 'chip-amber', pink: 'chip-pink', muted: 'bg-muted text-muted-foreground' }

const when = (iso: string | null | undefined) => (iso ? shortDate(iso) : null)

function StepMark({ view, active, onClick }: { view: StepView; active: boolean; onClick: () => void }) {
  const title = `${STATE_WORD[view.state]}${view.byHand ? ' (by hand)' : ''}${view.note ? ` — ${view.note}` : ''}${view.at ? ` · ${when(view.at)}` : ''}`
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-md px-1 font-mono text-[12px] leading-none transition hover:ring-1 hover:ring-primary/50',
        MARK[view.state],
        active && 'ring-1 ring-primary',
      )}
    >
      {GLYPH[view.state]}
      {view.byHand && <span className="text-[9px]" aria-label="by hand">✎</span>}
    </button>
  )
}

function Href({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = 'inline-flex items-center gap-1 text-xs text-primary hover:underline'
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {children}
        <ExternalLink className="h-3 w-3" />
      </a>
    )
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  )
}

export default function TrackerPage() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [stage, setStage] = useState<TrackStep | ''>('')
  const [step, setStep] = useState<TrackStep | ''>('')
  const [state, setState] = useState<StepState>('pending')
  const [archived, setArchived] = useState(false)
  const [open, setOpen] = useState<{ clientId: string; step: TrackStep | null } | null>(null)
  const [sync, setSync] = useState<SyncResponse | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (show !== 'all') params.set('show', show)
  if (stage) params.set('stage', stage)
  if (step) {
    params.set('step', step)
    params.set('state', state)
  }
  if (archived) params.set('archived', '1')
  const key = params.toString()

  const list = useQuery<ListResponse>({
    queryKey: ['tracker', key],
    queryFn: async () => {
      const r = await fetch(`/api/tracker?${key}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    },
    staleTime: 30_000,
  })

  const refresh = useMutation({
    mutationFn: async (): Promise<ListResponse> => {
      const r = await fetch(`/api/tracker?${key}${key ? '&' : ''}refresh=1`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    },
    onSuccess: (data) => {
      qc.setQueryData(['tracker', key], data)
      qc.invalidateQueries({ queryKey: ['tracker'] })
    },
    onError: (e) => setMsg(String(e instanceof Error ? e.message : e)),
  })

  const mark = useMutation({
    mutationFn: async (v: { clientId: string; step: TrackStep; status: 'done' | 'pending'; note?: string | null }) => {
      const r = await fetch('/api/tracker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tracker'] }),
    onError: (e) => setMsg(String(e instanceof Error ? e.message : e)),
  })

  const runSync = useMutation({
    mutationFn: async (dryRun: boolean): Promise<SyncResponse> => {
      const r = await fetch('/api/tracker/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun }) })
      return r.json()
    },
    onSuccess: (s) => {
      setSync(s)
      qc.invalidateQueries({ queryKey: ['tracker'] })
    },
  })

  async function copyLink(clientId: string) {
    const r = await fetch(`/api/tracker/${clientId}/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.path) return setMsg(j?.error ?? `Could not create link (HTTP ${r.status})`)
    const url = `${window.location.origin}${j.path}`
    await navigator.clipboard.writeText(url).catch(() => {})
    setMsg(`Status link copied (not sent): ${url}`)
  }

  const rows = list.data?.rows ?? []
  const summary = list.data?.summary
  const billing = list.data?.billing
  const pct = summary && summary.roster ? Math.round((summary.complete / summary.roster) * 100) : 0

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Client tracker"
        subtitle="Every onboarding step, read from what the Hub knows. Click a cell to see the evidence and where to act."
        breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: 'Tracker' }]}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm transition hover:bg-muted disabled:opacity-50"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
              title="Re-read Stripe and every board now"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />
              Refresh
            </button>
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-md border border-border bg-card px-3 py-1.5 text-sm transition hover:bg-muted">Sheet import</summary>
              <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-border bg-popover p-3 text-sm shadow-pop">
                <p className="text-xs text-muted-foreground">Ethan’s onboarding sheet still counts for the five hand-marked steps. Importing copies its ✅ cells into the Hub; the sheet is never changed.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="rounded-md border border-border px-2.5 py-1 text-xs transition hover:bg-muted disabled:opacity-50" disabled={runSync.isPending} onClick={() => runSync.mutate(true)}>
                    Preview
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2.5 py-1 text-xs transition hover:bg-muted disabled:opacity-50"
                    disabled={runSync.isPending}
                    onClick={() => confirm('Copy ✅ steps from the Google Sheet into the Hub? The sheet is not changed.') && runSync.mutate(false)}
                  >
                    Import now
                  </button>
                </div>
                {list.data?.sheetSync.last && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Last import {new Date(list.data.sheetSync.last.at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET{list.data.sheetSync.enabled ? ' (auto)' : ''}
                  </p>
                )}
              </div>
            </details>
          </div>
        }
      />

      {/* ---- The numbers ---- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="On the roster" value={summary?.roster ?? '—'} subtitle="not archived, churned or denied" />
        <StatCard label="Fully set up" value={summary?.complete ?? '—'} subtitle={summary ? `${pct}% have every core step done` : undefined} progress={summary ? pct : null} tone="green" />
        <StatCard label="Stuck" value={summary?.stuck ?? '—'} subtitle={`nothing has happened for ${STUCK_AFTER_DAYS}+ days`} tone="amber" />
        <StatCard label="Blocked" value={summary?.blocked ?? '—'} subtitle="a core step needs a person" tone="red" />
      </div>

      {/* ---- Where everyone is ---- */}
      {summary && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="eyebrow mr-1 text-muted-foreground">Stage</span>
          {CORE_STEPS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStage(stage === s ? '' : s)}
              className={cn('rounded-md border px-2 py-1 transition', stage === s ? 'border-primary bg-primary-soft text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted')}
            >
              {STEP_TITLE[s]} <span className="font-mono tabular-nums">{summary.byStep[s]}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShow(show === 'complete' ? 'all' : 'complete')}
            className={cn('rounded-md border px-2 py-1 transition', show === 'complete' ? 'border-primary bg-primary-soft text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted')}
          >
            All set up <span className="font-mono tabular-nums">{summary.complete}</span>
          </button>
        </div>
      )}

      {/* ---- Filters ---- */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input className="w-64 rounded-md border border-border bg-card px-3 py-1.5" placeholder="Search client, business, person, email" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="rounded-md border border-border bg-card px-2 py-1.5" value={show} onChange={(e) => setShow(e.target.value as Show)}>
          <option value="all">Everyone</option>
          <option value="working">Still being set up</option>
          <option value="stuck">Stuck</option>
          <option value="blocked">Blocked</option>
          <option value="complete">Fully set up</option>
        </select>
        <select className="rounded-md border border-border bg-card px-2 py-1.5" value={step} onChange={(e) => setStep(e.target.value as TrackStep | '')}>
          <option value="">Any step</option>
          {TRACK_STEPS.map((s) => (
            <option key={s} value={s}>
              {STEP_TITLE[s]}
            </option>
          ))}
        </select>
        {step && (
          <select className="rounded-md border border-border bg-card px-2 py-1.5" value={state} onChange={(e) => setState(e.target.value as StepState)}>
            {(['done', 'in_progress', 'blocked', 'pending', 'none'] as StepState[]).map((x) => (
              <option key={x} value={x}>
                is {STATE_WORD[x].toLowerCase()}
              </option>
            ))}
          </select>
        )}
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> archived too
        </label>
        <span className="text-muted-foreground">
          {rows.length} client{rows.length === 1 ? '' : 's'}
        </span>
        {billing && (
          <span className={cn('text-xs', billing.error ? 'text-destructive' : 'text-muted-foreground')} title={billing.error ?? undefined}>
            · Stripe {billing.error ? 'couldn’t be read' : billing.account?.name ? `${billing.account.name} · read ${new Date(billing.asOf ?? list.data!.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET` : 'read'}
          </span>
        )}
      </div>

      {msg && (
        <p className="cursor-pointer break-all rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}
      {sync && (
        <div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
          <p className="font-medium">
            {sync.dryRun ? 'Sheet preview' : 'Imported'}:{' '}
            {sync.error ??
              Object.entries(sync.counts ?? {})
                .map(([k, v]) => `${v} ${k}`)
                .join(', ')}
          </p>
          {!!sync.missingHeaders?.length && <p className="text-muted-foreground">Sheet has no column: {sync.missingHeaders.join(', ')}</p>}
          {sync.ops
            ?.filter((o) => o.kind === 'unmatched')
            .map((o) => (
              <p key={o.sheetRow} className="text-muted-foreground">
                Row {o.sheetRow} ({o.label}): {o.reason === 'ambiguous' ? 'matches more than one client' : o.reason === 'duplicate_row' ? 'second row for the same client' : 'no matching Hub client'}, skipped
              </p>
            ))}
        </div>
      )}

      {/* ---- The grid ---- */}
      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Reading Stripe, Genisys OS and the boards…</p>
      ) : list.error ? (
        <p className="text-sm text-destructive">{String(list.error)}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left">
              <tr className="border-b border-border">
                <th className="px-3 py-2 eyebrow text-muted-foreground">Client</th>
                <th className="px-2 py-2 eyebrow text-muted-foreground">Billing</th>
                {TRACK_STEPS.map((s) => (
                  <th key={s} className={cn('px-1.5 py-2 text-center eyebrow text-muted-foreground', !CORE_STEPS.includes(s) && 'text-muted-foreground/60')} title={STEP_MEANS[s]}>
                    {STEP_TITLE[s]}
                  </th>
                ))}
                <th className="px-2 py-2 eyebrow text-muted-foreground">Stage</th>
                <th className="px-2 py-2 eyebrow text-muted-foreground">Last change</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={TRACK_STEPS.length + 5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No clients match.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const isOpen = open?.clientId === r.clientId
                return (
                  <Fragment key={r.clientId}>
                    <tr className={cn('border-t border-border-soft transition hover:bg-muted/40', isOpen && 'bg-muted/40', r.archived && 'opacity-60')}>
                      <td className="px-3 py-2">
                        <button type="button" className="text-left" onClick={() => setOpen(isOpen ? null : { clientId: r.clientId, step: null })}>
                          <span className="flex items-center gap-2">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden />
                            <span className="font-medium text-foreground">{r.clientName}</span>
                            {r.lifecycle !== 'active' && r.lifecycle !== 'onboarding' && <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">{r.lifecycle}</span>}
                          </span>
                          <span className="block pl-4 text-xs text-muted-foreground">{[r.person, r.email].filter(Boolean).join(' · ') || (r.business ?? '')}</span>
                        </button>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {r.billing ? (
                          <span className={cn('inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium', TONE[r.billing.tone])} title={r.billing.detail ?? undefined}>
                            {r.billing.text}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">—</span>
                        )}
                      </td>
                      {TRACK_STEPS.map((s) => (
                        <td key={s} className="px-1.5 py-2 text-center">
                          <StepMark view={r.steps[s]} active={isOpen && open?.step === s} onClick={() => setOpen(isOpen && open?.step === s ? null : { clientId: r.clientId, step: s })} />
                        </td>
                      ))}
                      <td className="px-2 py-2 whitespace-nowrap text-xs">
                        {r.complete ? (
                          <span className="chip-mint rounded-md px-1.5 py-0.5">All set up</span>
                        ) : r.current ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className={cn(r.steps[r.current].state === 'blocked' ? 'text-destructive' : 'text-foreground')}>{STEP_TITLE[r.current]}</span>
                            {r.stuckDays != null && <span className={cn('font-mono tabular-nums', r.stuck ? 'text-warning' : 'text-muted-foreground')}>{r.stuckDays}d</span>}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap text-xs text-muted-foreground">{when(r.lastChangeAt) ?? '—'}</td>
                      <td className="px-2 py-2 whitespace-nowrap text-right">
                        <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => copyLink(r.clientId)}>
                          Status link
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-surface-muted/60">
                        <td colSpan={TRACK_STEPS.length + 5} className="px-3 py-3">
                          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                            {TRACK_STEPS.map((s) => {
                              const v = r.steps[s]
                              const picked = open?.step === s
                              const manual = isManualStep(s)
                              return (
                                <div key={s} className={cn('rounded-lg border bg-card p-2.5', picked ? 'border-primary' : 'border-border', !CORE_STEPS.includes(s) && 'opacity-90')}>
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-xs font-medium text-foreground">{STEP_TITLE[s]}</p>
                                    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium', MARK[v.state])}>
                                      {GLYPH[v.state]} {STATE_WORD[v.state]}
                                      {v.byHand && ' · by hand'}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-xs text-muted-foreground">{v.note ?? STEP_MEANS[s]}</p>
                                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                                    {v.at && <span className="text-[11px] text-muted-foreground/70">{when(v.at)}</span>}
                                    {v.href && <Href href={v.href}>Open</Href>}
                                    {manual && r.manual[s] !== 'done' && v.state !== 'done' && (
                                      <button
                                        type="button"
                                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                                        disabled={mark.isPending}
                                        onClick={() => {
                                          const note = prompt(`Mark "${STEP_TITLE[s]}" done by hand for ${r.clientName}. Why? (optional)`)
                                          if (note === null) return
                                          mark.mutate({ clientId: r.clientId, step: s, status: 'done', note: note.trim() || null })
                                        }}
                                      >
                                        Mark done by hand
                                      </button>
                                    )}
                                    {manual && r.manual[s] === 'done' && (
                                      <button
                                        type="button"
                                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                                        disabled={mark.isPending}
                                        onClick={() => mark.mutate({ clientId: r.clientId, step: s, status: 'pending' })}
                                      >
                                        Clear hand mark
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Legend ---- */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">How to read this</summary>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {(['done', 'in_progress', 'blocked', 'pending', 'none'] as StepState[]).map((x) => (
            <span key={x} className="inline-flex items-center gap-1.5">
              <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-md font-mono text-[11px]', MARK[x])}>{GLYPH[x]}</span>
              {STATE_WORD[x]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex h-5 items-center justify-center rounded-md px-1 font-mono text-[11px] chip-mint">✓✎</span>
            Marked by hand, the Hub has no evidence of its own
          </span>
        </div>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {TRACK_STEPS.map((s) => (
            <li key={s}>
              <span className="font-medium text-foreground">{STEP_TITLE[s]}</span>
              {!CORE_STEPS.includes(s) && <span className="ml-1 text-muted-foreground/70">(informational)</span>}: {STEP_MEANS[s]}
            </li>
          ))}
        </ul>
        <p className="mt-2">Stage is the first core step not done. A client is stuck when nothing has happened for {STUCK_AFTER_DAYS} days or more.</p>
      </details>
    </div>
  )
}
