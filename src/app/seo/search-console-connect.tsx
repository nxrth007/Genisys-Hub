'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, Search, Unplug } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SeoIntegrations } from '@/lib/seo/api-types'
import { btnPrimary, btnSmall, seoFetch, seoKeys } from './ui'

/**
 * Connect Search Console — one Google sign-in, after which the Hub
 * verifies every client site with Google and adds it to that account's
 * Search Console by itself (lib/seo/gsc-connect.ts). It rides on the
 * Hub's existing Google sign-in, so the browser goes to Google and comes
 * straight back here.
 */

export type GscNotice = { tone: 'ok' | 'err'; text: string }

type State = SeoIntegrations['searchConsole'] | undefined

const STATUS_DOT: Record<string, string> = {
  connected: 'bg-emerald-400',
  working: 'bg-sky-400 animate-pulse',
  waiting: 'bg-muted-foreground/50',
  needs_person: 'bg-amber-400',
}

export function SearchConsoleConnect({ state, notice }: { state: State; notice?: GscNotice }) {
  const qc = useQueryClient()
  const [note, setNote] = useState<GscNotice | null>(notice ?? null)
  const disconnect = useMutation({
    mutationFn: () => seoFetch<{ ok: true }>('/api/seo/gsc/connect', { method: 'DELETE' }),
    onMutate: () => setNote(null),
    onSuccess: () => {
      setNote({ tone: 'ok', text: 'Search Console disconnected. Sites already connected keep their property; nothing new gets connected.' })
      qc.invalidateQueries({ queryKey: seoKeys.overview })
    },
    onError: (e: Error) => setNote({ tone: 'err', text: e.message }),
  })

  if (!state) return null
  const connected = !!state.account
  const project = state.googleProject
  const apiLink = (api: string) =>
    `https://console.cloud.google.com/apis/library/${api}${project ? `?project=${encodeURIComponent(project)}` : ''}`

  return (
    <div className="mt-4 rounded-lg border border-border-soft bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          {connected ? `Search Console: ${state.account}` : 'Connect every site to Search Console'}
        </p>
        {connected ? (
          <button
            type="button"
            className={btnSmall}
            disabled={disconnect.isPending}
            onClick={() => {
              if (window.confirm('Disconnect Search Console? Connected sites keep their property, but no new sites get connected.')) disconnect.mutate()
            }}
          >
            {disconnect.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unplug className="h-3 w-3" />} Disconnect
          </button>
        ) : (
          <a href="/api/seo/gsc/connect" className={btnPrimary}>
            <ExternalLink className="h-4 w-4" /> Connect Search Console
          </a>
        )}
      </div>

      {!connected && (
        <div className="mt-1.5 flex flex-col gap-1.5 text-[12px] leading-snug text-muted-foreground">
          <p>
            One Google sign-in with the account that should own the sites in Search Console. After that the Hub verifies each
            client site with Google, adds it, submits its sitemap and pulls its search data &mdash; including every new client.
          </p>
          <p>
            First time only: switch on two Google APIs for the Hub&rsquo;s Cloud project &mdash;{' '}
            <a className="text-foreground underline underline-offset-2" href={apiLink('searchconsole.googleapis.com')} target="_blank" rel="noopener noreferrer">
              Search Console API
            </a>{' '}
            and{' '}
            <a className="text-foreground underline underline-offset-2" href={apiLink('siteverification.googleapis.com')} target="_blank" rel="noopener noreferrer">
              Site Verification API
            </a>{' '}
            (open each, click Enable).
          </p>
        </div>
      )}

      {connected && state.sites.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {state.sites.map((s) => (
            <li key={s.siteId} className="flex items-start gap-2 text-[12px] leading-snug">
              <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[s.status] ?? STATUS_DOT.waiting)} />
              <span className="min-w-0">
                <span className="font-medium text-foreground/90">{s.name}</span>{' '}
                <span className={s.status === 'needs_person' ? 'text-amber-300/90' : 'text-muted-foreground'}>{linkify(s.detail)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {note && <p className={cn('mt-2 text-[12.5px]', note.tone === 'ok' ? 'text-foreground/85' : 'text-destructive')}>{note.text}</p>}
    </div>
  )
}

/** Google's "switch this API on" errors carry a console link — make it clickable. */
function linkify(text: string) {
  const m = /https:\/\/console\.(?:cloud|developers)\.google\.com\/\S+/.exec(text)
  if (!m) return text
  return (
    <>
      {text.slice(0, m.index)}
      <a className="text-foreground underline underline-offset-2" href={m[0]} target="_blank" rel="noopener noreferrer">
        switch it on
      </a>
      {text.slice(m.index + m[0].length)}
    </>
  )
}
