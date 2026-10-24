'use client'

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Construction, Search } from 'lucide-react'
import { activeTab, sectionOf } from './nav'
import { Button, Card, Empty, ErrorNote, Spinner, Table, hlFetch, timeAgo } from './ui'

/** The section tab the page is on (?tab=, defaulting to the section's first tab). */
export function useSectionTab(sectionKey: string): string {
  const sp = useSearchParams()
  return activeTab(sectionOf(sectionKey), sp.get('tab')) ?? ''
}

/**
 * A GoHighLevel feature Hell-level doesn't do yet: the tab is there so the
 * structure matches GHL, and says plainly what it is and what to use meanwhile.
 */
export function NotYet({ title, what, meanwhile }: { title: string; what: string; meanwhile?: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Card className="flex flex-col items-center gap-3 px-8 py-12 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-full border border-border bg-surface text-muted-foreground">
          <Construction className="h-5 w-5" />
        </span>
        <p className="eyebrow text-muted-foreground">Not in Hell-level yet</p>
        <h2 className="text-[20px] font-semibold text-foreground">{title}</h2>
        <p className="max-w-lg text-[13px] text-muted-foreground">{what}</p>
        {meanwhile && <div className="mt-2 max-w-lg rounded-md border border-border bg-surface px-4 py-3 text-[13px] text-foreground/85">{meanwhile}</div>}
      </Card>
    </div>
  )
}

export type RecordRow = { id: string; kind: string; ghlId: string | null; name: string; data: Record<string, unknown>; createdAt: string; updatedAt: string }

export type RecordColumn = { label: string; render: (r: RecordRow) => ReactNode; className?: string }

const s = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v))
export const rv = (r: RecordRow, ...keys: string[]): string => {
  for (const k of keys) {
    const parts = k.split('.')
    let cur: unknown = r.data
    for (const p of parts) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined
    const out = s(cur)
    if (out) return out
  }
  return ''
}
export const money = (v: unknown, currency = 'USD') => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: currency || 'USD' }) : ''
}

/** A list GHL had (imported), in a table. */
export function RecordsTable({
  accountId,
  kind,
  title,
  columns,
  emptyText,
  action,
}: {
  accountId: string
  kind: string
  title: string
  columns: RecordColumn[]
  emptyText: string
  action?: ReactNode
}) {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const query = useQuery<{ records: RecordRow[]; total: number; pageSize: number }>({
    queryKey: ['hl', 'records', accountId, kind, q, page],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/records?kind=${kind}&q=${encodeURIComponent(q)}&page=${page}`),
  })
  const d = query.data
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{d ? `${d.total.toLocaleString('en-US')} imported from GoHighLevel` : ' '}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex h-9 w-64 items-center gap-2 rounded-md border border-border bg-surface px-3 text-muted-foreground focus-within:border-primary/50">
            <Search className="h-3.5 w-3.5" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(0)
              }}
              placeholder="Search"
              className="w-full bg-transparent text-[13px] text-foreground outline-none"
            />
          </label>
          {action}
        </div>
      </div>
      <Card>
        {query.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : !d?.records.length ? (
          <Empty title={q ? 'Nothing matches' : `No ${title.toLowerCase()}`}>{q ? 'Try another search.' : emptyText}</Empty>
        ) : (
          <Table head={[...columns.map((c) => c.label), 'Updated']}>
            {d.records.map((r) => (
              <tr key={r.id} className="border-b border-border-soft last:border-0 hover:bg-muted/40">
                {columns.map((c, i) => (
                  <td key={i} className={c.className ?? 'px-4 py-2.5 text-foreground/90'}>
                    {c.render(r)}
                  </td>
                ))}
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{timeAgo(r.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
        {d && d.total > d.pageSize && (
          <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[12.5px] text-muted-foreground">
            <span>
              Page {page + 1} of {pages}
            </span>
            <span className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </span>
          </div>
        )}
      </Card>
      <ErrorNote error={query.error} />
    </div>
  )
}
