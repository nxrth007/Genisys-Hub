'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  CheckCircle2,
  Circle,
  Zap,
  Flame,
  ListTodo,
  PauseCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Users,
  AlertTriangle,
  Clock,
  Trash2,
  GripVertical,
  Pencil,
  RotateCcw,
  Repeat,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { NewTaskDialog } from './new-task-dialog'
import { EditTaskDialog } from './edit-task-dialog'

/**
 * FocusList — a triage-first alternative to the Kanban view on Today.
 *
 * Instead of columns grouped by status, it groups tasks by *what you
 * should do next*:
 *
 *   ⚡ Doing right now      in-progress
 *   🔥 Do today            high priority OR due today/overdue (from To Do)
 *   📋 Up next             remaining to-do, priority-first
 *   ⏸  Waiting / Blocked   blocked
 *   ✓  Recently done       done (collapsed by default)
 *
 * Right-side assignee rail lets you instantly filter to one person's
 * tasks. Each row has a quick-complete circle; click the row to open
 * the page in Notion.
 *
 * Sources data from the same `['notion-tasks', dbId]` React Query key
 * that <TaskBoard /> uses, so both views share one network fetch.
 */

// ---- Types ----------------------------------------------------------------

type NotionTask = {
  id: string
  url: string
  properties: Record<string, Record<string, unknown>>
}

type NotionSchema = {
  titleProp: string
  statusPropName: string
  statusPropType: 'status' | 'select'
  statusOptions: Array<{ name: string }>
  priorityProp?: string
  priorityOptions?: string[]
  assigneeProp?: string
  assigneePropType: string
  assigneeOptions?: string[]
  dateProp?: string
}

type Extracted = {
  id: string
  url: string
  title: string
  status: string
  priority: string
  assignee: string
  dueDate: string | null
  task: NotionTask
}

type Section =
  | 'doing'
  | 'today'
  | 'upnext'
  | 'followup'
  | 'waiting'
  | 'done'

// ---- Helpers --------------------------------------------------------------

function richTextToPlain(rt: Array<{ plain_text?: string }> | undefined): string {
  if (!rt) return ''
  return rt.map((r) => r.plain_text || '').join('')
}

function extractPropValue(prop: Record<string, unknown> | undefined): string {
  if (!prop) return ''
  const type = prop.type as string
  switch (type) {
    case 'title':
      return richTextToPlain(prop.title as Array<{ plain_text?: string }>)
    case 'rich_text':
      return richTextToPlain(prop.rich_text as Array<{ plain_text?: string }>)
    case 'select':
      return (prop.select as { name?: string })?.name || ''
    case 'status':
      return (prop.status as { name?: string })?.name || ''
    case 'multi_select':
      return ((prop.multi_select as Array<{ name: string }>) || [])
        .map((s) => s.name)
        .join(', ')
    case 'date':
      return (prop.date as { start?: string })?.start || ''
    case 'people':
      return ((prop.people as Array<{ name?: string }>) || [])
        .map((p) => p.name || '')
        .filter(Boolean)
        .join(', ')
    default:
      return ''
  }
}

function discoverSchema(database: Record<string, unknown> | undefined): NotionSchema | null {
  if (!database) return null
  const props = database.properties as Record<string, Record<string, unknown>> | undefined
  if (!props) return null
  const entries = Object.entries(props)

  const statusEntry =
    entries.find(([, v]) => v.type === 'status') ||
    entries.find(
      ([name, v]) => v.type === 'select' && name.toLowerCase().includes('status')
    )
  if (!statusEntry) return null

  const statusPropName = statusEntry[0]
  const statusPropType = statusEntry[1].type === 'status' ? 'status' : 'select'
  const statusDef = statusEntry[1]
  const statusOptions: Array<{ name: string }> =
    (statusPropType === 'status'
      ? ((statusDef.status as Record<string, unknown>)?.options as Array<{ name: string }>)
      : ((statusDef.select as Record<string, unknown>)?.options as Array<{ name: string }>)) || []

  const titleProp = entries.find(([, v]) => v.type === 'title')?.[0] || 'Name'
  const priorityEntry = entries.find(([name]) =>
    name.toLowerCase().includes('priority')
  )
  const priorityProp = priorityEntry?.[0]
  const priorityDef = priorityEntry?.[1]
  const priorityOptions: string[] =
    priorityDef?.type === 'select'
      ? (((priorityDef.select as Record<string, unknown>)?.options as Array<{ name: string }>) || []).map(
          (o) => o.name
        )
      : []

  const assigneeEntry =
    entries.find(([, v]) => v.type === 'people') ||
    entries.find(([name]) => name.toLowerCase().includes('assign'))
  const assigneeProp = assigneeEntry?.[0]
  const assigneeDef = assigneeEntry?.[1]
  const assigneePropType = (assigneeDef?.type as string) || 'people'
  let assigneeOptions: string[] = []
  if (assigneeDef?.type === 'select') {
    assigneeOptions = (((assigneeDef.select as Record<string, unknown>)?.options as Array<{ name: string }>) || []).map(
      (o) => o.name
    )
  } else if (assigneeDef?.type === 'multi_select') {
    assigneeOptions = (
      ((assigneeDef.multi_select as Record<string, unknown>)?.options as Array<{ name: string }>) || []
    ).map((o) => o.name)
  }

  const dateProp = entries.find(([, v]) => v.type === 'date')?.[0]

  return {
    titleProp,
    statusPropName,
    statusPropType,
    statusOptions,
    priorityProp,
    priorityOptions,
    assigneeProp,
    assigneePropType,
    assigneeOptions,
    dateProp,
  }
}

