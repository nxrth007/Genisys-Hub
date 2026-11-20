'use client'

/**
 * Client tracker: every onboarding step for every client, read from what the
 * Hub knows (src/lib/tracker/derive.ts): Stripe, the onboarding form, Genisys
 * OS, Forge's site build, numbers, texting registration, automations, the
 * Google profile board, the SEO engine and the final check (QA). Nothing is
 * ticked by hand except the five sheet-era steps and QA, and a hand mark
 * shows as one.
 *
 * One quiet list, newest sign-up first, the way Stripe lists customers: the
 * person, when they signed up, a circle per step, and what the team does next
 * ("Text Torrence for onboarding"). Stripe sign-ups with no onboarding form
 * yet are rows too. A row opens the client's page (src/app/tracker/[clientId])
 * with the milestones, contact, business and the fulfillment list. "In Stripe
 * only" hides the clients Stripe has no record of (GHL- and Whop-era) and is
 * remembered per browser. Staff only.
 */
import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Ellipsis, PenLine, RefreshCw, Search } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { cn } from '@/lib/utils'
import {
  CORE_STEPS,
  STATE_WORD,
  STEP_MEANS,
  STEP_TITLE,
  STUCK_AFTER_DAYS,
  TRACK_STEPS,
  type Show,
  type StepState,
  type TrackStep,
  type TrackerRow,
  type TrackerSummary,
} from '@/lib/tracker/derive'
import { Mark, NextActionText, markTitle, rowTitle, signedUpShort } from './ui'

type ListResponse = {
  rows: TrackerRow[]
  summary: TrackerSummary
  billing: { asOf: string | null; error: string | null; account: { id: string | null; name: string | null } | null }
  asOf: string
  sheetSync: { enabled: boolean; last: { at: string; counts: Record<string, number>; error: string | null } | null }
}
type SyncResponse = { dryRun: boolean; counts: Record<string, number>; missingHeaders: string[]; error: string | null; ops: { kind: string; sheetRow: number; label?: string; reason?: string }[] }

/** The views along the top, each with its roster count. */
const VIEWS: { id: Show; label: string; count: (s: TrackerSummary) => number; hint: string }[] = [
  { id: 'all', label: 'Everyone', count: (s) => s.roster, hint: 'Every client and Stripe sign-up on the roster' },
  { id: 'act', label: 'Needs action', count: (s) => s.act, hint: 'The next action is the team’s to do' },
  { id: 'wait', label: 'Waiting', count: (s) => s.wait, hint: 'Waiting on someone else: Twilio, the carriers, Lovable' },
  { id: 'stuck', label: 'Stuck', count: (s) => s.stuck, hint: `Nothing has happened for ${STUCK_AFTER_DAYS}+ days` },
  { id: 'blocked', label: 'Blocked', count: (s) => s.blocked, hint: 'A step was rejected or failed' },
  { id: 'complete', label: 'Done', count: (s) => s.complete, hint: 'Every step done, the final check included' },
]

/** Column heads: short, with the full name and meaning on hover. */
const HEAD: Record<TrackStep, string> = {
  signup: 'Stripe',
  intake: 'Onboarding',
  subaccount: 'Sub-account',
  website: 'Website',
  domain: 'Domain',
  number: 'Number',
  texting: 'Texting',
  automations: 'Automations',
  gbp: 'Google',
  seo: 'SEO',
  qa: 'QA',
}
const LEGEND: StepState[] = ['done', 'in_progress', 'blocked', 'pending', 'not_needed', 'none']

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

/** The muted line under the name: the business, or for a Stripe sign-up with no client yet, who it might be. */
function rowSub(r: TrackerRow): string | null {
  if (r.stripeOnly) return r.suggestion ? `Might be ${r.suggestion.name}` : r.email
  if (r.person && r.person.toLowerCase() !== r.clientName.toLowerCase()) return r.clientName
  return r.email
}

const control = 'h-8 rounded-md border border-border bg-card px-2.5 text-[12.5px] text-foreground transition hover:bg-muted focus:outline-none focus:ring-1 focus:ring-primary/50'
const iconButton = 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50'

