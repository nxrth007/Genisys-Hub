'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Circle, Loader2, Mail, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { reportEmail, type ReadyItem, type ReportNumbers } from '@/lib/hl/client-report-plan'
import { postAction } from './confirm-dialog'

/** GET /api/clients/:id/report (src/lib/hl/client-report.ts). */
type View = {
  ready: boolean
  items: ReadyItem[]
  to: string | null
  logins: string[]
  draft: { business: string; firstName: string | null; numbers: ReportNumbers; site: { url: string; host: string }; phone: string; signInUrl: string } | null
  last: { at: string; to: string; by: string; login: boolean } | null
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * The client's report (Alex, 2026-11-15): once they're fully set up, email them what their system
 * did in the last 30 days, and the link to their dashboard login when they want one. Until then the
 * card lists what's still missing. Nothing is sent without the press in the preview.
 */
export function ClientReportCard({ clientId, canAct }: { clientId: string; canAct: boolean }) {
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/report`, { cache: 'no-store' })
      const data = (await res.json().catch(() => ({}))) as View & { error?: string }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setView(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [clientId])

  useEffect(() => {
    void load()
  }, [load])

  const missing = view?.items.filter((i) => !i.done) ?? []
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-foreground">Report for the client</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Email them what their system did in the last 30 days, with their dashboard login if they want one. Ready once they’re fully set up.
          </p>
        </div>
        {canAct && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={!view?.ready}
            title={view && !view.ready ? 'Ready once everything below is done' : undefined}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Mail className="h-3.5 w-3.5" /> Send report
          </button>
        )}
      </div>

      {!view && !error && (
        <p className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking their setup…
        </p>
      )}
      {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] text-foreground">Couldn’t check their setup: {error}</p>}

      {view && (
        <>
          <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {view.items.map((i) => (
              <li key={i.key} className="flex items-start gap-2 text-[12.5px]">
                {i.done ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />}
                <span className="min-w-0">
                  <span className={i.done ? 'text-foreground/90' : 'font-medium text-foreground'}>{i.label}</span>
                  {!i.done && i.note && <span className="block text-[11.5px] text-muted-foreground">{i.note}</span>}
                </span>
              </li>
            ))}
          </ul>
          {view.ready && view.draft ? (
            <p className="text-[12.5px] text-muted-foreground">
              Ready. Last 30 days: {view.draft.numbers.leads} new lead{view.draft.numbers.leads === 1 ? '' : 's'}, {view.draft.numbers.callsAnswered + view.draft.numbers.callsMissed} call
              {view.draft.numbers.callsAnswered + view.draft.numbers.callsMissed === 1 ? '' : 's'}, {view.draft.numbers.appointments} appointment{view.draft.numbers.appointments === 1 ? '' : 's'}.
            </p>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">{missing.length} thing{missing.length === 1 ? '' : 's'} to finish before the report can go out.</p>
          )}
          {view.last && (
            <p className="text-[12px] text-muted-foreground">
              Last sent {when(view.last.at)} to {view.last.to} by {view.last.by}
              {view.last.login ? ', with a login link' : ''}.
            </p>
          )}
        </>
      )}
      {msg && <p className="text-[12.5px] text-foreground/90">{msg}</p>}

      {open && view?.ready && view.draft && (
        <SendDialog
          clientId={clientId}
          view={view}
          onClose={() => setOpen(false)}
          onSent={(m) => {
            setMsg(m)
            setOpen(false)
            void load()
          }}
        />
      )}
    </section>
  )
}

/** The email as it will go, who to, and whether it carries their login link; then the press. */
function SendDialog({ clientId, view, onClose, onSent }: { clientId: string; view: View; onClose: () => void; onSent: (msg: string) => void }) {
  const draft = view.draft!
  const [to, setTo] = useState(view.to ?? '')
  const hasLogin = view.logins.includes(to.trim().toLowerCase())
  const [withLogin, setWithLogin] = useState(!view.logins.includes((view.to ?? '').toLowerCase()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && closeRef.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  // The preview's login button goes nowhere: the real link is made only when it's sent.
  const email = useMemo(() => reportEmail({ ...draft, login: withLogin ? { link: '#', email: to.trim() || 'their email' } : null }), [draft, withLogin, to])

  async function send() {
    setBusy(true)
    setError(null)
    const r = await postAction(`/api/clients/${clientId}/report`, { to, includeLogin: withLogin })
    setBusy(false)
    if (!r.ok) return setError(r.reason)
    onSent(`Sent to ${String(r.data.to ?? to)}${r.data.login ? ', with their login link' : ''}.`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[6vh] backdrop-blur-sm" onMouseDown={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Send the report" className="w-full max-w-2xl rounded-xl border border-border bg-popover shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
          <h2 className="text-[15px] font-semibold text-foreground">Email {draft.business} their report?</h2>
          <button type="button" onClick={onClose} disabled={busy} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-3 text-[13px] text-foreground/90">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-muted-foreground">To</span>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-9 rounded-lg border border-border bg-card px-3 text-[13px] text-foreground outline-none focus:border-foreground/40"
            />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={withLogin} onChange={(e) => setWithLogin(e.target.checked)} className="mt-0.5" />
            <span>
              Include their dashboard login (a link to choose their password, good for 7 days)
              {hasLogin && <span className="block text-[12px] text-muted-foreground">{to.trim()} already has a login: this sends a fresh link and the old one stops working.</span>}
            </span>
          </label>
          <p className="text-[12px] text-muted-foreground">Subject: {email.subject}</p>
          <iframe title="The report, as it will look" srcDoc={email.html} sandbox="" className="h-[440px] w-full rounded-lg border border-border bg-white" />
        </div>
        {error && <p className="mx-5 mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] leading-snug text-foreground">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={busy || !to.trim()}
            className={cn('inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50')}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Send report
          </button>
        </div>
      </div>
    </div>
  )
}