const TODO_SYNONYMS = new Set(['todo', 'todos', 'notstarted', 'backlog', 'inbox', 'new'])
const DOING_SYNONYMS = new Set(['inprogress', 'doing', 'started', 'active', 'working'])
const DONE_SYNONYMS = new Set(['done', 'complete', 'completed', 'shipped'])
const BLOCKED_SYNONYMS = new Set(['blocked', 'waiting', 'paused', 'onhold'])
const HIGH_PRIORITY = new Set(['high', 'urgent', 'critical', 'p0', 'p1', 'p0critical', 'p1high'])

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Find the best-matching column name for a synonym group in the DB. */
function resolveStatus(
  options: Array<{ name: string }>,
  synonyms: Set<string>
): string | null {
  for (const opt of options) {
    if (synonyms.has(normalize(opt.name))) return opt.name
  }
  return null
}

function isDueTodayOrOverdue(iso: string | null): boolean {
  if (!iso) return false
  const d = new Date(iso)
  if (isNaN(d.getTime())) return false
  const today = new Date()
  today.setHours(23, 59, 59, 999)
  return d.getTime() <= today.getTime()
}

function extractTasks(
  results: NotionTask[],
  schema: NotionSchema
): Extracted[] {
  return results.map((t) => ({
    id: t.id,
    url: t.url,
    title: extractPropValue(t.properties[schema.titleProp]) || '(Untitled)',
    status: extractPropValue(t.properties[schema.statusPropName]),
    priority: schema.priorityProp
      ? extractPropValue(t.properties[schema.priorityProp])
      : '',
    assignee: schema.assigneeProp
      ? extractPropValue(t.properties[schema.assigneeProp])
      : '',
    dueDate: schema.dateProp ? extractPropValue(t.properties[schema.dateProp]) || null : null,
    task: t,
  }))
}

/**
 * Marker prefix used by the New-task dialog's "Follow-up" toggle.
 * We can't add a new property to a user-owned Notion DB, so the
 * dialog stamps a leading "🔁 " on the title and we route any task
 * starting with that glyph into the Follow-ups section. Visible to
 * humans in Notion's native UI too — easy to spot, easy to remove.
 */
export const FOLLOW_UP_MARKER = '🔁 '

function isFollowUp(title: string): boolean {
  return title.startsWith(FOLLOW_UP_MARKER)
}

function classify(task: Extracted): Section {
  const s = normalize(task.status)
  if (DONE_SYNONYMS.has(s)) return 'done'
  if (BLOCKED_SYNONYMS.has(s)) return 'waiting'
  if (DOING_SYNONYMS.has(s)) return 'doing'
  // Title-prefix follow-ups get their own bucket so Ethan can scan
  // "people I owe a text" separately from regular work.
  if (isFollowUp(task.title)) return 'followup'
  // To-do bucket — split by urgency
  const isHigh = HIGH_PRIORITY.has(normalize(task.priority))
  const due = isDueTodayOrOverdue(task.dueDate)
  if (isHigh || due) return 'today'
  return 'upnext'
}

function priorityRank(p: string): number {
  const n = normalize(p)
  if (HIGH_PRIORITY.has(n)) return 0
  if (n === 'medium' || n === 'normal' || n === 'p2medium' || n === 'p2') return 1
  if (n === 'low' || n === 'p3low' || n === 'p3') return 2
  return 3
}

// ---- Main component -------------------------------------------------------

