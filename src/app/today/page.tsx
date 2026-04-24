'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  Circle,
  Plus,
  Trash2,
  Calendar,
  Clock,
  AlertCircle,
  X,
  Video,
  Phone,
  ExternalLink,
  Pin,
  CalendarCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TaskBoard } from '@/components/notion/task-board'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'

type Task = {
  id: string
  title: string
  notes: string | null
  dueAt: string | null
  completedAt: string | null
  priority: 'low' | 'normal' | 'high'
  createdAt: string
}

type CalEvent = {
  id?: string
  title?: string
  name?: string
  startTime?: string
  endTime?: string
  calendarName?: string
  contactName?: string
  status?: string
  // GHL's event shape varies by calendar integration. We scan all of these
  // for meeting/phone URLs and surface the first one that matches a known
  // provider, or any https URL as a generic fallback.
  address?: string
  meetingLocation?: string
  description?: string
  notes?: string
  location?: string
  meetingUrl?: string
  appointmentMeetingLocation?: string
  // Allow arbitrary extra fields — GHL payload is loose.
  [key: string]: unknown
}

type MeetingLink = {
  url: string
  kind: 'zoom' | 'meet' | 'teams' | 'phone' | 'url'
  label: string
}

// Minimal view of the Notion DB query response we need to count tasks per
// column. Mirrors the full shape that <TaskBoard /> consumes, but only
// types the fields the stat cards actually read so we don't couple to
// TaskBoard's internals.
type NotionBoardPayload = {
  database?: {
    properties?: Record<string, { type?: string }>
  }
  results?: Array<{
    properties: Record<
      string,
      {
        type?: string
        status?: { name?: string } | null
        select?: { name?: string } | null
      }
    >
  }>
}

/** Buckets Notion statuses into "todo" (starting column) and "done"
 *  (completed column) using the same synonyms the new-task trigger uses,
 *  so the stat card and the board agree on what "To Do" means. */
function computeBoardStats(
  data: NotionBoardPayload | undefined
): { todo: number; total: number; done: number } | null {
  if (!data?.database?.properties || !data?.results) return null

  // Find the status property — prefer 'status' type, fall back to 'select'.
  const props = data.database.properties
  let statusPropName: string | null = null
  for (const [name, p] of Object.entries(props)) {
    if (p.type === 'status') {
      statusPropName = name
      break
    }
  }
  if (!statusPropName) {
    for (const [name, p] of Object.entries(props)) {
      if (p.type === 'select') {
        statusPropName = name
        break
      }
    }
  }
  if (!statusPropName) return null

  const TODO_SYNONYMS = new Set([
    'todo',
    'todos',
    'notstarted',
    'backlog',
    'inbox',
    'new',
  ])
  const DONE_SYNONYMS = new Set(['done', 'complete', 'completed', 'shipped'])

  let todo = 0
  let done = 0
  for (const task of data.results) {
    const prop = task.properties[statusPropName]
    const statusName = prop?.status?.name || prop?.select?.name || ''
    const normalized = statusName.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (TODO_SYNONYMS.has(normalized)) todo++
    else if (DONE_SYNONYMS.has(normalized)) done++
  }
  return { todo, total: data.results.length, done }
}

/** Scan an event for a meeting link. Prefers known video providers over
 *  generic URLs and phone numbers. Returns null if nothing usable is found. */
