'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronRight, ExternalLink, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { GBP_STATUS_LABEL, type GbpStatus } from '@/lib/gbp-kit'
import type { GbpOverviewRow } from '@/lib/gbp-setup'

type Filter = 'all' | 'action' | 'waiting' | 'done' | 'unknown'

const FILTERS: { id: Filter; label: string; match: (r: GbpOverviewRow) => boolean }[] = [
  { id: 'action', label: 'Needs us', match: (r) => r.status === 'needed' || r.status === 'existing' || r.status === 'created' },
  { id: 'waiting', label: 'Waiting on client', match: (r) => r.status === 'verifying' },
  { id: 'done', label: 'Done', match: (r) => r.status === 'verified' || r.status === 'has_profile' },
  { id: 'unknown', label: 'No answer', match: (r) => !r.status },
  { id: 'all', label: 'All', match: () => true },
]

const TONE: Record<GbpStatus, string> = {
  needed: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  existing: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  created: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  verifying: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  verified: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  has_profile: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
}

/** /google-profiles — every client's Google Business Profile, and what's left to do. */
export default function GoogleProfilesPage() {
  const [filter, setFilter] = useState<Filter>('action')
  const [search, setSearch] = useState('')
  const q = useQuery({
    queryKey: ['gbp-overview'],
    queryFn: async (): Promise<{ clients: GbpOverviewRow[] }> => {
      const res = await fetch('/api/gbp')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
  })
  const all = useMemo(() => q.data?.clients ?? [], [q.data])
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, all.filter(f.match).length])) as Record<Filter, number>, [all])
  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!
    const s = search.trim().toLowerCase()
    return all.filter((r) => f.match(r) && (!s || r.name.toLowerCase().includes(s)))
  }, [all, filter, search])

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <PageHeader
        title="Google Profiles"
        subtitle="Every client’s Google Business Profile: who still needs one, who’s waiting to verify, and who’s done. Open a client for the setup kit, the Maps search and the verification texts."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Google Profiles' }]}
      />
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition',
              filter === f.id ? 'border-foreground/40 bg-card' : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {f.label}
            <span className="font-mono text-[11px] text-muted-foreground">{counts[f.id] ?? 0}</span>
          </button>
        ))}
        <label className="relative ml-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a client"
            className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-[13px] outline-none transition focus:border-foreground/30"
          />
        </label>
      </div>

      {q.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((r, i) => (
            <li key={r.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border-soft')}>
              <Link href={`/clients/${r.id}/gbp`} className="group min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium group-hover:underline">{r.name}</span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {[
                    r.answer ? `Form: “${r.answer}”` : 'No onboarding answer',
                    r.lookupError ? 'Maps search failed' : r.found == null ? null : r.found ? `${r.found} possible listing${r.found === 1 ? '' : 's'} on Maps` : 'Nothing on Maps',
                    r.textsSent ? `${r.textsSent} text${r.textsSent === 1 ? '' : 's'} sent${r.lastTextAt ? `, last ${new Date(r.lastTextAt).toLocaleDateString()}` : ''}` : null,
                    r.reminding ? 'reminders on' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </Link>
              {r.profileUrl && (
                <a href={r.profileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                  Profile <ExternalLink className="h-3 w-3" />
                </a>
              )}
              <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px]', r.status ? TONE[r.status] : 'border-border text-muted-foreground')}>
                {(r.status === 'verified' || r.status === 'has_profile') && <Check className="h-3 w-3" />}
                {r.status ? GBP_STATUS_LABEL[r.status] : 'Unknown'}
              </span>
              <Link href={`/clients/${r.id}/gbp`} aria-label={`Open ${r.name}`}>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
          {rows.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-muted-foreground">No clients here.</li>}
        </ul>
      )}
    </div>
  )
}
