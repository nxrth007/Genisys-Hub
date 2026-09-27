'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, Plus, Loader2, Repeat } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { FOLLOW_UP_MARKER } from './focus-list'

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
  /** Notion date-property name. When set, the dialog shows a
   *  Due Date field; on submit we write `{ date: { start } }`
   *  to that property. Auto-detected by FocusList from the DB
   *  schema (first column with type=date). */
  dateProp?: string
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
  // Due date — empty string means "no date set" (most tasks
  // don't need one). Bound to a native <input type="date">
  // so the picker stays consistent with the agent appointment
  // picker. Submitted as YYYY-MM-DD to Notion's date property,
  // which Notion accepts as a midnight-anchored start.
  const [dueDate, setDueDate] = useState<string>('')
  // Follow-up flag — when true, the submitted title is stamped with
  // a leading marker glyph that the FocusList classifier picks up to
  // route the task into the dedicated Follow-ups section. Lives
  // entirely in the title string so we don't need to mutate the
  // user's Notion DB schema.
  const [isFollowUp, setIsFollowUp] = useState(false)
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
      const cleanTitle = title.trim()
      // Stamp the marker prefix onto the title if the toggle is on
      // (and not already present from the user typing it themselves).
      const finalTitle =
        isFollowUp && !cleanTitle.startsWith(FOLLOW_UP_MARKER)
          ? `${FOLLOW_UP_MARKER}${cleanTitle}`
          : cleanTitle
      const properties: Record<string, unknown> = {
        [schema.titleProp]: { title: [{ text: { content: finalTitle } }] },
      }
      if (schema.statusPropType === 'status') {
        properties[schema.statusPropName] = { status: { name: targetStatus } }
      } else {
        properties[schema.statusPropName] = { select: { name: targetStatus } }
      }
      if (schema.priorityProp && priority) {
        properties[schema.priorityProp] = { select: { name: priority } }
      }
      if (schema.dateProp && dueDate && isFollowUp) {
        // Notion date property accepts a YYYY-MM-DD start
        // (midnight in the user's local zone). Tasks without a
        // due date just skip this property — Notion treats the
        // missing key as "no date" rather than null. Only
        // FOLLOW-UP tasks get a due date written; regular tasks
        // intentionally don't have one (per Ethan).
        properties[schema.dateProp] = { date: { start: dueDate } }
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
        className="relative w-full max-w-md space-y-4 rounded-xl bg-card p-5 shadow-pop bg-card"
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">New task</h3>
            <p className="text-xs text-muted-foreground">
              Adds to the board&apos;s{' '}
              <span className="font-medium text-foreground/85">
                &ldquo;{targetStatus}&rdquo;
              </span>{' '}
              column.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground/70 hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Title */}
        <div>
          <label className="mb-1 block eyebrow text-muted-foreground">
            Task
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="What needs to get done?"
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
          />
        </div>

        {/* Urgency — pill selector */}
        {hasPriority && (
          <div>
            <label className="mb-1.5 block eyebrow text-muted-foreground">
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
            <label className="mb-1.5 block eyebrow text-muted-foreground">
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
              <p className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning border-warning/30 bg-warning/15 text-warning">
                The <code className="rounded bg-card/60 px-1 bg-card/60">
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

        {/* Follow-up toggle — Ethan: "follow-up button under assignee
            section that creates a task under a follow-up section".
            Sits as a single-pill row right under Assignee so the
            placement matches the ask. Tapping it tags the task with
            the FOLLOW_UP_MARKER glyph so the FocusList routes it into
            the Follow-ups bucket — no DB schema changes needed. */}
        <div>
          <label className="mb-1.5 block eyebrow text-muted-foreground">
            Type
          </label>
          <button
            type="button"
            onClick={() => setIsFollowUp((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs font-medium transition-colors',
              isFollowUp
                ? 'border-violet-600 bg-foreground/80 text-white'
                : 'border-border text-foreground/85 hover:bg-muted border-border text-foreground/85 hover:bg-muted',
            )}
            title={
              isFollowUp
                ? 'Will land in the Follow-ups section'
                : 'Tap to mark as a follow-up'
            }
          >
            <Repeat className="h-3.5 w-3.5" />
            Follow-up
          </button>
          {isFollowUp && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Tagged with a leading <span className="font-semibold">🔁</span> so
              you can spot it in Notion. Set a due date below for
              the reminder.
            </p>
          )}
        </div>

        {/* Due date — only shown for FOLLOW-UP tasks, not regular
            tasks. Per Ethan: regular tasks live in the Today list
            for the day they're created and don't need a date;
            follow-ups get a date so the reminder pops back into
            the drawer at the right time. Field hidden entirely
            when the Follow-up toggle above is off, OR when the
            Notion DB has no date column. */}
        {isFollowUp && schema.dateProp && (
          <div>
            <label className="mb-1.5 block eyebrow text-muted-foreground">
              Due date
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-sm focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30 border-border bg-background dark:focus:ring-blue-900/60"
              />
              {dueDate && (
                <button
                  type="button"
                  onClick={() => setDueDate('')}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline text-muted-foreground hover:text-foreground"
                >
                  clear
                </button>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive border-destructive/30 bg-destructive/10 text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border-soft pt-3 border-border">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted text-foreground/85 hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
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
    active: 'bg-destructive text-destructive-foreground border-destructive',
    idle: 'border-destructive/30 text-destructive hover:bg-destructive/10 border-destructive/30 text-destructive hover:bg-destructive/10',
  },
  urgent: {
    active: 'bg-destructive text-destructive-foreground border-destructive',
    idle: 'border-destructive/30 text-destructive hover:bg-destructive/10 border-destructive/30 text-destructive hover:bg-destructive/10',
  },
  medium: {
    active: 'bg-warning text-warning-foreground border-warning',
    idle: 'border-warning/30 text-warning hover:bg-warning/15 border-warning/30 text-warning hover:bg-warning/10',
  },
  normal: {
    active: 'bg-warning text-warning-foreground border-warning',
    idle: 'border-warning/30 text-warning hover:bg-warning/15 border-warning/30 text-warning hover:bg-warning/10',
  },
  low: {
    active: 'bg-success text-success-foreground border-success',
    idle: 'border-success/30 text-success hover:bg-success/15 border-success/30 text-success hover:bg-success/10',
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
    active: 'bg-zinc-700 text-white border-zinc-700 dark:bg-zinc-200 text-background border-border',
    idle: 'border-border text-muted-foreground hover:bg-muted border-border text-muted-foreground hover:bg-muted',
  }
  const styles = tone || neutral
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-3 py-1 text-xs font-medium transition-colors',
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
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-foreground text-background'
          : 'border-border text-foreground/85 hover:bg-muted border-border text-foreground/85 hover:bg-muted'
      )}
    >
      {name ? <Avatar name={name} size="xs" /> : null}
      {label}
    </button>
  )
}