function findMeetingLink(ev: CalEvent): MeetingLink | null {
  // Fields GHL is known to stash URLs in, in rough priority order.
  const fields = [
    ev.meetingUrl,
    ev.meetingLocation,
    ev.appointmentMeetingLocation,
    ev.address,
    ev.location,
    ev.description,
    ev.notes,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0)

  // Also walk every string value in case the URL is in an unexpected field.
  for (const v of Object.values(ev)) {
    if (typeof v === 'string' && v.length > 0 && !fields.includes(v)) {
      fields.push(v)
    }
  }

  const urlRe = /https?:\/\/[^\s<>"']+/i
  // Find a URL first — walk fields and match the URL regex.
  for (const text of fields) {
    const m = text.match(urlRe)
    if (!m) continue
    const url = m[0].replace(/[.,;)]+$/, '')
    if (/zoom\.us\//i.test(url)) return { url, kind: 'zoom', label: 'Join Zoom' }
    if (/meet\.google\.com\//i.test(url)) return { url, kind: 'meet', label: 'Join Meet' }
    if (/teams\.(microsoft|live)\.com\//i.test(url)) return { url, kind: 'teams', label: 'Join Teams' }
    // Generic https URL — could be a custom meeting room or a conference tool
    // we don't recognize. Still useful to surface.
    return { url, kind: 'url', label: 'Join meeting' }
  }

  // No URL — look for a phone number in the likely fields. GHL sometimes
  // stores "Phone Call" appointments with the number in `address` or
  // `meetingLocation`.
  for (const text of fields) {
    const phoneMatch = text.match(/\+?\d[\d\s().-]{8,}\d/)
    if (phoneMatch) {
      const digits = phoneMatch[0].replace(/[^\d+]/g, '')
      return { url: `tel:${digits}`, kind: 'phone', label: digits }
    }
  }

  return null
}

export default function TodayPage() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  // Bumped on "+ New task" click to signal TaskBoard to open its inline
  // new-task modal for the "To Do" column. Only wired when a Notion board
  // is pinned; otherwise the click opens the AddTaskModal below instead.
  const [newTaskTrigger, setNewTaskTrigger] = useState(0)

  const tasksQuery = useQuery<{ tasks: Task[] }>({
    queryKey: ['today-tasks'],
    queryFn: async () => {
      const res = await fetch('/api/today/tasks')
      if (!res.ok) throw new Error('Failed to load tasks')
      return res.json()
    },
  })

  const calQuery = useQuery<{ events: CalEvent[] }>({
    queryKey: ['today-calendar'],
    queryFn: async () => {
      const res = await fetch('/api/today/calendar')
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to load calendar')
      }
      return res.json()
    },
    retry: false,
  })

  const tasks = tasksQuery.data?.tasks ?? []
  const events = calQuery.data?.events ?? []
  const incompleteTasks = tasks.filter((t) => !t.completedAt)
  const completedTasks = tasks.filter((t) => t.completedAt)

  // If a Notion database has been pinned from the task-board page, embed
  // that Kanban on Today instead of the built-in local tasks list. Ethan
  // gets the full drag-and-drop + delete experience without leaving Today.
  const pinnedBoardQuery = useQuery<{ dbId: string | null }>({
    queryKey: ['today-task-board-setting'],
    queryFn: async () => {
      const res = await fetch('/api/settings/today-task-board')
      if (!res.ok) throw new Error('Failed to load pinned board')
      return res.json()
    },
  })
  const pinnedDbId = pinnedBoardQuery.data?.dbId

  // Fetch the pinned Notion DB so the stat cards can count tasks in "To Do"
  // / "Done" columns. Same queryKey as <TaskBoard /> uses, so React Query
  // dedupes into one network fetch — the stat cards and the board share
  // the same live data.
  const notionBoardQuery = useQuery<NotionBoardPayload>({
    queryKey: ['notion-tasks', pinnedDbId],
    queryFn: async () => {
      const res = await fetch('/api/notion/databases/' + pinnedDbId)
      if (!res.ok) throw new Error('Failed to load Notion tasks')
      return res.json()
    },
    enabled: !!pinnedDbId,
  })
  const boardStats = computeBoardStats(notionBoardQuery.data)

  // Booked-appointment counters for the Today stat strip. Fed by every
  // agent's Appointment rows; scoped to today in the viewer's timezone.
  const bookingStatsQuery = useQuery<{
    bookedToday: number
    bookedYesterday: number
    bookedLast7Days: number
    bookedTotal: number
    trend: number | null
  }>({
    queryKey: ['today-booking-stats'],
    queryFn: async () => {
      const res = await fetch('/api/today/booking-stats')
      if (!res.ok) throw new Error('Failed to load booking stats')
      return res.json()
    },
  })
  const bookingStats = bookingStatsQuery.data

  // Pick source-of-truth counts based on whether a board is pinned. Local
  // tasks are used when no board is attached, Notion counts when one is.
  const tasksToDoCount = pinnedDbId
    ? boardStats?.todo ?? 0
    : incompleteTasks.length
  const tasksTotalCount = pinnedDbId
    ? boardStats?.total ?? 0
    : tasks.length
  const tasksDoneCount = pinnedDbId
    ? boardStats?.done ?? 0
    : completedTasks.length

  // Whole page centers on wide displays. Sections that shouldn't stretch full
  // width (header row, meetings list) get their own max-w-3xl so reading
  // widths stay comfortable while the Kanban can use all available horizontal
  // space. mx-auto on those centers them within the wider page container.
  const constrainedSection = 'max-w-3xl mx-auto w-full'

  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="mx-auto max-w-screen-xl space-y-6">
      <div className={constrainedSection}>
        <PageHeader
          icon={CheckCircle2}
          title="Today"
          subtitle={todayLabel}
          actions={
            <button
              onClick={() => {
                if (pinnedDbId) {
                  // Ask the embedded TaskBoard to open its To Do modal.
                  setNewTaskTrigger((n) => n + 1)
                } else {
                  // No Notion board pinned — fall back to the local task modal.
                  setShowAdd(true)
                }
              }}
              className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-blue-700 hover:shadow-md"
              title={
                pinnedDbId
                  ? 'Add a task to the "To Do" column on the pinned board'
                  : 'Add a new task'
              }
            >
              <Plus className="h-4 w-4" />
              New Task
            </button>
          }
        />
      </div>

      {/* At-a-glance numbers — mirrors Ethan's Tasks stat row */}
      <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4', constrainedSection)}>
        <StatCard
          icon={Calendar}
          label="Meetings today"
          value={events.length}
          subtitle="scheduled"
          tone="blue"
        />
        <StatCard
          icon={Circle}
          label="Tasks to do"
          value={tasksToDoCount}
          subtitle={
            tasksTotalCount > 0
              ? `of ${tasksTotalCount}`
              : pinnedDbId
                ? 'board loading…'
                : 'nothing logged today'
          }
          tone={tasksToDoCount > 0 ? 'amber' : 'zinc'}
          progress={
            tasksTotalCount > 0
              ? Math.round((tasksDoneCount / tasksTotalCount) * 100)
              : null
          }
        />
        <StatCard
          icon={CheckCircle2}
          label={pinnedDbId ? 'Completed' : 'Completed today'}
          value={tasksDoneCount}
          subtitle={tasksDoneCount === 0 ? "let's go" : 'nice work'}
          tone={tasksDoneCount > 0 ? 'green' : 'zinc'}
        />
        <StatCard
          icon={CalendarCheck}
          label="Booked appointments"
          value={bookingStats?.bookedToday ?? 0}
          subtitle={
            bookingStats
              ? `today · ${bookingStats.bookedLast7Days} past 7d`
              : 'loading…'
          }
          trend={bookingStats?.trend ?? null}
          tone={(bookingStats?.bookedToday ?? 0) > 0 ? 'indigo' : 'zinc'}
        />
      </div>

      {/* Meetings section */}
      <section className={cn('rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900', constrainedSection)}>
        <div className="flex items-center gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <Calendar className="h-4 w-4 text-blue-600" />
          <h3 className="font-semibold text-sm">
            Meetings
            {events.length > 0 && (
              <span className="ml-2 text-xs font-normal text-zinc-500">({events.length})</span>
            )}
          </h3>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {calQuery.isLoading ? (
            <div className="px-5 py-8 text-center text-sm text-zinc-500">Loading calendar…</div>
          ) : calQuery.isError ? (
            <div className="px-5 py-6">
              <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 rounded-md p-3 dark:bg-amber-950 dark:text-amber-200">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">Calendar unavailable</div>
                  <div className="text-xs mt-1">
                    {(calQuery.error as Error).message}
                  </div>
                  <div className="text-xs mt-1 text-amber-600 dark:text-amber-300">
                    Make sure &quot;GHL Genisys Token&quot; is in the vault and the GHL sub-account has calendar data.
                  </div>
                </div>
              </div>
            </div>
          ) : events.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-zinc-500">
              No meetings scheduled today.
            </div>
          ) : (
            events.map((ev, i) => {
              const link = findMeetingLink(ev)
              return (
                <div key={ev.id || i} className="flex items-center gap-4 px-5 py-3">
                  <div className="flex-shrink-0 text-right" style={{ minWidth: '6rem' }}>
                    <div className="text-sm font-medium">
                      {formatTime(ev.startTime)}
                    </div>
                    {ev.endTime && (
                      <div className="text-xs text-zinc-400">
                        – {formatTime(ev.endTime)}
                      </div>
                    )}
                  </div>
                  <div className="h-8 w-px bg-blue-200 dark:bg-blue-800" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {ev.title || ev.name || 'Untitled'}
                    </div>
                    <div className="flex gap-2 text-xs text-zinc-500">
                      {ev.calendarName && <span>{ev.calendarName}</span>}
                      {ev.contactName && <span>• {ev.contactName}</span>}
                      {ev.status && <span>• {ev.status}</span>}
                    </div>
                  </div>
                  {link && <JoinButton link={link} />}
                </div>
              )
            })
          )}
        </div>
      </section>

      {/* Tasks section — Notion Kanban when a DB is pinned, otherwise the
           built-in local task list. When pinned we drop the wrapper card
           entirely: column chrome already gives each status its own card
           appearance, and the outer section box doubled it up visually. */}
      {pinnedDbId ? (
        <div className="-mx-1">
          <TaskBoard
            dbId={pinnedDbId}
            variant="embed"
            defaultView="board"
            newTaskTrigger={newTaskTrigger}
            newTaskColumnHint="To Do"
          />
        </div>
      ) : (
        <section className={cn('rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900', constrainedSection)}>
          <div className="flex items-center gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <CheckCircle2 className="h-4 w-4 text-blue-600" />
            <h3 className="font-semibold text-sm">
              Tasks
              {incompleteTasks.length > 0 && (
                <span className="ml-2 text-xs font-normal text-zinc-500">
                  ({incompleteTasks.length} remaining)
                </span>
              )}
            </h3>
            <Link
              href="/notion"
              className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
              title="Open a Notion task DB and click 'Pin to Today' to replace this list with a Kanban"
            >
              <Pin className="h-3 w-3" /> Pin a Notion board
            </Link>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {tasksQuery.isLoading ? (
              <div className="px-5 py-8 text-center text-sm text-zinc-500">Loading tasks…</div>
            ) : incompleteTasks.length === 0 && completedTasks.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-zinc-300 mb-2" />
                <p className="text-sm text-zinc-500">
                  No tasks yet. Click &quot;Add task&quot; to get started, or{' '}
                  <Link href="/notion" className="text-blue-600 hover:underline">
                    pin a Notion board
                  </Link>{' '}
                  to use a Kanban here.
                </p>
              </div>
            ) : (
              <>
                {incompleteTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onUpdate={() => qc.invalidateQueries({ queryKey: ['today-tasks'] })}
                  />
                ))}
                {completedTasks.length > 0 && (
                  <div className="bg-zinc-50 dark:bg-zinc-950/50">
                    <div className="px-5 py-2 text-xs font-medium text-zinc-400 uppercase tracking-wide">
                      Completed today ({completedTasks.length})
                    </div>
                    {completedTasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onUpdate={() => qc.invalidateQueries({ queryKey: ['today-tasks'] })}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {showAdd && (
        <AddTaskModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['today-tasks'] })
            setShowAdd(false)
          }}
        />
      )}
    </div>
  )
}

