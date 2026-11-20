'use client'

/**
 * Client tracker: every onboarding step for every client, read from what the
 * Hub knows (src/lib/tracker/derive.ts): Stripe, the onboarding form, Genisys
 * OS, Forge's site build, numbers, texting registration, automations, the
 * Google profile board and the SEO engine. Nothing here is ticked by hand
 * except the five sheet-era steps, and a hand mark shows as one. Staff only.
 *
 * One quiet table, in the manner of a Stripe list: a row per client, a mark
 * per step, hairlines and nothing else. Click a mark (or the client) to open
 * the row: every step with its evidence, its date and a link to where to act.
 * "Copy status link" copies the client's read-only status page to the
 * clipboard; nothing is sent to the client. "In Stripe only" hides the
 * clients Stripe has no record of (GHL- and Whop-era) and is remembered
 * per browser.
 */
import { Fragment, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Circle, CircleDashed, Ellipsis, ExternalLink, Link2, Minus, PenLine, RefreshCw, Search, X, type LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
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

/** The views along the top, each with its roster count. */
const SHOWS: { id: Show; label: string; count: (s: TrackerSummary) => number }[] = [
  { id: 'all', label: 'Everyone', count: (s) => s.roster },
  { id: 'working', label: 'Being set up', count: (s) => s.roster - s.complete },
  { id: 'stuck', label: 'Stuck', count: (s) => s.stuck },
  { id: 'blocked', label: 'Blocked', count: (s) => s.blocked },
  { id: 'complete', label: 'Fully set up', count: (s) => s.complete },
]

/** Column heads: short, with the full name and meaning on hover. */
const HEAD: Record<TrackStep, string> = {
  signup: 'Sign-up',
  intake: 'Form',
  subaccount: 'Sub-account',
  website: 'Website',
  domain: 'Domain',
  number: 'Number',
  texting: 'Texting',
  automations: 'Automations',
  gbp: 'Google',
  seo: 'SEO',
}

const INK: Record<StepState, string> = {
  done: 'text-success',
  in_progress: 'text-primary',
  blocked: 'text-destructive',
  pending: 'text-muted-foreground/60',
  not_needed: 'text-muted-foreground/40',
  none: 'text-muted-foreground/35',
}
const ICON: Record<Exclude<StepState, 'in_progress'>, LucideIcon> = { done: Check, blocked: X, pending: Circle, not_needed: Minus, none: CircleDashed }
const TONE: Record<string, string> = { mint: 'chip-mint', blue: 'chip-blue', amber: 'chip-amber', pink: 'chip-pink', muted: 'bg-muted text-muted-foreground' }
const LEGEND: StepState[] = ['done', 'in_progress', 'blocked', 'pending', 'not_needed', 'none']

const when = (iso: string | null | undefined) => (iso ? shortDate(iso) : null)

/**
 * "In Stripe only", remembered per browser. A tiny external store (not an
 * effect) so the server render and hydration agree and the toggle updates
 * every open Tracker tab.
 */
const STRIPE_ONLY_KEY = 'tracker.stripeOnly'
const stripeOnlyListeners = new Set<() => void>()
let stripeOnlyFallback = false
function subscribeStripeOnly(cb: () => void) {
  stripeOnlyListeners.add(cb)
  window.addEventListener('storage', cb)
  return () => {
    stripeOnlyListeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}
function readStripeOnly(): boolean {
  try {
    return localStorage.getItem(STRIPE_ONLY_KEY) === '1'
  } catch {
    return stripeOnlyFallback
  }
}
function setStripeOnly(v: boolean) {
  stripeOnlyFallback = v
  try {
    localStorage.setItem(STRIPE_ONLY_KEY, v ? '1' : '0')
  } catch {}
  stripeOnlyListeners.forEach((l) => l())
}

/** The mark for a state: a check, a half circle, a cross, a ring, a dash, a dashed ring. */
function Mark({ state, className }: { state: StepState; className?: string }) {
  const cls = cn('h-3.5 w-3.5 shrink-0', INK[state], className)
  if (state === 'in_progress') {
    return (
      <svg viewBox="0 0 16 16" className={cls} aria-hidden>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <path d="M8 2a6 6 0 0 1 0 12Z" fill="currentColor" />
      </svg>
    )
  }
  const Icon = ICON[state]
  return <Icon className={cls} strokeWidth={state === 'done' ? 2.75 : state === 'blocked' ? 2.5 : 1.75} aria-hidden />
}

function StepMark({ view, active, onClick }: { view: StepView; active: boolean; onClick: () => void }) {
  const title = `${STATE_WORD[view.state]}${view.byHand ? ' (by hand)' : ''}${view.note ? ` — ${view.note}` : ''}${view.at ? ` · ${when(view.at)}` : ''}`
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn('relative inline-flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-muted', active && 'bg-muted ring-1 ring-primary/60')}
    >
      <Mark state={view.state} />
      {view.byHand && <PenLine className="absolute right-0.5 top-0.5 h-2 w-2 text-muted-foreground" aria-label="by hand" />}
    </button>
  )
}

