'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { AppWindow, Loader2, RotateCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { siteHost } from '@/lib/site-status'

/** Lovable's builder for a project, or straight at its Settings → Domains (the link Lovable's own app uses). */
export function lovableBuilderUrl(projectId: string, where: 'editor' | 'domains'): string {
  const base = `https://lovable.dev/projects/${encodeURIComponent(projectId)}`
  return where === 'domains' ? `${base}?view=more&subview=settings-domains` : base
}

/**
 * Lovable in its own window (a pop-up, not a tab) over the right of the
 * screen, so the Hub's window stays visible on the left. Lovable sends
 * X-Frame-Options: DENY, so its builder can't be shown inside the Hub.
 */
function openLovableWindow(projectId: string, where: 'editor' | 'domains', current: Window | null): Window | null {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number }
  const width = Math.min(s.availWidth, Math.max(960, Math.round(s.availWidth * 0.62)))
  const left = (s.availLeft ?? 0) + s.availWidth - width
  const win =
    current && !current.closed
      ? current
      : window.open('', `lovable-${projectId}`, `popup=yes,width=${width},height=${s.availHeight},left=${left},top=${s.availTop ?? 0}`)
  if (!win) return null
  try {
    // Lovable needs no handle back to the Hub.
    win.opener = null
  } catch {
    // Already showing Lovable (another origin): nothing to clear.
  }
  win.location.href = lovableBuilderUrl(projectId, where)
  win.focus()
  return win
}