// -------------------------------------------------------------------------
// Sub-components
// -------------------------------------------------------------------------

function TaskRow({ task, onUpdate }: { task: Task; onUpdate: () => void }) {
  const isComplete = !!task.completedAt

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/today/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed: !isComplete }),
      })
      if (!res.ok) throw new Error('Failed to update')
    },
    onSuccess: onUpdate,
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/today/tasks/${task.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
    },
    onSuccess: onUpdate,
  })

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-5 py-3 group',
        isComplete && 'opacity-60'
      )}
    >
      <button
        onClick={() => toggleMutation.mutate()}
        disabled={toggleMutation.isPending}
        className="flex-shrink-0 text-zinc-400 hover:text-blue-600 transition-colors disabled:opacity-50"
        title={isComplete ? 'Mark incomplete' : 'Mark complete'}
      >
        {isComplete ? (
          <CheckCircle2 className="h-5 w-5 text-green-500" />
        ) : (
          <Circle className="h-5 w-5" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-sm font-medium',
            isComplete && 'line-through text-zinc-400'
          )}
        >
          {task.priority === 'high' && (
            <span className="text-red-500 mr-1">!</span>
          )}
          {task.title}
        </div>
        {task.notes && (
          <div className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{task.notes}</div>
        )}
      </div>

      {task.dueAt && (
        <div className="flex items-center gap-1 text-xs text-zinc-400 flex-shrink-0">
          <Clock className="h-3 w-3" />
          {formatTime(task.dueAt)}
        </div>
      )}

      <button
        onClick={() => deleteMutation.mutate()}
        disabled={deleteMutation.isPending}
        className="flex-shrink-0 text-zinc-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
        title="Delete task"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}

function AddTaskModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch('/api/today/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          notes: notes.trim() || null,
          priority,
        }),
      })
      if (!res.ok) throw new Error('Failed to create')
      onCreated()
    } catch {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-900">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-lg font-semibold">Add task</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to get done?"
              required
              autoFocus
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Notes (optional)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional context"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Priority</label>
            <div className="flex gap-2">
              {(['low', 'normal', 'high'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-medium border transition-colors',
                    priority === p
                      ? p === 'high'
                        ? 'border-red-300 bg-red-50 text-red-700'
                        : p === 'low'
                          ? 'border-zinc-300 bg-zinc-50 text-zinc-600'
                          : 'border-blue-300 bg-blue-50 text-blue-700'
                      : 'border-zinc-200 text-zinc-400 hover:border-zinc-300'
                  )}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Adding…' : 'Add task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function JoinButton({ link }: { link: MeetingLink }) {
  const Icon =
    link.kind === 'phone' ? Phone : link.kind === 'url' ? ExternalLink : Video

  // Distinct tint per provider so Ethan can recognize at a glance which
  // meeting tool he's about to launch.
  const tone =
    link.kind === 'zoom'
      ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
      : link.kind === 'meet'
        ? 'border-green-600 bg-green-600 text-white hover:bg-green-700'
        : link.kind === 'teams'
          ? 'border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700'
          : link.kind === 'phone'
            ? 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200'
            : 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'

  return (
    <a
      href={link.url}
      target={link.kind === 'phone' ? undefined : '_blank'}
      rel={link.kind === 'phone' ? undefined : 'noopener noreferrer'}
      title={link.url}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium',
        tone
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {link.label}
    </a>
  )
}

function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return iso
  }
}
