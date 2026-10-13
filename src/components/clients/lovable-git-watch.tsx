'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ExternalLink, GitBranch, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GitWatchView, WatchedProject } from '@/lib/seo/lovable-git-watch'

/**
 * One strip under the Clients header: new Lovable projects and whether
 * they're on GitHub yet. Lovable only links a project to GitHub from its
 * own settings, so the Hub checks daily, links each new project straight
 * to that screen, and once it's connected attaches the repo to the client.
 * Hidden for anyone without SEO access.
 */

const KEY = ['lovable-git-watch']

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const d = Math.floor(ms / 86_400_000)
  if (d >= 1) return d === 1 ? 'yesterday' : `${d} days ago`
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return `${h}h ago`
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

async function post(body: Record<string, unknown>): Promise<{ view: GitWatchView }> {
  const res = await fetch('/api/seo/lovable/git-watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
  return data
}

export function LovableGitWatch() {
  const qc = useQueryClient()
  const q = useQuery<GitWatchView | null>({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch('/api/seo/lovable/git-watch')
      if (res.status === 403) return null
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      return res.json()
    },
    staleTime: 60_000,
  })
  const act = useMutation({
    mutationFn: post,
    onSuccess: (data) => {
      qc.setQueryData(KEY, data.view)
      qc.invalidateQueries({ queryKey: ['clients-roster'] })
    },
  })

  const v = q.data
  if (!v) return null

  const pending = v.projects.filter((p) => p.status === 'needs_github')
  const unlinked = v.projects.filter((p) => p.status === 'connected' && p.attach !== 'attached')
  const checkedAt = v.lastRunAt ? Date.parse(v.lastRunAt) : 0
  const recent = v.projects.filter(
    (p) => p.status === 'connected' && p.attach === 'attached' && p.connectedAt && checkedAt - Date.parse(p.connectedAt) < 7 * 86_400_000,
  )

  const problem = !v.connected
    ? 'Lovable isn’t connected to the Hub — connect it on the SEO page.'
    : v.lastError
      ? v.lastError
      : pending.length
        ? `${pending.length} new project${pending.length === 1 ? '' : 's'} need${pending.length === 1 ? 's' : ''} GitHub.`
        : unlinked.length
          ? `${unlinked.length} connected project${unlinked.length === 1 ? '' : 's'} need${unlinked.length === 1 ? 's' : ''} a client.`
          : null

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border px-4 py-2.5 text-[12.5px]',
        problem ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border-soft bg-surface text-muted-foreground',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
          <GitBranch className="h-3.5 w-3.5" /> Lovable → GitHub
        </span>
        <span className="inline-flex items-center gap-1.5">
          {problem ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />}
          {problem ?? 'Every new project is on GitHub'}
        </span>
        <span>
          {v.startedAt
            ? `Watching projects created since ${day(v.startedAt)}${v.lastRunAt ? `, checked ${ago(v.lastRunAt)}` : ''}`
            : 'Starts watching on its first check — projects that exist then are left alone.'}
        </span>
        <span className="ml-auto">
          <button
            type="button"
            onClick={() => act.mutate({ action: 'run' })}
            disabled={act.isPending || !v.connected}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground/85 transition hover:bg-muted disabled:opacity-50"
          >
            {act.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Check now
          </button>
        </span>
      </div>

      {(pending.length > 0 || unlinked.length > 0 || recent.length > 0) && (
        <ul className="flex flex-col divide-y divide-border-soft rounded-lg border border-border-soft bg-card text-[12.5px] text-foreground">
          {pending.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="font-medium">{p.name}</span>
              <span className="text-muted-foreground">
                {p.createdAt ? `created ${day(p.createdAt)}` : `seen ${day(p.firstSeenAt)}`} · Settings → Git → GitHub → Connect
              </span>
              <span className="ml-auto flex items-center gap-2">
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium hover:bg-muted"
                >
                  Open in Lovable <ExternalLink className="h-3 w-3" />
                </a>
                <button
                  type="button"
                  onClick={() => act.mutate({ action: 'dismiss', projectId: p.id })}
                  disabled={act.isPending}
                  className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  title="Not a client site — stop flagging it"
                >
                  Not a client site
                </button>
              </span>
            </li>
          ))}
          {unlinked.map((p) => (
            <UnlinkedRow key={p.id} p={p} clients={v.clients} busy={act.isPending} onAttach={(clientId) => act.mutate({ action: 'attach', projectId: p.id, clientId })} />
          ))}
          {recent.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              <span className="font-medium text-foreground">{p.name}</span>
              <span className="font-mono text-[11.5px]">{p.repoFullName}</span>
              <span>→ linked to {p.clientName}</span>
            </li>
          ))}
        </ul>
      )}
      {act.isError && <p className="text-[12px] text-destructive">{(act.error as Error).message}</p>}
    </div>
  )
}

function UnlinkedRow({
  p,
  clients,
  busy,
  onAttach,
}: {
  p: WatchedProject
  clients: GitWatchView['clients']
  busy: boolean
  onAttach: (clientId: string) => void
}) {
  const [clientId, setClientId] = useState(p.clientId ?? '')
  const options = clients.filter((c) => !c.repoFullName || c.repoFullName.toLowerCase() === p.repoFullName?.toLowerCase() || c.id === p.clientId)
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
      <span className="font-medium">{p.name}</span>
      <span className="font-mono text-[11.5px] text-muted-foreground">{p.repoFullName}</span>
      {p.note && <span className="text-muted-foreground">{p.note}</span>}
      <span className="ml-auto flex items-center gap-2">
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="h-7 rounded-md border border-border bg-surface px-2 text-[12px] outline-none"
        >
          <option value="">Pick a client…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!clientId || busy}
          onClick={() => onAttach(clientId)}
          className="rounded-md border border-border px-2 py-1 text-[11.5px] font-medium hover:bg-muted disabled:opacity-50"
        >
          Link repo
        </button>
      </span>
    </li>
  )
}
