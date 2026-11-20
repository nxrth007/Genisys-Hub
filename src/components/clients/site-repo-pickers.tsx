'use client'

/**
 * The two pickers that say where a client's website lives, shared by the
 * Clients page (its Site and Repo columns, and the client drawer) and a
 * client's folder in Sites (the top of the folder):
 *
 *   SiteLink    the site we built: a link once it is set; an inline field to
 *               paste it into until then, with the live sites the Hub found
 *               for the client listed under it (green = the page names the
 *               business)
 *   RepoSelect  the GitHub repo the site lives in: a dropdown of the agency's
 *               repos, the Hub's guess first and in green, repos another
 *               client already holds greyed out
 *
 * useRepoGuesses works out who holds which repo and the Hub's guess for each
 * client (src/lib/site-match.ts) from whatever client list the page has.
 * Both pickers take `onSaved`, for a page rendered on the server that needs
 * to refresh itself (the folder).
 */
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ExternalLink, FolderGit2, Globe, Loader2, Pencil, TrendingUp, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { suggestReposForClients, type RepoSuggestion } from '@/lib/site-match'
import type { SiteSuggestion } from '@/lib/site-suggestions'
import type { GitWatchView } from '@/lib/seo/lovable-git-watch'

export type { RepoSuggestion }

/** What the pickers need to know about a client. The Clients page's roster rows fit as they are. */
export type PickerClient = {
  id: string
  name: string
  siteUrl: string | null
  archivedAt: string | null
  /** The client's SEO site, which holds the repo link (null: none yet, or archived). */
  seo: { siteId: string; repoFullName: string | null } | null
}

/** A client as the repo guess reads it: its owners' names and every address the Hub holds for it. */
export type RepoMatchClient = PickerClient & {
  people: (string | null | undefined)[]
  addresses: (string | null | undefined)[]
}

/** The queries a saved site link or repo changes, wherever they're shown. */
const AFFECTED = [['clients-roster'], ['clients'], ['clients-repo-context'], ['tracker']] as const

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * The site we built. A link once it is set; an inline field to paste
 * it into until then. Enter saves, Esc cancels, clicking the pencil
 * reopens it for changes. While the field is open, the live sites the
 * Hub found for this client are listed under it (green = the page names
 * the business); clicking one saves it.
 */
export function SiteLink({ client, size = 'sm', onSaved }: { client: PickerClient; size?: 'sm' | 'md'; onSaved?: () => void }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(client.siteUrl ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  const found = useQuery<{ suggestions: SiteSuggestion[] }>({
    queryKey: ['site-suggestions', client.id],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${client.id}/site-suggestions`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Couldn’t look for sites (${res.status})`)
      return data
    },
    enabled: editing,
    staleTime: 5 * 60_000,
    retry: false,
  })

  const save = useMutation({
    mutationFn: async (siteUrl: string) => {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteUrl }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save')
      }
    },
    onSuccess: () => {
      for (const queryKey of AFFECTED) qc.invalidateQueries({ queryKey: [...queryKey] })
      // The Home globe fires an arc for a newly live site.
      qc.invalidateQueries({ queryKey: ['home-globe'] })
      setEditing(false)
      onSaved?.()
    },
  })

  function open() {
    setValue(client.siteUrl ?? '')
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  if (editing) {
    const options = (found.data?.suggestions ?? []).filter((s) => !s.current)
    return (
      <div className="flex flex-col gap-1.5">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate(value.trim())
          }}
          className="flex items-center gap-1.5"
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
            }}
            placeholder="https://"
            spellCheck={false}
            className={cn(
              'rounded-md border border-border bg-surface px-2 font-mono text-[12px] outline-none focus:border-foreground/30',
              size === 'sm' ? 'h-7 w-44' : 'h-9 w-72',
            )}
          />
          <button
            type="submit"
            disabled={save.isPending}
            className="grid h-7 w-7 place-items-center rounded-md border border-border text-foreground hover:bg-muted disabled:opacity-50"
            title="Save"
          >
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          {save.isError && (
            <span className="text-xs text-destructive">{(save.error as Error).message}</span>
          )}
        </form>
        {found.isFetching ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Looking for this client’s live site…
          </span>
        ) : found.isError ? (
          <span className="text-[11px] text-muted-foreground">{(found.error as Error).message}</span>
        ) : found.data && !options.length ? (
          <span className="text-[11px] text-muted-foreground">No live site found yet. Paste it above.</span>
        ) : (
          options.map((s) => (
            <button
              key={s.url}
              type="button"
              disabled={save.isPending}
              onClick={() => {
                if (s.takenBy && !window.confirm(`${hostOf(s.url)} is already ${s.takenBy}’s site. Use it for ${client.name} too?`)) return
                setValue(s.url)
                save.mutate(s.url)
              }}
              title={[
                s.title,
                s.confirmed
                  ? 'Our Lovable build, and the page names this business'
                  : s.lovable
                    ? 'On Lovable, but the page doesn’t name this business'
                    : 'Not on Lovable: likely the client’s own or older site',
                `Found from: ${s.from.join(', ')}`,
              ]
                .filter(Boolean)
                .join('\n')}
              className={cn(
                'inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[12px] transition disabled:opacity-50',
                s.takenBy
                  ? 'border-border text-muted-foreground/70 hover:text-foreground'
                  : s.confirmed
                    ? 'border-success/40 bg-success/10 text-success hover:bg-success/15'
                    : 'border-dashed border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {s.confirmed && !s.takenBy ? <Check className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
              {hostOf(s.url)}
              {s.takenBy ? <span className="font-sans text-[11px]">· {s.takenBy}’s</span> : null}
            </button>
          ))
        )}
      </div>
    )
  }

  if (client.siteUrl) {
    return (
      <span className="group inline-flex items-center gap-1.5">
        <a
          href={client.siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[12px] text-foreground transition hover:border-foreground/30',
            size === 'md' && 'px-2.5 py-1.5 text-[13px]',
          )}
          title={client.siteUrl}
        >
          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
          {hostOf(client.siteUrl)}
          <ExternalLink className="h-3 w-3 text-muted-foreground/70" />
        </a>
        <button
          type="button"
          onClick={open}
          className={cn(
            'grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground',
            // In the table the pencil waits for a hover; on the folder it's always there.
            size === 'sm' && 'opacity-0 group-hover:opacity-100',
          )}
          title="Change link"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 font-mono text-[12px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground',
        size === 'md' && 'px-2.5 py-1.5 text-[13px]',
      )}
    >
      <Globe className="h-3.5 w-3.5" /> Add site link
    </button>
  )
}

