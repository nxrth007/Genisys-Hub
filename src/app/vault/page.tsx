'use client'

import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Key,
  Plus,
  Eye,
  EyeOff,
  Pencil,
  Trash2,
  History,
  Copy,
  Check,
  Search,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type VaultEntry = {
  id: string
  name: string
  description: string | null
  tags: string[]
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: { id: string; name: string | null; email: string }
}

type AuditLogRow = {
  id: string
  action: 'create' | 'view' | 'edit' | 'delete'
  createdAt: string
  user: { id: string; name: string | null; email: string }
}

export default function VaultPage() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<VaultEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<VaultEntry | null>(null)
  const [auditTarget, setAuditTarget] = useState<VaultEntry | null>(null)
  const [revealedFor, setRevealedFor] = useState<{ id: string; name: string; value: string } | null>(null)
  const [search, setSearch] = useState('')

  const { data, isLoading, error } = useQuery<{ entries: VaultEntry[] }>({
    queryKey: ['vault-entries'],
    queryFn: async () => {
      const res = await fetch('/api/vault')
      if (!res.ok) throw new Error('Failed to load vault')
      return res.json()
    },
  })

  const revealMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/vault/${id}/reveal`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to reveal')
      return res.json() as Promise<{ id: string; name: string; value: string }>
    },
    onSuccess: (data) => {
      setRevealedFor(data)
      qc.invalidateQueries({ queryKey: ['vault-entries'] })
    },
  })

  const entries = data?.entries ?? []
  const filtered = entries.filter((e) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      e.name.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q))
    )
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
              <Key className="h-6 w-6 text-purple-600" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight">API Key Vault</h2>
          </div>
          <p className="mt-2 text-sm text-zinc-500">
            Encrypted with XChaCha20-Poly1305. Every reveal, edit, and delete is logged.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-700"
        >
          <Plus className="h-4 w-4" />
          Add entry
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
        <input
          type="text"
          placeholder="Search by name, description, or tag..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-zinc-200 bg-white pl-10 pr-4 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 dark:border-zinc-800 dark:bg-zinc-900"
        />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-sm text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="p-12 text-center text-sm text-red-600">Failed to load vault.</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <Key className="mx-auto h-8 w-8 text-zinc-300 mb-3" />
            <p className="text-sm text-zinc-500">
              {entries.length === 0
                ? 'No entries yet. Click "Add entry" to store your first API key.'
                : 'No entries match your search.'}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-950/50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Tags</th>
                <th className="px-4 py-3 font-medium">Created by</th>
                <th className="px-4 py-3 font-medium">Last used</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {filtered.map((entry) => (
                <tr key={entry.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-950/50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{entry.name}</div>
                    {entry.description && (
                      <div className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{entry.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {entry.tags.length === 0 ? (
                        <span className="text-xs text-zinc-400">—</span>
                      ) : (
                        entry.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          >
                            {tag}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {entry.createdBy.name || entry.createdBy.email}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">
                    {entry.lastUsedAt ? formatRelative(entry.lastUsedAt) : 'Never'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        label="Reveal"
                        onClick={() => revealMutation.mutate(entry.id)}
                        disabled={revealMutation.isPending}
                      >
                        <Eye className="h-4 w-4" />
                      </IconButton>
                      <IconButton label="Edit" onClick={() => setEditTarget(entry)}>
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      <IconButton label="Audit log" onClick={() => setAuditTarget(entry)}>
                        <History className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        label="Delete"
                        onClick={() => setDeleteTarget(entry)}
                        variant="danger"
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <EntryFormModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['vault-entries'] })
            setShowAdd(false)
          }}
        />
      )}

      {editTarget && (
        <EntryFormModal
          entry={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['vault-entries'] })
            setEditTarget(null)
          }}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          entry={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ['vault-entries'] })
            setDeleteTarget(null)
          }}
        />
      )}

      {auditTarget && (
        <AuditLogModal entry={auditTarget} onClose={() => setAuditTarget(null)} />
      )}

      {revealedFor && (
        <RevealModal
          entry={revealedFor}
          onClose={() => setRevealedFor(null)}
        />
      )}
    </div>
  )
}

// -------------------------------------------------------------------------
// Sub-components
// -------------------------------------------------------------------------

function IconButton({
  children,
  label,
  onClick,
  disabled,
  variant = 'default',
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'danger'
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'rounded-md p-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'danger'
          ? 'text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
      )}
    >
      {children}
    </button>
  )
}

function Modal({
  title,
  onClose,
  children,
  maxWidth = 'max-w-lg',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  maxWidth?: string
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className={cn(
          'relative w-full rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-900',
          maxWidth
        )}
      >
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function EntryFormModal({
  entry,
  onClose,
  onSaved,
}: {
  entry?: VaultEntry
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!entry
  const [name, setName] = useState(entry?.name ?? '')
  const [description, setDescription] = useState(entry?.description ?? '')
  const [tagsInput, setTagsInput] = useState((entry?.tags ?? []).join(', '))
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setSubmitting(true)

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    try {
      const body: Record<string, unknown> = {
        name,
        description: description.trim() || null,
        tags,
      }
      if (value) body.value = value

      const url = isEdit ? `/api/vault/${entry!.id}` : '/api/vault'
      const method = isEdit ? 'PATCH' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Request failed (${res.status})`)
      }
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={isEdit ? `Edit: ${entry!.name}` : 'Add vault entry'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g. "GHL • Genisys"'
            required
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </Field>

        <Field label="Description">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional notes"
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </Field>

        <Field label="Tags (comma-separated)">
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="ghl, client:acme"
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </Field>

        <Field
          label={isEdit ? 'Value (leave blank to keep current)' : 'Value'}
          required={!isEdit}
        >
          <div className="relative">
            <input
              type={showValue ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required={!isEdit}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-zinc-200 px-3 py-2 pr-10 text-sm font-mono focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
            <button
              type="button"
              onClick={() => setShowValue(!showValue)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-700"
              tabIndex={-1}
            >
              {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        {err && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{err}</div>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name || (!isEdit && !value)}
            className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add entry'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function DeleteConfirmModal({
  entry,
  onClose,
  onDeleted,
}: {
  entry: VaultEntry
  onClose: () => void
  onDeleted: () => void
}) {
  const [submitting, setSubmitting] = useState(false)

  async function handleDelete() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/vault/${entry.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      onDeleted()
    } catch {
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Delete entry?" onClose={onClose}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        This will permanently delete <span className="font-semibold">{entry.name}</span> and its entire
        audit history. This cannot be undone.
      </p>
      <div className="flex items-center justify-end gap-2 pt-6">
        <button
          onClick={onClose}
          className="rounded-md px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          onClick={handleDelete}
          disabled={submitting}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {submitting ? 'Deleting…' : 'Delete permanently'}
        </button>
      </div>
    </Modal>
  )
}

function AuditLogModal({ entry, onClose }: { entry: VaultEntry; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ log: AuditLogRow[] }>({
    queryKey: ['vault-audit', entry.id],
    queryFn: async () => {
      const res = await fetch(`/api/vault/${entry.id}/audit`)
      if (!res.ok) throw new Error('Failed to load audit log')
      return res.json()
    },
  })

  return (
    <Modal title={`Audit log: ${entry.name}`} onClose={onClose} maxWidth="max-w-2xl">
      {isLoading ? (
        <p className="text-sm text-zinc-500 py-8 text-center">Loading…</p>
      ) : !data?.log?.length ? (
        <p className="text-sm text-zinc-500 py-8 text-center">No access recorded yet.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-950/50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {data.log.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                    {formatRelative(row.createdAt)}
                  </td>
                  <td className="px-3 py-2">{row.user.name || row.user.email}</td>
                  <td className="px-3 py-2">
                    <ActionBadge action={row.action} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

function ActionBadge({ action }: { action: AuditLogRow['action'] }) {
  const styles: Record<AuditLogRow['action'], string> = {
    create: 'bg-green-100 text-green-800',
    view: 'bg-purple-100 text-purple-800',
    edit: 'bg-amber-100 text-amber-800',
    delete: 'bg-red-100 text-red-800',
  }
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', styles[action])}
    >
      {action}
    </span>
  )
}

function RevealModal({
  entry,
  onClose,
}: {
  entry: { id: string; name: string; value: string }
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(30)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(intervalRef.current!)
          onClose()
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [onClose])

  async function copy() {
    try {
      await navigator.clipboard.writeText(entry.value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <Modal title={`Reveal: ${entry.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          This view auto-closes in <strong>{secondsLeft}s</strong>. Your reveal is recorded in the audit log.
        </div>
        <div className="rounded-md bg-zinc-100 p-3 font-mono text-sm break-all dark:bg-zinc-950">
          {entry.value}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={copy}
            className="inline-flex items-center gap-2 rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

function formatRelative(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
