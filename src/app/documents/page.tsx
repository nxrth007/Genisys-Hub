'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  FolderOpen,
  Folder,
  FileText,
  FileType,
  File,
  Image as ImageIcon,
  Upload,
  FolderPlus,
  Trash2,
  ChevronRight,
  Home,
  Loader2,
  AlertCircle,
  Download,
  User as UserIcon,
  MoreVertical,
  Pencil,
  Move,
  Search,
  X,
  ExternalLink,
  Eye,
} from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'

type FolderNode = {
  id: string
  name: string
  parentId: string | null
  createdBy: { name: string | null; email: string }
  _count: { documents: number; children: number }
  updatedAt: string
}

type DocumentItem = {
  id: string
  folderId: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  uploadedBy: { name: string | null; email: string }
  createdAt: string
  updatedAt: string
}

type Listing = {
  folders: FolderNode[]
  documents: DocumentItem[]
  crumbs: Array<{ id: string; name: string }>
}

type SearchResultFolder = {
  kind: 'folder'
  id: string
  parentId: string | null
  name: string
  path: string[]
  documentCount: number
  childCount: number
  updatedAt: string
  createdBy: { name: string | null; email: string }
}

type SearchResultDocument = {
  kind: 'document'
  id: string
  folderId: string | null
  filename: string
  path: string[]
  mimeType: string
  sizeBytes: number
  createdAt: string
  updatedAt: string
  uploadedBy: { name: string | null; email: string }
}

type SearchResult = SearchResultFolder | SearchResultDocument

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function canPreview(mime: string): boolean {
  return mime === 'application/pdf' || mime.startsWith('image/')
}

