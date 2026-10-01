'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, Plug, Unplug } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SeoIntegrations } from '@/lib/seo/api-types'
import { btnPrimary, btnSmall, fieldClass, seoFetch, seoKeys } from './ui'

/**
 * Connect Lovable — the Hub's own sign-in, so a merged change publishes
 * itself instead of waiting for someone to click Publish in the builder.
 *
 * Lovable only finishes a login at a local address for an app it hasn't
 * approved, so the last step is manual: after signing in, the browser
 * lands on a 127.0.0.1 page that doesn't load, and the person copies that
 * address back here. It happens once; the sign-in renews itself.
 */

type State = SeoIntegrations['lovable'] | undefined

export function LovableConnect({ state }: { state: State }) {
  const qc = useQueryClient()
  const [step, setStep] = useState<'idle' | 'waiting'>('idle')
  const [pasted, setPasted] = useState('')
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: seoKeys.overview })

  const start = useMutation({
    mutationFn: () => seoFetch<{ authorizeUrl: string }>('/api/seo/lovable/connect', { method: 'POST', body: { step: 'start' } }),
    onMutate: () => setNote(null),
    onSuccess: ({ authorizeUrl }) => {
      window.open(authorizeUrl, '_blank', 'noopener')
      setStep('waiting')
    },
    onError: (e: Error) => setNote({ tone: 'err', text: e.message }),
  })
  const finish = useMutation({
    mutationFn: () =>
      seoFetch<{ account: string | null }>('/api/seo/lovable/connect', { method: 'POST', body: { step: 'finish', redirectUrl: pasted } }),
    onMutate: () => setNote(null),
    onSuccess: ({ account }) => {
      setStep('idle')
      setPasted('')
      setNote({ tone: 'ok', text: `Connected${account ? ` as ${account}` : ''}. Merges now publish themselves.` })
      refresh()
    },
    onError: (e: Error) => setNote({ tone: 'err', text: e.message }),
  })
  const test = useMutation({
    mutationFn: () => seoFetch<{ account: string | null }>('/api/seo/lovable/connect', { method: 'POST', body: { step: 'test' } }),
    onMutate: () => setNote(null),
    onSuccess: ({ account }) => setNote({ tone: 'ok', text: `Working — signed in${account ? ` as ${account}` : ''}.` }),
    onError: (e: Error) => {
      setNote({ tone: 'err', text: e.message })
      refresh()
    },
  })
  const disconnect = useMutation({
    mutationFn: () => seoFetch<{ ok: true }>('/api/seo/lovable/connect', { method: 'DELETE' }),
    onMutate: () => setNote(null),
    onSuccess: () => {
      setNote({ tone: 'ok', text: 'Disconnected. Publishing goes back to a click in Lovable.' })
      refresh()
    },
    onError: (e: Error) => setNote({ tone: 'err', text: e.message }),
  })

  if (!state) return null
  // A Business-plan API key in the Vault already covers publishing.
  if (state.channel === 'api') return null
  const connected = state.channel === 'mcp'
  const busy = start.isPending || finish.isPending || test.isPending || disconnect.isPending

  return (
    <div className="mt-4 rounded-lg border border-border-soft bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <Plug className="h-3.5 w-3.5 text-muted-foreground" />
          {connected ? 'Lovable is connected' : state.broken ? 'Lovable needs reconnecting' : 'Publish without clicking in Lovable'}
        </p>
        <div className="flex items-center gap-2">
          {connected ? (
            <>
              <button type="button" className={btnSmall} disabled={busy} onClick={() => test.mutate()}>
                {test.isPending && <Loader2 className="h-3 w-3 animate-spin" />} Test
              </button>
              <button
                type="button"
                className={btnSmall}
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Disconnect Lovable? Merges will wait for someone to click Publish again.')) disconnect.mutate()
                }}
              >
                <Unplug className="h-3 w-3" /> Disconnect
              </button>
            </>
          ) : (
            step === 'idle' && (
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => start.mutate()}>
                {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                {state.broken ? 'Reconnect Lovable' : 'Connect Lovable'}
              </button>
            )
          )}
        </div>
      </div>

      {!connected && step === 'idle' && (
        <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground">
          A one-time sign-in, free on any Lovable plan. After that the Hub publishes each merged change itself, a few minutes
          after it lands, and checks the pages are live. Sign in with the Lovable account that owns the client sites.
        </p>
      )}

      {!connected && step === 'waiting' && (
        <div className="mt-2 flex flex-col gap-2 text-[12.5px] text-muted-foreground">
          <ol className="list-decimal space-y-1 pl-4 leading-snug">
            <li>In the tab that just opened, sign in to Lovable and approve the Genisys Hub.</li>
            <li>
              The tab then goes to an address starting with{' '}
              <span className="font-mono text-foreground/85">http://127.0.0.1:53682/callback</span> and shows “can’t be reached”. That is
              expected.
            </li>
            <li>Copy that whole address from the address bar and paste it here.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="http://127.0.0.1:53682/callback?code=…"
              spellCheck={false}
              className={cn(fieldClass, 'min-w-0 flex-1 font-mono text-[12px]')}
            />
            <button type="button" className={btnPrimary} disabled={busy || !pasted.trim()} onClick={() => finish.mutate()}>
              {finish.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Finish
            </button>
            <button
              type="button"
              className={btnSmall}
              disabled={busy}
              onClick={() => {
                setStep('idle')
                setPasted('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {note && <p className={cn('mt-2 text-[12.5px]', note.tone === 'ok' ? 'text-foreground/85' : 'text-destructive')}>{note.text}</p>}
    </div>
  )
}
