'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, Plus, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'

/**
 * Shared "New task" modal used by both the Focus list and the Kanban
 * board on /today. Same visual frame, same pickers, same submit flow —
 * so creating a task feels identical no matter which view you're in.
 *
 * Target column is controlled by `targetStatus`. Focus always passes
 * "To Do" (or the board's best synonym for it); Kanban passes whichever
 * column's "+ New task" was clicked.
 */

export type NewTaskDialogSchema = {
  titleProp: string
  statusPropName: string
  statusPropType: 'status' | 'select'
  priorityProp?: string
  priorityOptions?: string[]
  assigneeProp?: string
  /** 'people' | 'select' | 'multi_select' */
  assigneePropType?: string
  /** For select / multi_select: the named options from the DB schema. */
  assigneeOptions?: string[]
}

type NotionUser = { id: string; name: string; email?: string }

export function NewTaskDialog({
  dbId,
  schema,
  targetStatus,
  onClose,
  onCreated,
}: {
  dbId: string
  schema: NewTaskDialogSchema
  targetStatus: string
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<string>('')
  const [assignee, setAssignee] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only fetch Notion users when the DB actually uses a people-type
  // assignee column. Select / multi_select assignees read options from
  // the schema instead.
  const peopleMode = schema.assigneePropType === 'people'
  const { data: usersData } = useQuery<{ users: NotionUser[] }>({
    queryKey: ['notion-users'],
    queryFn: async () => {
      const res = await fetch('/api/notion/users')
      if (!res.ok) throw new Error('Failed to load Notion users')
      return res.json()
    },
    enabled: peopleMode,
    staleTime: 5 * 60_000,
  })
  const notionUsers = usersData?.users ?? []

  const assigneeChoices: string[] = peopleMode
    ? notionUsers.map((u) => u.name)
    : schema.assigneeOptions ?? []
  const hasAssignee = !!schema.assigneeProp && assigneeChoices.length > 0
  const hasPriority =
    !!schema.priorityProp && (schema.priorityOptions?.length ?? 0) > 0

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const properties: Record<string, unknown> = {
        [schema.titleProp]: { title: [{ text: { content: title.trim() } }] },
      }
      if (schema.statusPropType === 'status') {
        properties[schema.statusPropName] = { status: { name: targetStatus } }
      } else {
        properties[schema.statusPropName] = { select: { name: targetStatus } }
      }
      if (schema.priorityProp && priority) {
        properties[schema.priorityProp] = { select: { name: priority } }
      }
      if (schema.assigneeProp && assignee) {
        if (schema.assigneePropType === 'people') {
          const user = notionUsers.find((u) => u.name === assignee)
          if (user) {
            properties[schema.assigneeProp] = {
              people: [{ object: 'user', id: user.id }],
            }
          }
        } else if (schema.assigneePropType === 'multi_select') {
          properties[schema.assigneeProp] = {
            multi_select: [{ name: assignee }],
          }
        } else {
          properties[schema.assigneeProp] = { select: { name: assignee } }
        }
      }

      const res = await fetch('/api/notion/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: dbId, properties, isDatabase: true }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to create task')
      }
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <form
        onSubmit={submit}
        className="relative w-full max-w-md space-y-4 rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900"
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">New task</h3>
            <p className="text-xs text-zinc-500">
              Adds to the board&apos;s{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                &ldquo;{targetStatus}&rdquo;
              </span>{' '}
              column.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Title */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Task
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="What needs to get done?"
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>

        {/* Urgency — pill selector */}
        {hasPriority && (
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Urgency
            </label>
            <div className="flex flex-wrap gap-1.5">
              <PriorityPill
                value=""
                label="None"
                active={priority === ''}
                onClick={() => setPriority('')}
              />
              {(schema.priorityOptions || []).map((p) => (
                <PriorityPill
                  key={p}
                  value={p}
                  label={p}
                  active={priority === p}
                  onClick={() => setPriority(p)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Assignee — avatar-prefixed dropdown when options exist */}
        {schema.assigneeProp && (
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Assignee
            </label>
            {hasAssignee ? (
              <div className="flex flex-wrap gap-1.5">
                <AssigneePill
                  name=""
                  label="Unassigned"
                  active={assignee === ''}
                  onClick={() => setAssignee('')}
                />
                {assigneeChoices.map((a) => (
                  <AssigneePill
                    key={a}
                    name={a}
                    label={a}
                    active={assignee === a}
                    onClick={() => setAssignee(a)}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                The <code className="rounded bg-white/60 px-1 dark:bg-zinc-900/60">
                  &quot;{schema.assigneeProp}&quot;
                </code>{' '}
                column ({schema.assigneePropType}) has no options yet.
                {schema.assigneePropType === 'people'
                  ? ' Share the Notion integration with your team so they appear here.'
                  : ' Add options to the column in Notion.'}
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {submitting ? 'Adding…' : 'Add task'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ---- Sub-pills ------------------------------------------------------------

const PRIORITY_TONE: Record<string, { active: string; idle: string }> = {
  high: {
    active: 'bg-rose-600 text-white border-rose-600',
    idle: 'border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40',
  },
  urgent: {
    active: 'bg-rose-600 text-white border-rose-600',
    idle: 'border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40',
  },
  medium: {
    active: 'bg-amber-500 text-white border-amber-500',
    idle: 'border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-300 dark:hover:bg-amber-950/40',
  },
  normal: {
    active: 'bg-amber-500 text-white border-amber-500',
    idle: 'border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-300 dark:hover:bg-amber-950/40',
  },
  low: {
    active: 'bg-emerald-600 text-white border-emerald-600',
    idle: 'border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950/40',
  },
}

// Exported so EditTaskDialog can reuse the exact same selector
// styling — keeps create + edit visually identical.
export function PriorityPill({
  value,
  label,
  active,
  onClick,
}: {
  value: string
  label: string
  active: boolean
  onClick: () => void
}) {
  const key = value.toLowerCase().replace(/[^a-z]/g, '')
  const tone = PRIORITY_TONE[key]
  const neutral = {
    active: 'bg-zinc-700 text-white border-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:border-zinc-200',
    idle: 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800',
  }
  const styles = tone || neutral
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active ? styles.active : styles.idle
      )}
    >
      {label}
    </button>
  )
}

export function AssigneePill({
  name,
  label,
  active,
  onClick,
}: {
  name: string
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-blue-600 bg-blue-600 text-white'
          : 'border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
      )}
    >
      {name ? <Avatar name={name} size="xs" /> : null}
      {label}
    </button>
  )
}
