'use client'

import dynamic from 'next/dynamic'
import { useSyncExternalStore, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Check, ExternalLink, Hammer, Loader2, Pause, Play, Radio, Rocket, RotateCcw, Send, ShieldCheck, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { DESKS } from '@/lib/office/layout'
import type { OfficeApproval, OfficeBot, OfficeRequest, OfficeState, OfficeStatus } from '@/lib/office/mapping'
import { OFFICE_THEMES, STATUS_META, type OfficeTheme } from './theme'

// The SVG scene + animation loop only runs in the browser and stays out of
// every other page's bundle.
const OfficeScene = dynamic(() => import('./office-scene'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-xs text-zinc-500">Loading office…</div>,
})

const POLL_MS = 7_000
const THEME_KEY = 'office-theme'
const THEME_EVENT = 'office-theme-change'

function subscribeTheme(cb: () => void) {
  window.addEventListener(THEME_EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(THEME_EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}
function readTheme(): OfficeTheme {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'day' || v === 'evening' || v === 'night' ? v : 'night'
  } catch {
    return 'night'
  }
}
function setTheme(t: OfficeTheme) {
  try {
    localStorage.setItem(THEME_KEY, t)
  } catch {
    // non-fatal
  }
  window.dispatchEvent(new Event(THEME_EVENT))
}

const LEGEND: OfficeStatus[] = ['coding', 'browsing', 'terminal', 'thinking', 'needs_you', 'error']

function StatusPill({ status }: { status: OfficeStatus }) {
  const m = STATUS_META[status]
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${m.color}22`, color: m.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  )
}

type Decision = 'hl' | 'ghl' | 'identified' | 'no' | 'submit' | 'hold' | 'retry' | 'buy' | 'build' | 'publish'
/** Answers that leave things as they are (shown quietly). */
const quiet = (d: Decision) => d === 'no' || d === 'hold'
type Answer = { decision: Decision; text: string }

const BTN_PRIMARY = 'inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-[12px] font-semibold text-black transition hover:bg-emerald-400 disabled:opacity-40'
const BTN_SECONDARY = 'inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-zinc-100 transition hover:bg-white/10 disabled:opacity-40'
const BTN_GHOST = 'inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40'

/**
 * A bot's question waiting for an answer. Echo asking where to get a new
 * client's toll-free number: Buy in Hell-level (right away, no ID check) or
 * Verify identity in GHL (opens the client's GHL Phone System and waits);
 * then Identification complete hands the GHL route to the browser worker.
 * Echo asking about GHL's toll-free registration it filled: Send it, See
 * what was filled (the client's folder in Sites), Not now; or, when it
 * stopped, Try again. An answer that settles it stays a few seconds to say
 * what happened.
 */
function ApprovalCard({
  a,
  bot,
  canAnswer,
  demo,
  done,
  onAnswered,
}: {
  a: OfficeApproval
  bot: OfficeBot | undefined
  canAnswer: boolean
  demo: boolean
  done: Answer | null
  onAnswered: (answer: Answer) => void
}) {
  // What's spinning: a decision, or "buy:<domain>" for one of Forge's suggestions.
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const color = bot?.color ?? '#f472b6'
  const locked = demo || !canAnswer || !!busy || !!done
  const spin = (d: string) => busy === d && <Loader2 className="h-3.5 w-3.5 animate-spin" />

  async function answer(decision: Decision, name?: string) {
    setBusy(name ? `buy:${name}` : decision)
    setErr(null)
    try {
      const res = await fetch('/api/office/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: a.id, kind: a.kind, decision, ...(name ? { name } : {}) }),
      })
      const out = (await res.json().catch(() => ({}))) as { error?: string; detail?: string | null }
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`)
      onAnswered({ decision, text: decision === 'no' ? 'Declined.' : out.detail || (decision === 'hold' ? 'On hold.' : 'Done.') })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const ghlButton = (label: string, decision: Decision | null) =>
    a.ghlLink && !locked ? (
      // A real link, so the new tab opens from the click itself (an opened-after-fetch window gets blocked).
      <a href={a.ghlLink} target="_blank" rel="noopener noreferrer" onClick={() => decision && void answer(decision)} className={BTN_SECONDARY}>
        {decision && spin(decision)} {label} <ExternalLink className="h-3.5 w-3.5" />
      </a>
    ) : (
      <button type="button" disabled className={BTN_SECONDARY} title={a.ghlLink ? undefined : 'No GHL sub-account is linked to this client'}>
        {label} <ExternalLink className="h-3.5 w-3.5" />
      </button>
    )

  return (
    <div
      className="pointer-events-auto w-full max-w-[520px] rounded-xl border border-white/10 bg-[#0b0e13]/90 p-3 backdrop-blur"
      style={{ boxShadow: `0 0 0 1px ${color}40, 0 12px 40px rgba(0,0,0,0.55)` }}
      role="alertdialog"
      aria-label={a.question}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold text-black" style={{ background: color, boxShadow: `0 0 8px ${color}66` }}>
          {(bot?.name ?? 'Echo')[0]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-zinc-400">
            <span className="font-medium" style={{ color }}>
              {bot?.name ?? 'Echo'}
            </span>{' '}
            · {bot?.role ?? 'A2P registration'} · <span className="font-mono">{format(new Date(a.at), 'h:mm a')}</span>
          </div>
          <p className="mt-0.5 text-[13px] font-medium leading-snug text-zinc-100">{a.question}</p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">{a.note}</p>
          {a.detail && <p className="mt-1.5 rounded-md bg-amber-400/10 px-2 py-1 text-[11px] leading-snug text-amber-300">{a.detail}</p>}
          {err && <p className="mt-1.5 text-[11px] text-red-300">{err}</p>}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {done ? (
              <span className={cn('inline-flex items-start gap-1 text-[12px] font-medium leading-snug', quiet(done.decision) ? 'text-zinc-400' : 'text-emerald-400')}>
                {quiet(done.decision) ? <X className="mt-px h-3.5 w-3.5 shrink-0" /> : <Check className="mt-px h-3.5 w-3.5 shrink-0" />}
                {done.text}
              </span>
            ) : a.kind === 'domain' ? (
              <>
                {(a.choices ?? []).map((c, i) => (
                  <button key={c.name} type="button" onClick={() => answer('buy', c.name)} disabled={locked} className={i === 0 ? BTN_PRIMARY : BTN_SECONDARY} title={c.renewalCents ? `Renews at $${(c.renewalCents / 100).toFixed(2)}/yr` : undefined}>
                    {spin(`buy:${c.name}`) || <Check className="h-3.5 w-3.5" />} {c.name} · ${(c.costCents / 100).toFixed(2)}
                  </button>
                ))}
                {a.domainsLink && (
                  <a href={a.domainsLink} target="_blank" rel="noopener noreferrer" className={BTN_GHOST}>
                    Search other names <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button type="button" onClick={() => answer('no')} disabled={locked} className={BTN_GHOST}>
                  {spin('no') || <X className="h-3.5 w-3.5" />} {(a.choices ?? []).length ? 'None of these' : 'No'}
                </button>
              </>
            ) : a.kind === 'site' ? (
              <>
                {a.stage === 'publish' ? (
                  <button type="button" onClick={() => answer('publish')} disabled={locked} className={BTN_PRIMARY}>
                    {spin('publish') || <Rocket className="h-3.5 w-3.5" />} Publish it
                  </button>
                ) : (
                  <button type="button" onClick={() => answer('build')} disabled={locked} className={BTN_PRIMARY}>
                    {spin('build') || <Hammer className="h-3.5 w-3.5" />} Build it
                  </button>
                )}
                {a.reviewLink && (
                  <a href={a.reviewLink} target="_blank" rel="noopener noreferrer" className={BTN_SECONDARY}>
                    {a.stage === 'publish' ? 'Open in Lovable' : 'Their folder'} <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button type="button" onClick={() => answer('no')} disabled={locked} className={BTN_GHOST}>
                  {spin('no') || <X className="h-3.5 w-3.5" />} Not now
                </button>
              </>
            ) : a.kind === 'registration' && a.stage === 'review' ? (
              <>
                <button type="button" onClick={() => answer('submit')} disabled={locked} className={BTN_PRIMARY}>
                  {spin('submit') || <Send className="h-3.5 w-3.5" />} Send it
                </button>
                {a.reviewLink && (
                  <a href={a.reviewLink} target="_blank" rel="noopener noreferrer" className={BTN_SECONDARY}>
                    See what was filled <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button type="button" onClick={() => answer('hold')} disabled={locked} className={BTN_GHOST}>
                  {spin('hold') || <X className="h-3.5 w-3.5" />} Not now
                </button>
              </>
            ) : a.kind === 'registration' ? (
              <>
                <button type="button" onClick={() => answer('retry')} disabled={locked} className={BTN_PRIMARY}>
                  {spin('retry') || <RotateCcw className="h-3.5 w-3.5" />} Try again
                </button>
                {ghlButton('Open GHL', null)}
                <button type="button" onClick={() => answer('hold')} disabled={locked} className={BTN_GHOST}>
                  {spin('hold') || <X className="h-3.5 w-3.5" />} Not now
                </button>
              </>
            ) : a.stage === 'identity' ? (
              <>
                {ghlButton('Open GHL', null)}
                <button type="button" onClick={() => answer('identified')} disabled={locked} className={BTN_PRIMARY}>
                  {spin('identified') || <ShieldCheck className="h-3.5 w-3.5" />} Identification complete
                </button>
                <button type="button" onClick={() => answer('hl')} disabled={locked} className={BTN_GHOST}>
                  {spin('hl')} Buy in Hell-level instead
                </button>
                <button type="button" onClick={() => answer('no')} disabled={locked} className={BTN_GHOST}>
                  {spin('no') || <X className="h-3.5 w-3.5" />} No
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => answer('hl')} disabled={locked} className={BTN_PRIMARY}>
                  {spin('hl') || <Check className="h-3.5 w-3.5" />} Buy in Hell-level
                </button>
                <button type="button" onClick={() => answer('no')} disabled={locked} className={BTN_GHOST}>
                  {spin('no') || <X className="h-3.5 w-3.5" />} No
                </button>
              </>
            )}
            {!done && (demo ? (
              <span className="text-[11px] text-amber-300/80">Sample request (demo mode)</span>
            ) : !canAnswer ? (
              <span className="text-[11px] text-zinc-500">Only an admin can answer this.</span>
            ) : null)}
          </div>
        </div>
      </div>
    </div>
  )
}

const APPROVALS_SHOWN = 3

const WORKING: ReadonlySet<OfficeStatus> = new Set(['coding', 'browsing', 'terminal', 'thinking'])

/**
 * The Requests tab: everything the bots need from a person, as a list. The
 * questions they won't act on without an answer (purchases, filings), what's
 * stuck or failed with where to fix it, and what each bot is doing now.
 */
function RequestsPanel({
  approvals,
  requests,
  bots,
  loading,
  error,
  renderApproval,
}: {
  approvals: OfficeApproval[]
  requests: OfficeRequest[]
  bots: OfficeBot[]
  loading: boolean
  error: string | null
  renderApproval: (a: OfficeApproval) => ReactNode
}) {
  const busy = bots.filter((b) => b.id !== 'alfred' && WORKING.has(b.status))
  const errors = requests.filter((r) => r.kind === 'error')
  const stuck = requests.filter((r) => r.kind === 'stuck')
  const row = (r: OfficeRequest) => {
    const bot = bots.find((b) => b.id === r.botId)
    return (
      <li key={r.id} className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2.5">
        <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', r.kind === 'error' ? 'bg-red-400' : 'bg-yellow-400')} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-zinc-500">
            <span className="font-medium" style={{ color: bot?.color }}>
              {bot?.name ?? r.botId}
            </span>{' '}
            · {bot?.role ?? ''} · <span className="font-mono">{format(new Date(r.at), 'MMM d, h:mm a')}</span>
          </div>
          <p className="mt-0.5 text-[13px] leading-snug text-zinc-200">{r.text}</p>
        </div>
        {r.link && (
          <a href={r.link} className={cn(BTN_SECONDARY, 'shrink-0')}>
            Open <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </li>
    )
  }
  const heading = (title: string, count: number, hint: string) => (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 className="font-mono text-[11px] uppercase tracking-widest text-zinc-400">
        {title} <span className="text-zinc-600">· {count}</span>
      </h2>
      <p className="text-[11px] text-zinc-500">{hint}</p>
    </div>
  )
  if (loading) return <div className="grid flex-1 place-items-center text-xs text-zinc-500">Loading requests…</div>
  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      {error && <p className="mb-3 rounded bg-red-500/15 px-3 py-1.5 text-xs text-red-300">Couldn&apos;t load the office ({error}). Retrying…</p>}
      <section className="mb-6">
        {heading('Waiting on your answer', approvals.length, 'Purchases and filings the bots won’t do without you')}
        {approvals.length ? <div className="flex flex-col gap-2">{approvals.map(renderApproval)}</div> : <p className="text-[12.5px] text-zinc-500">Nothing to answer right now.</p>}
      </section>
      <section className="mb-6">
        {heading('Failed', errors.length, 'Something broke; open it to see what')}
        {errors.length ? <ul className="flex flex-col gap-2">{errors.map(row)}</ul> : <p className="text-[12.5px] text-zinc-500">Nothing failed.</p>}
      </section>
      <section className="mb-6">
        {heading('Stuck on something', stuck.length, 'Waiting on a person to fix or check')}
        {stuck.length ? <ul className="flex flex-col gap-2">{stuck.map(row)}</ul> : <p className="text-[12.5px] text-zinc-500">Nothing stuck.</p>}
      </section>
      <section>
        {heading('Working on now', busy.length, 'What each bot is doing')}
        {busy.length ? (
          <ul className="flex flex-col gap-1.5">
            {busy.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-[12.5px]">
                <StatusPill status={b.status} />
                <span className="font-medium" style={{ color: b.color }}>
                  {b.name}
                </span>
                <span className="truncate text-zinc-300" title={b.task}>
                  {b.task}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-zinc-500">All quiet.</p>
        )}
      </section>
    </div>
  )
}

export function OfficeView({
  demo,
  user,
  initialTab = 'office',
}: {
  demo: boolean
  user: { name: string | null; email: string | null; image: string | null; role: string | null }
  initialTab?: 'office' | 'requests'
}) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'night' as OfficeTheme)
  const [paused, setPaused] = useState(false)
  // The office floor, or every request from the bots as a list (?tab=requests).
  const [tab, setTabState] = useState<'office' | 'requests'>(initialTab)
  function setTab(t: 'office' | 'requests') {
    setTabState(t)
    const u = new URL(window.location.href)
    if (t === 'requests') u.searchParams.set('tab', 'requests')
    else u.searchParams.delete('tab')
    window.history.replaceState(null, '', u)
  }

  const { data, error, isLoading } = useQuery<OfficeState>({
    queryKey: ['office-state', demo],
    queryFn: async () => {
      const res = await fetch(`/api/office/state${demo ? '?demo=1' : ''}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    refetchInterval: paused ? false : POLL_MS,
    refetchIntervalInBackground: false,
  })

  const qc = useQueryClient()
  const bots = data?.bots ?? []
  // Answered questions stay a few seconds (the next poll drops them) so the card can say what happened.
  const [answered, setAnswered] = useState<{ a: OfficeApproval; answer: Answer }[]>([])
  const approvals = [
    ...answered.map((x) => x.a),
    ...(data?.approvals ?? []).filter((a) => !answered.some((x) => x.a.id === a.id)),
  ]
  function onAnswered(a: OfficeApproval, answer: Answer) {
    // Choosing GHL doesn't settle it: the same card comes back at its next step (the ID check).
    if (answer.decision !== 'ghl') setAnswered((prev) => [...prev.filter((x) => x.a.id !== a.id), { a, answer }])
    void qc.invalidateQueries({ queryKey: ['office-state', demo] })
    setTimeout(() => setAnswered((prev) => prev.filter((x) => x.a.id !== a.id)), 12_000)
  }
  const occupied = bots.filter((b) => b.id === 'alfred' || b.status !== 'idle').length
  const free = Math.max(0, DESKS.length - occupied)
  const working = data?.counts.working ?? 0
  const idle = data?.counts.idle ?? 0
  const needs = (data?.counts.needsYou ?? 0) + (data?.counts.error ?? 0)
  const requests = data?.requests ?? []
  const requestCount = approvals.length + requests.length

  return (
    <div className="flex h-full min-h-[640px] flex-col bg-[#07090d] text-zinc-100 lg:flex-row">
      <section className="relative flex min-h-[520px] flex-1 flex-col overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-5 py-3">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight">Genisys Staff Virtual Office</h1>
              <p className="mt-0.5 font-mono text-[11px] text-zinc-400">
                {working} working • {idle} idle • {free} free desk{free === 1 ? '' : 's'}
                {needs > 0 && <span className="text-yellow-400"> • {needs} need{needs === 1 ? 's' : ''} you</span>}
              </p>
            </div>
            <div className="flex rounded-lg border border-white/10 bg-white/5 p-0.5" role="tablist" aria-label="Office view">
              {(['office', 'requests'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition-colors', tab === t ? 'bg-white/15 text-white' : 'text-zinc-400 hover:text-zinc-200')}
                >
                  {t === 'office' ? 'Office' : 'Requests'}
                  {t === 'requests' && requestCount > 0 && (
                    <span className="rounded-full bg-yellow-400/20 px-1.5 text-[10px] font-semibold tabular-nums text-yellow-300">{requestCount}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
            {demo ? (
              <span className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-300">Sample data · demo mode</span>
            ) : (
              <span className={cn('inline-flex items-center gap-1.5 rounded px-2 py-1', paused ? 'text-zinc-500' : 'text-emerald-400')}>
                <Radio className="h-3 w-3" /> {paused ? 'Paused' : 'Live'}
              </span>
            )}
          </div>
        </header>

        {tab === 'requests' ? (
          <RequestsPanel
            approvals={approvals}
            requests={requests}
            bots={bots}
            loading={isLoading}
            error={error ? (error as Error).message : null}
            renderApproval={(a) => (
              <ApprovalCard
                key={a.id}
                a={a}
                bot={bots.find((b) => b.id === a.botId)}
                canAnswer={user.role === 'admin'}
                demo={demo}
                done={answered.find((x) => x.a.id === a.id)?.answer ?? null}
                onAnswered={(answer) => onAnswered(a, answer)}
              />
            )}
          />
        ) : (
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-3">
            {error ? (
              <div className="pointer-events-auto rounded bg-red-500/15 px-3 py-1.5 text-xs text-red-300">Couldn&apos;t load office state ({(error as Error).message}). Retrying…</div>
            ) : null}
            {approvals.slice(0, APPROVALS_SHOWN).map((a) => (
              <ApprovalCard
                key={a.id}
                a={a}
                bot={bots.find((b) => b.id === a.botId)}
                canAnswer={user.role === 'admin'}
                demo={demo}
                done={answered.find((x) => x.a.id === a.id)?.answer ?? null}
                onAnswered={(answer) => onAnswered(a, answer)}
              />
            ))}
            {approvals.length > APPROVALS_SHOWN && (
              <div className="pointer-events-auto rounded-full border border-white/10 bg-black/60 px-3 py-1 text-[11px] text-zinc-300 backdrop-blur">
                {approvals.length - APPROVALS_SHOWN} more waiting for an answer
              </div>
            )}
          </div>
          {isLoading ? (
            <div className="grid h-full place-items-center text-xs text-zinc-500">Loading office…</div>
          ) : (
            <div className="absolute inset-0 p-2">
              <OfficeScene bots={bots} handoffs={data?.handoffs ?? []} theme={theme} paused={paused} wallStat={`${working} working · ${needs} need you`} />
            </div>
          )}

          {/* Legend */}
          <div className="absolute bottom-3 left-3 rounded-lg border border-white/10 bg-black/55 px-3 py-2 backdrop-blur">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-zinc-500">Status</div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
              {LEGEND.map((s) => (
                <li key={s} className="flex items-center gap-1.5 text-[11px] text-zinc-300">
                  <span className="h-2 w-2 rounded-full" style={{ background: STATUS_META[s].color, boxShadow: `0 0 6px ${STATUS_META[s].color}` }} />
                  {STATUS_META[s].label}
                </li>
              ))}
            </ul>
          </div>

          {/* Theme toggle */}
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 rounded-full border border-white/10 bg-black/55 p-1 backdrop-blur" role="radiogroup" aria-label="Office lighting">
            {OFFICE_THEMES.map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={theme === t}
                onClick={() => setTheme(t)}
                className={cn('rounded-full px-3 py-1 text-[11px] font-medium capitalize transition-colors', theme === t ? 'bg-white/15 text-white' : 'text-zinc-400 hover:text-zinc-200')}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Pause */}
          <button
            onClick={() => setPaused((p) => !p)}
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-3 py-2 text-[11px] font-medium text-zinc-200 backdrop-blur hover:bg-black/70"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume live view' : 'Pause live view'}
          </button>
        </div>
        )}
      </section>

      <aside className="flex w-full shrink-0 flex-col border-l border-white/5 bg-[#0b0e13] lg:w-[340px]">
        <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
          <Avatar name={user.name} email={user.email} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{user.name || user.email}</div>
            <div className="text-[11px] capitalize text-zinc-500">{user.role ?? 'staff'}</div>
          </div>
        </div>

        <div className="border-b border-white/5 px-4 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Team · {bots.length}</div>
          <ul className="space-y-2.5">
            {bots.map((b) => (
              <li key={b.id} className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold text-black" style={{ background: b.color, boxShadow: `0 0 8px ${b.color}66` }}>
                  {b.name[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-medium">
                      {b.name} <span className="font-normal text-zinc-500">· {b.role}</span>
                    </span>
                    <StatusPill status={b.status} />
                  </div>
                  <div className="truncate text-[11px] text-zinc-400" title={b.task}>
                    {b.task}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Activity{demo ? ' · sample' : ''}</div>
          <div className="min-h-[160px] flex-1 overflow-y-auto pr-1">
            {data && data.activity.length === 0 ? (
              <p className="text-[12px] text-zinc-500">No pipeline events in the last 3 days. Bots stay idle until the Hub records real work.</p>
            ) : (
              <ul className="space-y-2">
                {(data?.activity ?? []).map((a) => {
                  const bot = bots.find((b) => b.id === a.botId)
                  const color = a.tone === 'done' ? '#22c55e' : STATUS_META[a.tone].color
                  return (
                    <li key={a.id} className="flex gap-2 text-[11.5px] leading-snug">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
                      <span className="text-zinc-300">
                        <span className="font-mono text-zinc-500">{format(new Date(a.at), 'h:mm a')}</span> — <span className="font-medium" style={{ color: bot?.color }}>{bot?.name ?? a.botId}</span>: {a.text}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}