export function FocusList({
  dbId,
  newTaskTrigger,
  grouped = true,
  showAssigneeSidebar = true,
  dateRange,
}: {
  dbId: string
  newTaskTrigger?: number
  /** When false, renders all tasks as a single flat checklist (no
   *  Doing / Up next / Waiting / Done sections). Default true keeps
   *  the original behavior for places like /notion/db/[id]. */
  grouped?: boolean
  /** When false, hides the right-rail assignee filter and collapses
   *  the layout to a single column. Used by /today where the page
   *  prefers a clean centered list. */
  showAssigneeSidebar?: boolean
  /** Optional due-date filter — only tasks whose dueDate falls
   *  inside the range are shown (tasks with no dueDate at all are
   *  always shown, since hiding undated work would obscure the
   *  triage list). Wired by /today's scope/calendar filter. */
  dateRange?: { start: Date; end: Date }
}) {
  const queryClient = useQueryClient()
  const [selectedAssignee, setSelectedAssignee] = useState<string>('all')
  const [doneExpanded, setDoneExpanded] = useState(false)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  // Open task ID for the full edit dialog. Stored as the page id so
  // it survives refetches / optimistic updates that may briefly swap
  // the underlying task object.
  const [editingId, setEditingId] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery<{
    database?: Record<string, unknown>
    results?: NotionTask[]
  }>({
    queryKey: ['notion-tasks', dbId],
    queryFn: async () => {
      const res = await fetch('/api/notion/databases/' + dbId)
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load')
      return res.json()
    },
  })

  const schema = useMemo(() => discoverSchema(data?.database), [data])
  const tasks = useMemo<Extracted[]>(() => {
    if (!schema || !data?.results) return []
    return extractTasks(data.results, schema)
  }, [data, schema])

  // Open the new-task modal whenever the parent *increments*
  // newTaskTrigger — NOT just because it's non-zero on mount. Without
  // this ref guard, remounting (e.g. swapping Focus ↔ Kanban after the
  // trigger has already been bumped once) would immediately reopen the
  // modal with the stale counter value.
  const initialTriggerRef = useRef<number | undefined>(newTaskTrigger)
  useEffect(() => {
    if (newTaskTrigger === undefined) return
    if (newTaskTrigger !== initialTriggerRef.current) {
      setNewTaskOpen(true)
      initialTriggerRef.current = newTaskTrigger
    }
  }, [newTaskTrigger])

  // Filter by assignee + optional due-date range.
  // - 'unassigned' means the task has no assignee set.
  // - dateRange (when provided) filters out tasks whose dueDate is
  //   outside the range. Tasks without a dueDate always pass through
  //   so the focus list isn't gutted by an aggressive scope.
  const filtered = useMemo(() => {
    let list = tasks
    if (selectedAssignee !== 'all') {
      if (selectedAssignee === 'unassigned') {
        list = list.filter((t) => !t.assignee.trim())
      } else {
        list = list.filter((t) =>
          t.assignee
            .split(',')
            .map((s) => s.trim())
            .includes(selectedAssignee),
        )
      }
    }
    if (dateRange) {
      const startMs = dateRange.start.getTime()
      const endMs = dateRange.end.getTime()
      list = list.filter((t) => {
        if (!t.dueDate) return true
        const d = new Date(t.dueDate).getTime()
        if (isNaN(d)) return true
        return d >= startMs && d <= endMs
      })
    }
    return list
  }, [tasks, selectedAssignee, dateRange])

  // (Renamed from `grouped` to `groupedTasks` so it doesn't shadow
  // the new `grouped` prop above.)
  const groupedTasks = useMemo(() => {
    const g: Record<Section, Extracted[]> = {
      doing: [],
      today: [],
      upnext: [],
      followup: [],
      waiting: [],
      done: [],
    }
    for (const t of filtered) g[classify(t)].push(t)
    // Sort each section
    g.today.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    g.upnext.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    g.followup.sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
    )
    g.done.sort(() => 0) // already in Notion order
    return g
  }, [filtered])

  // Assignee list with counts — always computed from the *unfiltered* task
  // set so the sidebar shows real counts even when a filter is applied.
  const assigneeList = useMemo(() => {
    const counts = new Map<string, number>()
    let unassigned = 0
    for (const t of tasks) {
      if (!t.assignee.trim()) {
        unassigned++
        continue
      }
      for (const name of t.assignee.split(',').map((s) => s.trim()).filter(Boolean)) {
        counts.set(name, (counts.get(name) || 0) + 1)
      }
    }
    const list = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { list, unassigned, total: tasks.length }
  }, [tasks])

  // --- Mutations ----------------------------------------------------------

  // Map each visible section to the synonym set that describes its
  // "canonical" status. The derived "today" bucket isn't a real status
  // — drops there fall back to TO-DO so the task joins Up next's logic.
  const SECTION_SYNONYMS: Record<Section, Set<string>> = {
    doing: DOING_SYNONYMS,
    today: TODO_SYNONYMS,
    upnext: TODO_SYNONYMS,
    // Follow-ups live in TODO column under the hood — dropping a
    // task into the Follow-ups section can't itself add the marker
    // prefix to the title (drag move only changes status), so a
    // dropped task lands in TODO and only flips bucket if its title
    // happens to already start with "🔁 ". The intentional "create a
    // follow-up" path is the New-task button.
    followup: TODO_SYNONYMS,
    waiting: BLOCKED_SYNONYMS,
    done: DONE_SYNONYMS,
  }

  /** Resolve the best-matching DB status name for a Focus section. */
  function resolveSectionStatus(section: Section): string | null {
    if (!schema) return null
    return (
      resolveStatus(schema.statusOptions, SECTION_SYNONYMS[section]) ||
      schema.statusOptions[0]?.name ||
      null
    )
  }

  // Single mutation covers both the checkbox toggle and drag-drop — every
  // move ultimately changes the task's Status property, just to a different
  // target column.
  const moveMutation = useMutation({
    mutationFn: async (params: { pageId: string; section: Section }) => {
      if (!schema) throw new Error('No schema')
      const targetName = resolveSectionStatus(params.section)
      if (!targetName) throw new Error('Could not resolve target status')
      const properties: Record<string, unknown> = {}
      if (schema.statusPropType === 'status') {
        properties[schema.statusPropName] = { status: { name: targetName } }
      } else {
        properties[schema.statusPropName] = { select: { name: targetName } }
      }
      const res = await fetch('/api/notion/pages/' + params.pageId + '/properties', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties }),
      })
      if (!res.ok) throw new Error('Failed to update')
      return res.json()
    },
    // Optimistic — update local cache immediately so the row flies to the
    // target section without a spinner. Refetch on settle reconciles any
    // server-side transformations.
    onMutate: async ({ pageId, section }) => {
      if (!schema) return
      const targetName = resolveSectionStatus(section)
      if (!targetName) return
      await queryClient.cancelQueries({ queryKey: ['notion-tasks', dbId] })
      const previous = queryClient.getQueryData<{
        database?: Record<string, unknown>
        results?: NotionTask[]
      }>(['notion-tasks', dbId])
      queryClient.setQueryData(['notion-tasks', dbId], (old: unknown) => {
        const o = old as { database?: unknown; results?: NotionTask[] } | undefined
        if (!o?.results) return old
        return {
          ...o,
          results: o.results.map((t) =>
            t.id === pageId
              ? {
                  ...t,
                  properties: {
                    ...t.properties,
                    [schema.statusPropName]: {
                      ...(t.properties[schema.statusPropName] || {}),
                      type: schema.statusPropType,
                      [schema.statusPropType]: { name: targetName },
                    },
                  },
                }
              : t
          ),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context && typeof context === 'object' && 'previous' in context) {
        queryClient.setQueryData(['notion-tasks', dbId], (context as { previous: unknown }).previous)
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['notion-tasks', dbId] }),
  })

  // Backwards-compat helper — checkbox click keeps the same API as before.
  function toggleComplete(id: string, done: boolean) {
    moveMutation.mutate({ pageId: id, section: done ? 'done' : 'upnext' })
  }

  // Rename — PATCHes just the title property. Optimistic so the new title
  // appears instantly on blur/Enter; reconciled on refetch.
  const renameMutation = useMutation({
    mutationFn: async (params: { pageId: string; title: string }) => {
      if (!schema) throw new Error('No schema')
      const properties = {
        [schema.titleProp]: {
          title: [{ text: { content: params.title } }],
        },
      }
      const res = await fetch('/api/notion/pages/' + params.pageId + '/properties', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties }),
      })
      if (!res.ok) throw new Error('Failed to rename')
      return res.json()
    },
    onMutate: async ({ pageId, title }) => {
      if (!schema) return
      await queryClient.cancelQueries({ queryKey: ['notion-tasks', dbId] })
      const previous = queryClient.getQueryData(['notion-tasks', dbId])
      queryClient.setQueryData(['notion-tasks', dbId], (old: unknown) => {
        const o = old as { database?: unknown; results?: NotionTask[] } | undefined
        if (!o?.results) return old
        return {
          ...o,
          results: o.results.map((t) =>
            t.id === pageId
              ? {
                  ...t,
                  properties: {
                    ...t.properties,
                    [schema.titleProp]: {
                      ...(t.properties[schema.titleProp] || {}),
                      type: 'title',
                      title: [{ type: 'text', text: { content: title }, plain_text: title }],
                    },
                  },
                }
              : t
          ),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context && typeof context === 'object' && 'previous' in context) {
        queryClient.setQueryData(['notion-tasks', dbId], (context as { previous: unknown }).previous)
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['notion-tasks', dbId] }),
  })

  const deleteMutation = useMutation({
    mutationFn: async (pageId: string) => {
      const res = await fetch('/api/notion/pages/' + pageId, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      return res.json()
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['notion-tasks', dbId] }),
  })

  // --- Render -------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="py-16 text-center text-sm text-zinc-400">Loading tasks…</div>
    )
  }
  if (error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        Couldn&apos;t load the pinned Notion board: {(error as Error).message}
      </div>
    )
  }
  if (!schema) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
        This Notion database doesn&apos;t have a status column. Add a Status or
        Select column named &quot;Status&quot; to use the Focus view.
      </div>
    )
  }

  return (
    <FocusDndWrapper
      onMoveTask={(pageId, section) =>
        moveMutation.mutate({ pageId, section })
      }
      tasks={filtered}
    >
      {/* Layout adapts to the props: with the assignee sidebar we use
          a 2-column grid; without it the main column expands to full
          width so the checklist sits centered under the page header. */}
      <div
        className={cn(
          'grid min-w-0 gap-4',
          showAssigneeSidebar && 'lg:grid-cols-[minmax(0,1fr)_220px]'
        )}
      >
        {/* ---- Main column ---- */}
        <div className="min-w-0 space-y-5">
          {grouped ? (
            <>
              <FocusSection
                section="doing"
                icon={Zap}
                label="Doing right now"
                count={groupedTasks.doing.length}
                tone="blue"
                tasks={groupedTasks.doing}
                onToggle={toggleComplete}
                onDelete={(id) => deleteMutation.mutate(id)}
                onRename={(id, title) => renameMutation.mutate({ pageId: id, title })}
                onEdit={(id) => setEditingId(id)}
                emptyHint="Nothing in progress — drag a task here to start."
              />
              <FocusSection
                section="today"
                icon={Flame}
                label="Do today"
                count={groupedTasks.today.length}
                tone="red"
                tasks={groupedTasks.today}
                onToggle={toggleComplete}
                onDelete={(id) => deleteMutation.mutate(id)}
                onRename={(id, title) => renameMutation.mutate({ pageId: id, title })}
                onEdit={(id) => setEditingId(id)}
                emptyHint="Nothing urgent. Nice."
              />
              <FocusSection
                section="upnext"
                icon={ListTodo}
                label="Up next"
                count={groupedTasks.upnext.length}
                tone="indigo"
                tasks={groupedTasks.upnext}
                onToggle={toggleComplete}
                onDelete={(id) => deleteMutation.mutate(id)}
                onRename={(id, title) => renameMutation.mutate({ pageId: id, title })}
                onEdit={(id) => setEditingId(id)}
                emptyHint="Backlog is clear."
              />
              <FocusSection
                section="followup"
                icon={Repeat}
                label="Follow-ups"
                count={groupedTasks.followup.length}
                tone="violet"
                tasks={groupedTasks.followup}
                onToggle={toggleComplete}
                onDelete={(id) => deleteMutation.mutate(id)}
                onRename={(id, title) => renameMutation.mutate({ pageId: id, title })}
                onEdit={(id) => setEditingId(id)}
                emptyHint='No follow-ups queued. Click "New task" and toggle Follow-up to add one.'
              />
              <FocusSection
                section="waiting"
                icon={PauseCircle}
                label="Waiting / Blocked"
                count={groupedTasks.waiting.length}
                tone="amber"
                tasks={groupedTasks.waiting}
                onToggle={toggleComplete}
                onDelete={(id) => deleteMutation.mutate(id)}
                onRename={(id, title) => renameMutation.mutate({ pageId: id, title })}
                onEdit={(id) => setEditingId(id)}
                emptyHint="Nothing blocked right now."
              />

              {/* Done — collapsible to keep the page clean, but droppable
                  even when collapsed so you can drag a task onto the
                  header to mark it complete without expanding first. */}
              <DoneSection
                tasks={groupedTasks.done}
                expanded={doneExpanded}
                onToggleExpanded={() => setDoneExpanded((v) => !v)}
                onToggleTask={toggleComplete}
                onDeleteTask={(id) => deleteMutation.mutate(id)}
                onRenameTask={(id, title) => renameMutation.mutate({ pageId: id, title })}
                onEditTask={(id) => setEditingId(id)}
              />
            </>
          ) : (
            // Flat checklist mode (used by /today). Active tasks first,
            // then a Follow-ups subsection (so Ethan can spot people he
            // owes a text), then Done at the bottom — all rendered
            // inline in one card. Done items strike through but stay
            // visible per Ethan's feedback ("strikethrough — don't
            // disappear immediately"). Drag handles render but only
            // toggle done via the checkbox in this mode.
            <FlatChecklist
              active={[
                ...groupedTasks.doing,
                ...groupedTasks.today,
                ...groupedTasks.upnext,
                ...groupedTasks.waiting,
              ]}
              followUps={groupedTasks.followup}
              done={groupedTasks.done}
              doneExpanded={doneExpanded}
              onToggleDoneExpanded={() => setDoneExpanded((v) => !v)}
              onToggle={toggleComplete}
              onDelete={(id) => deleteMutation.mutate(id)}
              onRename={(id, title) => renameMutation.mutate({ pageId: id, title })}
              onEdit={(id) => setEditingId(id)}
            />
          )}
        </div>

        {/* ---- Assignee sidebar (hidden on /today via prop) ---- */}
        {showAssigneeSidebar && (
          <div className="lg:sticky lg:top-4 lg:self-start">
            <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-2 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                <Users className="h-3 w-3" />
                Filter by assignee
              </div>
              <div className="space-y-0.5">
                <AssigneeRow
                  label="All"
                  count={assigneeList.total}
                  active={selectedAssignee === 'all'}
                  onClick={() => setSelectedAssignee('all')}
                  color={null}
                />
                {assigneeList.list.map((a) => (
                  <AssigneeRow
                    key={a.name}
                    label={a.name}
                    count={a.count}
                    active={selectedAssignee === a.name}
                    onClick={() => setSelectedAssignee(a.name)}
                    color={a.name}
                  />
                ))}
                {assigneeList.unassigned > 0 && (
                  <AssigneeRow
                    label="Unassigned"
                    count={assigneeList.unassigned}
                    active={selectedAssignee === 'unassigned'}
                    onClick={() => setSelectedAssignee('unassigned')}
                    color={null}
                    italic
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ---- New task modal ---- */}
      {newTaskOpen && (
        <NewTaskDialog
          dbId={dbId}
          schema={schema}
          targetStatus={
            resolveStatus(schema.statusOptions, TODO_SYNONYMS) ||
            schema.statusOptions[0]?.name ||
            'To Do'
          }
          onClose={() => setNewTaskOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['notion-tasks', dbId] })
            setNewTaskOpen(false)
          }}
        />
      )}

      {/* ---- Edit task modal ---- */}
      {(() => {
        const editing = editingId
          ? tasks.find((t) => t.id === editingId)
          : null
        if (!editing) return null
        return (
          <EditTaskDialog
            dbId={dbId}
            schema={schema}
            task={{
              id: editing.id,
              title: editing.title,
              priority: editing.priority,
              assignee: editing.assignee,
            }}
            onClose={() => setEditingId(null)}
            onSaved={() => setEditingId(null)}
          />
        )
      })()}
    </FocusDndWrapper>
  )
}

