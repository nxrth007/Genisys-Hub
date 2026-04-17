'use client'

import { useState, FormEvent, useMemo, useEffect } from 'react'
import Image from 'next/image'
import { useQuery } from '@tanstack/react-query'
import {
  Search,
  HardDrive,
  ExternalLink,
  FolderOpen,
  FileText,
  Sheet,
  Presentation,
  FileType,
  Image as ImageIcon,
  File,
  Loader2,
  AlertCircle,
  Star,
  Users,
  User as UserIcon,
  Filter,
  X,
  Maximize2,
} from 'lucide-react'
import Link from 'next/link'
import { cn, formatDate, truncate } from '@/lib/utils'

type KindFilter = 'all' | 'folders' | 'docs' | 'sheets' | 'slides' | 'pdf' | 'images'
type OwnershipFilter = 'any' | 'mine' | 'shared' | 'starred'

type DriveFileResponse = {
  id: string
  name: string
  mimeType: string
  sourceAccount: string
  visibleToAccounts: string[]
  iconLink?: string | null
  webViewLink?: string | null
  thumbnailLink?: string | null
  size?: string | null
  modifiedTime?: string | null
  createdTime?: string | null
  owners?: Array<{ displayName?: string | null; emailAddress?: string | null }>
  lastModifyingUser?: { displayName?: string | null; emailAddress?: string | null } | null
  shared?: boolean | null
  starred?: boolean | null
  trashed?: boolean | null
  parents?: string[] | null
}

const KIND_OPTIONS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'folders', label: 'Folders' },
  { value: 'docs', label: 'Docs' },
  { value: 'sheets', label: 'Sheets' },
  { value: 'slides', label: 'Slides' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'images', label: 'Images' },
]

const OWNERSHIP_OPTIONS: Array<{ value: OwnershipFilter; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'any', label: 'Any', icon: HardDrive },
  { value: 'mine', label: 'Owned', icon: UserIcon },
  { value: 'shared', label: 'Shared', icon: Users },
  { value: 'starred', label: 'Starred', icon: Star },
]

function MimeIcon({ mime, className }: { mime: string; className?: string }) {
  if (mime === 'application/vnd.google-apps.folder') return <FolderOpen className={className} />
  if (mime === 'application/vnd.google-apps.document') return <FileText className={className} />
  if (mime === 'application/vnd.google-apps.spreadsheet') return <Sheet className={className} />
  if (mime === 'application/vnd.google-apps.presentation') return <Presentation className={className} />
  if (mime === 'application/pdf') return <FileType className={className} />
  if (mime.startsWith('image/')) return <ImageIcon className={className} />
  return <File className={className} />
}

