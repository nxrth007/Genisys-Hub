'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X, Save, Loader2 } from 'lucide-react'
import {
  PriorityPill,
  AssigneePill,
  type NewTaskDialogSchema,
} from './new-task-dialog'

/**
 * Edit existing Notion task properties — title, priority, assignee.
 * Counterpart to NewTaskDialog: same visual frame and the same pill
 * pickers (imported), but PATCHes /api/notion/pages/:id/properties
 * instead of POSTing a new page.
 *
 * Pre-fills from the task's current values so the dialog reflects
 * what's actually in Notion right now. Submit only writes the
 * properties whose values changed — that way the page's other
 * properties (status, dates, anything not surfaced in this dialog)
 * stay untouched.
 */

type Task = {
  id: string
  title: string
  priority: string
  assignee: string
}

type NotionUser = { id: string; name: string; email?: string }

export function EditTaskDialog({
  dbId,
  schema,
  task,
  onClose,
  onSaved,
}: {
  dbId: string
  schema: NewTaskDialogSchema
  task: Task
  onClose: () => void
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(task.title)
  const [priority, setPriority] = useState<string>(task.priority || '')
  // For people-type assignees, the task carries the *display name* —
  // we resolve back to a user id at submit time using the cached user
  // list. For select / multi_select, the value is just a string token.
  const [assignee, setAssignee] = useState<string>(task.assignee || '')
  const [error, setError] = useState<string | null>(null)

  // Esc to dismiss — same convention used elsewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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

  const mutation = useMutation({
    mutationFn: async () => {
      const properties: Record<string, unknown> = {}

      // Title — only include when it changed (cheaper write + avoids
      // bumping last-edited-time for no-op saves).
      const trimmedTitle = title.trim()
      if (trimmedTitle && trimmedTitle !== task.title) {
        properties[schema.titleProp] = {
          title: [{ text: { content: trimmedTitle } }],
        }
      }

      // Priority. Empty string = clear. Notion accepts a null `select`
      // value to clear a select-type column.
      if (schema.priorityProp && priority !== task.priority) {
        properties[schema.priorityProp] = priority
          ? { select: { name: priority } }
          : { select: null }
      }

      // Assignee — depends on the column type.
      if (schema.assigneeProp && assignee !== task.assignee) {
        if (schema.assigneePropType === 'people') {
          if (!assignee) {
            properties[schema.assigneeProp] = { people: [] }
          } else {
            const user = notionUsers.find((u) => u.name === assignee)
            if (user) {
              properties[schema.assigneeProp] = {
                people: [{ object: 'user', id: user.id }],
              }
            }
          }
        } else if (schema.assigneePropType === 'multi_select') {
          properties[schema.assigneeProp] = assignee
            ? { multi_select: [{ name: assignee }] }
            : { multi_select: [] }
        } else {
          properties[schema.assigneeProp] = assignee
            ? { select: { name: assignee } }
            : { select: null }
        }
      }

      if (Object.keys(properties).length === 0) {
        // Nothing to save — close cleanly without firing a request.
        return { skipped: true }
      }

      const res = await fetch(`/api/notion/pages/${task.id}/properties`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save changes')
      }
      return res.json()
    },
    onSuccess: () => {
      // Invalidate the board cache so the row picks up the new
      // priority/assignee on the next render. dbId scope keeps it
      // tight to just the active board.
      qc.invalidateQueries({ queryKey: ['notion-tasks', dbId] })
      onSaved()
    },
    onError: (err: Error) => setError(err.message),
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setError('Title is required.')
      return
    }
    setError(null)
    mutation.mutate()
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
            <h3 className="text-lg font-semibold">Edit task</h3>
            <p className="text-xs text-zinc-500">
              Updates land on the Notion page in place. Status + dates
              stay where they are — only the fields below get written.
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

        {/* Priority */}
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

        {/* Assignee */}
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
                The{' '}
                <code className="rounded bg-white/60 px-1 dark:bg-zinc-900/60">
                  &quot;{schema.assigneeProp}&quot;
                </code>{' '}
                column has no options yet.
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
            disabled={mutation.isPending || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
