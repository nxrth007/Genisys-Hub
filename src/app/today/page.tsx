'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  Circle,
  Plus,
  Trash2,
  Calendar,
  Send,
  Clock,
  AlertCircle,
  Check,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

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
}

export default function TodayPage() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)

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

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
              <CheckCircle2 className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Today</h2>
              <p className="text-sm text-zinc-500">
                {new Date().toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <BriefTestButton />
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Add task
          </button>
        </div>
      </div>

      {/* Meetings section */}
      <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
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
            events.map((ev, i) => (
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
              </div>
            ))
          )}
        </div>
      </section>

      {/* Tasks section */}
      <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
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
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {tasksQuery.isLoading ? (
            <div className="px-5 py-8 text-center text-sm text-zinc-500">Loading tasks…</div>
          ) : incompleteTasks.length === 0 && completedTasks.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-zinc-300 mb-2" />
              <p className="text-sm text-zinc-500">
                No tasks yet. Click &quot;Add task&quot; to get started.
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

function BriefTestButton() {
  const [email, setEmail] = useState('')
  const [showInput, setShowInput] = useState(false)

  const mutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch('/api/today/brief', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Send failed')
      return data
    },
    onSuccess: () => {
      setShowInput(false)
      setEmail('')
    },
  })

  if (!showInput) {
    return (
      <button
        onClick={() => setShowInput(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        title="Send a morning brief right now (for testing)"
      >
        <Send className="h-4 w-4" />
        Test brief
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Recipient email"
        autoFocus
        className="rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
        onKeyDown={(e) => e.key === 'Escape' && setShowInput(false)}
      />
      <button
        onClick={() => email && mutation.mutate(email.trim())}
        disabled={mutation.isPending || !email}
        className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {mutation.isPending ? '…' : <Check className="h-4 w-4" />}
      </button>
      <button
        onClick={() => setShowInput(false)}
        className="rounded-md px-2 py-2 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <X className="h-4 w-4" />
      </button>
      {mutation.isError && (
        <span className="text-xs text-red-500">{(mutation.error as Error).message}</span>
      )}
      {mutation.isSuccess && (
        <span className="text-xs text-green-600">Sent!</span>
      )}
    </div>
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