function formatBytes(bytes: string | number | null | undefined): string {
  if (bytes == null) return ''
  const n = typeof bytes === 'string' ? Number(bytes) : bytes
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let val = n
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export default function DrivePage() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [ownership, setOwnership] = useState<OwnershipFilter>('any')
  const [accountFilter, setAccountFilter] = useState<string>('all')
  const [previewFile, setPreviewFile] = useState<DriveFileResponse | null>(null)

  const accountsQuery = useQuery<{ accounts: Array<{ email: string }> }>({
    queryKey: ['drive-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/drive/accounts')
      if (!res.ok) throw new Error('Failed to load accounts')
      return res.json()
    },
  })

  const filesQuery = useQuery<{
    files: DriveFileResponse[]
    errors: Array<{ account: string; message: string }>
  }>({
    queryKey: ['drive-files', submitted, kind, ownership, accountFilter],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (submitted) params.set('q', submitted)
      if (kind !== 'all') params.set('kind', kind)
      if (ownership !== 'any') params.set('ownership', ownership)
      if (accountFilter !== 'all') params.set('account', accountFilter)
      const res = await fetch(`/api/drive/files?${params.toString()}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to load files')
      }
      return res.json()
    },
    enabled: (accountsQuery.data?.accounts.length ?? 0) > 0,
  })

  const accounts = accountsQuery.data?.accounts ?? []
  const files = useMemo(() => filesQuery.data?.files ?? [], [filesQuery.data])
  const accountErrors = filesQuery.data?.errors ?? []

  const resultMeta = useMemo(() => {
    if (!filesQuery.isSuccess) return null
    const byAcct = new Map<string, number>()
    for (const f of files) byAcct.set(f.sourceAccount, (byAcct.get(f.sourceAccount) ?? 0) + 1)
    return { total: files.length, byAcct }
  }, [files, filesQuery.isSuccess])

  function submit(e: FormEvent) {
    e.preventDefault()
    setSubmitted(query.trim())
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
              <HardDrive className="h-6 w-6 text-purple-600" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight">Drive</h2>
          </div>
          <p className="mt-2 text-sm text-zinc-500">
            Files accessible to any connected Google account. Use the account chip to narrow to a single mailbox.
          </p>
        </div>
        {accounts.length > 0 && (
          <Link
            href="/settings"
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Manage accounts
          </Link>
        )}
      </div>

      {accounts.length === 0 && !accountsQuery.isLoading ? (
        <EmptyAccountsState />
      ) : (
        <>
          <form onSubmit={submit} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search file name or full-text content…"
                className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
            >
              Search
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            {KIND_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setKind(opt.value)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  kind === opt.value
                    ? 'border-purple-600 bg-purple-600 text-white'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
                )}
              >
                {opt.label}
              </button>
            ))}

            <div className="ml-2 flex items-center gap-1 border-l border-zinc-200 pl-2 dark:border-zinc-800">
              {OWNERSHIP_OPTIONS.map((opt) => {
                const Icon = opt.icon
                return (
                  <button
                    key={opt.value}
                    onClick={() => setOwnership(opt.value)}
                    className={cn(
                      'flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      ownership === opt.value
                        ? 'border-purple-600 bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                        : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
                    )}
                    title={opt.label}
                  >
                    <Icon className="h-3 w-3" />
                    {opt.label}
                  </button>
                )
              })}
            </div>

            {accounts.length > 1 && (
              <div className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
                <Filter className="h-3 w-3" />
                <select
                  value={accountFilter}
                  onChange={(e) => setAccountFilter(e.target.value)}
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <option value="all">All accounts</option>
                  {accounts.map((a) => (
                    <option key={a.email} value={a.email}>
                      {a.email}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {accountErrors.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-amber-900 dark:text-amber-200">
                    {accountErrors.length === 1
                      ? '1 account returned an error'
                      : `${accountErrors.length} accounts returned errors`}
                  </div>
                  <ul className="mt-1 space-y-0.5 text-xs text-amber-800 dark:text-amber-300">
                    {accountErrors.map((e) => (
                      <li key={e.account}>
                        <span className="font-medium">{e.account}:</span> {e.message}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                    Most common fix: disconnect the account in Settings, then click Connect and
                    grant the Drive scope on Google&apos;s consent screen.
                  </p>
                </div>
              </div>
            </div>
          )}

          {resultMeta && (
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <span>
                {resultMeta.total} file{resultMeta.total === 1 ? '' : 's'}
              </span>
              {Array.from(resultMeta.byAcct.entries()).map(([acct, n]) => (
                <span key={acct} className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                  {acct}: {n}
                </span>
              ))}
            </div>
          )}

          {filesQuery.isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
            </div>
          ) : filesQuery.isError ? (
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-medium">Couldn&apos;t load files</div>
                <div className="mt-1 text-xs">{(filesQuery.error as Error).message}</div>
              </div>
            </div>
          ) : files.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center text-sm text-zinc-500 dark:border-zinc-800">
              No files match these filters.
            </div>
          ) : (
            <FileList
              files={files}
              multipleAccounts={accounts.length > 1}
              onPreview={setPreviewFile}
            />
          )}
        </>
      )}

      {previewFile && (
        <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  )
}

function FileList({
  files,
  multipleAccounts,
  onPreview,
}: {
  files: DriveFileResponse[]
  multipleAccounts: boolean
  onPreview: (file: DriveFileResponse) => void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {files.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            multipleAccounts={multipleAccounts}
            onPreview={onPreview}
          />
        ))}
      </div>
    </div>
  )
}

function FileRow({
  file,
  multipleAccounts,
  onPreview,
}: {
  file: DriveFileResponse
  multipleAccounts: boolean
  onPreview: (file: DriveFileResponse) => void
}) {
  const owner = file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress
  const isFolder = file.mimeType === 'application/vnd.google-apps.folder'
  const driveUrl =
    file.webViewLink ||
    (isFolder
      ? `https://drive.google.com/drive/folders/${file.id}`
      : `https://drive.google.com/file/d/${file.id}/view`)

  // Folders don't render in the iframe preview — Drive responds with a download
  // prompt for their zip. Click behavior: folders open in Drive, files preview in-Hub.
  const handleClick = () => {
    if (isFolder) {
      window.open(driveUrl, '_blank', 'noopener,noreferrer')
    } else {
      onPreview(file)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      className="group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none dark:hover:bg-zinc-800/50 dark:focus:bg-zinc-800/50"
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
        {file.iconLink ? (
          <Image src={file.iconLink} alt="" width={18} height={18} className="h-[18px] w-[18px]" unoptimized />
        ) : (
          <MimeIcon mime={file.mimeType} className="h-[18px] w-[18px] text-zinc-500" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{file.name}</p>
          {file.starred ? <Star className="h-3 w-3 flex-shrink-0 fill-yellow-400 text-yellow-400" /> : null}
          {file.shared ? <Users className="h-3 w-3 flex-shrink-0 text-zinc-400" /> : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
          {owner && <span className="truncate">{truncate(owner, 28)}</span>}
          {file.modifiedTime && (
            <>
              <span>•</span>
              <span>modified {formatDate(file.modifiedTime)}</span>
            </>
          )}
          {file.size && formatBytes(file.size) && (
            <>
              <span>•</span>
              <span>{formatBytes(file.size)}</span>
            </>
          )}
          {multipleAccounts && (
            <>
              <span>•</span>
              <span className="rounded-full bg-purple-50 px-2 py-0.5 text-purple-700 dark:bg-purple-950 dark:text-purple-300">
                {file.sourceAccount.split('@')[0]}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Separate button: open in Drive in a new tab, bypassing the preview. */}
      <a
        href={driveUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Open in Drive"
        className="flex-shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-zinc-100 hover:text-purple-600 dark:hover:bg-zinc-800"
      >
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  )
}

function PreviewModal({
  file,
  onClose,
}: {
  file: DriveFileResponse
  onClose: () => void
}) {
  // Which Google account's session to use when loading the iframe. Defaults to
  // whichever mailbox first returned the file; user can switch if multiple
  // mailboxes have access. Fixes "you need access" errors that come from
  // Chrome loading the iframe as the wrong multi-logged-in account.
  const [viewAs, setViewAs] = useState(file.sourceAccount)

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // ?authuser=<email> tells Google Drive which multi-logged-in account's
  // permissions to apply when rendering the iframe, overriding Chrome's
  // default primary-account behavior.
  const previewUrl = `https://drive.google.com/file/d/${file.id}/preview?authuser=${encodeURIComponent(viewAs)}`
  const driveUrl = `https://drive.google.com/file/d/${file.id}/view?usp=drivesdk&authuser=${encodeURIComponent(viewAs)}`

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-zinc-200 bg-zinc-50/50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
        <button
          onClick={onClose}
          title="Back to files (Esc)"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />

        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
          {file.iconLink ? (
            <Image
              src={file.iconLink}
              alt=""
              width={16}
              height={16}
              className="h-4 w-4"
              unoptimized
            />
          ) : (
            <MimeIcon mime={file.mimeType} className="h-4 w-4 text-zinc-500" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="truncate text-xs text-zinc-500">
            {file.modifiedTime ? `modified ${formatDate(file.modifiedTime)}` : ''}
            {file.size && formatBytes(file.size)
              ? ` · ${formatBytes(file.size)}`
              : ''}
          </p>
        </div>

        {file.visibleToAccounts.length > 1 ? (
          <div className="flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900">
            <span className="text-zinc-500">Viewing as</span>
            <select
              value={viewAs}
              onChange={(e) => setViewAs(e.target.value)}
              className="bg-transparent font-medium focus:outline-none"
            >
              {file.visibleToAccounts.map((acct) => (
                <option key={acct} value={acct}>
                  {acct}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900"
            title="Only this mailbox has access to this file"
          >
            as {viewAs}
          </span>
        )}

        <a
          href={driveUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Drive"
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Open in Drive
        </a>
      </div>

      <iframe
        // Key includes viewAs so switching accounts forces a fresh iframe load.
        key={`${file.id}-${viewAs}`}
        src={previewUrl}
        title={file.name}
        className="flex-1 w-full bg-white dark:bg-zinc-950"
        allow="autoplay; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
      />

      {file.visibleToAccounts.length > 1 && (
        <div className="flex-shrink-0 border-t border-zinc-200 bg-zinc-50/50 px-4 py-1.5 text-center text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
          Seeing &quot;You need access&quot;? Switch the viewing account above.
        </div>
      )}
    </div>
  )
}

function EmptyAccountsState() {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-12 text-center dark:border-zinc-700 dark:bg-zinc-900">
      <HardDrive className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600" />
      <h3 className="mt-4 text-sm font-semibold">No Google Drive accounts connected</h3>
      <p className="mt-2 text-sm text-zinc-500">
        Connect alex@ and ethan@leadgenisys.com to see files across both mailboxes here.
      </p>
      <Link
        href="/settings"
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700"
      >
        Go to Settings
      </Link>
    </div>
  )
}
