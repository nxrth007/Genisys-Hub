'use client'

import { useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, File, Image as ImageIcon, Search, Trash2, Upload } from 'lucide-react'
import { useAccount } from '@/components/hell-level/bits'
import { confirmAction } from '@/components/hell-level/confirm'
import { rv, type RecordRow } from '@/components/hell-level/section'
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Spinner, copyText, hlFetch, timeAgo } from '@/components/hell-level/ui'

type MediaItem = { id: string; name: string; mimeType: string; sizeBytes: number; sourceUrl: string | null; createdAt: string; url: string }

/**
 * Media Storage: images kept here (logos uploaded or copied in from Peakfinity
 * Studio, src/lib/hl/media.ts), then the files GHL kept for the sub-account
 * (images, PDFs, video), by link.
 */
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
      <KeptHere accountId={accountId} />
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

/** Images kept here: uploaded, or copied in from a link that won't last. Forms and the chat show the logo from here on client sites. */
function KeptHere({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const account = useAccount(accountId)
  const list = useQuery<{ media: MediaItem[] }>({ queryKey: ['hl', 'media', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/media`) })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['hl', 'media', accountId] })
    qc.invalidateQueries({ queryKey: ['hl', 'account', accountId] })
  }
  const file = useRef<HTMLInputElement>(null)
  const upload = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData()
      form.append('file', f)
      return hlFetch(`/api/hl/accounts/${accountId}/media`, { method: 'POST', body: form })
    },
    onSuccess: refresh,
  })
  const setLogo = useMutation({ mutationFn: (mediaId: string) => hlFetch(`/api/hl/accounts/${accountId}/media`, { method: 'POST', json: { action: 'set-logo', mediaId } }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (mediaId: string) => hlFetch(`/api/hl/accounts/${accountId}/media?mediaId=${encodeURIComponent(mediaId)}`, { method: 'DELETE' }), onSuccess: refresh })
  const [copied, setCopied] = useState<string | null>(null)
  const logo = account.data?.account.profile.logoUrl
  const media = list.data?.media ?? []
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold text-foreground">Kept here</p>
          <p className="text-[12.5px] text-muted-foreground">Logos and images uploaded here or copied in from Peakfinity Studio. They don’t expire, and forms and the chat show the logo on the client’s site.</p>
        </div>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) upload.mutate(f)
            e.target.value = ''
          }}
        />
        <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} loading={upload.isPending} onClick={() => file.current?.click()}>
          Upload
        </Button>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : !media.length ? (
        <p className="text-[12.5px] text-muted-foreground">Nothing yet. Upload a logo here or in Settings → Business Profile.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {media.map((m) => {
            const isLogo = logo === m.url
            return (
              <div key={m.id} className="overflow-hidden rounded-lg border border-border bg-card">
                <a href={m.url} target="_blank" rel="noreferrer" className="relative grid aspect-[4/3] place-items-center bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element -- served by the Hub at /hl/media */}
                  <img src={m.url} alt={m.name} loading="lazy" className="h-full w-full object-contain p-2" />
                  {isLogo && (
                    <Badge color="green" className="absolute left-2 top-2">
                      Logo
                    </Badge>
                  )}
                </a>
                <div className="flex flex-col gap-1.5 px-2.5 py-2">
                  <p className="truncate text-[12.5px] text-foreground" title={m.name}>
                    {m.name}
                  </p>
                  <p className="font-mono text-[10.5px] text-muted-foreground">
                    {Math.max(1, Math.round(m.sizeBytes / 1024))} KB · {timeAgo(m.createdAt)}
                  </p>
                  <div className="flex flex-wrap items-center gap-1">
                    {!isLogo && (
                      <Button size="sm" loading={setLogo.isPending && setLogo.variables === m.id} onClick={() => setLogo.mutate(m.id)}>
                        Use as logo
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={copied === m.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      title="Copy its link"
                      onClick={() => {
                        copyText(m.url)
                        setCopied(m.id)
                      }}
                    >
                      Link
                    </Button>
                    {!isLogo && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        title="Delete"
                        aria-label={`Delete ${m.name}`}
                        loading={remove.isPending && remove.variables === m.id}
                        onClick={() => void confirmAction(`Delete ${m.name}?`, 'Delete', { danger: true }).then((ok) => ok && remove.mutate(m.id))}
                      />
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <ErrorNote error={list.error || upload.error || setLogo.error || remove.error} />
    </Card>
  )
}