// ---- Section renderer -----------------------------------------------------

const SECTION_TONES: Record<
  'blue' | 'red' | 'indigo' | 'amber' | 'emerald' | 'violet',
  { iconBg: string; icon: string; accent: string }
> = {
  blue: {
    iconBg: 'bg-blue-50 dark:bg-blue-950/50',
    icon: 'text-blue-600',
    accent: 'before:bg-blue-500',
  },
  red: {
    iconBg: 'bg-rose-50 dark:bg-rose-950/50',
    icon: 'text-rose-600',
    accent: 'before:bg-rose-500',
  },
  indigo: {
    iconBg: 'bg-indigo-50 dark:bg-indigo-950/50',
    icon: 'text-indigo-600',
    accent: 'before:bg-indigo-500',
  },
  amber: {
    iconBg: 'bg-amber-50 dark:bg-amber-950/50',
    icon: 'text-amber-600',
    accent: 'before:bg-amber-500',
  },
  emerald: {
    iconBg: 'bg-emerald-50 dark:bg-emerald-950/50',
    icon: 'text-emerald-600',
    accent: 'before:bg-emerald-500',
  },
  violet: {
    iconBg: 'bg-violet-50 dark:bg-violet-950/50',
    icon: 'text-violet-600',
    accent: 'before:bg-violet-500',
  },
}

