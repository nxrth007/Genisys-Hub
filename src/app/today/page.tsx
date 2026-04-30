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
  ArrowRight,
  ListChecks,
  KanbanSquare,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TaskBoard } from '@/components/notion/task-board'
import { FocusList } from '@/components/notion/focus-list'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { DropdownPill } from '@/components/ui/dropdown-pill'
import {
  DateRangePicker,
  defaultRange,
  type DateRange,
} from '@/components/ui/date-range-picker'

type Task = {
  id: string
  title: string
  notes: string | null
  dueAt: string | null
  completedAt: string | null
  priority: 'low' | 'normal' | 'high'
  createdAt: string
}

/** Subset of the staff callbacks endpoint payload we actually use
 *  on /today. Keeps coupling loose — extra fields the server
 *  returns are tolerated, but TS only types what we read. */
type Callback = {
  id: string
  customerName: string
  customerPhone: string
  callbackAt: string
  notes: string | null
  reason: string | null
  completedAt: string | null
  agent?: { id: string; name: string | null; email: string }
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
  // Bumped on "+ New task" click to signal the active view (Focus or
  // Kanban) to open its new-task modal for the "To Do" column. Only
  // wired when a Notion board is pinned; otherwise the click opens the
  // local AddTaskModal below instead.
  const [newTaskTrigger, setNewTaskTrigger] = useState(0)
  // Default to "focus" — a grouped-list layout that's faster for triage
  // ("what should I do next?") than a Kanban's visual workflow. Users
  // can flip to "board" via the toggle to see the old Kanban.
  const [tasksView, setTasksView] = useState<'focus' | 'board'>('focus')

  // Scope + date-range — match the mockup's filter bar. Scope is the
  // "Daily / Weekly / Monthly / Quarterly" pill; the date range
  // pill on the right is a 2-month calendar popover with quick
  // presets. Both filters are visual scaffolding for now — the
  // FocusList still renders the Notion DB's full task set; we just
  // surface the controls so Ethan can see his preferred layout.
  // Hooking the filters into Notion's date-range query is a separate
  // pass once we agree on which property maps to "due date".
  const [scope, setScope] = useState<'Daily' | 'Weekly' | 'Monthly' | 'Quarterly'>(
    'Daily'
  )
  const [range, setRange] = useState<DateRange>(() => defaultRange(7))

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

  // Follow-ups — the staff callbacks across all agents. Used both
  // for the "Follow-ups due" stat card and the collapsible drawer
  // below the tasks view (Ethan: "follow-up means I just need to text
  // these people"). Pending+overdue are surfaced; completed ones are
  // hidden so the drawer only shows actionable rows.
  const followUpsQuery = useQuery<{ callbacks: Callback[] }>({
    queryKey: ['today-followups'],
    queryFn: async () => {
      // bucket=pending fetches non-completed callbacks regardless of
      // due-date (overdue rolls into pending too on the server side).
      const res = await fetch('/api/call-center/callbacks?bucket=pending')
      if (!res.ok) throw new Error('Failed to load callbacks')
      return res.json()
    },
  })
  const followUps = followUpsQuery.data?.callbacks ?? []
  const followUpStats = (() => {
    const now = new Date()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const endOfToday = new Date(startOfToday)
    endOfToday.setDate(endOfToday.getDate() + 1)
    let overdue = 0
    let today = 0
    for (const c of followUps) {
      const at = new Date(c.callbackAt)
      if (isNaN(at.getTime())) continue
      if (at < startOfToday) overdue++
      else if (at < endOfToday) today++
    }
    return { due: followUps.length, overdue, today }
  })()

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

  // Single-column layout capped at 5xl so everything shares the same
  // gutters — no left-of-center drift from mixing max-w-screen-xl outside
  // with max-w-3xl inside.
  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="Today"
        subtitle={todayLabel}
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Today' }]}
        actions={
          <button
            onClick={() => {
              if (pinnedDbId) {
                setNewTaskTrigger((n) => n + 1)
              } else {
                setShowAdd(true)
              }
            }}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary/90"
            title={
              pinnedDbId
                ? 'Add a task to the "To Do" column on the pinned board'
                : 'Add a new task'
            }
          >
            <Plus className="h-4 w-4" />
            New task
          </button>
        }
      />

      {/* Filter row — scope dropdown + date range picker. Mirrors the
          mockup's filter bar above the KPI cards. */}
      <div className="flex flex-wrap items-center gap-3">
        <DropdownPill
          value={scope}
          options={[
            { id: 'Daily', label: 'Daily' },
            { id: 'Weekly', label: 'Weekly' },
            { id: 'Monthly', label: 'Monthly' },
            { id: 'Quarterly', label: 'Quarterly' },
          ]}
          onChange={setScope}
          icon={Calendar}
        />
        <DateRangePicker value={range} onChange={setRange} align="start" />
      </div>

      {/* At-a-glance numbers — three cards mirroring Ethan's mockup.
          (Booked-appointments card was removed per his feedback —
          that data still drives Master Tracker stats; here it just
          competed with the task focus he wants.) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Tasks completed"
          value={tasksDoneCount}
          subtitle={
            tasksTotalCount > 0
              ? `${tasksToDoCount} open`
              : pinnedDbId
                ? 'board loading…'
                : 'nothing logged today'
          }
          tone={tasksDoneCount > 0 ? 'green' : 'zinc'}
          progress={
            tasksTotalCount > 0
              ? Math.round((tasksDoneCount / tasksTotalCount) * 100)
              : null
          }
        />
        <StatCard
          label="Meetings today"
          value={events.length}
          subtitle={events.length === 0 ? 'nothing scheduled' : 'scheduled'}
          tone="blue"
          progress={events.length > 0 ? 100 : 0}
        />
        <StatCard
          label="Follow-ups due"
          value={followUpStats.due}
          subtitle={
            followUpStats.due === 0
              ? 'all caught up'
              : `${followUpStats.overdue} overdue · ${followUpStats.today} today`
          }
          tone={followUpStats.overdue > 0 ? 'amber' : followUpStats.due > 0 ? 'indigo' : 'zinc'}
        />
      </div>

      {/* Tasks first, Meetings second — agents triage their own work
          before reviewing the day's meeting block. */}

      {/* View toggle row — mockup-style DropdownPill on the left,
          live count on the right. Only renders when a Notion DB is
          pinned (the local-task fallback below has its own header). */}
      {pinnedDbId && (
        <div className="flex items-center justify-between">
          <DropdownPill
            value={tasksView}
            options={[
              { id: 'focus', label: 'Focus' },
              { id: 'board', label: 'Kanban' },
            ]}
            onChange={(v) => setTasksView(v as 'focus' | 'board')}
            icon={tasksView === 'focus' ? ListChecks : KanbanSquare}
          />
          <p className="text-xs text-muted-foreground">
            {tasksTotalCount} task{tasksTotalCount === 1 ? '' : 's'} ·{' '}
            {tasksDoneCount} done
          </p>
        </div>
      )}

      {/* Tasks section — Notion Kanban when a DB is pinned, otherwise
           the built-in local task list. When pinned we drop the wrapper
           card entirely (the column chrome already gives each status
           its own card appearance). */}
      {pinnedDbId ? (
        // min-w-0 lets the page collapse to the parent's width so the
        // Kanban's horizontal scroll stays inside the card instead of
        // pushing the whole page wider.
        <div className="min-w-0 space-y-3">
          {tasksView === 'focus' ? (
            // Single flat checklist + no assignee sidebar per Ethan's
            // mockup. Status grouping (Doing / Up next / Waiting /
            // Done) only shows up on the dedicated /notion/db/[id]
            // view where the deeper triage breakdown is useful.
            <FocusList
              dbId={pinnedDbId}
              newTaskTrigger={newTaskTrigger}
              grouped={false}
              showAssigneeSidebar={false}
            />
          ) : (
            <TaskBoard
              dbId={pinnedDbId}
              variant="embed"
              defaultView="board"
              newTaskTrigger={newTaskTrigger}
              newTaskColumnHint="To Do"
            />
          )}
        </div>
      ) : (
        // Local task list — styled to mirror the mockup's checklist
        // card: rounded-2xl, bg-card, shadow-soft, "Add a task" footer
        // row that opens the same modal the header button does.
        <section className="rounded-2xl border border-border bg-card p-2 shadow-soft">
          <div className="flex items-center justify-between border-b border-border-soft px-3 py-2">
            <h3 className="text-sm font-semibold">
              Tasks
              {incompleteTasks.length > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ({incompleteTasks.length} remaining)
                </span>
              )}
            </h3>
            <Link
              href="/notion"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              title="Pin a Notion DB to replace this list with a Kanban"
            >
              <Pin className="h-3 w-3" /> Pin a Notion board
            </Link>
          </div>
          <div className="divide-y divide-border-soft">
            {tasksQuery.isLoading ? (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                Loading tasks…
              </div>
            ) : incompleteTasks.length === 0 && completedTasks.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No tasks yet. Click &ldquo;New task&rdquo; to get started, or{' '}
                  <Link href="/notion" className="text-primary hover:underline">
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
                    onUpdate={() =>
                      qc.invalidateQueries({ queryKey: ['today-tasks'] })
                    }
                  />
                ))}
                {completedTasks.length > 0 && (
                  <div className="bg-surface-muted">
                    <div className="px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Completed today ({completedTasks.length})
                    </div>
                    {completedTasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onUpdate={() =>
                          qc.invalidateQueries({ queryKey: ['today-tasks'] })
                        }
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="border-t border-border-soft px-3 py-2">
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
            >
              <Plus className="h-4 w-4" /> Add a task
            </button>
          </div>
        </section>
      )}

      {/* Follow-ups — collapsible "sub-tab" per Ethan's mockup
          ("most of the day is just following up. but it's not really
          part of checklist, so I want a sub-tab"). Closed by default
          to keep the page light; counts on the header so the
          collapsed state still telegraphs how many things need a
          response. */}
      <FollowUpsDrawer
        followUps={followUps}
        loading={followUpsQuery.isLoading}
        error={followUpsQuery.error as Error | null}
      />

      {/* "Next up" — meetings list ported from the mockup's pattern.
          The very next meeting is highlighted with the primary-soft
          background + Join button; the rest are surface cards with
          shadow-soft and a Details affordance. Each row is a stack of
          time/duration · title/contact · join action — matches the
          mockup's grid almost exactly. */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[20px] font-semibold tracking-tight">Next up</h2>
          {events.length > 0 && (
            <Link
              href="/calendar"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              See all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>

        {calQuery.isLoading ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground shadow-soft">
            Loading calendar…
          </div>
        ) : calQuery.isError ? (
          <div className="flex items-start gap-2 rounded-2xl border border-border-soft bg-surface-muted p-4 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
            <div>
              <div className="font-medium">Calendar unavailable</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {(calQuery.error as Error).message}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Make sure &quot;GHL Genisys Token&quot; is in the vault and
                the GHL sub-account has calendar data.
              </div>
            </div>
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center shadow-soft">
            <Calendar className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">
              No meetings scheduled today.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {events.map((ev, i) => {
              const link = findMeetingLink(ev)
              const isFirst = i === 0
              return (
                <li
                  key={ev.id || i}
                  className={cn(
                    'flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition',
                    isFirst
                      ? 'border-primary/20 bg-primary-soft'
                      : 'border-border bg-card shadow-soft hover:bg-surface-muted'
                  )}
                >
                  <div className="w-20 shrink-0">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatTime(ev.startTime)}
                    </p>
                    {ev.endTime && (
                      <p className="text-xs text-muted-foreground">
                        – {formatTime(ev.endTime)}
                      </p>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {ev.title || ev.name || 'Untitled'}
                      {ev.calendarName && (
                        <span className="font-normal text-muted-foreground">
                          {' '}
                          · {ev.calendarName}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[ev.contactName, ev.status].filter(Boolean).join(' · ') ||
                        'No contact attached'}
                    </p>
                  </div>
                  {link ? (
                    <JoinButton link={link} highlighted={isFirst} />
                  ) : (
                    // No meeting URL — show a neutral "Details" pill
                    // so the row still terminates with an action and
                    // the layout stays consistent across rows.
                    <span
                      className={cn(
                        'rounded-full px-4 py-1.5 text-xs font-semibold',
                        isFirst
                          ? 'bg-primary text-primary-foreground'
                          : 'border border-border bg-card text-foreground/80'
                      )}
                    >
                      Details
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
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

/**
 * Collapsible "Follow-ups" drawer — closed by default. Opens to a
 * checklist of pending callbacks across all agents (the staff view
 * of /api/call-center/callbacks). Per Ethan: "follow-up means I
 * just need to text the people."
 *
 * Each row shows the customer + reason + when the callback is due,
 * tinted rose if the row is overdue. A "Mark done" button on each
 * row optimistically marks the callback complete and invalidates
 * the query so the row falls out of the list.
 */
function FollowUpsDrawer({
  followUps,
  loading,
  error,
}: {
  followUps: Callback[]
  loading: boolean
  error: Error | null
}) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)

  // Sort overdue → due-soonest at the top. Inside each bucket we
  // rely on the server's existing callbackAt-asc order.
  const now = new Date()
  const ordered = [...followUps].sort((a, b) => {
    const aTime = new Date(a.callbackAt).getTime()
    const bTime = new Date(b.callbackAt).getTime()
    return aTime - bTime
  })
  const overdueCount = followUps.filter(
    (c) => new Date(c.callbackAt) < now
  ).length

  const completeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/call-center/callbacks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      })
      if (!res.ok) throw new Error('Failed to mark done')
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['today-followups'] })
      const previous = qc.getQueryData<{ callbacks: Callback[] }>([
        'today-followups',
      ])
      if (previous) {
        qc.setQueryData(
          ['today-followups'],
          {
            ...previous,
            callbacks: previous.callbacks.filter((c) => c.id !== id),
          }
        )
      }
      return { previous }
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(['today-followups'], ctx.previous)
    },
  })

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white shadow-soft dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
      >
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary-soft text-primary">
            <Phone className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight">
              Follow-ups
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
                {followUps.length}
              </span>
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {overdueCount > 0
                ? `${overdueCount} overdue · ${followUps.length - overdueCount} upcoming`
                : 'people to text/call back today'}
            </p>
          </div>
        </div>
        <ChevronRight
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-border-soft">
          {loading ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              Loading follow-ups…
            </div>
          ) : error ? (
            <div className="px-5 py-5 text-sm text-rose-600">
              Couldn&apos;t load follow-ups: {error.message}
            </div>
          ) : ordered.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              All caught up — no pending callbacks.
            </div>
          ) : (
            <ul className="divide-y divide-border-soft">
              {ordered.map((c) => {
                const due = new Date(c.callbackAt)
                const overdue = !isNaN(due.getTime()) && due < now
                return (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <button
                      onClick={() => completeMutation.mutate(c.id)}
                      disabled={completeMutation.isPending}
                      className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:text-primary"
                      title="Mark done"
                      aria-label={`Mark follow-up with ${c.customerName} done`}
                    >
                      <Circle className="h-3 w-3" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {c.customerName}
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          · {c.customerPhone}
                        </span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {c.reason || c.notes || 'No reason logged'}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'flex-shrink-0 text-xs',
                        overdue
                          ? 'font-semibold text-rose-600'
                          : 'text-muted-foreground'
                      )}
                    >
                      {overdue ? 'Overdue' : ''}{' '}
                      <span className="tabular-nums">
                        {due.toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true,
                        })}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

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

function JoinButton({
  link,
  highlighted,
}: {
  link: MeetingLink
  /** When true, renders the solid primary-pill style used on the
   *  "first up" highlighted meeting; otherwise renders the neutral
   *  outline-pill style for subsequent rows. */
  highlighted?: boolean
}) {
  const Icon =
    link.kind === 'phone' ? Phone : link.kind === 'url' ? ExternalLink : Video

  return (
    <a
      href={link.url}
      target={link.kind === 'phone' ? undefined : '_blank'}
      rel={link.kind === 'phone' ? undefined : 'noopener noreferrer'}
      title={link.url}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition',
        highlighted
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border border-border bg-card text-foreground/80 hover:bg-muted'
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
