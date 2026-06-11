'use client'

/**
 * Lead-list detail — one Vicidial list's called-count breakdown +
 * a searchable, paginated browser over its leads. The status table
 * mirrors "CALLED COUNTS WITHIN THIS LIST" from the dialer's list
 * stats page; the lead browser mirrors the blue-TOTAL lead search
 * (capped at 10,000 rows by Vicidial itself).
 */
import { use, useState } from 'react'
import Link from 'next/link'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Search } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'

const PAGE_SIZE = 50

type StatsResponse =
  | {
      ok: true
      listId: string
      total: number | null
      statuses: { status: string; statusName: string; subtotal: number }[]
      fetchedAt: string
    }
  | { ok: false; error: string; fetchedAt: string }

type Lead = {
  leadId: string
  status: string
  vendorId: string
  lastAgent: string
  listId: string
  phone: string
  name: string
  city: string
  lastCall: string
}

type LeadsResponse =
  | {
      ok: true
      listId: string
      totalParsed: number
      totalFiltered: number
      offset: number
      limit: number
      leads: Lead[]
      fetchedAt: string
    }
  | { ok: false; error: string; fetchedAt: string }

type SnapshotRow = {
  snapshotDay: string
  total: number | null
  newCount: number | null
}

/**
 * Burn-down history — daily NEW + total counts for this list. The
 * scheduler snapshots every list once per UTC day (plus a lazy
 * snapshot on first view), so the table grows a row per day from
 * today forward. NEW shrinking is the dialer consuming the list;
 * the Δ column makes the daily burn rate readable at a glance.
 */
