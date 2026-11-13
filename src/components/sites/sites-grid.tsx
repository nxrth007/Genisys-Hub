'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Check, Folder, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import type { SiteFolder } from '@/lib/sites'
import { siteHost, type SiteStatus } from '@/lib/site-status'

type Filter = 'all' | 'needs' | 'live'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Need a site' },
  { id: 'live', label: 'Live' },
]

/** The portfolio: a folder per client, ✓ when their site is live, ! when they still need one. */
export function SitesGrid({ folders }: { folders: SiteFolder[] }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const live = folders.filter((f) => f.status === 'live').length
  const q = query.trim().toLowerCase()
  const shown = folders.filter((f) => (filter === 'all' || (filter === 'live') === (f.status === 'live')) && (!q || f.name.toLowerCase().includes(q) || siteHost(f.siteUrl).includes(q)))

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="Sites"
        subtitle={`Every client’s website: ${live} live, ${folders.length - live} still need one. Open a folder for their status, site link and the toll-free number that goes on the site.`}
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Sites' }]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex w-full max-w-xs items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a client or site"
            aria-label="Find a client or site"
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>
        <div role="radiogroup" aria-label="Show" className="flex rounded-lg border border-border bg-card p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn('rounded-md px-3 py-1.5 text-[12.5px] font-medium transition', filter === f.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-6 text-center text-[13px] text-muted-foreground">No clients match.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-2 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {shown.map((f) => (
            <li key={f.id}>
              <FolderTile f={f} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FolderTile({ f }: { f: SiteFolder }) {
  const live = f.status === 'live'
  return (
    <Link
      href={`/sites/${f.id}`}
      className="group flex h-full flex-col items-center gap-1.5 rounded-xl p-3 text-center transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <span className="relative">
        <Folder className="h-20 w-20 transition group-hover:-translate-y-0.5" style={{ color: f.color, fill: `${f.color}2e` }} strokeWidth={1.25} aria-hidden />
        {f.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- the client's own logo, found on their site
          <img
            src={f.logoUrl}
            alt=""
            loading="lazy"
            className="absolute left-1/2 top-[57%] h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-sm object-contain"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
        <StatusBadge status={f.status} className="absolute -right-1 top-1.5" />
      </span>
      <span className="line-clamp-2 text-[12.5px] font-medium leading-tight text-foreground">{f.name}</span>
      <span className={cn('max-w-full truncate text-[11px]', live ? 'text-muted-foreground' : f.status === 'blocked' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')}>
        {live ? siteHost(f.siteUrl) : f.status === 'building' ? 'Being built' : f.status === 'blocked' ? 'Build blocked' : 'Needs a site'}
      </span>
    </Link>
  )
}

/** ✓ on a finished site, ! on one that still needs building. */
export function StatusBadge({ status, className, size = 'sm' }: { status: SiteStatus; className?: string; size?: 'sm' | 'lg' }) {
  const live = status === 'live'
  return (
    <span
      className={cn(
        'grid place-items-center rounded-full border-2 border-background text-white shadow-sm',
        size === 'lg' ? 'h-8 w-8' : 'h-6 w-6',
        live ? 'bg-emerald-500' : status === 'blocked' ? 'bg-red-500' : 'bg-amber-500',
        className,
      )}
      role="img"
      aria-label={live ? 'Site finished' : 'Needs a site'}
      title={live ? 'Site finished' : 'Needs a site'}
    >
      {live ? <Check className={size === 'lg' ? 'h-[18px] w-[18px]' : 'h-3.5 w-3.5'} strokeWidth={3} /> : <span className={cn('font-black leading-none', size === 'lg' ? 'text-[17px]' : 'text-[13px]')}>!</span>}
    </span>
  )
}
