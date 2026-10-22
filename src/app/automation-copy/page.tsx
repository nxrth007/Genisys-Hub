'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronRight, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'

type Row = { id: string; name: string; siteUrl: string | null; hasIntake: boolean; done: number }

/** /automation-copy — every client A–Z; each opens its copy-and-paste board for the GHL automations. */
export default function AutomationCopyPage() {
  const [filter, setFilter] = useState('')
  const q = useQuery({
    queryKey: ['automation-copy'],
    queryFn: async (): Promise<{ clients: Row[]; total: number }> => {
      const res = await fetch('/api/automation-copy')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
  })
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (q.data?.clients ?? []).filter((c) => !f || c.name.toLowerCase().includes(f))
  }, [q.data, filter])
  const total = q.data?.total ?? 0

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6">
      <PageHeader
        title="Automation Copy"
        subtitle="The text for each client’s GHL automations, personalized from their onboarding answers. Open a client and copy each box into their sub-account."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Automation Copy' }]}
      />
      <label className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a client"
          className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-[13px] outline-none transition focus:border-foreground/30"
        />
      </label>
      {q.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((c, i) => {
            const complete = total > 0 && c.done >= total
            return (
              <li key={c.id} className={cn(i > 0 && 'border-t border-border-soft')}>
                <Link href={`/automation-copy/${c.id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-muted/60">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{c.name}</span>
                    <span className="block truncate font-mono text-[11.5px] text-muted-foreground">
                      {c.siteUrl ? c.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'No live site yet'}
                      {!c.hasIntake && ' · no onboarding answers'}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]',
                      complete ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-border text-muted-foreground',
                    )}
                    title="Automations ticked as set up in GHL"
                  >
                    {complete && <Check className="h-3 w-3" />}
                    {c.done}/{total} set up
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            )
          })}
          {rows.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-muted-foreground">No clients match.</li>}
        </ul>
      )}
    </div>
  )
}