function BurnDownCard({ listId }: { listId: string }) {
  const query = useQuery<{
    ok: boolean
    snapshots: SnapshotRow[]
  }>({
    queryKey: ['vicidial-list-snapshots', listId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/vicidial/lists/${listId}/snapshots?days=30`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load history')
      }
      return res.json()
    },
  })

  const rows = query.data?.snapshots ?? []

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Burn-down history</h2>
        <span className="text-[11px] text-muted-foreground">
          Snapshots daily at 6 AM ET · NEW = uncalled leads remaining
        </span>
      </div>
      {query.isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      )}
      {query.isError && (
        <p className="mt-3 text-xs text-red-700 dark:text-red-300">
          {(query.error as Error).message}
        </p>
      )}
      {!query.isLoading && rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-4 font-medium">Day</th>
                <th className="py-1.5 pr-4 font-medium">Total</th>
                <th className="py-1.5 pr-4 font-medium">NEW remaining</th>
                <th className="py-1.5 font-medium">Δ NEW vs prior day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...rows].reverse().slice(0, 14).map((r, i, arr) => {
                const prior = arr[i + 1]
                const delta =
                  r.newCount !== null && prior?.newCount != null
                    ? r.newCount - prior.newCount
                    : null
                return (
                  <tr key={r.snapshotDay}>
                    <td className="py-1.5 pr-4 font-mono">{r.snapshotDay}</td>
                    <td className="py-1.5 pr-4 tabular-nums">
                      {r.total?.toLocaleString() ?? '—'}
                    </td>
                    <td className="py-1.5 pr-4 tabular-nums">
                      {r.newCount?.toLocaleString() ?? '—'}
                    </td>
                    <td
                      className={`py-1.5 tabular-nums ${
                        delta !== null && delta < 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {delta === null
                        ? '—'
                        : delta === 0
                          ? '0'
                          : delta > 0
                            ? `+${delta.toLocaleString()}`
                            : delta.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 1 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              First snapshot recorded just now — the burn rate appears
              once there&apos;s a second day of history.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function LeadListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const statsQuery = useQuery<StatsResponse>({
    queryKey: ['vicidial-list-stats', id],
    queryFn: async () => {
      const res = await fetch(`/api/admin/vicidial/lists/${id}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load list stats')
      }
      return res.json()
    },
  })

  const leadsQuery = useQuery<LeadsResponse>({
    queryKey: ['vicidial-list-leads', id, page, submittedSearch, statusFilter],
    queryFn: async () => {
      const sp = new URLSearchParams({
        offset: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE),
      })
      if (submittedSearch) sp.set('q', submittedSearch)
      if (statusFilter) sp.set('status', statusFilter)
      const res = await fetch(`/api/admin/vicidial/lists/${id}/leads?${sp}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load leads')
      }
      return res.json()
    },
    placeholderData: keepPreviousData,
  })

  const stats = statsQuery.data?.ok ? statsQuery.data : null
  const leads = leadsQuery.data?.ok ? leadsQuery.data : null
  const pageCount = leads ? Math.ceil(leads.totalFiltered / PAGE_SIZE) : 0

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={`List ${id}`}
        breadcrumbs={[
          { label: 'Genisys' },
          { label: 'Leads', href: '/leads' },
          { label: `List ${id}` },
        ]}
        actions={
          <Link
            href="/leads"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" /> All lists
          </Link>
        }
      />

      {/* Status breakdown */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Called counts within this list
          </h2>
          {stats?.total !== null && stats?.total !== undefined && (
            <span className="text-sm tabular-nums text-muted-foreground">
              Total leads:{' '}
              <span className="font-semibold text-foreground">
                {stats.total.toLocaleString()}
              </span>
            </span>
          )}
        </div>
        {statsQuery.isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        )}
        {(statsQuery.isError || (statsQuery.data && !statsQuery.data.ok)) && (
          <p className="mt-3 break-all text-xs text-red-700 dark:text-red-300">
            {statsQuery.data && !statsQuery.data.ok
              ? statsQuery.data.error
              : (statsQuery.error as Error | null)?.message}
          </p>
        )}
        {stats && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {stats.statuses.map((s) => (
              <button
                key={s.status}
                type="button"
                onClick={() => {
                  setStatusFilter((cur) => (cur === s.status ? '' : s.status))
                  setPage(0)
                }}
                title={`Filter leads by ${s.status}`}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${
                  statusFilter === s.status
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-background hover:bg-muted'
                }`}
              >
                <span className="min-w-0">
                  <span className="font-mono font-semibold">{s.status}</span>
                  <span className="ml-1.5 truncate text-muted-foreground">
                    {s.statusName}
                  </span>
                </span>
                <span className="ml-2 font-semibold tabular-nums">
                  {s.subtotal.toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Burn-down history */}
      <BurnDownCard listId={id} />

      {/* Lead browser */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <form
            className="relative flex-1"
            onSubmit={(e) => {
              e.preventDefault()
              setSubmittedSearch(search.trim())
              setPage(0)
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone, city, or lead ID — press Enter"
              className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </form>
          {statusFilter && (
            <button
              type="button"
              onClick={() => {
                setStatusFilter('')
                setPage(0)
              }}
              className="rounded-full border border-primary bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary"
            >
              Status: {statusFilter} ✕
            </button>
          )}
          {leads && (
            <span className="text-xs text-muted-foreground">
              {leads.totalFiltered.toLocaleString()} lead
              {leads.totalFiltered === 1 ? '' : 's'}
              {leads.totalParsed >= 10000 && ' (Vicidial caps results at 10,000)'}
            </span>
          )}
        </div>

        {leadsQuery.isLoading && (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}
        {(leadsQuery.isError || (leadsQuery.data && !leadsQuery.data.ok)) && (
          <div className="p-5 text-xs text-red-700 dark:text-red-300">
            <p className="font-semibold text-sm">Couldn&apos;t load leads</p>
            <p className="mt-1 break-all">
              {leadsQuery.data && !leadsQuery.data.ok
                ? leadsQuery.data.error
                : (leadsQuery.error as Error | null)?.message}
            </p>
          </div>
        )}

        {leads && (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Lead ID</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Phone</th>
                  <th className="px-4 py-2.5 font-medium">City</th>
                  <th className="px-4 py-2.5 font-medium">Last agent</th>
                  <th className="px-4 py-2.5 font-medium">Last call</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.leads.map((l) => (
                  <tr key={l.leadId} className="transition hover:bg-muted/40">
                    <td className="px-4 py-2 font-mono text-xs">{l.leadId}</td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">
                        {l.status || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-medium">{l.name || '—'}</td>
                    <td className="px-4 py-2 tabular-nums">{l.phone || '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {l.city || '—'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {l.lastAgent || '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {l.lastCall || '—'}
                    </td>
                  </tr>
                ))}
                {leads.leads.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-sm text-muted-foreground"
                    >
                      No leads match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Pagination */}
            <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs">
              <span className="text-muted-foreground">
                Page {page + 1} of {Math.max(1, pageCount)}
                {leadsQuery.isFetching && (
                  <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />
                )}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="rounded-md border border-border px-3 py-1.5 font-medium transition hover:bg-muted disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-md border border-border px-3 py-1.5 font-medium transition hover:bg-muted disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