/**
 * Flat checklist mode used by /today. Three inline groups in one
 * card: active → follow-ups → done. Done is a collapsible cluster
 * (closed by default) so the page lands clean without a wall of
 * yesterday's completed work, but the count stays visible on the
 * header so you know there's history if you want it. Click to
 * expand and see strikethrough rows inline.
 */
function FlatChecklist({
  active,
  followUps,
  done,
  doneExpanded,
  onToggleDoneExpanded,
  onToggle,
  onDelete,
  onRename,
  onEdit,
}: {
  active: Extracted[]
  followUps: Extracted[]
  done: Extracted[]
  doneExpanded: boolean
  onToggleDoneExpanded: () => void
  onToggle: (id: string, done: boolean) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  /** Open the full edit dialog for a row. Optional so older
   *  in-component callers stay typesafe; flat mode passes it. */
  onEdit?: (id: string) => void
}) {
  const totalCount = active.length + followUps.length + done.length
  if (totalCount === 0) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white shadow-soft dark:border-zinc-800 dark:bg-zinc-900">
        <div className="grid place-items-center px-4 py-12 text-sm text-zinc-500">
          No tasks on this board yet.
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white shadow-soft dark:border-zinc-800 dark:bg-zinc-900">
      {/* Active list */}
      {active.length > 0 && (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {active.map((t) => (
            <li key={t.id}>
              <TaskRow
                task={t}
                done={false}
                onToggle={(d) => onToggle(t.id, d)}
                onDelete={() => onDelete(t.id)}
                onRename={(title) => onRename(t.id, title)}
                onEdit={onEdit ? () => onEdit(t.id) : undefined}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Follow-ups subsection — labeled, but no collapse so the
          rows are always one glance away. */}
      {followUps.length > 0 && (
        <div className="border-t border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-300">
            <Repeat className="h-3.5 w-3.5" />
            Follow-ups ({followUps.length})
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {followUps.map((t) => (
              <li key={t.id}>
                <TaskRow
                  task={t}
                  done={false}
                  onToggle={(d) => onToggle(t.id, d)}
                  onDelete={() => onDelete(t.id)}
                  onRename={(title) => onRename(t.id, title)}
                  onEdit={onEdit ? () => onEdit(t.id) : undefined}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Done — collapsible, closed by default. Click the header to
          expand and see strikethrough rows inline. The count stays
          on the header so you can tell there's something to expand. */}
      {done.length > 0 && (
        <div className="border-t border-zinc-100 dark:border-zinc-800">
          <button
            type="button"
            onClick={onToggleDoneExpanded}
            className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800/40"
          >
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              Done today ({done.length})
            </span>
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                doneExpanded && 'rotate-90',
              )}
            />
          </button>
          {doneExpanded && (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {done.map((t) => (
                <li key={t.id}>
                  <TaskRow
                    task={t}
                    done
                    onToggle={(d) => onToggle(t.id, d)}
                    onDelete={() => onDelete(t.id)}
                    onRename={(title) => onRename(t.id, title)}
                    onEdit={onEdit ? () => onEdit(t.id) : undefined}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function FocusSection({
  section,
  icon: Icon,
  label,
  count,
  tone,
  tasks,
  onToggle,
  onDelete,
  onRename,
  onEdit,
  emptyHint,
}: {
  section: Section
  icon: React.ComponentType<{ className?: string }>
  label: string
  count: number
  tone: 'blue' | 'red' | 'indigo' | 'amber' | 'violet'
  tasks: Extracted[]
  onToggle: (id: string, done: boolean) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onEdit?: (id: string) => void
  emptyHint?: string
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'section-' + section })
  const t = SECTION_TONES[tone]

  return (
    <section
      ref={setNodeRef}
      className={cn(
        // `before` pseudo-element renders a thin colored accent strip on
        // the left edge so each bucket is visually distinct at a glance.
        'relative overflow-hidden rounded-xl border bg-white transition-colors dark:bg-zinc-900',
        'before:absolute before:left-0 before:top-0 before:h-full before:w-1',
        t.accent,
        isOver
          ? 'border-blue-400 ring-2 ring-blue-200 dark:border-blue-500 dark:ring-blue-900/40'
          : 'border-zinc-200 dark:border-zinc-800'
      )}
    >
      <div className="flex items-center gap-3 border-b border-zinc-100 pl-5 pr-4 py-3.5 dark:border-zinc-800">
        <div className={cn('rounded-lg p-2', t.iconBg)}>
          <Icon className={cn('h-4 w-4', t.icon)} />
        </div>
        <h3 className="text-[15px] font-semibold tracking-tight">{label}</h3>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {count}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p
          className={cn(
            'px-5 py-7 text-center text-sm transition-colors',
            isOver ? 'text-blue-600 dark:text-blue-300' : 'text-zinc-400'
          )}
        >
          {isOver ? 'Drop to move here' : emptyHint || 'Nothing here.'}
        </p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onToggle={(done) => onToggle(task.id, done)}
              onDelete={() => onDelete(task.id)}
              onRename={(title) => onRename(task.id, title)}
              onEdit={onEdit ? () => onEdit(task.id) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ---- Done section (collapsible, also droppable) ---------------------------

function DoneSection({
  tasks,
  expanded,
  onToggleExpanded,
  onToggleTask,
  onDeleteTask,
  onRenameTask,
  onEditTask,
}: {
  tasks: Extracted[]
  expanded: boolean
  onToggleExpanded: () => void
  onToggleTask: (id: string, done: boolean) => void
  onDeleteTask: (id: string) => void
  onRenameTask: (id: string, title: string) => void
  onEditTask?: (id: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'section-done' })
  const t = SECTION_TONES.emerald
  return (
    <div
      ref={setNodeRef}
      className={cn(
        // Same accent-strip pattern as the live sections above so the
        // collapsed Done card visually belongs to the same family.
        'relative overflow-hidden rounded-xl border bg-white transition-colors dark:bg-zinc-900',
        'before:absolute before:left-0 before:top-0 before:h-full before:w-1',
        t.accent,
        isOver
          ? 'border-emerald-400 ring-2 ring-emerald-200 dark:border-emerald-500 dark:ring-emerald-900/40'
          : 'border-zinc-200 dark:border-zinc-800'
      )}
    >
      <button
        onClick={onToggleExpanded}
        className="flex w-full items-center gap-3 pl-5 pr-4 py-3.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      >
        <div className={cn('rounded-lg p-2', t.iconBg)}>
          <CheckCircle2 className={cn('h-4 w-4', t.icon)} />
        </div>
        <h3 className="text-[15px] font-semibold tracking-tight">
          {isOver ? (
            <span className="text-emerald-700 dark:text-emerald-300">
              Drop to mark as done
            </span>
          ) : (
            'Recently done'
          )}
        </h3>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {tasks.length}
        </span>
        <span className="ml-auto text-zinc-400">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>
      </button>
      {expanded && tasks.length > 0 && (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {tasks.slice(0, 20).map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              done
              onToggle={(done) => onToggleTask(task.id, done)}
              onDelete={() => onDeleteTask(task.id)}
              onRename={(title) => onRenameTask(task.id, title)}
              onEdit={onEditTask ? () => onEditTask(task.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---- DnD wrapper ---------------------------------------------------------

function FocusDndWrapper({
  tasks,
  onMoveTask,
  children,
}: {
  tasks: Extracted[]
  onMoveTask: (pageId: string, section: Section) => void
  children: React.ReactNode
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeId) || null,
    [tasks, activeId]
  )
  // Small activation distance so a click-to-open doesn't accidentally start
  // a drag — dragging needs ~6px of movement before it engages.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  )

  function onStart(e: DragStartEvent) {
    setActiveId(String(e.active.id))
  }

  function onEnd(e: DragEndEvent) {
    setActiveId(null)
    if (!e.over) return
    const pageId = String(e.active.id)
    const overId = String(e.over.id)
    const match = overId.match(
      /^section-(doing|today|upnext|followup|waiting|done)$/,
    )
    if (!match) return
    const target = match[1] as Section
    onMoveTask(pageId, target)
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onStart}
      onDragEnd={onEnd}
      onDragCancel={() => setActiveId(null)}
    >
      {children}
      <DragOverlay>
        {activeTask ? (
          <div className="rounded-lg border-2 border-blue-400 bg-white px-4 py-2 text-sm font-medium shadow-xl dark:bg-zinc-900">
            {activeTask.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

// ---- Task row -------------------------------------------------------------

const PRIORITY_PILL: Record<string, string> = {
  high: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  urgent: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  normal: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  low: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
}

function TaskRow({
  task,
  done,
  onToggle,
  onDelete,
  onRename,
  onEdit,
}: {
  task: Extracted
  done?: boolean
  onToggle: (done: boolean) => void
  onDelete: () => void
  onRename: (title: string) => void
  /** Optional click-to-open hook for the full edit dialog. When
   *  omitted (callers that haven't migrated yet), the pencil button
   *  falls back to the legacy inline-title rename flow. */
  onEdit?: () => void
}) {
  const [overdue, setOverdue] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(task.title)

  useEffect(() => {
    if (task.dueDate && isDueTodayOrOverdue(task.dueDate)) {
      const d = new Date(task.dueDate)
      if (!isNaN(d.getTime()) && d < new Date(new Date().setHours(0, 0, 0, 0))) {
        setOverdue(true)
      }
    }
  }, [task.dueDate])

  // Keep the draft in sync with the canonical title when the parent
  // refetches — e.g. an optimistic rename reconciles back to whatever
  // Notion actually wrote (usually identical, but defend the UX).
  useEffect(() => {
    if (!isEditing) setDraftTitle(task.title)
  }, [task.title, isEditing])

  function commitEdit() {
    const trimmed = draftTitle.trim()
    setIsEditing(false)
    if (trimmed && trimmed !== task.title) onRename(trimmed)
    else setDraftTitle(task.title)
  }

  function cancelEdit() {
    setDraftTitle(task.title)
    setIsEditing(false)
  }

  // Drag handle covers the whole row (via listeners spread on the outer
  // element). Interactive children (checkbox, link, delete) handle their
  // own events so they don't kidnap clicks from the drag layer.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: done || isEditing, // completed or actively-editing rows aren't draggable
  })

  const priorityKey = normalize(task.priority)
  const priorityClass =
    PRIORITY_PILL[priorityKey] ||
    (HIGH_PRIORITY.has(priorityKey)
      ? PRIORITY_PILL.high
      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400')

  return (
    <div
      ref={setNodeRef}
      className={cn(
        // items-start so multi-line meta doesn't vertically shift the
        // checkbox off the title baseline. Consistent left padding (pl-5)
        // aligns every row with the section header's text column.
        'group relative flex items-start gap-2.5 pl-5 pr-4 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
        isDragging && 'opacity-40'
      )}
    >
      {/* Drag handle — reserved 16px slot so layout never shifts on hover.
          On `done` rows the slot stays empty (not draggable) but still
          reserves the width so rows sit on the same x-axis. */}
      <div className="flex h-5 w-4 flex-shrink-0 items-center">
        {!done && (
          <button
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
            onClick={(e) => e.preventDefault()}
            className="cursor-grab text-zinc-300 opacity-0 transition-opacity hover:text-zinc-500 group-hover:opacity-100 active:cursor-grabbing dark:text-zinc-600"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Check circle */}
      <button
        onClick={() => onToggle(!done)}
        aria-label={done ? 'Mark as not done' : 'Mark as done'}
        className="flex h-5 flex-shrink-0 items-center text-zinc-300 transition-colors hover:text-blue-500 dark:text-zinc-600"
      >
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        ) : (
          <Circle className="h-5 w-5" />
        )}
      </button>

      {/* Title + meta — inline-editable: pencil button (or double-click)
          swaps the title into an <input>. Enter/blur saves, Esc cancels. */}
      <div className="min-w-0 flex-1 py-0.5">
        {isEditing ? (
          <input
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelEdit()
              }
            }}
            onBlur={commitEdit}
            className="w-full rounded-md border border-blue-400 bg-white px-2 py-1 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-200 dark:bg-zinc-950 dark:focus:ring-blue-900/60"
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <a
                href={task.url}
                target="_blank"
                rel="noopener noreferrer"
                onDoubleClick={(e) => {
                  // Double-click = edit; prevent the single-click navigate
                  // that would otherwise fire as part of the double.
                  e.preventDefault()
                  if (!done) setIsEditing(true)
                }}
                className={cn(
                  'min-w-0 truncate text-sm font-medium',
                  done && 'text-zinc-400 line-through dark:text-zinc-500'
                )}
                title={done ? task.title : `${task.title} — double-click to edit`}
              >
                {task.title}
              </a>
              {task.priority && (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    // Keep the priority pill on done rows too — it's
                    // useful context when triaging the Done section.
                    // Just dim it so the row's "this is finished"
                    // signal still reads first.
                    done
                      ? 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500'
                      : priorityClass
                  )}
                >
                  {task.priority}
                </span>
              )}
              {overdue && !done && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  Overdue
                </span>
              )}
            </div>
            {(task.assignee || task.dueDate) && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                {task.assignee && (
                  <span className="inline-flex items-center gap-1.5 leading-none">
                    <Avatar name={task.assignee} size="xs" />
                    <span className="leading-none">{task.assignee}</span>
                  </span>
                )}
                {task.dueDate && (
                  <span className="inline-flex items-center gap-1 leading-none">
                    <Clock className="h-3 w-3" />
                    {formatDueDate(task.dueDate)}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Right-side actions — reserve a fixed-width slot so absence of
          hover doesn't make the title expand/contract. While editing,
          hide the actions entirely so the Enter/blur interaction owns
          focus and the save is obvious. Done rows get the same actions
          *plus* a Restore button so accidentally-completed tasks are
          easy to pull back; they're also still editable (priority +
          assignee + title via the dialog). */}
      {!isEditing && (
        <div className="flex h-5 w-[100px] flex-shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {done && (
            <button
              onClick={() => onToggle(false)}
              title="Restore — mark as not done"
              className="rounded p-1 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          {/* Pencil — opens the full edit dialog (title, priority,
              assignee). Falls back to the legacy inline-title rename
              when no onEdit is wired (covers older callers). */}
          <button
            onClick={() => {
              if (onEdit) onEdit()
              else if (!done) setIsEditing(true)
            }}
            title={onEdit ? 'Edit task' : 'Edit title'}
            className="rounded p-1 text-zinc-400 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950/40"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <a
            href={task.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Notion"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            onClick={onDelete}
            title="Delete"
            className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

function formatDueDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const now = new Date()
  const diffDays = Math.floor(
    (d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      (24 * 60 * 60 * 1000)
  )
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays < 0) return `${Math.abs(diffDays)}d ago`
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ---- Assignee sidebar row -------------------------------------------------

function AssigneeRow({
  label,
  count,
  active,
  onClick,
  color,
  italic,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  color: string | null
  italic?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
        active
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/80'
      )}
    >
      {color ? (
        <Avatar name={color} size="xs" />
      ) : (
        <div className="h-5 w-5 flex-shrink-0" aria-hidden />
      )}
      <span className={cn('min-w-0 flex-1 truncate font-medium', italic && 'italic')}>
        {label}
      </span>
      <span
        className={cn(
          'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
          active
            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200'
            : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
        )}
      >
        {count}
      </span>
    </button>
  )
}