function Href({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = 'inline-flex items-center gap-1 text-primary hover:underline'
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

const control = 'h-8 rounded-md border border-border bg-card px-2.5 text-[12.5px] text-foreground transition hover:bg-muted focus:outline-none focus:ring-1 focus:ring-primary/50'
const iconButton = 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50'
const quietLink = 'text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50'

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

  const stripeOnly = useSyncExternalStore(subscribeStripeOnly, readStripeOnly, () => false)

  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (show !== 'all') params.set('show', show)
  if (stage) params.set('stage', stage)
  if (step) {
    params.set('step', step)
    params.set('state', state)
  }
  if (stripeOnly) params.set('stripe', '1')
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
  const readAt = billing && !billing.error ? new Date(billing.asOf ?? list.data!.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : null
  const cols = TRACK_STEPS.length + 5

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="Tracker"
        subtitle="Every onboarding step for every client, read from what the Hub knows."
        breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: 'Tracker' }]}
        actions={
          <div className="flex items-center gap-1.5">
            <button type="button" className={iconButton} disabled={refresh.isPending} onClick={() => refresh.mutate()} title="Re-read Stripe and every board now" aria-label="Refresh">
              <RefreshCw className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />
            </button>
            <details className="relative">
              <summary className={cn(iconButton, 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')} title="More" aria-label="More">
                <Ellipsis className="h-4 w-4" />
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-border bg-popover p-3 text-[12.5px] shadow-pop">
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
                  Include archived clients
                </label>
                <div className="my-3 border-t border-border" />
                <p className="eyebrow text-muted-foreground">Sheet import</p>
                <p className="mt-1.5 text-muted-foreground">Ethan’s onboarding sheet still counts for the five hand-marked steps. Importing copies its ✅ cells into the Hub; the sheet is never changed.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="rounded-md border border-border px-2.5 py-1 transition hover:bg-muted disabled:opacity-50" disabled={runSync.isPending} onClick={() => runSync.mutate(true)}>
                    Preview
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2.5 py-1 transition hover:bg-muted disabled:opacity-50"
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

      {/* ---- Who to look at ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        {SHOWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setShow(v.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] transition',
              show === v.id ? 'border-primary bg-primary-soft text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {v.label}
            {summary && <span className="font-mono text-[11px] tabular-nums opacity-70">{v.count(summary)}</span>}
          </button>
        ))}
      </div>

      {/* ---- Find ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input className={cn(control, 'w-72 pl-8 hover:bg-card placeholder:text-muted-foreground/70')} placeholder="Search client, person or email" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <select className={control} value={stage} onChange={(e) => setStage(e.target.value as TrackStep | '')} title="The step a client is on">
          <option value="">Any stage</option>
          {CORE_STEPS.map((s) => (
            <option key={s} value={s}>
              {STEP_TITLE[s]}
              {summary ? ` (${summary.byStep[s]})` : ''}
            </option>
          ))}
        </select>
        <select className={control} value={step} onChange={(e) => setStep(e.target.value as TrackStep | '')}>
          <option value="">Any step</option>
          {TRACK_STEPS.map((s) => (
            <option key={s} value={s}>
              {STEP_TITLE[s]}
            </option>
          ))}
        </select>
        {step && (
          <select className={control} value={state} onChange={(e) => setState(e.target.value as StepState)}>
            {(['done', 'in_progress', 'blocked', 'pending', 'none'] as StepState[]).map((x) => (
              <option key={x} value={x}>
                is {STATE_WORD[x].toLowerCase()}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-pressed={stripeOnly}
          onClick={() => setStripeOnly(!stripeOnly)}
          title="Hide the clients Stripe has no record of (GHL- and Whop-era clients)"
          className={cn(control, 'inline-flex items-center gap-1.5', stripeOnly ? 'border-primary bg-primary-soft text-foreground hover:bg-primary-soft' : 'text-muted-foreground hover:text-foreground')}
        >
          {stripeOnly && <Check className="h-3 w-3" strokeWidth={2.5} />}
          In Stripe only
        </button>
      </div>

      {msg && (
        <p className="cursor-pointer break-all rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}
      {sync && (
        <div className="rounded-md border border-border bg-card px-3 py-2 text-[12.5px]">
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

      {/* ---- The table ---- */}
      {list.isLoading ? (
        <p className="py-8 text-center text-[12.5px] text-muted-foreground">Reading Stripe, Genisys OS and the boards…</p>
      ) : list.error ? (
        <p className="text-[12.5px] text-destructive">{String(list.error)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11.5px] font-medium text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Client</th>
                <th className="px-2 py-2 font-medium">Billing</th>
                {TRACK_STEPS.map((s) => (
                  <th key={s} className={cn('px-1 py-2 text-center font-medium', !CORE_STEPS.includes(s) && 'text-muted-foreground/60')} title={`${STEP_TITLE[s]} — ${STEP_MEANS[s]}`}>
                    {HEAD[s]}
                  </th>
                ))}
                <th className="px-2 py-2 font-medium">Stage</th>
                <th className="hidden px-2 py-2 font-medium 2xl:table-cell">Last change</th>
                <th className="w-9 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={cols} className="py-10 text-center text-[12.5px] text-muted-foreground">
                    No clients match.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const isOpen = open?.clientId === r.clientId
                const sub = [r.person, r.email].filter(Boolean).join(' · ') || r.business || ''
                return (
                  <Fragment key={r.clientId}>
                    <tr className={cn('group transition hover:bg-muted/40', isOpen && 'bg-muted/40', r.archived && 'opacity-60')}>
                      <td className="py-2 pr-3">
                        <button type="button" className="block max-w-[16rem] text-left" onClick={() => setOpen(isOpen ? null : { clientId: r.clientId, step: null })}>
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium text-foreground">{r.clientName}</span>
                            {r.lifecycle !== 'active' && r.lifecycle !== 'onboarding' && <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">{r.lifecycle}</span>}
                          </span>
                          {sub && <span className="block truncate text-[12px] text-muted-foreground">{sub}</span>}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        {r.billing ? (
                          <span className={cn('inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium', TONE[r.billing.tone])} title={r.billing.detail ?? undefined}>
                            {r.billing.text}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                      {TRACK_STEPS.map((s) => (
                        <td key={s} className="px-1 py-1.5 text-center">
                          <StepMark view={r.steps[s]} active={isOpen && open?.step === s} onClick={() => setOpen(isOpen && open?.step === s ? null : { clientId: r.clientId, step: s })} />
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2 py-2 text-[12.5px]">
                        {r.complete ? (
                          <span className="text-success">All set up</span>
                        ) : r.current ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className={cn(r.steps[r.current].state === 'blocked' ? 'text-destructive' : 'text-foreground')}>{STEP_TITLE[r.current]}</span>
                            {r.stuckDays != null && <span className={cn('font-mono text-[11px] tabular-nums', r.stuck ? 'text-warning' : 'text-muted-foreground/70')}>{r.stuckDays}d</span>}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="hidden whitespace-nowrap px-2 py-2 text-[12.5px] text-muted-foreground 2xl:table-cell">{when(r.lastChangeAt) ?? '—'}</td>
                      <td className="py-1.5 pl-1 text-right">
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/40 transition hover:bg-muted hover:text-foreground group-hover:text-muted-foreground"
                          onClick={() => copyLink(r.clientId)}
                          title="Copy the client's status link (nothing is sent)"
                          aria-label="Copy status link"
                        >
                          <Link2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-muted/25">
                        <td colSpan={cols} className="px-3 py-3">
                          <ul className="grid gap-x-10 gap-y-1 text-[12.5px] sm:grid-cols-2">
                            {TRACK_STEPS.map((s) => {
                              const v = r.steps[s]
                              const picked = open?.step === s
                              const manual = isManualStep(s)
                              return (
                                <li key={s} className={cn('flex items-start gap-2.5 rounded-md px-2 py-1.5', picked && 'bg-card ring-1 ring-primary/40', !CORE_STEPS.includes(s) && 'opacity-80')}>
                                  <Mark state={v.state} className="mt-0.5" />
                                  <div className="min-w-0 flex-1">
                                    <p>
                                      <span className="font-medium text-foreground">{STEP_TITLE[s]}</span>
                                      <span className="text-muted-foreground">
                                        {' · '}
                                        {STATE_WORD[v.state]}
                                        {v.byHand && ', by hand'}
                                      </span>
                                    </p>
                                    <p className="text-muted-foreground">{v.note ?? STEP_MEANS[s]}</p>
                                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11.5px]">
                                      {v.at && <span className="text-muted-foreground/70">{when(v.at)}</span>}
                                      {v.href && <Href href={v.href}>Open</Href>}
                                      {manual && r.manual[s] !== 'done' && v.state !== 'done' && (
                                        <button
                                          type="button"
                                          className={quietLink}
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
                                        <button type="button" className={quietLink} disabled={mark.isPending} onClick={() => mark.mutate({ clientId: r.clientId, step: s, status: 'pending' })}>
                                          Clear hand mark
                                        </button>
                                      )}
                                    </p>
                                  </div>
                                </li>
                              )
                            })}
                          </ul>
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

      {/* ---- Footer: count, Stripe read, legend ---- */}
      {list.data && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-muted-foreground">
          <span>
            {rows.length} client{rows.length === 1 ? '' : 's'}
            {stripeOnly ? ' in Stripe' : ''}
          </span>
          {billing && (
            <span className={cn(billing.error && 'text-destructive')} title={billing.error ?? undefined}>
              Stripe {billing.error ? 'couldn’t be read' : `read ${readAt} ET`}
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            {LEGEND.map((x) => (
              <span key={x} className="inline-flex items-center gap-1">
                <Mark state={x} className="h-3 w-3" />
                {STATE_WORD[x]}
              </span>
            ))}
            <span className="inline-flex items-center gap-1" title="Marked by hand: the Hub has no evidence of its own">
              <PenLine className="h-2.5 w-2.5" />
              by hand
            </span>
          </span>
        </div>
      )}
      <details className="text-[11.5px] text-muted-foreground">
        <summary className="cursor-pointer">What each step means</summary>
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