function MimeIcon({ mime, className }: { mime: string; className?: string }) {
  if (mime === 'application/pdf') return <FileType className={className} />
  if (mime.startsWith('image/')) return <ImageIcon className={className} />
  if (
    mime === 'application/msword' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return <FileText className={className} />
  return <File className={className} />
}

export default function DocumentsPage() {
  const qc = useQueryClient()
  const [folderId, setFolderId] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [previewDoc, setPreviewDoc] = useState<DocumentItem | SearchResultDocument | null>(null)
  const [moveTarget, setMoveTarget] = useState<
    | { kind: 'document'; id: string; filename: string; currentFolderId: string | null }
    | { kind: 'folder'; id: string; name: string; currentParentId: string | null }
    | null
  >(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Debounce search input so typing doesn't spam the API. 250ms feels
  // responsive without triggering a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const isSearching = debouncedSearch.length > 0

  const listing = useQuery<Listing>({
    queryKey: ['documents', folderId],
    queryFn: async () => {
      const sp = new URLSearchParams()
      if (folderId) sp.set('folderId', folderId)
      const res = await fetch(`/api/documents?${sp.toString()}`)
      if (!res.ok) throw new Error('Failed to load')
      return res.json()
    },
    enabled: !isSearching,
  })

  const searchQuery = useQuery<{ results: SearchResult[] }>({
    queryKey: ['documents-search', debouncedSearch],
    queryFn: async () => {
      const res = await fetch(
        `/api/documents/search?q=${encodeURIComponent(debouncedSearch)}`
      )
      if (!res.ok) throw new Error('Search failed')
      return res.json()
    },
    enabled: isSearching,
  })

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['documents'] })
    qc.invalidateQueries({ queryKey: ['documents-search'] })
    qc.invalidateQueries({ queryKey: ['documents-folders-all'] })
  }

  const createFolder = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/documents/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newFolderName, parentId: folderId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Create failed')
      return data
    },
    onSuccess: () => {
      setShowNewFolder(false)
      setNewFolderName('')
      invalidateAll()
    },
  })

  const deleteFolder = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/documents/folders/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      return res.json()
    },
    onSuccess: invalidateAll,
  })

  const renameFolder = useMutation({
    mutationFn: async (params: { id: string; name: string }) => {
      const res = await fetch(`/api/documents/folders/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: params.name }),
      })
      if (!res.ok) throw new Error('Rename failed')
      return res.json()
    },
    onSuccess: invalidateAll,
  })

  const moveFolder = useMutation({
    mutationFn: async (params: { id: string; parentId: string | null }) => {
      const res = await fetch(`/api/documents/folders/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: params.parentId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Move failed')
      return data
    },
    onSuccess: () => {
      setMoveTarget(null)
      invalidateAll()
    },
  })

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      return res.json()
    },
    onSuccess: invalidateAll,
  })

  const renameDoc = useMutation({
    mutationFn: async (params: { id: string; filename: string }) => {
      const res = await fetch(`/api/documents/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: params.filename }),
      })
      if (!res.ok) throw new Error('Rename failed')
      return res.json()
    },
    onSuccess: invalidateAll,
  })

  const moveDoc = useMutation({
    mutationFn: async (params: { id: string; folderId: string | null }) => {
      const res = await fetch(`/api/documents/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: params.folderId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Move failed')
      return data
    },
    onSuccess: () => {
      setMoveTarget(null)
      invalidateAll()
    },
  })

  const upload = useMutation({
    mutationFn: async (files: FileList | File[]) => {
      const results: Array<{ name: string; ok: boolean; error?: string }> = []
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', file)
        if (folderId) fd.append('folderId', folderId)
        const res = await fetch('/api/documents', { method: 'POST', body: fd })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          results.push({ name: file.name, ok: false, error: data.error || 'Failed' })
        } else {
          results.push({ name: file.name, ok: true })
        }
      }
      const failures = results.filter((r) => !r.ok)
      if (failures.length > 0) {
        throw new Error(failures.map((f) => `${f.name}: ${f.error}`).join('\n'))
      }
      return results
    },
    onMutate: () => {
      setUploadError(null)
    },
    onSuccess: () => {
      invalidateAll()
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    onError: (err) => {
      setUploadError((err as Error).message)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
  })

  const folders = listing.data?.folders ?? []
  const documents = listing.data?.documents ?? []
  const crumbs = listing.data?.crumbs ?? []
  const searchResults = searchQuery.data?.results ?? []

  // Page-wide drag-and-drop upload. React's drag events count both outer
  // and inner elements entering; the counter keeps the overlay stable.
  const dragCounter = useRef(0)
  function onDragEnter(e: React.DragEvent) {
    e.preventDefault()
    if (e.dataTransfer?.types?.includes('Files')) {
      dragCounter.current += 1
      setIsDragOver(true)
    }
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current -= 1
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setIsDragOver(false)
    }
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)
    const files = e.dataTransfer?.files
    if (files && files.length > 0) upload.mutate(files)
  }

  return (
    <div
      className="relative max-w-5xl space-y-6"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-purple-600/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-purple-500 bg-white/95 px-8 py-6 shadow-xl dark:bg-zinc-900/95">
            <Upload className="mx-auto h-10 w-10 text-purple-600" />
            <p className="mt-2 text-center text-lg font-semibold text-purple-700 dark:text-purple-300">
              Drop to upload
            </p>
            <p className="text-center text-xs text-zinc-500">
              Files will land in{' '}
              {folderId
                ? crumbs[crumbs.length - 1]?.name || 'current folder'
                : 'the root folder'}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
              <FolderOpen className="h-6 w-6 text-purple-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Documents</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Internal contracts and important files. Stored in the Hub — separate
                from Google Drive. Drag and drop to upload.
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            onClick={() => setShowNewFolder(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New folder
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={upload.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-2 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {upload.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.png,.jpg,.jpeg"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                upload.mutate(e.target.files)
              }
            }}
          />
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search all documents and folders…"
          className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-9 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
        />
        {searchInput && (
          <button
            onClick={() => setSearchInput('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
            title="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Breadcrumb — hidden while searching since results span folders */}
      {!isSearching && (
        <div className="flex items-center gap-1 overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
          <button
            onClick={() => setFolderId(null)}
            className={cn(
              'flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium transition-colors',
              folderId === null
                ? 'text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
            )}
          >
            <Home className="h-3 w-3" />
            Documents
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
                    onClick={() => setFolderId(c.id)}
                    className="rounded-md px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  >
                    {c.name}
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}

      {uploadError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Upload failed</p>
            <pre className="mt-1 whitespace-pre-wrap font-sans">{uploadError}</pre>
          </div>
        </div>
      )}

      {showNewFolder && !isSearching && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (newFolderName.trim()) createFolder.mutate()
          }}
          className="flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 p-3 dark:border-purple-800 dark:bg-purple-950/30"
        >
          <FolderPlus className="h-4 w-4 flex-shrink-0 text-purple-600" />
          <input
            autoFocus
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="Folder name"
            className="flex-1 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <button
            type="submit"
            disabled={createFolder.isPending || !newFolderName.trim()}
            className="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {createFolder.isPending ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowNewFolder(false)
              setNewFolderName('')
            }}
            className="rounded-md px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          {createFolder.isError && (
            <span className="text-xs text-red-600">
              {(createFolder.error as Error).message}
            </span>
          )}
        </form>
      )}

      {/* Listing — search mode OR folder browse */}
      {isSearching ? (
        <SearchListing
          results={searchResults}
          isLoading={searchQuery.isLoading}
          query={debouncedSearch}
          onOpenFolder={(id) => {
            setFolderId(id)
            setSearchInput('')
          }}
          onPreviewDoc={(d) => setPreviewDoc(d)}
          onDeleteDoc={(id, name) => {
            if (confirm(`Delete "${name}"? This cannot be undone.`)) {
              deleteDoc.mutate(id)
            }
          }}
          onDeleteFolder={(id, name, count) => {
            if (
              count > 0
                ? confirm(
                    `Delete "${name}" and the ${count} item${
                      count === 1 ? '' : 's'
                    } inside it? This cannot be undone.`
                  )
                : confirm(`Delete "${name}"?`)
            ) {
              deleteFolder.mutate(id)
            }
          }}
        />
      ) : listing.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
        </div>
      ) : folders.length === 0 && documents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <FolderOpen className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-500">
            {folderId ? 'This folder is empty.' : 'No documents yet.'}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Click Upload, drag files onto the page, or create a folder.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {folders.map((f) => (
              <FolderRow
                key={f.id}
                folder={f}
                onOpen={() => setFolderId(f.id)}
                onRename={(name) => renameFolder.mutate({ id: f.id, name })}
                onMove={() =>
                  setMoveTarget({
                    kind: 'folder',
                    id: f.id,
                    name: f.name,
                    currentParentId: f.parentId,
                  })
                }
                onDelete={() => {
                  const has = f._count.documents + f._count.children
                  if (
                    has > 0
                      ? confirm(
                          `Delete "${f.name}" and the ${has} item${
                            has === 1 ? '' : 's'
                          } inside it? This cannot be undone.`
                        )
                      : confirm(`Delete "${f.name}"?`)
                  ) {
                    deleteFolder.mutate(f.id)
                  }
                }}
              />
            ))}
            {documents.map((d) => (
              <DocumentRow
                key={d.id}
                doc={d}
                onPreview={() => setPreviewDoc(d)}
                onRename={(filename) => renameDoc.mutate({ id: d.id, filename })}
                onMove={() =>
                  setMoveTarget({
                    kind: 'document',
                    id: d.id,
                    filename: d.filename,
                    currentFolderId: d.folderId,
                  })
                }
                onDelete={() => {
                  if (confirm(`Delete "${d.filename}"? This cannot be undone.`)) {
                    deleteDoc.mutate(d.id)
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-zinc-400">
        Allowed: PDF, Word, Excel, PowerPoint, text, PNG/JPEG. Max 25 MB per file.
      </p>

      {previewDoc && (
        <PreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {moveTarget && (
        <MoveDialog
          target={moveTarget}
          onCancel={() => setMoveTarget(null)}
          onMove={(destFolderId) => {
            if (moveTarget.kind === 'document') {
              moveDoc.mutate({ id: moveTarget.id, folderId: destFolderId })
            } else {
              moveFolder.mutate({ id: moveTarget.id, parentId: destFolderId })
            }
          }}
          pending={moveDoc.isPending || moveFolder.isPending}
          error={
            (moveDoc.error as Error | null)?.message ||
            (moveFolder.error as Error | null)?.message ||
            null
          }
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------

function FolderRow({
  folder,
  onOpen,
  onRename,
  onMove,
  onDelete,
}: {
  folder: FolderNode
  onOpen: () => void
  onRename: (name: string) => void
  onMove: () => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(folder.name)

  return (
    <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <button
        onClick={renaming ? undefined : onOpen}
        disabled={renaming}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-purple-100 dark:bg-purple-950">
          <Folder className="h-[18px] w-[18px] text-purple-600" />
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault()
                if (name.trim() && name.trim() !== folder.name) onRename(name.trim())
                setRenaming(false)
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  if (name.trim() && name.trim() !== folder.name) onRename(name.trim())
                  setRenaming(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setName(folder.name)
                    setRenaming(false)
                  }
                }}
                className="w-full rounded-md border border-purple-500 bg-white px-2 py-0.5 text-sm focus:outline-none dark:bg-zinc-950"
              />
            </form>
          ) : (
            <p className="truncate text-sm font-medium">{folder.name}</p>
          )}
          <p className="mt-0.5 text-xs text-zinc-500">
            {folder._count.documents} file{folder._count.documents === 1 ? '' : 's'}
            {folder._count.children > 0 &&
              ` · ${folder._count.children} subfolder${folder._count.children === 1 ? '' : 's'}`}
            {' · created '}
            {formatDate(folder.updatedAt)}
            {folder.createdBy.name && ` · ${folder.createdBy.name}`}
          </p>
        </div>
      </button>
      <RowMenu
        onRename={() => {
          setName(folder.name)
          setRenaming(true)
        }}
        onMove={onMove}
        onDelete={onDelete}
      />
    </div>
  )
}

function DocumentRow({
  doc,
  onPreview,
  onRename,
  onMove,
  onDelete,
}: {
  doc: DocumentItem
  onPreview: () => void
  onRename: (filename: string) => void
  onMove: () => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [filename, setFilename] = useState(doc.filename)
  const previewable = canPreview(doc.mimeType)

  return (
    <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <button
        onClick={renaming ? undefined : previewable ? onPreview : undefined}
        disabled={renaming || !previewable}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 text-left',
          !previewable && !renaming && 'cursor-default'
        )}
      >
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
          <MimeIcon mime={doc.mimeType} className="h-[18px] w-[18px] text-zinc-500" />
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault()
                if (filename.trim() && filename.trim() !== doc.filename) {
                  onRename(filename.trim())
                }
                setRenaming(false)
              }}
            >
              <input
                autoFocus
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                onBlur={() => {
                  if (filename.trim() && filename.trim() !== doc.filename) {
                    onRename(filename.trim())
                  }
                  setRenaming(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setFilename(doc.filename)
                    setRenaming(false)
                  }
                }}
                className="w-full rounded-md border border-purple-500 bg-white px-2 py-0.5 text-sm focus:outline-none dark:bg-zinc-950"
              />
            </form>
          ) : (
            <p className="truncate text-sm font-medium">{doc.filename}</p>
          )}
          <p className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
            <span>{humanSize(doc.sizeBytes)}</span>
            <span>·</span>
            <span>added {formatDate(doc.createdAt)}</span>
            {doc.uploadedBy.name && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  <UserIcon className="h-3 w-3" />
                  {doc.uploadedBy.name}
                </span>
              </>
            )}
            {previewable && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1 text-purple-600">
                  <Eye className="h-3 w-3" />
                  click to preview
                </span>
              </>
            )}
          </p>
        </div>
      </button>
      <a
        href={`/api/documents/${doc.id}`}
        download={doc.filename}
        title="Download"
        className="flex-shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-zinc-100 hover:text-purple-600 dark:hover:bg-zinc-800"
      >
        <Download className="h-3.5 w-3.5" />
      </a>
      <RowMenu
        onRename={() => {
          setFilename(doc.filename)
          setRenaming(true)
        }}
        onMove={onMove}
        onDelete={onDelete}
      />
    </div>
  )
}