export default function TrackerPage() {
  const qc = useQueryClient()
  const router = useRouter()
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [stage, setStage] = useState<TrackStep | ''>('')
  const [step, setStep] = useState<TrackStep | ''>('')
  const [state, setState] = useState<StepState>('pending')
  const [archived, setArchived] = useState(false)
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

  const rows = list.data?.rows ?? []
  const summary = list.data?.summary
  const billing = list.data?.billing
  const readAt = billing && !billing.error ? new Date(billing.asOf ?? list.data!.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : null
  const cols = TRACK_STEPS.length + 3

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="Tracker"
        subtitle="Every client from sign-up to the final check, newest first. Click a client for the details."
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
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            title={v.hint}
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
          <input className={cn(control, 'w-72 pl-8 hover:bg-card placeholder:text-muted-foreground/70')} placeholder="Search name, business or email" value={q} onChange={(e) => setQ(e.target.value)} />
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
            {(['done', 'in_progress', 'blocked', 'pending', 'not_needed', 'none'] as StepState[]).map((x) => (
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

      {/* ---- The list ---- */}
      {list.isLoading ? (
        <p className="py-8 text-center text-[12.5px] text-muted-foreground">Reading Stripe, Genisys OS and the boards…</p>
      ) : list.error ? (
        <p className="text-[12.5px] text-destructive">{String(list.error)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[62rem] text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[12px] text-muted-foreground">
                <th className="whitespace-nowrap py-2.5 pr-3 font-medium">Client</th>
                <th className="whitespace-nowrap px-2 py-2.5 font-medium">Signed up</th>
                {TRACK_STEPS.map((s) => (
                  <th
                    key={s}
                    className={cn('whitespace-nowrap px-1 py-2.5 text-center font-medium', CORE_STEPS.includes(s) ? 'text-foreground/75' : 'text-muted-foreground/70')}
                    title={`${STEP_TITLE[s]}: ${STEP_MEANS[s]}`}
                  >
                    {HEAD[s]}
                  </th>
                ))}
                <th className="whitespace-nowrap px-2 py-2.5 font-medium">Next action</th>
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
                const href = `/tracker/${r.clientId}`
                const sub = rowSub(r)
                return (
                  <tr key={r.clientId} onClick={() => router.push(href)} className={cn('cursor-pointer transition hover:bg-muted/40', r.archived && 'opacity-60')}>
                    <td className="py-3 pr-3">
                      <Link href={href} onClick={(e) => e.stopPropagation()} className="block max-w-[12rem]">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-semibold text-foreground">{rowTitle(r)}</span>
                          {r.lifecycle !== 'active' && r.lifecycle !== 'onboarding' && <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">{r.lifecycle}</span>}
                        </span>
                        {sub && <span className={cn('block truncate text-[12px]', r.stripeOnly && r.suggestion ? 'text-warning' : 'text-muted-foreground')}>{sub}</span>}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 text-muted-foreground">{signedUpShort(r.signedUpAt)}</td>
                    {TRACK_STEPS.map((s) => (
                      <td key={s} className="px-1 py-3 text-center">
                        <span className="inline-flex" title={markTitle(r.steps[s])}>
                          <Mark state={r.steps[s].state} byHand={r.steps[s].byHand} />
                        </span>
                      </td>
                    ))}
                    <td className="px-2 py-3 leading-snug">
                      <NextActionText next={r.next} stuckDays={r.stuckDays} stuck={r.stuck} />
                    </td>
                  </tr>
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
              <span key={x} className="inline-flex items-center gap-1.5">
                <Mark state={x} size="sm" />
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
        <p className="mt-2">
          The next action is the first core step not done. Red means it’s the team’s to do; grey means someone else has it. A client is stuck when nothing has happened for {STUCK_AFTER_DAYS} days or more. Stripe sign-ups with no onboarding form under their email show up here too, so nobody is missed.
        </p>
      </details>
    </div>
  )
}
