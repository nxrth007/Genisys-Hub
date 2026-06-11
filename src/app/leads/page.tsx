'use client'

/**
 * Leads — Vicidial Lists mirror (Lists → Show Lists).
 *
 * Read-only visibility into the BPO dialer's lead lists: per-list
 * counts, active/inactive, campaign, last call date. Clicking a
 * row opens /leads/[id] with the called-count status breakdown and
 * the full lead listing. Data comes from the admin scraper in
 * lib/vicidial-lists (5-min server cache shields the dialer).
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2,
  RefreshCcw,
  ListChecks,
  ArrowUpDown,
  ExternalLink,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'

type VicidialList = {
  listId: string
  name: string
  description: string
  leadsCount: number | null
  active: boolean
  lastCallDate: string | null
  campaign: string
}

type ListsResponse =
  | { ok: true; lists: VicidialList[]; fetchedAt: string }
  | { ok: false; error: string; fetchedAt: string }

type SortKey = 'listId' | 'name' | 'leadsCount' | 'campaign' | 'lastCallDate'

export default function LeadsPage() {
  const [sortKey, setSortKey] = useState<SortKey>('listId')
  const [sortAsc, setSortAsc] = useState(true)

  const query = useQuery<ListsResponse>({
    queryKey: ['vicidial-lists'],
    queryFn: async () => {
      const res = await fetch('/api/admin/vicidial/lists')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load Vicidial lists')
      }
      return res.json()
    },
    refetchInterval: 5 * 60_000,
  })

  const lists = useMemo(() => {
    if (!query.data?.ok) return []
    const arr = [...query.data.lists]
    arr.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'leadsCount') {
        cmp = (a.leadsCount ?? -1) - (b.leadsCount ?? -1)
      } else if (sortKey === 'listId') {
        cmp = Number(a.listId) - Number(b.listId)
      } else {
        cmp = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''))
      }
      return sortAsc ? cmp : -cmp
    })
    return arr
  }, [query.data, sortKey, sortAsc])

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const totalLeads = lists.reduce((sum, l) => sum + (l.leadsCount ?? 0), 0)
  const haveAnyCounts = lists.some((l) => l.leadsCount !== null)

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="Leads"
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Leads' }]}
        actions={
          <button
            type="button"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            {query.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}
            Refresh
          </button>
        }
      />

      {/* Summary strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          label="Dialer lists"
          value={query.data?.ok ? String(lists.length) : '—'}
        />
        <SummaryCard
          label="Active lists"
          value={
            query.data?.ok ? String(lists.filter((l) => l.active).length) : '—'
          }
        />
        <SummaryCard
          label="Total leads (across lists)"
          value={
            query.data?.ok && haveAnyCounts
              ? totalLeads.toLocaleString()
              : '—'
          }
        />
      </div>

      {query.isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {(query.isError || (query.data && !query.data.ok)) && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">Couldn&apos;t load Vicidial lists</p>
          <p className="mt-1 break-all text-xs">
            {query.data && !query.data.ok
              ? query.data.error
              : (query.error as Error | null)?.message}
          </p>
        </div>
      )}

      {query.data?.ok && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <SortableTh label="List ID" onClick={() => toggleSort('listId')} />
                <SortableTh label="Name" onClick={() => toggleSort('name')} />
                <th className="px-4 py-2.5 font-medium">Description</th>
                <SortableTh
                  label="Leads"
                  onClick={() => toggleSort('leadsCount')}
                />
                <SortableTh
                  label="Campaign"
                  onClick={() => toggleSort('campaign')}
                />
                <th className="px-4 py-2.5 font-medium">Active</th>
                <SortableTh
                  label="Last call"
                  onClick={() => toggleSort('lastCallDate')}
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lists.map((l) => (
                <tr key={l.listId} className="transition hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/leads/${l.listId}`}
                      className="inline-flex items-center gap-1 font-mono font-semibold text-primary hover:underline"
                    >
                      {l.listId}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/leads/${l.listId}`} className="hover:underline">
                      {l.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {l.description || '—'}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {l.leadsCount !== null ? l.leadsCount.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2.5">{l.campaign || '—'}</td>
                  <td className="px-4 py-2.5">
                    {l.active ? (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {l.lastCallDate || 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <ListChecks className="h-3.5 w-3.5" />
              Mirrored from Vicidial · Lists → Show Lists
            </span>
            <span>
              Fetched{' '}
              {new Date(query.data.fetchedAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })}
              {' · '}cached up to 5 min
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function SortableTh({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <th className="px-4 py-2.5 font-medium">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground"
      >
        {label}
        <ArrowUpDown className="h-3 w-3" />
      </button>
    </th>
  )
}