function RowMenu({
  onRename,
  onMove,
  onDelete,
}: {
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
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

  return (
    <div ref={menuRef} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="More"
        className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          <MenuItem
            icon={Pencil}
            label="Rename"
            onClick={() => {
              setOpen(false)
              onRename()
            }}
          />
          <MenuItem
            icon={Move}
            label="Move to…"
            onClick={() => {
              setOpen(false)
              onMove()
            }}
          />
          <MenuItem
            icon={Trash2}
            label="Delete"
            destructive
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          />
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

// ---------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------

function SearchListing({
  results,
  isLoading,
  query,
  onOpenFolder,
  onPreviewDoc,
  onDeleteDoc,
  onDeleteFolder,
}: {
  results: SearchResult[]
  isLoading: boolean
  query: string
  onOpenFolder: (id: string) => void
  onPreviewDoc: (d: SearchResultDocument) => void
  onDeleteDoc: (id: string, name: string) => void
  onDeleteFolder: (id: string, name: string, childCount: number) => void
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
      </div>
    )
  }
  if (results.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
        <Search className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" />
        <p className="mt-3 text-sm text-zinc-500">
          No matches for &quot;{query}&quot;.
        </p>
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/50">
        {results.length} result{results.length === 1 ? '' : 's'} for &quot;{query}&quot;
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {results.map((r) =>
          r.kind === 'folder' ? (
            <div
              key={`f-${r.id}`}
              className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
            >
              <button
                onClick={() => onOpenFolder(r.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-purple-100 dark:bg-purple-950">
                  <Folder className="h-[18px] w-[18px] text-purple-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {r.path.length > 0 ? r.path.join(' / ') : 'Root'} ·{' '}
                    {r.documentCount} file{r.documentCount === 1 ? '' : 's'}
                  </p>
                </div>
              </button>
              <button
                onClick={() =>
                  onDeleteFolder(r.id, r.name, r.documentCount + r.childCount)
                }
                title="Delete folder"
                className="flex-shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 opacity-0 group-hover:opacity-100 dark:hover:bg-red-950"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div
              key={`d-${r.id}`}
              className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
            >
              <button
                onClick={() => (canPreview(r.mimeType) ? onPreviewDoc(r) : null)}
                disabled={!canPreview(r.mimeType)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-3 text-left',
                  !canPreview(r.mimeType) && 'cursor-default'
                )}
              >
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                  <MimeIcon
                    mime={r.mimeType}
                    className="h-[18px] w-[18px] text-zinc-500"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.filename}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {r.path.length > 0 ? r.path.join(' / ') : 'Root'} ·{' '}
                    {humanSize(r.sizeBytes)}
                    {r.uploadedBy.name && ` · ${r.uploadedBy.name}`}
                  </p>
                </div>
              </button>
              <a
                href={`/api/documents/${r.id}`}
                download={r.filename}
                title="Download"
                className="flex-shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-zinc-100 hover:text-purple-600 dark:hover:bg-zinc-800"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
              <button
                onClick={() => onDeleteDoc(r.id, r.filename)}
                title="Delete"
                className="flex-shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 opacity-0 group-hover:opacity-100 dark:hover:bg-red-950"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Preview modal — PDFs + images render inline via the download endpoint
// ---------------------------------------------------------------------

function PreviewModal({
  doc,
  onClose,
}: {
  doc: DocumentItem | SearchResultDocument
  onClose: () => void
}) {
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const filename = 'filename' in doc ? doc.filename : ''
  const url = `/api/documents/${doc.id}`

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-zinc-200 bg-zinc-50/50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
        <button
          onClick={onClose}
          title="Close (Esc)"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
          <MimeIcon mime={doc.mimeType} className="h-4 w-4 text-zinc-500" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{filename}</p>
          <p className="truncate text-xs text-zinc-500">{humanSize(doc.sizeBytes)}</p>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in new tab"
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open
        </a>
        <a
          href={url}
          download={filename}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      </div>
      <iframe
        src={url}
        title={filename}
        className="flex-1 w-full bg-white dark:bg-zinc-950"
      />
    </div>
  )
}

// ---------------------------------------------------------------------
// Move dialog — folder tree picker
// ---------------------------------------------------------------------

type MoveTarget =
  | { kind: 'document'; id: string; filename: string; currentFolderId: string | null }
  | { kind: 'folder'; id: string; name: string; currentParentId: string | null }

function MoveDialog({
  target,
  onCancel,
  onMove,
  pending,
  error,
}: {
  target: MoveTarget
  onCancel: () => void
  onMove: (destFolderId: string | null) => void
  pending: boolean
  error: string | null
}) {
  const { data } = useQuery<{ folders: Array<{ id: string; name: string; parentId: string | null }> }>({
    queryKey: ['documents-folders-all'],
    queryFn: async () => {
      const res = await fetch('/api/documents/folders')
      if (!res.ok) throw new Error('Failed to load folders')
      return res.json()
    },
  })
  const folders = useMemo(() => data?.folders ?? [], [data])

  const [selectedId, setSelectedId] = useState<string | null>(
    target.kind === 'document' ? target.currentFolderId : target.currentParentId
  )

  const currentLocationId =
    target.kind === 'document' ? target.currentFolderId : target.currentParentId

  // Folders we can't move INTO: if moving a folder, exclude itself and any
  // descendant (would create a cycle).
  const disabledIds = useMemo(() => {
    if (target.kind !== 'folder') return new Set<string>()
    const blocked = new Set<string>([target.id])
    let changed = true
    while (changed) {
      changed = false
      for (const f of folders) {
        if (f.parentId && blocked.has(f.parentId) && !blocked.has(f.id)) {
          blocked.add(f.id)
          changed = true
        }
      }
    }
    return blocked
  }, [folders, target])

  // Render as a nested tree — root-level folders with children indented.
  const byParent = useMemo(() => {
    const m = new Map<string | null, typeof folders>()
    for (const f of folders) {
      const p = f.parentId
      if (!m.has(p)) m.set(p, [])
      m.get(p)!.push(f)
    }
    return m
  }, [folders])

  const renderTree = (parentId: string | null, depth: number): React.ReactNode => {
    const children = byParent.get(parentId) || []
    return children.map((f) => (
      <div key={f.id}>
        <button
          type="button"
          onClick={() => !disabledIds.has(f.id) && setSelectedId(f.id)}
          disabled={disabledIds.has(f.id)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
            selectedId === f.id
              ? 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200'
              : disabledIds.has(f.id)
                ? 'cursor-not-allowed text-zinc-300 dark:text-zinc-600'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-purple-600" />
          <span className="truncate">{f.name}</span>
          {f.id === currentLocationId && (
            <span className="ml-auto text-[10px] text-zinc-400">current</span>
          )}
        </button>
        {renderTree(f.id, depth + 1)}
      </div>
    ))
  }

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold">Move to folder</h3>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {target.kind === 'document' ? target.filename : target.name}
          </p>
        </div>

        <div className="max-h-[55vh] overflow-y-auto px-3 py-2">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
              selectedId === null
                ? 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
            )}
          >
            <Home className="h-3.5 w-3.5 flex-shrink-0 text-purple-600" />
            <span className="font-medium">Root (Documents)</span>
            {currentLocationId === null && (
              <span className="ml-auto text-[10px] text-zinc-400">current</span>
            )}
          </button>
          {renderTree(null, 0)}
          {folders.length === 0 && (
            <p className="px-2 py-4 text-xs text-zinc-400">
              No folders yet. Cancel and create one first.
            </p>
          )}
        </div>

        {error && (
          <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onMove(selectedId)}
            disabled={pending || selectedId === currentLocationId}
            className="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {pending ? 'Moving…' : 'Move here'}
          </button>
        </div>
      </div>
    </div>
  )
}
