'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Token = {
  id: string
  name: string
  prefix: string
  scope: string
  createdBy: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

function when(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

export function ApiTokensClient() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ ok: true; tokens: Token[] }>({
    queryKey: ['api-tokens'],
    queryFn: async () => {
      const res = await fetch('/api/admin/api-tokens')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Failed to load tokens')
      return d
    },
  })

  const create = useMutation({
    mutationFn: async (tokenName: string) => {
      const res = await fetch('/api/admin/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tokenName }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not create token')
      return d as { plaintext: string }
    },
    onSuccess: (d) => {
      setFresh(d.plaintext)
      setName('')
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] })
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : 'Could not create token'),
  })

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/api-tokens?id=${id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Could not revoke token')
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] }),
  })

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const live = (data?.tokens ?? []).filter((t) => !t.revokedAt)
  const dead = (data?.tokens ?? []).filter((t) => t.revokedAt)

  const reference = [
    `API base:  ${origin}/api/external/v1`,
    `Header:    Authorization: Bearer ghub_...`,
    ``,
    `GET /me            token check`,
    `GET /stats         dashboard numbers`,
    `GET /clients       client roster`,
    `GET /appointments  recent appointments (customer PII masked)`,
  ].join('\n')

  return (
    <div className="flex flex-col gap-6">
      {/* Freshly minted token — shown exactly once, never recoverable */}
      {fresh && (
        <div className="rounded-2xl border border-primary/30 bg-primary-soft p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-primary">
            <KeyRound className="h-4 w-4" />
            Copy this token now — it can&apos;t be shown again
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="flex-1 truncate rounded-xl border border-border bg-card px-3 py-2 font-mono text-xs">
              {fresh}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(fresh)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => setFresh(null)}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Paste it into the frontend&apos;s Connect screen. Only a hash is
            stored here, so there is no way to look it up later.
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-card p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Create */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-soft">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          New token
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="min-w-[240px] flex-1 rounded-xl border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lovable frontend — Ethan"
          />
          <button
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate(name)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary/90 disabled:opacity-50"
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Create token
          </button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : live.length === 0 && dead.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
          <KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            No tokens yet. Create one to connect the Lovable frontend.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {[...live, ...dead].map((t) => (
            <div
              key={t.id}
              className={cn(
                'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3',
                t.revokedAt && 'opacity-60',
              )}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {t.name}
                  {t.revokedAt && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      (revoked)
                    </span>
                  )}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {t.prefix}···· · last used {when(t.lastUsedAt)}
                </p>
              </div>
              {!t.revokedAt && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Revoke "${t.name}"? Any frontend using it stops working immediately.`,
                      )
                    )
                      return
                    revoke.mutate(t.id)
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Wiring reference */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-soft">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connecting a frontend
        </p>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-border-soft bg-surface-muted p-3 font-mono text-[11px] leading-relaxed">
          {reference}
        </pre>
      </div>
    </div>
  )
}