/** What Lovable showed for the domain (its lovable_verify= code, or both): the Hub sets the DNS at Porkbun, or lists the records. */
export function DomainCodeBox({ clientId, domain, inputId }: { clientId: string; domain: string | null; inputId: string }) {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function paste() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/hl-site`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'code', text: code }) })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; detail?: string | null; error?: string }
      setMsg(out.ok ? out.detail || 'Done.' : out.reason || out.error || 'Couldn’t use that code.')
      if (out.ok) setCode('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[12.5px] text-foreground/90">
        Paste Lovable’s code for {domain ?? 'their domain'} (it starts with lovable_verify=; both codes if it shows two)
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="lovable_verify=…"
          spellCheck={false}
          className="min-w-[200px] flex-1 rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-[12.5px] text-foreground outline-none focus:border-foreground/40"
        />
        <button
          type="button"
          onClick={paste}
          disabled={busy || !code.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Connect it
        </button>
      </div>
      {msg && <p className="text-[12px] text-muted-foreground">{msg}</p>}
    </div>
  )
}

export type BuilderSite = {
  /** The Lovable project: Forge's copy, else the SEO seat's. */
  projectId: string
  /** Where the site shows now: their connected domain, the published lovable.app address, or the site link in Clients. */
  siteUrl: string | null
}

type Frame = { url: string; kind: 'live' | 'latest' }

/**
 * The client's website, managed from inside the Hub: the site itself on the
 * right, and on the left Lovable's builder (in its own window beside this
 * one) with the steps and paste box for connecting their domain.
 */
export function BuilderWindow({
  open,
  onClose,
  clientId,
  clientName,
  site,
  connect,
  detail,
}: {
  open: boolean
  onClose: () => void
  clientId: string
  clientName: string
  site: BuilderSite
  /** Forge is connecting this domain and waits for Lovable's code. */
  connect: { domain: string; managed: boolean } | null
  /** Where Forge's build stands, as the folder says it. */
  detail: string | null
}) {
  const lovable = useRef<Window | null>(null)
  const lastWhere = useRef<'editor' | 'domains' | null>(null)
  const [lovableOpen, setLovableOpen] = useState(false)
  // A browser that allows no pop-up windows (the desktop app's browser pane, a blocker): which one it refused.
  const [blocked, setBlocked] = useState<'editor' | 'domains' | null>(null)
  const [frame, setFrame] = useState<Frame | null>(site.siteUrl ? { url: site.siteUrl, kind: 'live' } : null)
  const [loading, setLoading] = useState(false)
  const [frameNote, setFrameNote] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const closeRef = useRef<HTMLButtonElement>(null)
  // The folder passes a new onClose each render (a refresh after a paste): opening runs once regardless.
  const closeCb = useRef(onClose)
  closeCb.current = onClose

  /** Lovable's own preview of the latest build (no Lovable login), for one hour on the Hub's address. */
  async function showLatest() {
    setLoading(true)
    setFrameNote(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/hl-site`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'embed' }) })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; reason?: string; error?: string }
      if (out.ok && out.url) setFrame({ url: out.url, kind: 'latest' })
      else setFrameNote(out.reason || out.error || 'Lovable wouldn’t show the latest version here. Open it in Lovable’s builder.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeCb.current()
    window.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    // Whether Lovable's window is still open, for the "bring it forward" line.
    const watch = window.setInterval(() => setLovableOpen(!!lovable.current && !lovable.current.closed), 1500)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      window.clearInterval(watch)
    }
  }, [open])

  useEffect(() => {
    // Not published anywhere yet: show Lovable's preview of the build straight away.
    if (open && !frame && !loading && !frameNote) void showLatest()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open])

  if (!open) return null

  function openLovable(where: 'editor' | 'domains') {
    const current = lovable.current && !lovable.current.closed ? lovable.current : null
    if (current && lastWhere.current === where) {
      current.focus()
      return
    }
    const win = openLovableWindow(site.projectId, where, current)
    setBlocked(win ? null : where)
    if (win) {
      lovable.current = win
      lastWhere.current = where
      setLovableOpen(true)
    }
  }

  const primary = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50'
  const secondary = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50'

  return (
    <div className="fixed inset-0 z-50 flex bg-black/70 p-2 backdrop-blur-sm sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${clientName}’s website`}
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">{clientName} · Website builder</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex max-h-[45%] shrink-0 flex-col gap-5 overflow-y-auto border-b border-border p-4 md:max-h-none md:w-[340px] md:border-b-0 md:border-r">
            <section className="flex flex-col gap-2">
              <h3 className="text-[13px] font-semibold text-foreground">Lovable’s builder</h3>
              <p className="text-[12.5px] leading-snug text-muted-foreground">
                Lovable doesn’t let its builder show inside other sites, so it opens in its own window on the right, with this one beside it. Sign in to Lovable there if it asks.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => openLovable('domains')} className={connect ? primary : secondary}>
                  Open Lovable at Domains
                </button>
                <button type="button" onClick={() => openLovable('editor')} className={connect ? secondary : primary}>
                  Open Lovable builder
                </button>
              </div>
              {lovableOpen && <p className="text-[12px] text-emerald-600 dark:text-emerald-400">Lovable is open in its own window. The buttons bring it forward.</p>}
              {blocked && (
                <p className="text-[12px] leading-snug text-amber-600 dark:text-amber-400">
                  This browser didn’t open Lovable’s window. Allow pop-ups for the Hub and press it again, or{' '}
                  <a href={lovableBuilderUrl(site.projectId, blocked)} target="_blank" rel="noopener noreferrer" className="underline">
                    open Lovable in a tab
                  </a>
                  .
                </p>
              )}
            </section>

            {connect && (
              <section className="flex flex-col gap-2">
                <h3 className="text-[13px] font-semibold text-foreground">Connect {connect.domain}</h3>
                <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-[12.5px] leading-snug text-foreground/90">
                  <li>In Lovable’s window (Open Lovable at Domains): Connect domain, type {connect.domain}, Continue, keeping the www redirect on.</li>
                  <li>Choose Connect a different way, then Set up manually. Copy the value that starts with lovable_verify= (both, if it shows two), then press Done.</li>
                  <li>
                    Paste it here and press Connect it.{' '}
                    {connect.managed
                      ? 'The Hub sets the DNS at Porkbun and finishes on its own; Lovable’s certificate can take a few hours.'
                      : 'The Hub lists the DNS records to add where the domain’s DNS is managed.'}
                  </li>
                </ol>
                <DomainCodeBox clientId={clientId} domain={connect.domain} inputId="builder-lovable-code" />
              </section>
            )}

            {detail && !connect && (
              <section className="flex flex-col gap-1">
                <h3 className="text-[13px] font-semibold text-foreground">Where it stands</h3>
                <p className="whitespace-pre-wrap break-words text-[12px] leading-snug text-muted-foreground">{detail}</p>
              </section>
            )}
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
                {frame ? (frame.kind === 'live' ? siteHost(frame.url) : 'Latest version in Lovable (not published)') : loading ? 'Loading the latest version…' : 'Nothing to show yet'}
              </span>
              {site.siteUrl && (
                <div role="radiogroup" aria-label="Show" className="flex rounded-lg border border-border bg-card p-0.5">
                  {(
                    [
                      ['live', 'Live site'],
                      ['latest', 'Latest version'],
                    ] as const
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={frame?.kind === kind}
                      disabled={loading}
                      onClick={() => {
                        if (kind === 'latest') return void showLatest()
                        setFrameNote(null)
                        setFrame({ url: site.siteUrl!, kind: 'live' })
                      }}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-[12px] font-medium transition',
                        frame?.kind === kind ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setReload((n) => n + 1)}
                disabled={!frame}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                aria-label="Reload the site"
              >
                <RotateCw className="h-4 w-4" />
              </button>
            </div>
            {frameNote && <p className="border-b border-border bg-amber-500/10 px-3 py-2 text-[12.5px] leading-snug text-foreground">{frameNote}</p>}
            {frame ? (
              <iframe
                key={`${frame.url}#${reload}`}
                src={frame.url}
                title={`${clientName}’s website`}
                className="min-h-0 w-full flex-1 bg-white"
                // The site runs as itself; it can't move the Hub's page away.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              />
            ) : (
              <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-muted-foreground">
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Not published yet. Open Lovable’s builder to see it.'}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
