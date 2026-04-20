'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
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
} from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'

type Folder = {
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
  folders: Folder[]
  documents: DocumentItem[]
  crumbs: Array<{ id: string; name: string }>
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
  const fileInputRef = useRef<HTMLInputElement>(null)

  const listing = useQuery<Listing>({
    queryKey: ['documents', folderId],
    queryFn: async () => {
      const sp = new URLSearchParams()
      if (folderId) sp.set('folderId', folderId)
      const res = await fetch(`/api/documents?${sp.toString()}`)
      if (!res.ok) throw new Error('Failed to load')
      return res.json()
    },
  })

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
      qc.invalidateQueries({ queryKey: ['documents', folderId] })
    },
  })

  const deleteFolder = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/documents/folders/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents', folderId] })
    },
  })

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents', folderId] })
    },
  })

  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      // Upload sequentially — keeps memory predictable and makes per-file
      // error reporting straightforward.
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
        throw new Error(
          failures.map((f) => `${f.name}: ${f.error}`).join('\n')
        )
      }
      return results
    },
    onMutate: () => {
      setUploadError(null)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents', folderId] })
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    onError: (err) => {
      setUploadError((err as Error).message)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
  })

  const data = listing.data
  const folders = data?.folders ?? []
  const documents = data?.documents ?? []
  const crumbs = data?.crumbs ?? []

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
              <FolderOpen className="h-6 w-6 text-purple-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Documents</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Internal contracts and important files. Stored directly in the Hub —
                separate from your Google Drive.
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

      {/* Breadcrumb */}
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

      {uploadError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Upload failed</p>
            <pre className="mt-1 whitespace-pre-wrap font-sans">{uploadError}</pre>
          </div>
        </div>
      )}

      {showNewFolder && (
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

      {listing.isLoading ? (
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
            Click Upload to add a file, or New folder to organize.
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
    </div>
  )
}

function FolderRow({
  folder,
  onOpen,
  onDelete,
}: {
  folder: Folder
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-purple-100 dark:bg-purple-950">
          <Folder className="h-[18px] w-[18px] text-purple-600" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{folder.name}</p>
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
      <button
        onClick={onDelete}
        title="Delete folder"
        className="flex-shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 opacity-0 group-hover:opacity-100 dark:hover:bg-red-950"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function DocumentRow({
  doc,
  onDelete,
}: {
  doc: DocumentItem
  onDelete: () => void
}) {
  return (
    <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <Link
        href={`/api/documents/${doc.id}`}
        target="_blank"
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
          <MimeIcon mime={doc.mimeType} className="h-[18px] w-[18px] text-zinc-500" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{doc.filename}</p>
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
          </p>
        </div>
      </Link>
      <a
        href={`/api/documents/${doc.id}`}
        download={doc.filename}
        title="Download"
        className="flex-shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-zinc-100 hover:text-purple-600 dark:hover:bg-zinc-800"
      >
        <Download className="h-3.5 w-3.5" />
      </a>
      <button
        onClick={onDelete}
        title="Delete"
        className="flex-shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 opacity-0 group-hover:opacity-100 dark:hover:bg-red-950"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
