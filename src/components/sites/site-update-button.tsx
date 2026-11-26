'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, MessageSquareShare, X } from 'lucide-react'
import { prettyPhone, siteUpdateText, type SiteUpdateView } from '@/lib/hl/site-update-plan'
import { postAction } from './confirm-dialog'

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * "Send Site Update" (Alex, 2026-11-25), at the right end of the folder's Site/Repo/Stripe strip
 * once the site is live on their own domain: a text to the owner from Lead Genisys's GHL
 * sub-account with the first draft's link and their Genisys OS login. Nothing is sent without the
 * press in the preview; the last send shows under the button.
 */
export function SiteUpdateButton({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const q = useQuery<SiteUpdateView>({
    queryKey: ['site-update', clientId],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/site-update`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    staleTime: 30_000,
    retry: false,
  })
  const view = q.data
  if (!view?.ready) return null
  const last = view.last
  return (
    <div className="ml-auto flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground transition hover:bg-muted"
      >
        <MessageSquareShare className="h-4 w-4" /> Send Site Update
      </button>
      {msg ? (
        <p className="text-[11.5px] text-foreground/90">{msg}</p>
      ) : last ? (
        <p className="max-w-[320px] text-right text-[11.5px] text-muted-foreground">
          {last.ok ? `Sent ${when(last.at)} to ${prettyPhone(last.to)} by ${last.by}${last.login ? ', with a login' : ''}` : `Didn’t go out ${when(last.at)}: ${last.detail ?? 'failed'}`}
        </p>
      ) : null}
      {open && (
        <SendDialog
          clientId={clientId}
          view={view}
          onClose={() => setOpen(false)}
          onSent={(m) => {
            setMsg(m)
            setOpen(false)
            void q.refetch()
          }}
        />
      )}
    </div>
  )
}

/** The text as it will go, who to, and whether it carries their login link; then the press. */
function SendDialog({ clientId, view, onClose, onSent }: { clientId: string; view: SiteUpdateView; onClose: () => void; onSent: (msg: string) => void }) {
  const [to, setTo] = useState(view.to ? prettyPhone(view.to) : '')
  const [email, setEmail] = useState(view.email ?? '')
  const [withLogin, setWithLogin] = useState(view.canLogin && !!view.email)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasLogin = view.logins.includes(email.trim().toLowerCase())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // The preview's link is a stand-in: the real one is made only when it's sent.
  const text = siteUpdateText({
    firstName: view.firstName,
    siteUrl: view.siteUrl ?? '',
    login: withLogin ? { link: '(their link to choose a password)', email: email.trim() || 'their email', signInUrl: view.signInUrl } : null,
  })

  async function send() {
    setBusy(true)
    setError(null)
    const r = await postAction(`/api/clients/${clientId}/site-update`, { to, email: email.trim() || null, includeLogin: withLogin })
    setBusy(false)
    if (!r.ok) return setError(r.reason)
    onSent(`Sent to ${String(r.data.to ?? to)}${r.data.login ? `, with a login for ${String(r.data.login)}` : ''}.`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[6vh] backdrop-blur-sm" onMouseDown={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Send the site update" className="w-full max-w-xl rounded-xl border border-border bg-popover text-left shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
          <h2 className="text-[15px] font-semibold text-foreground">Text {view.business} their site update?</h2>
          <button type="button" onClick={onClose} disabled={busy} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-3 text-[13px] text-foreground/90">
          <p className="text-[12.5px] text-muted-foreground">Goes out from Lead Genisys’s GHL sub-account, the line our texts to clients come from.</p>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-muted-foreground">To (the owner’s cell)</span>
            <input
              type="tel"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="(555) 123-4567"
              className="h-9 rounded-lg border border-border bg-card px-3 text-[13px] text-foreground outline-none focus:border-foreground/40"
            />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={withLogin} disabled={!view.canLogin} onChange={(e) => setWithLogin(e.target.checked)} className="mt-0.5" />
            <span>
              Include their Genisys OS login (a link to choose their password, good for 7 days)
              {!view.canLogin && <span className="block text-[12px] text-muted-foreground">They have no Genisys OS sub-account yet, so there’s no login to send.</span>}
              {hasLogin && withLogin && <span className="block text-[12px] text-muted-foreground">{email.trim()} already has a login: this sends a fresh link and the old one stops working.</span>}
            </span>
          </label>
          {withLogin && (
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-muted-foreground">Their email (what they sign in with)</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@example.com"
                className="h-9 rounded-lg border border-border bg-card px-3 text-[13px] text-foreground outline-none focus:border-foreground/40"
              />
            </label>
          )}
          <pre className="max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card px-3 py-2.5 font-sans text-[12.5px] leading-relaxed text-foreground/90">{text}</pre>
          {view.goesOutAt && <p className="text-[12px] text-amber-600 dark:text-amber-400">It’s outside 9 AM to 7 PM where they are, so it can’t go out now. Try again at {view.goesOutAt}.</p>}
        </div>
        {error && <p className="mx-5 mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] leading-snug text-foreground">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={busy || !to.trim() || !!view.goesOutAt || (withLogin && !email.trim())}
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Send the text
          </button>
        </div>
      </div>
    </div>
  )
}