type GithubRepo = { fullName: string; private: boolean; pushedAt: string | null }

/** The repos on the agency's GitHub account. Only people who can use SEO can load them. */
export function useGithubRepos() {
  return useQuery<{ repos: GithubRepo[] }>({
    queryKey: ['seo-github-repos'],
    queryFn: async () => {
      const res = await fetch('/api/seo/github/repos')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not load repos (${res.status})`)
      return data
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/**
 * Who holds which repo (so the dropdown greys out a repo another client
 * has) and the repo each client most likely lives in (shown in green),
 * worked out over the whole client list the page has.
 */
export function useRepoGuesses(clients: RepoMatchClient[]): { repoOwners: Map<string, string>; suggestions: Map<string, RepoSuggestion> } {
  const repoOwners = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of clients) if (c.seo?.repoFullName) m.set(c.seo.repoFullName.toLowerCase(), c.name)
    return m
  }, [clients])
  const repoList = useGithubRepos()
  const gitWatch = useQuery<GitWatchView | null>({
    queryKey: ['lovable-git-watch'],
    queryFn: async () => {
      const res = await fetch('/api/seo/lovable/git-watch')
      if (res.status === 403) return null
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      return res.json()
    },
    staleTime: 60_000,
  })
  const suggestions = useMemo(() => {
    const repos = (repoList.data?.repos ?? []).map((r) => r.fullName)
    if (!repos.length) return new Map<string, RepoSuggestion>()
    const live = clients.filter((c) => !c.archivedAt)
    return suggestReposForClients(
      live.map((c) => ({ id: c.id, name: c.name, people: c.people, addresses: c.addresses, repoFullName: c.seo?.repoFullName ?? null })),
      repos,
      (gitWatch.data?.projects ?? []).map((p) => ({ name: p.name, repoFullName: p.repoFullName, clientId: p.clientId })),
    )
  }, [clients, repoList.data, gitWatch.data])
  return { repoOwners, suggestions }
}

/**
 * The GitHub repo the client's website lives in — a dropdown of the repos
 * on the agency's GitHub account, styled like the Site chip. Picking one
 * links the client's SEO site to it (and moves it from Audit to Review, so
 * the engine can open pull requests that a person approves).
 *
 * A native <select> on purpose: the Clients table scrolls sideways, and a
 * custom popup would be clipped by that scroll area. Only people who can
 * use SEO can load the repo list; everyone else sees the repo as plain text.
 *
 * The Hub's guess (src/lib/site-match.ts) shows in green: the suggested
 * repo tops the list, an unlinked client gets a one-click chip, and a
 * linked repo that matches the guess turns green. A linked repo that
 * differs from the guess gets an amber dot worth a second look.
 */
export function RepoSelect({
  client,
  repoOwners,
  suggestion,
  size = 'sm',
  onSaved,
}: {
  client: PickerClient
  repoOwners: Map<string, string>
  suggestion?: RepoSuggestion
  size?: 'sm' | 'md'
  onSaved?: () => void
}) {
  const qc = useQueryClient()
  const current = client.seo?.repoFullName ?? ''

  const repos = useGithubRepos()

  const assign = useMutation({
    mutationFn: async (repoFullName: string) => {
      const res = await fetch(`/api/clients/${client.id}/repo`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoFullName: repoFullName || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      return data as { siteId: string; repoFullName: string | null }
    },
    onSuccess: () => {
      for (const queryKey of AFFECTED) qc.invalidateQueries({ queryKey: [...queryKey] })
      qc.invalidateQueries({ queryKey: ['seo-overview'] })
      onSaved?.()
    },
  })

  const short = (full: string) => full.split('/').pop() ?? full
  const md = size === 'md'

  // Not allowed to manage repos (or GitHub isn't connected): show, don't edit.
  if (repos.isError || client.archivedAt) {
    return current ? (
      <span className={cn('inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[12px]', md && 'px-2.5 py-1.5 text-[13px]')} title={current}>
        <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
        {short(current)}
      </span>
    ) : (
      <span className="text-muted-foreground/50">—</span>
    )
  }

  const list = repos.data?.repos ?? []
  // Keep the current repo selectable even if the list hasn't loaded or no longer has it.
  const withCurrent =
    current && !list.some((r) => r.fullName.toLowerCase() === current.toLowerCase())
      ? [{ fullName: current, private: true, pushedAt: null }, ...list]
      : list
  const suggested = suggestion?.repo ?? null
  const isSuggested = (fullName: string) => !!suggested && fullName.toLowerCase() === suggested.toLowerCase()
  // The suggested repo first.
  const options = suggested
    ? [...withCurrent.filter((r) => isSuggested(r.fullName)), ...withCurrent.filter((r) => !isSuggested(r.fullName))]
    : withCurrent
  const matches = !!current && isSuggested(current)
  const differs = !!current && !!suggested && !matches
  const busy = assign.isPending || repos.isLoading

  return (
    <span className="group inline-flex flex-wrap items-center gap-1.5">
      <span
        className={cn(
          'relative inline-flex items-center rounded-md border font-mono transition focus-within:border-foreground/30 hover:border-foreground/30',
          md ? 'text-[13px]' : 'text-[12px]',
          matches
            ? 'border-success/40 bg-success/10 text-success'
            : current
              ? 'border-border bg-surface text-foreground'
              : 'border-dashed border-border text-muted-foreground hover:text-foreground',
          busy && 'opacity-60',
        )}
        title={
          matches
            ? `${current}\nMatches this client: ${suggestion!.why}`
            : current || 'Pick the GitHub repo this client’s site lives in'
        }
      >
        {assign.isPending ? (
          <Loader2 className={cn('pointer-events-none absolute h-3.5 w-3.5 animate-spin', md ? 'left-2.5' : 'left-2')} />
        ) : (
          <FolderGit2 className={cn('pointer-events-none absolute h-3.5 w-3.5', md ? 'left-2.5' : 'left-2', matches ? 'text-success' : 'text-muted-foreground')} />
        )}
        <select
          value={current}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value
            if (next === current) return
            if (!next && !window.confirm(`Unlink ${short(current)} from ${client.name}? The SEO engine goes back to audit-only for this client.`)) return
            assign.mutate(next)
          }}
          className={cn('max-w-[18rem] cursor-pointer appearance-none truncate bg-transparent focus:outline-none', md ? 'py-1.5 pl-8 pr-7' : 'py-1 pl-7 pr-6')}
        >
          <option value="">{current ? 'No repo' : 'Assign repo'}</option>
          {options.map((r) => {
            const owner = repoOwners.get(r.fullName.toLowerCase())
            const taken = !!owner && owner !== client.name
            const pick = isSuggested(r.fullName)
            return (
              <option
                key={r.fullName}
                value={r.fullName}
                disabled={taken}
                style={pick ? { color: 'var(--success)', fontWeight: 600 } : undefined}
              >
                {pick ? '✓ ' : ''}
                {short(r.fullName)}
                {pick ? ' (suggested)' : ''}
                {taken ? ` — ${owner}` : ''}
              </option>
            )
          })}
        </select>
        <ChevronDown className={cn('pointer-events-none absolute h-3 w-3', md ? 'right-2' : 'right-1.5', matches ? 'text-success' : 'text-muted-foreground')} />
      </span>
      {!current && suggested && (
        <button
          type="button"
          disabled={busy}
          onClick={() => assign.mutate(suggested)}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-success/40 bg-success/10 px-2 py-1 font-mono text-[12px] text-success transition hover:bg-success/15 disabled:opacity-50',
            md && 'px-2.5 py-1.5 text-[13px]',
          )}
          title={`Suggested: ${suggested}\n${suggestion!.why}`}
        >
          <Check className="h-3 w-3" /> {short(suggested)}
        </button>
      )}
      {differs && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
          title={`Worth a second look: the Hub expected ${short(suggested!)} (${suggestion!.why}).`}
        />
      )}
      {current && client.seo?.siteId && (
        <a
          href={`/seo/${client.seo.siteId}`}
          className={cn(
            'grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground',
            !md && 'opacity-0 group-hover:opacity-100',
          )}
          title="Open this client in SEO"
        >
          <TrendingUp className="h-3 w-3" />
        </a>
      )}
      {assign.isError && <span className="text-xs text-destructive">{(assign.error as Error).message}</span>}
    </span>
  )
}
