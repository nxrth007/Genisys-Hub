'use client'

import { useState, FormEvent, useMemo, useEffect, useRef } from 'react'
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
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Download,
  ChevronRight,
  Home,
  FolderPlus,
} from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
  // Folder navigation — null = show everything. When set, the list is scoped
  // to this folder's children and breadcrumbs render above the filter bar.
  const [folder, setFolder] = useState<{ id: string; name: string; account: string } | null>(null)
  const qc = useQueryClient()

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
    queryKey: ['drive-files', submitted, kind, ownership, accountFilter, folder?.id],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (submitted) params.set('q', submitted)
      if (kind !== 'all') params.set('kind', kind)
      if (ownership !== 'any') params.set('ownership', ownership)
      if (accountFilter !== 'all') params.set('account', accountFilter)
      if (folder) {
        params.set('parentId', folder.id)
        // Folder contents must come from the account that owns the folder —
        // the other account's listing wouldn't know about these children.
        params.set('account', folder.account)
      }
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
          <div className="flex items-center gap-2">
            <NewFileMenu
              accounts={accounts.map((a) => a.email)}
              defaultAccount={folder?.account || accounts[0]?.email}
              parentId={folder?.id}
              onCreated={(created) => {
                qc.invalidateQueries({ queryKey: ['drive-files'] })
                if (created.webViewLink) {
                  window.open(created.webViewLink, '_blank', 'noopener,noreferrer')
                }
              }}
            />
            <Link
              href="/settings"
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Manage accounts
            </Link>
          </div>
        )}
      </div>

      {folder && (
        <Breadcrumbs
          folder={folder}
          onNavigate={(next) => setFolder(next)}
        />
      )}

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
              onOpenFolder={(f) =>
                setFolder({ id: f.id, name: f.name, account: f.sourceAccount })
              }
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
  onOpenFolder,
}: {
  files: DriveFileResponse[]
  multipleAccounts: boolean
  onPreview: (file: DriveFileResponse) => void
  onOpenFolder: (file: DriveFileResponse) => void
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
            onOpenFolder={onOpenFolder}
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
  onOpenFolder,
}: {
  file: DriveFileResponse
  multipleAccounts: boolean
  onPreview: (file: DriveFileResponse) => void
  onOpenFolder: (file: DriveFileResponse) => void
}) {
  const owner = file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress
  const isFolder = file.mimeType === 'application/vnd.google-apps.folder'
  const driveUrl =
    file.webViewLink ||
    (isFolder
      ? `https://drive.google.com/drive/folders/${file.id}`
      : `https://drive.google.com/file/d/${file.id}/view`)

  // Folders drill in-Hub; files open the preview modal.
  const handleClick = () => {
    if (isFolder) {
      onOpenFolder(file)
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

      <FileRowActions file={file} driveUrl={driveUrl} isFolder={isFolder} />
    </div>
  )
}

function FileRowActions({
  file,
  driveUrl,
  isFolder,
}: {
  file: DriveFileResponse
  driveUrl: string
  isFolder: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(file.name)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const patchMutation = useMutation({
    mutationFn: async (body: { name?: string; starred?: boolean; trashed?: boolean }) => {
      const res = await fetch(`/api/drive/files/${file.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: file.sourceAccount, ...body }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      return data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drive-files'] })
    },
  })

  return (
    <div ref={menuRef} className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => patchMutation.mutate({ starred: !file.starred })}
        disabled={patchMutation.isPending}
        title={file.starred ? 'Unstar' : 'Star'}
        className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-100 hover:text-yellow-500 dark:hover:bg-zinc-800"
      >
        <Star
          className={cn('h-4 w-4', file.starred && 'fill-yellow-400 text-yellow-400')}
        />
      </button>
      <a
        href={driveUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="Open in Drive"
        className="inline-block rounded-md p-1.5 text-zinc-300 hover:bg-zinc-100 hover:text-purple-600 dark:hover:bg-zinc-800"
      >
        <ExternalLink className="h-4 w-4" />
      </a>
      <button
        onClick={() => setOpen((v) => !v)}
        title="More"
        className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const name = newName.trim()
                if (!name || name === file.name) {
                  setRenaming(false)
                  setOpen(false)
                  return
                }
                patchMutation.mutate({ name })
                setRenaming(false)
                setOpen(false)
              }}
              className="p-2"
            >
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setRenaming(false)
                    setNewName(file.name)
                  }
                }}
                className="w-full rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              />
              <div className="mt-2 flex gap-1">
                <button
                  type="submit"
                  className="flex-1 rounded-md bg-purple-600 px-2 py-1 text-xs font-medium text-white hover:bg-purple-700"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(false)
                    setNewName(file.name)
                  }}
                  className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <MenuItem
                icon={Pencil}
                label="Rename"
                onClick={() => {
                  setRenaming(true)
                  setNewName(file.name)
                }}
              />
              {!isFolder && (
                <MenuItem
                  icon={Download}
                  label="Download"
                  onClick={() => {
                    window.open(
                      `/api/drive/stream?id=${encodeURIComponent(file.id)}&account=${encodeURIComponent(file.sourceAccount)}`,
                      '_blank'
                    )
                    setOpen(false)
                  }}
                />
              )}
              <MenuItem
                icon={Trash2}
                label="Move to trash"
                destructive
                onClick={() => {
                  if (!confirm(`Move "${file.name}" to Drive trash?`)) return
                  patchMutation.mutate({ trashed: true })
                  setOpen(false)
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800',
        destructive
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50'
          : 'text-zinc-700 dark:text-zinc-200'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

// Maps the Google Workspace mimeType to its editable web URL path segment.
// When present here, a file can be opened in Google's real editor via iframe.
const EDITOR_PATH: Record<string, string> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheets',
  'application/vnd.google-apps.presentation': 'presentation',
  'application/vnd.google-apps.drawing': 'drawings',
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

  // View vs Edit vs Data. View uses our backend stream (guaranteed access,
  // read-only). Edit iframes Google's real editor (needs Chrome to be signed
  // into the right Google account). Data is a Sheets-only mode that pulls
  // structured data via the Sheets API and renders a real interactive table
  // — ideal for wide operational spreadsheets that don't survive PDF export.
  const editorPath = EDITOR_PATH[file.mimeType]
  const canEdit = Boolean(editorPath)
  const isSheet = file.mimeType === 'application/vnd.google-apps.spreadsheet'
  const [mode, setMode] = useState<'view' | 'edit' | 'data'>(isSheet ? 'data' : 'view')

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

  // Non-streamable Google-native types (folders, forms, sites, shortcuts, maps)
  // have no renderable export format. Fall back to Drive's own iframe for those.
  const GOOGLE_NATIVE_NOT_STREAMABLE = [
    'application/vnd.google-apps.folder',
    'application/vnd.google-apps.shortcut',
    'application/vnd.google-apps.form',
    'application/vnd.google-apps.site',
    'application/vnd.google-apps.map',
  ]
  const canStream = !GOOGLE_NATIVE_NOT_STREAMABLE.includes(file.mimeType)

  // View URL: stream through our backend using the stored OAuth token —
  // bypasses Chrome's cookie-session auth entirely. "Viewing as" picks which
  // token to use.
  const viewUrl = canStream
    ? `/api/drive/stream?id=${encodeURIComponent(file.id)}&account=${encodeURIComponent(viewAs)}`
    : `https://drive.google.com/file/d/${file.id}/preview?authuser=${encodeURIComponent(viewAs)}`

  // Edit URL: Google's real editor. Requires the iframe's Chrome cookie
  // session to be signed in as the account with edit permission — the
  // authuser hint helps when multiple accounts are signed in at once, but
  // if the account isn't signed in at all, Google shows a login inside
  // the frame.
  const editUrl = canEdit
    ? `https://docs.google.com/${editorPath}/d/${file.id}/edit?authuser=${encodeURIComponent(viewAs)}&rm=embedded`
    : null

  // Actually-rendered iframe URL, based on selected mode.
  const iframeUrl = mode === 'edit' && editUrl ? editUrl : viewUrl
  const iframeNeedsSandbox = mode === 'edit' || !canStream

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

        {canEdit && (
          <div className="flex overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
            {isSheet && (
              <ModeButton
                label="Data"
                active={mode === 'data'}
                onClick={() => setMode('data')}
                title="Interactive table view via Sheets API — works regardless of Chrome session."
              />
            )}
            <ModeButton
              label="View"
              active={mode === 'view'}
              onClick={() => setMode('view')}
              title="PDF export of the file."
            />
            <ModeButton
              label="Edit"
              active={mode === 'edit'}
              onClick={() => setMode('edit')}
              title="Google's real editor. Needs Chrome signed into the right account."
            />
          </div>
        )}

        {file.visibleToAccounts.length > 1 ? (
          <div className="flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900">
            <span className="text-zinc-500">{mode === 'edit' ? 'Edit as' : 'View as'}</span>
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

      {mode === 'data' && isSheet ? (
        <SheetsTable spreadsheetId={file.id} account={viewAs} />
      ) : (
        <iframe
          // Key includes mode + viewAs so switching them forces a fresh iframe load.
          key={`${file.id}-${mode}-${viewAs}`}
          src={iframeUrl}
          title={file.name}
          className="flex-1 w-full bg-white dark:bg-zinc-950"
          allow="autoplay; clipboard-read; clipboard-write; fullscreen"
          // Sandbox only for third-party iframes (drive.google.com, docs.google.com).
          // Our own same-origin stream runs unsandboxed so Chrome's built-in PDF
          // viewer extension works. allow-top-navigation-by-user-activation lets
          // the real Google editor open links when the user clicks them.
          sandbox={
            iframeNeedsSandbox
              ? 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-top-navigation-by-user-activation allow-presentation'
              : undefined
          }
        />
      )}

      {!canStream && (
        <div className="flex-shrink-0 border-t border-zinc-200 bg-amber-50 px-4 py-1.5 text-center text-[11px] text-amber-800 dark:border-zinc-800 dark:bg-amber-950/50 dark:text-amber-300">
          This file type can&apos;t be rendered through the Hub. Showing Drive&apos;s native preview —
          if you see &quot;You need access&quot;, switch the account or open in Drive.
        </div>
      )}
    </div>
  )
}

function ModeButton({
  label,
  active,
  onClick,
  title,
}: {
  label: string
  active: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-purple-600 text-white'
          : 'bg-white text-zinc-600 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
      )}
    >
      {label}
    </button>
  )
}

type SheetDataResponse = {
  title: string
  tabs: Array<{ id: number; title: string; rowCount: number; columnCount: number; gridIndex: number }>
  activeTab: string
  values: string[][]
}

function SheetsTable({
  spreadsheetId,
  account,
}: {
  spreadsheetId: string
  account: string
}) {
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')
  // Client-side sort: null = sheet order, else { col, dir }.
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null)

  const query = useQuery<SheetDataResponse>({
    queryKey: ['drive-sheet', spreadsheetId, account, activeTab],
    queryFn: async () => {
      const params = new URLSearchParams({ id: spreadsheetId, account })
      if (activeTab) params.set('tab', activeTab)
      const res = await fetch(`/api/drive/sheet?${params.toString()}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load sheet')
      return data
    },
  })

  const values = query.data?.values ?? []
  // Treat the first row as headers for display. If someone has a sheet without
  // headers, they still get a usable table — the header row is just row 1.
  const headerRow = values[0] ?? []
  const dataRows = values.slice(1)

  const displayRows = useMemo(() => {
    let rows = dataRows
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(q)))
    }
    if (sort) {
      const { col, dir } = sort
      rows = [...rows].sort((a, b) => {
        const av = a[col] ?? ''
        const bv = b[col] ?? ''
        // Try numeric sort first, fall back to locale compare.
        const an = Number(av.replace(/[,$%]/g, ''))
        const bn = Number(bv.replace(/[,$%]/g, ''))
        if (Number.isFinite(an) && Number.isFinite(bn)) {
          return dir === 'asc' ? an - bn : bn - an
        }
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      })
    }
    return rows
  }, [dataRows, search, sort])

  function toggleSort(col: number) {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' }
      if (prev.dir === 'asc') return { col, dir: 'desc' }
      return null
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        {query.data && query.data.tabs.length > 1 && (
          <div className="flex items-center gap-1 overflow-x-auto">
            {query.data.tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.title)
                  setSort(null)
                }}
                className={cn(
                  'flex-shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  (activeTab ?? query.data!.activeTab) === tab.title
                    ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                )}
              >
                {tab.title}
              </button>
            ))}
          </div>
        )}
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter rows…"
            className="w-56 rounded-md border border-zinc-200 bg-white py-1 pl-7 pr-2 text-xs focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>
        {query.data && (
          <span className="flex-shrink-0 text-xs text-zinc-500">
            {displayRows.length} / {dataRows.length}
            {' row'}
            {dataRows.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {query.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
        </div>
      ) : query.isError ? (
        <div className="m-4 flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <div className="font-medium">Couldn&apos;t load sheet data</div>
            <div className="mt-1 text-xs">{(query.error as Error).message}</div>
            <div className="mt-2 text-xs text-red-700 dark:text-red-300">
              If this says &quot;insufficient scopes&quot;, reconnect the account in Settings
              to grant the Sheets permission.
            </div>
          </div>
        </div>
      ) : values.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          This tab is empty.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-max min-w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-zinc-50 shadow-[0_1px_0_0_rgba(0,0,0,0.06)] dark:bg-zinc-900">
              <tr>
                <th className="sticky left-0 z-20 w-10 border-r border-zinc-200 bg-zinc-50 px-2 py-2 text-right font-medium text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
                  #
                </th>
                {headerRow.map((cell, i) => {
                  const sorted = sort?.col === i
                  return (
                    <th
                      key={i}
                      onClick={() => toggleSort(i)}
                      className="cursor-pointer select-none border-r border-zinc-200 px-3 py-2 text-left font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      <span className="inline-flex items-center gap-1">
                        {cell || <span className="italic text-zinc-400">col {i + 1}</span>}
                        {sorted && (
                          <span className="text-purple-600">
                            {sort!.dir === 'asc' ? '↑' : '↓'}
                          </span>
                        )}
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, r) => (
                <tr key={r} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <td className="sticky left-0 z-10 w-10 border-r border-b border-zinc-200 bg-white px-2 py-1.5 text-right text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950">
                    {r + 2}
                  </td>
                  {headerRow.map((_, c) => (
                    <td
                      key={c}
                      className="max-w-[320px] truncate border-r border-b border-zinc-100 px-3 py-1.5 text-zinc-800 dark:border-zinc-800 dark:text-zinc-100"
                      title={row[c] || ''}
                    >
                      {row[c] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function NewFileMenu({
  accounts,
  defaultAccount,
  parentId,
  onCreated,
}: {
  accounts: string[]
  defaultAccount: string | undefined
  parentId?: string
  onCreated: (file: { id?: string | null; name?: string | null; webViewLink?: string | null }) => void
}) {
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<{
    kind: 'document' | 'spreadsheet' | 'presentation' | 'folder'
  } | null>(null)
  const [name, setName] = useState('')
  const [account, setAccount] = useState(defaultAccount || accounts[0] || '')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
        setStage(null)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!stage) throw new Error('No kind')
      const res = await fetch('/api/drive/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account,
          kind: stage.kind,
          name: name.trim(),
          parentId,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Create failed')
      return data.file as { id: string; name: string; webViewLink?: string | null }
    },
    onSuccess: (file) => {
      onCreated(file)
      setOpen(false)
      setStage(null)
      setName('')
    },
  })

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => {
          setOpen((v) => !v)
          setStage(null)
        }}
        className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
      >
        <Plus className="h-3.5 w-3.5" /> New
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          {!stage ? (
            <>
              <MenuItem icon={FileText} label="New Doc" onClick={() => setStage({ kind: 'document' })} />
              <MenuItem icon={Sheet} label="New Sheet" onClick={() => setStage({ kind: 'spreadsheet' })} />
              <MenuItem icon={Presentation} label="New Slides" onClick={() => setStage({ kind: 'presentation' })} />
              <MenuItem icon={FolderPlus} label="New Folder" onClick={() => setStage({ kind: 'folder' })} />
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!name.trim() || !account) return
                createMutation.mutate()
              }}
              className="space-y-2 p-3"
            >
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                  Name
                </label>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={stage.kind === 'folder' ? 'Folder name' : 'Untitled'}
                  className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
                />
              </div>
              {accounts.length > 1 && (
                <div>
                  <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                    Create in
                  </label>
                  <select
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    {accounts.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex gap-1">
                <button
                  type="submit"
                  disabled={createMutation.isPending || !name.trim()}
                  className="flex-1 rounded-md bg-purple-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Creating…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStage(null)
                    setName('')
                  }}
                  className="rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  Back
                </button>
              </div>
              {createMutation.isError && (
                <p className="text-xs text-red-600">
                  {(createMutation.error as Error).message}
                </p>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  )
}

function Breadcrumbs({
  folder,
  onNavigate,
}: {
  folder: { id: string; name: string; account: string }
  onNavigate: (next: { id: string; name: string; account: string } | null) => void
}) {
  const query = useQuery<{ crumbs: Array<{ id: string; name: string }> }>({
    queryKey: ['drive-crumbs', folder.id, folder.account],
    queryFn: async () => {
      const res = await fetch(
        `/api/drive/folder?id=${encodeURIComponent(folder.id)}&account=${encodeURIComponent(folder.account)}`
      )
      if (!res.ok) throw new Error('Failed to resolve folder')
      return res.json()
    },
  })
  const crumbs = query.data?.crumbs ?? [{ id: folder.id, name: folder.name }]

  return (
    <div className="flex items-center gap-1 overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      <button
        onClick={() => onNavigate(null)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <Home className="h-3 w-3" />
        All files
      </button>
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1
        return (
          <span key={c.id} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 flex-shrink-0 text-zinc-300" />
            {isLast ? (
              <span className="px-1.5 py-0.5 font-medium text-zinc-900 dark:text-zinc-100">
                {c.name}
              </span>
            ) : (
              <button
                onClick={() => onNavigate({ id: c.id, name: c.name, account: folder.account })}
                className="rounded-md px-1.5 py-0.5 text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                {c.name}
              </button>
            )}
          </span>
        )
      })}
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
