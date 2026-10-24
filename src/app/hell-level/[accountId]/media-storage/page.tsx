'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { File, Image as ImageIcon, Search } from 'lucide-react'
import { rv, type RecordRow } from '@/components/hell-level/section'
import { Button, Card, Empty, ErrorNote, PageHeader, Spinner, hlFetch, timeAgo } from '@/components/hell-level/ui'

/** Media Storage: the files GHL kept for the sub-account (images, PDFs, video), by link. */
export default function MediaStoragePage() {
  const { accountId } = useParams<{ accountId: string }>()
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const query = useQuery<{ records: RecordRow[]; total: number; pageSize: number }>({
    queryKey: ['hl', 'records', accountId, 'media', q, page],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/records?kind=media&q=${encodeURIComponent(q)}&page=${page}`),
  })
  const d = query.data
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
      <PageHeader
        title="Media Storage"
        description={d ? `${d.total.toLocaleString('en-US')} files from GoHighLevel. They stay on GHL’s storage; copy anything you need to keep before cancelling GHL.` : ' '}
        actions={
          <label className="flex h-9 w-64 items-center gap-2 rounded-md border border-border bg-surface px-3 text-muted-foreground focus-within:border-primary/50">
            <Search className="h-3.5 w-3.5" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(0)
              }}
              placeholder="Search files"
              className="w-full bg-transparent text-[13px] text-foreground outline-none"
            />
          </label>
        }
      />
      {query.isLoading ? (
        <div className="flex justify-center py-14">
          <Spinner />
        </div>
      ) : !d?.records.length ? (
        <Card>
          <Empty icon={<ImageIcon className="h-5 w-5" />} title="No media">
            Files from GoHighLevel’s media library show up here after the import.
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {d.records.map((r) => {
            const url = rv(r, 'url')
            const isImage = /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url) || rv(r, 'type').startsWith('image')
            return (
              <a key={r.id} href={url || undefined} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-lg border border-border bg-card transition hover:border-primary/50">
                <div className="grid aspect-[4/3] place-items-center bg-surface-muted">
                  {isImage && url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- files hosted on GHL's storage, any domain
                    <img src={url} alt={r.name} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <File className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>
                <div className="px-2.5 py-2">
                  <p className="truncate text-[12.5px] text-foreground">{r.name}</p>
                  <p className="font-mono text-[10.5px] text-muted-foreground">{timeAgo(rv(r, 'createdAt') || r.createdAt)}</p>
                </div>
              </a>
            )
          })}
        </div>
      )}
      {d && d.total > d.pageSize && (
        <div className="flex items-center justify-between text-[12.5px] text-muted-foreground">
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
      <ErrorNote error={query.error} />
    </div>
  )
}
