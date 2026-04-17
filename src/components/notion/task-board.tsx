'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState, useMemo } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDroppable } from '@dnd-kit/core'
import {
  Loader2,
  ExternalLink,
  LayoutGrid,
  List,
  GripVertical,
  Plus,
  Check,
  Trash2,
  Pin,
  PinOff,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Helpers ───────────────────────────────────────────────

function richTextToPlain(rt: Array<{ plain_text?: string }> | undefined): string {
  if (!rt) return ''
  return rt.map((r) => r.plain_text || '').join('')
}

function extractPropValue(prop: Record<string, unknown>): string {
  if (!prop) return ''
  const type = prop.type as string
  switch (type) {
    case 'title': return richTextToPlain(prop.title as Array<{ plain_text?: string }>)
    case 'rich_text': return richTextToPlain(prop.rich_text as Array<{ plain_text?: string }>)
    case 'number': return prop.number != null ? String(prop.number) : ''
    case 'select': return (prop.select as { name?: string })?.name || ''
    case 'multi_select': return ((prop.multi_select as Array<{ name: string }>) || []).map((s) => s.name).join(', ')
    case 'date': return (prop.date as { start?: string })?.start || ''
    case 'checkbox': return prop.checkbox ? '✓' : ''
    case 'status': return (prop.status as { name?: string })?.name || ''
    case 'people': return ((prop.people as Array<{ name?: string }>) || []).map((p) => p.name || '').join(', ')
    case 'last_edited_time': return new Date(prop.last_edited_time as string).toLocaleDateString()
    case 'unique_id': {
      const uid = prop.unique_id as { prefix?: string; number?: number }
      return uid ? `${uid.prefix || ''}${uid.number || ''}` : ''
    }
    default: return ''
  }
}

// Status column colors — matching Notion's dark theme style
const COLUMN_STYLES: Record<string, { bg: string; headerBg: string; dot: string; text: string }> = {
  'to do': { bg: 'bg-zinc-900/50', headerBg: 'bg-zinc-800', dot: 'bg-zinc-400', text: 'text-zinc-300' },
  'not started': { bg: 'bg-zinc-900/50', headerBg: 'bg-zinc-800', dot: 'bg-zinc-400', text: 'text-zinc-300' },
  'in progress': { bg: 'bg-blue-950/30', headerBg: 'bg-blue-900/60', dot: 'bg-blue-400', text: 'text-blue-300' },
  'done': { bg: 'bg-green-950/30', headerBg: 'bg-green-900/60', dot: 'bg-green-400', text: 'text-green-300' },
  'blocked': { bg: 'bg-red-950/30', headerBg: 'bg-red-900/60', dot: 'bg-red-400', text: 'text-red-300' },
  'under review': { bg: 'bg-amber-950/30', headerBg: 'bg-amber-900/60', dot: 'bg-amber-400', text: 'text-amber-300' },
  'no status': { bg: 'bg-zinc-900/50', headerBg: 'bg-zinc-800', dot: 'bg-zinc-500', text: 'text-zinc-400' },
}

// Light mode column styles
const COLUMN_STYLES_LIGHT: Record<string, { bg: string; headerBg: string; dot: string; text: string }> = {
  'to do': { bg: 'bg-zinc-50', headerBg: 'bg-zinc-100', dot: 'bg-zinc-400', text: 'text-zinc-700' },
  'not started': { bg: 'bg-zinc-50', headerBg: 'bg-zinc-100', dot: 'bg-zinc-400', text: 'text-zinc-700' },
  'in progress': { bg: 'bg-blue-50', headerBg: 'bg-blue-100', dot: 'bg-blue-500', text: 'text-blue-800' },
  'done': { bg: 'bg-green-50', headerBg: 'bg-green-100', dot: 'bg-green-500', text: 'text-green-800' },
  'blocked': { bg: 'bg-red-50', headerBg: 'bg-red-100', dot: 'bg-red-500', text: 'text-red-800' },
  'under review': { bg: 'bg-amber-50', headerBg: 'bg-amber-100', dot: 'bg-amber-500', text: 'text-amber-800' },
  'no status': { bg: 'bg-zinc-50', headerBg: 'bg-zinc-100', dot: 'bg-zinc-400', text: 'text-zinc-600' },
}

function getColStyle(status: string) {
  const key = status.toLowerCase().replace(/[^\w\s]/g, '').trim()
  return {
    dark: COLUMN_STYLES[key] || COLUMN_STYLES['to do'],
    light: COLUMN_STYLES_LIGHT[key] || COLUMN_STYLES_LIGHT['to do'],
  }
}

const PRIORITY_BADGE: Record<string, { bg: string; text: string }> = {
  'high': { bg: 'bg-red-500/20', text: 'text-red-400' },
  'p0 - critical': { bg: 'bg-red-500/20', text: 'text-red-400' },
  'p1 - high': { bg: 'bg-orange-500/20', text: 'text-orange-400' },
  'medium': { bg: 'bg-amber-500/20', text: 'text-amber-400' },
  'normal': { bg: 'bg-amber-500/20', text: 'text-amber-400' },
  'p2 - medium': { bg: 'bg-amber-500/20', text: 'text-amber-400' },
  'low': { bg: 'bg-green-500/20', text: 'text-green-400' },
  'p3 - low': { bg: 'bg-green-500/20', text: 'text-green-400' },
}

function getPriorityBadge(p: string) {
  return PRIORITY_BADGE[p.toLowerCase()] || { bg: 'bg-zinc-500/20', text: 'text-zinc-400' }
}

type TaskItem = {
  id: string
  url: string
  properties: Record<string, Record<string, unknown>>
}

// ─── Droppable Column ──────────────────────────────────────

function DroppableColumn({
  id,
  statusName,
  tasks,
  titleProp,
  priorityProp,
  assigneeProp,
  dateProp,
  descProp,
  statusPropName,
  statusPropType,
  statusOptions,
  priorityOptions,
  assigneeOptions,
  compact,
  onUpdate,
  onDelete,
  onNewTask,
}: {
  id: string
  statusName: string
  tasks: TaskItem[]
  titleProp: string
  priorityProp?: string
  assigneeProp?: string
  dateProp?: string
  descProp?: string
  statusPropName: string
  statusPropType: string
  statusOptions: Array<{ name: string }>
  priorityOptions: string[]
  assigneeOptions: string[]
  compact?: boolean
  onUpdate: (pageId: string, props: Record<string, unknown>) => void
  onDelete: (pageId: string) => void
  onNewTask: (status: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const style = getColStyle(statusName)
  const taskIds = tasks.map((t) => t.id)

  return (
    // Column is a flex column with a bounded max-height so a "To Do" with
    // 30 tasks stays the same visual height as "Done" with 3. The header
    // stays pinned at the top; only the task list + new-task button scroll
    // inside. Height is viewport-relative minus rough chrome allowance.
    <div
      className={cn(
        'flex-shrink-0 flex flex-col',
        compact ? 'w-[240px] max-h-[calc(100vh-340px)]' : 'w-[280px] max-h-[calc(100vh-240px)]'
      )}
    >
      {/* Column Header — sticky at top of the column */}
      <div className={cn(
        'flex-shrink-0 rounded-t-xl px-4 py-3 flex items-center justify-between',
        style.light.headerBg, 'dark:' + style.dark.headerBg.replace('bg-', 'bg-')
      )}
        style={{ background: undefined }}
      >
        <div className="flex items-center gap-2">
          <div className={cn('h-2.5 w-2.5 rounded-full', style.light.dot)} />
          <span className={cn('text-sm font-semibold', style.light.text)}>{statusName}</span>
        </div>
        <span className="rounded-full bg-white/80 dark:bg-zinc-900/80 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {tasks.length}
        </span>
      </div>

      {/* Column Body — scrollable when content exceeds max-height */}
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 min-h-0 overflow-y-auto rounded-b-xl border border-t-0 p-2 space-y-2 transition-colors',
          isOver ? 'bg-blue-100/50 border-purple-300 dark:bg-blue-900/30 dark:border-purple-600' : cn(style.light.bg, 'border-zinc-200 dark:border-zinc-700'),
        )}
      >
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              titleProp={titleProp}
              priorityProp={priorityProp}
              assigneeProp={assigneeProp}
              dateProp={dateProp}
              descProp={descProp}
              statusPropName={statusPropName}
              statusPropType={statusPropType}
              statusOptions={statusOptions}
              priorityOptions={priorityOptions}
              assigneeOptions={assigneeOptions}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 && !isOver && (
          <div className="text-center py-4 text-xs text-zinc-400">No tasks</div>
        )}

        {/* New task button */}
        <button
          onClick={() => onNewTask(statusName)}
          className="w-full flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-zinc-400 hover:text-purple-500 hover:bg-white/50 dark:hover:bg-zinc-800/50 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> New task
        </button>
      </div>
    </div>
  )
}

// ─── Sortable Task Card ────────────────────────────────────

function SortableTaskCard({
  task,
  titleProp,
  priorityProp,
  assigneeProp,
  dateProp,
  descProp,
  statusPropName,
  statusPropType,
  statusOptions,
  priorityOptions,
  assigneeOptions,
  onUpdate,
  onDelete,
}: {
  task: TaskItem
  titleProp: string
  priorityProp?: string
  assigneeProp?: string
  dateProp?: string
  descProp?: string
  statusPropName: string
  statusPropType: string
  statusOptions: Array<{ name: string }>
  priorityOptions: string[]
  assigneeOptions: string[]
  onUpdate: (pageId: string, props: Record<string, unknown>) => void
  onDelete: (pageId: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id })

  const transformStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const title = extractPropValue(task.properties[titleProp] || {})
  const priority = priorityProp ? extractPropValue(task.properties[priorityProp] || {}) : ''
  const assignee = assigneeProp ? extractPropValue(task.properties[assigneeProp] || {}) : ''
  const dueDate = dateProp ? extractPropValue(task.properties[dateProp] || {}) : ''
  const desc = descProp ? extractPropValue(task.properties[descProp] || {}) : ''
  const status = extractPropValue(task.properties[statusPropName] || {})
  const multiSelect = task.properties['Task type'] ? extractPropValue(task.properties['Task type']) : ''

  const priBadge = priority ? getPriorityBadge(priority) : null

  return (
    <div
      ref={setNodeRef}
      style={transformStyle}
      className={cn(
        'rounded-lg bg-white border border-zinc-200 shadow-sm transition-all dark:bg-zinc-900 dark:border-zinc-700',
        isDragging && 'opacity-50 shadow-lg scale-105',
      )}
    >
      {/* Drag handle + Title */}
      <div className="px-3 pt-3 pb-1">
        <div className="flex items-start gap-1.5">
          <button
            {...attributes}
            {...listeners}
            className="mt-0.5 cursor-grab active:cursor-grabbing text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <p className="text-sm font-medium leading-snug flex-1">{title || 'Untitled'}</p>
        </div>
      </div>

      {/* Description preview */}
      {desc && !isEditing && (
        <p className="px-3 text-xs text-zinc-400 leading-relaxed line-clamp-2 mb-1">{desc}</p>
      )}

      {/* Tags */}
      <div className="px-3 pb-2 flex flex-wrap gap-1.5">
        {priBadge && (
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', priBadge.bg, priBadge.text)}>
            {priority}
          </span>
        )}
        {multiSelect && multiSelect.split(', ').map((tag) => (
          <span key={tag} className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/20 text-purple-400">
            {tag}
          </span>
        ))}
        {dueDate && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {new Date(dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      {/* Bottom: Assignee + Actions */}
      <div className="px-3 pb-2 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800 pt-2">
        {assignee ? (
          <div className="flex items-center gap-1.5">
            <div className="h-5 w-5 rounded-full bg-purple-600 flex items-center justify-center text-[10px] font-bold text-white">
              {assignee.charAt(0).toUpperCase()}
            </div>
            <span className="text-xs text-zinc-500">{assignee}</span>
          </div>
        ) : <span className="text-xs text-zinc-400">Unassigned</span>}

        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsEditing(!isEditing)}
            className="text-[10px] font-medium text-purple-500 hover:text-purple-600 px-1.5 py-0.5 rounded hover:bg-purple-50 dark:hover:bg-purple-950"
          >
            {isEditing ? 'Close' : 'Edit'}
          </button>
          <a
            href={task.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-400 hover:text-purple-500 p-0.5"
            title="Open in Notion"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
          <button
            onClick={() => onDelete(task.id)}
            className="text-zinc-300 hover:text-red-500 p-0.5"
            title="Delete task"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Inline Edit Panel */}
      {isEditing && (
        <div className="px-3 pb-3 space-y-2 border-t border-zinc-100 dark:border-zinc-800 pt-2">
          {/* Title */}
          <div>
            <label className="text-[10px] font-semibold text-zinc-400 uppercase block mb-0.5">Title</label>
            <input
              defaultValue={title}
              onFocus={(e) => setEditTitle(e.target.value)}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={() => {
                if (editTitle && editTitle !== title) {
                  onUpdate(task.id, { [titleProp]: { title: [{ text: { content: editTitle } }] } })
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              className="w-full rounded border border-zinc-200 px-2 py-1 text-xs bg-white dark:border-zinc-700 dark:bg-zinc-800"
            />
          </div>

          {/* Status */}
          <div>
            <label className="text-[10px] font-semibold text-zinc-400 uppercase block mb-0.5">Status</label>
            <select
              value={status}
              onChange={(e) => {
                const props: Record<string, unknown> = {}
                if (statusPropType === 'status') {
                  props[statusPropName] = { status: { name: e.target.value } }
                } else {
                  props[statusPropName] = { select: { name: e.target.value } }
                }
                onUpdate(task.id, props)
              }}
              className="w-full rounded border border-zinc-200 px-2 py-1 text-xs bg-white dark:border-zinc-700 dark:bg-zinc-800"
            >
              {statusOptions.map((s) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Priority */}
          {priorityProp && priorityOptions.length > 0 && (
            <div>
              <label className="text-[10px] font-semibold text-zinc-400 uppercase block mb-0.5">Priority</label>
              <select
                value={priority}
                onChange={(e) => onUpdate(task.id, { [priorityProp]: { select: { name: e.target.value } } })}
                className="w-full rounded border border-zinc-200 px-2 py-1 text-xs bg-white dark:border-zinc-700 dark:bg-zinc-800"
              >
                <option value="">None</option>
                {priorityOptions.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          )}

          {/* Assignee */}
          {assigneeProp && assigneeOptions.length > 0 && (
            <div>
              <label className="text-[10px] font-semibold text-zinc-400 uppercase block mb-0.5">Assignee</label>
              <select
                value={assignee}
                onChange={(e) => {
                  const val = e.target.value
                  if (!val) {
                    onUpdate(task.id, { [assigneeProp]: { people: [] } })
                  } else {
                    onUpdate(task.id, { [assigneeProp]: { people: [{ name: val }] } })
                  }
                }}
                className="w-full rounded border border-zinc-200 px-2 py-1 text-xs bg-white dark:border-zinc-700 dark:bg-zinc-800"
              >
                <option value="">Unassigned</option>
                {assigneeOptions.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Overlay Card (shown while dragging) ───────────────────

function TaskCardOverlay({ task, titleProp, priorityProp }: { task: TaskItem; titleProp: string; priorityProp?: string }) {
  const title = extractPropValue(task.properties[titleProp] || {})
  const priority = priorityProp ? extractPropValue(task.properties[priorityProp] || {}) : ''
  const priBadge = priority ? getPriorityBadge(priority) : null

  return (
    <div className="w-[260px] rounded-lg bg-white border-2 border-purple-400 shadow-xl p-3 dark:bg-zinc-900 dark:border-purple-500 opacity-90">
      <p className="text-sm font-medium">{title || 'Untitled'}</p>
      {priBadge && (
        <span className={cn('inline-block mt-1 rounded px-1.5 py-0.5 text-[10px] font-semibold', priBadge.bg, priBadge.text)}>
          {priority}
        </span>
      )}
    </div>
  )
}

// ─── New Task Inline Form ──────────────────────────────────

function NewTaskForm({
  status,
  dbId,
  titleProp,
  statusPropName,
  statusPropType,
  onClose,
  onCreated,
}: {
  status: string
  dbId: string
  titleProp: string
  statusPropName: string
  statusPropType: string
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)

  async function handleCreate() {
    if (!title.trim()) return
    setCreating(true)
    try {
      const properties: Record<string, unknown> = {
        [titleProp]: { title: [{ text: { content: title } }] },
      }
      if (statusPropType === 'status') {
        properties[statusPropName] = { status: { name: status } }
      } else {
        properties[statusPropName] = { select: { name: status } }
      }

      await fetch('/api/notion/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: dbId, properties, isDatabase: true }),
      })
      setTitle('')
      onCreated()
      onClose()
    } catch {
      // ignore
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="rounded-lg bg-white border border-purple-300 p-2 shadow-md dark:bg-zinc-900 dark:border-purple-600">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') onClose() }}
        placeholder="Task name..."
        className="w-full rounded border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={handleCreate}
          disabled={!title.trim() || creating}
          className="flex items-center gap-1 rounded bg-purple-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
        >
          {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Create
        </button>
        <button onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-600">
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Main Board Component ──────────────────────────────────

/**
 * Reusable Kanban for any Notion database. Used both at /notion/tasks/[id]
 * (full page variant) and embedded in /today (embed variant).
 *
 * Props:
 *   dbId         — Notion database ID
 *   variant      — 'page' renders the back button + pin/unpin controls;
 *                  'embed' is headless for use inside another layout
 *   defaultView  — optional initial 'board' | 'list'
 */
export function TaskBoard({
  dbId,
  variant = 'page',
  defaultView = 'board',
}: {
  dbId: string
  variant?: 'page' | 'embed'
  defaultView?: 'board' | 'list'
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [viewMode, setViewMode] = useState<'board' | 'list'>(defaultView)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newTaskStatus, setNewTaskStatus] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const { data, isLoading, error } = useQuery({
    queryKey: ['notion-tasks', dbId],
    queryFn: async () => {
      const res = await fetch('/api/notion/databases/' + dbId)
      if (!res.ok) throw new Error((await res.json()).error || 'Failed')
      return res.json()
    },
  })

  type BoardData = { database: unknown; results: TaskItem[] } & Record<string, unknown>

  const updateMutation = useMutation({
    mutationFn: async ({ pageId, properties }: { pageId: string; properties: Record<string, unknown> }) => {
      const res = await fetch('/api/notion/pages/' + pageId + '/properties', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Update failed')
      return res.json()
    },
    // Optimistic update — immediately reflect the change in the board UI so
    // drag-and-drop feels instant. The Notion round-trip (~300-500ms) happens
    // in the background; on failure we revert to the snapshot we took.
    onMutate: async ({ pageId, properties }) => {
      await queryClient.cancelQueries({ queryKey: ['notion-tasks', dbId] })
      const previous = queryClient.getQueryData<BoardData>(['notion-tasks', dbId])
      queryClient.setQueryData<BoardData>(['notion-tasks', dbId], (old) => {
        if (!old) return old
        return {
          ...old,
          results: old.results.map((task) => {
            if (task.id !== pageId) return task
            const mergedProps: Record<string, Record<string, unknown>> = { ...task.properties }
            for (const [key, partial] of Object.entries(properties)) {
              // Merge so we preserve .type (needed by extractPropValue) and
              // only override the value shape the mutation sent.
              mergedProps[key] = {
                ...(task.properties[key] || {}),
                ...(partial as Record<string, unknown>),
              }
            }
            return { ...task, properties: mergedProps }
          }),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['notion-tasks', dbId], context.previous)
      }
    },
    // Always refetch at the end so any server-side transformations (e.g.
    // timestamps, rollups) reconcile with our optimistic assumption.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notion-tasks', dbId] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (pageId: string) => {
      const res = await fetch('/api/notion/pages/' + pageId, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error || 'Delete failed')
      return res.json()
    },
    // Optimistic remove — card disappears immediately on click. Reverted if
    // Notion rejects the archive call.
    onMutate: async (pageId) => {
      await queryClient.cancelQueries({ queryKey: ['notion-tasks', dbId] })
      const previous = queryClient.getQueryData<BoardData>(['notion-tasks', dbId])
      queryClient.setQueryData<BoardData>(['notion-tasks', dbId], (old) => {
        if (!old) return old
        return { ...old, results: old.results.filter((t) => t.id !== pageId) }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['notion-tasks', dbId], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notion-tasks', dbId] })
    },
  })

  // Pin this database as the Today page's Kanban. Only surfaced in the
  // `page` variant (embedded boards on Today are *already* pinned).
  const pinnedQuery = useQuery<{ dbId: string | null }>({
    queryKey: ['today-task-board-setting'],
    queryFn: async () => {
      const res = await fetch('/api/settings/today-task-board')
      if (!res.ok) throw new Error('Failed to load pin state')
      return res.json()
    },
    enabled: variant === 'page',
  })
  const isPinned = pinnedQuery.data?.dbId === dbId

  const pinMutation = useMutation({
    mutationFn: async (next: string | null) => {
      const res = await fetch('/api/settings/today-task-board', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbId: next }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Pin failed')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['today-task-board-setting'] })
    },
  })

  // Parse database schema. Every derived value is memoized off `data` so the
  // React Compiler can preserve memoization down the chain (otherwise it
  // flags every downstream useMemo as having a potentially mutated input).
  const db = useMemo(() => data?.database || {}, [data])
  const results = useMemo<TaskItem[]>(() => data?.results || [], [data])
  const dbTitle = db.title ? db.title.map((t: { plain_text: string }) => t.plain_text).join('') : 'Tasks'
  const dbIcon = db.icon?.type === 'emoji' ? db.icon.emoji : '📋'
  const properties = useMemo(
    () => (db.properties ? (Object.entries(db.properties) as Array<[string, Record<string, unknown>]>) : []),
    [db]
  )

  const schema = useMemo(() => {
    const statusProp =
      properties.find(([, v]) => v.type === 'status') ||
      properties.find(([name, v]) => v.type === 'select' && name.toLowerCase().includes('status'))
    const statusPropName = statusProp?.[0] || 'Status'
    const statusPropDef = statusProp?.[1] || {}
    const statusPropType = (statusPropDef.type as string) || 'status'

    let statusOpts: Array<{ name: string }> = []
    if (statusPropType === 'status') {
      statusOpts = ((statusPropDef.status as Record<string, unknown>)?.options as Array<{ name: string }>) || []
    } else if (statusPropType === 'select') {
      statusOpts = ((statusPropDef.select as Record<string, unknown>)?.options as Array<{ name: string }>) || []
    }
    if (statusOpts.length === 0) statusOpts = [{ name: 'No Status' }]

    const titleProp = properties.find(([, v]) => v.type === 'title')?.[0] || 'Name'
    const priorityProp = properties.find(([name]) => name.toLowerCase().includes('priority'))?.[0]
    const assigneeProp =
      properties.find(([, v]) => v.type === 'people')?.[0] ||
      properties.find(([name]) => name.toLowerCase().includes('assign'))?.[0]
    const dateProp = properties.find(([, v]) => v.type === 'date')?.[0]
    const descProp = properties.find(
      ([name]) => name.toLowerCase().includes('description') || name.toLowerCase().includes('notes')
    )?.[0]

    const priorityPropDef = priorityProp ? properties.find(([n]) => n === priorityProp)?.[1] : null
    let priorityOpts: string[] = []
    if (priorityPropDef?.type === 'select') {
      priorityOpts = ((priorityPropDef.select as Record<string, unknown>)?.options as Array<{ name: string }> || [])
        .map((o) => o.name)
    }

    const assigneePropDef = assigneeProp ? properties.find(([n]) => n === assigneeProp)?.[1] : null
    const assigneePropType = (assigneePropDef?.type as string) || 'select'
    let selectAssigneeOpts: string[] = []
    if (assigneePropDef?.type === 'select') {
      selectAssigneeOpts = ((assigneePropDef.select as Record<string, unknown>)?.options as Array<{ name: string }> || [])
        .map((o) => o.name)
    }

    return {
      statusPropName,
      statusPropType,
      statusOptions: statusOpts,
      titleProp,
      priorityProp,
      assigneeProp,
      dateProp,
      descProp,
      priorityOptions: priorityOpts,
      assigneePropType,
      selectAssigneeOptions: selectAssigneeOpts,
    }
  }, [properties])

  const {
    statusPropName,
    statusPropType,
    statusOptions,
    titleProp,
    priorityProp,
    assigneeProp,
    dateProp,
    descProp,
    priorityOptions,
    assigneePropType,
    selectAssigneeOptions,
  } = schema

  // Fetch Notion users for people-type assignee fields
  const { data: usersData } = useQuery({
    queryKey: ['notion-users'],
    queryFn: async () => {
      const res = await fetch('/api/notion/users')
      if (!res.ok) return { users: [] }
      return res.json()
    },
    enabled: assigneePropType === 'people',
  })
  const notionUsers: Array<{ id: string; name: string; email: string }> = useMemo(
    () => usersData?.users || [],
    [usersData]
  )
  // People-type assignees source from Notion user list, everything else uses
  // the select options pre-extracted in schema.
  const assigneeOptions = useMemo<string[]>(() => {
    if (assigneePropType === 'people') {
      return notionUsers.map((u) => u.name)
    }
    return selectAssigneeOptions
  }, [assigneePropType, selectAssigneeOptions, notionUsers])

  // Group tasks by status
  const grouped = useMemo(() => {
    const g: Record<string, TaskItem[]> = {}
    for (const opt of statusOptions) g[opt.name] = []
    for (const task of results) {
      const s = extractPropValue(task.properties[statusPropName] || {}) || statusOptions[0]?.name || 'No Status'
      if (!g[s]) g[s] = []
      g[s].push(task)
    }
    return g
  }, [results, statusOptions, statusPropName])

  // Find which column a task belongs to
  function findColumn(taskId: string): string | undefined {
    for (const [status, tasks] of Object.entries(grouped)) {
      if (tasks.some((t) => t.id === taskId)) return status
    }
    return undefined
  }

  // DnD handlers
  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)
    if (!over) return

    const activeTaskId = active.id as string
    const overId = over.id as string

    // Check if dropped on a column (status name) or on another task
    const targetColumn = statusOptions.find((s) => s.name === overId)?.name || findColumn(overId)
    const sourceColumn = findColumn(activeTaskId)

    if (targetColumn && targetColumn !== sourceColumn) {
      // Move task to new status
      const props: Record<string, unknown> = {}
      if (statusPropType === 'status') {
        props[statusPropName] = { status: { name: targetColumn } }
      } else {
        props[statusPropName] = { select: { name: targetColumn } }
      }
      updateMutation.mutate({ pageId: activeTaskId, properties: props })
    }
  }

  function handleUpdate(pageId: string, props: Record<string, unknown>) {
    // If updating a people-type assignee field, convert name to user ID format
    if (assigneeProp && props[assigneeProp] && assigneePropType === 'people') {
      const val = props[assigneeProp] as { people?: Array<{ name: string }> }
      if (val.people) {
        // Map names to Notion user IDs
        const mapped = val.people
          .map(p => {
            const user = notionUsers.find(u => u.name === p.name)
            return user ? { object: 'user' as const, id: user.id } : null
          })
          .filter(Boolean)
        props[assigneeProp] = { people: mapped }
      }
    }
    updateMutation.mutate({ pageId, properties: props })
  }

  const activeTask = activeId ? results.find((t) => t.id === activeId) : null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <button onClick={() => router.back()} className="text-sm text-purple-600 hover:underline">&larr; Back</button>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error instanceof Error ? error.message : 'Failed to load'}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Top bar — only rendered in the full page variant. Embed variant
          relies on the parent layout for chrome. */}
      {variant === 'page' && (
        <div className="flex items-center justify-between">
          <button onClick={() => router.back()} className="text-sm text-purple-600 hover:underline">
            &larr; Back to Notion
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => pinMutation.mutate(isPinned ? null : dbId)}
              disabled={pinMutation.isPending}
              title={isPinned ? 'Unpin from Today page' : 'Show this board on the Today page'}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                isPinned
                  ? 'border-purple-600 bg-purple-600 text-white hover:bg-purple-700'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
              )}
            >
              {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
              {isPinned ? 'Unpin from Today' : 'Pin to Today'}
            </button>
            {db.url && (
              <a href={db.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-purple-600">
                Open in Notion <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className={cn('flex items-center', variant === 'embed' ? 'gap-2' : 'gap-3')}>
          <span className={variant === 'embed' ? 'text-base' : 'text-2xl'}>{dbIcon}</span>
          <div>
            <h2 className={cn('font-bold', variant === 'embed' ? 'text-sm' : 'text-xl')}>
              {dbTitle}
            </h2>
            {variant === 'page' && (
              <p className="text-sm text-zinc-500">{results.length} tasks</p>
            )}
          </div>
          {variant === 'embed' && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {results.length}
            </span>
          )}
        </div>
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-700">
          <button
            onClick={() => setViewMode('board')}
            className={cn(
              variant === 'embed' ? 'p-1' : 'p-2',
              'rounded-l-md',
              viewMode === 'board'
                ? 'bg-purple-600 text-white'
                : 'text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            )}
            title="Board view"
          >
            <LayoutGrid className={variant === 'embed' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              variant === 'embed' ? 'p-1' : 'p-2',
              'rounded-r-md',
              viewMode === 'list'
                ? 'bg-purple-600 text-white'
                : 'text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            )}
            title="List view"
          >
            <List className={variant === 'embed' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
          </button>
        </div>
      </div>

      {/* Subtle floating pill — optimistic UI already reflects the change,
           this just confirms a sync is in flight. Positioned so it doesn't
           reserve layout space (avoids a jumpy board on every drop). */}
      {(updateMutation.isPending || deleteMutation.isPending) && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-purple-200 bg-white px-3 py-1.5 text-xs font-medium text-purple-700 shadow-sm dark:border-purple-800 dark:bg-zinc-900 dark:text-purple-300">
          <Loader2 className="h-3 w-3 animate-spin" /> Syncing with Notion
        </div>
      )}

      {/* Board View with DnD */}
      {viewMode === 'board' ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className={cn('flex overflow-x-auto pb-4', variant === 'embed' ? 'gap-2' : 'gap-3')}>
            {statusOptions.map((statusOpt) => (
              <DroppableColumn
                key={statusOpt.name}
                id={statusOpt.name}
                statusName={statusOpt.name}
                tasks={grouped[statusOpt.name] || []}
                titleProp={titleProp}
                priorityProp={priorityProp}
                assigneeProp={assigneeProp}
                dateProp={dateProp}
                descProp={descProp}
                statusPropName={statusPropName}
                statusPropType={statusPropType}
                statusOptions={statusOptions}
                priorityOptions={priorityOptions}
                assigneeOptions={assigneeOptions}
                compact={variant === 'embed'}
                onUpdate={handleUpdate}
                onDelete={(pageId) => {
                  if (confirm('Delete this task? It will be moved to Notion\'s trash.')) {
                    deleteMutation.mutate(pageId)
                  }
                }}
                onNewTask={(status) => setNewTaskStatus(status)}
              />
            ))}
          </div>

          <DragOverlay>
            {activeTask ? (
              <TaskCardOverlay task={activeTask} titleProp={titleProp} priorityProp={priorityProp} />
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        /* List View */
        <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-zinc-500 text-xs">Task</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-500 text-xs">Status</th>
                {priorityProp && <th className="text-left px-4 py-3 font-medium text-zinc-500 text-xs">Priority</th>}
                {assigneeProp && <th className="text-left px-4 py-3 font-medium text-zinc-500 text-xs">Assignee</th>}
                {dateProp && <th className="text-left px-4 py-3 font-medium text-zinc-500 text-xs">Due</th>}
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {results.map((task) => {
                const title = extractPropValue(task.properties[titleProp] || {})
                const status = extractPropValue(task.properties[statusPropName] || {})
                const priority = priorityProp ? extractPropValue(task.properties[priorityProp] || {}) : ''
                const assignee = assigneeProp ? extractPropValue(task.properties[assigneeProp] || {}) : ''
                const dueDate = dateProp ? extractPropValue(task.properties[dateProp] || {}) : ''

                return (
                  <tr key={task.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800">
                    <td className="px-4 py-3 font-medium">
                      <input
                        defaultValue={title || 'Untitled'}
                        onBlur={(e) => {
                          const newVal = e.target.value.trim()
                          if (newVal && newVal !== title) {
                            handleUpdate(task.id, { [titleProp]: { title: [{ text: { content: newVal } }] } })
                          }
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                        className="w-full bg-transparent border-0 p-0 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-purple-500 focus:rounded focus:px-1"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={status}
                        onChange={(e) => {
                          const props: Record<string, unknown> = {}
                          if (statusPropType === 'status') {
                            props[statusPropName] = { status: { name: e.target.value } }
                          } else {
                            props[statusPropName] = { select: { name: e.target.value } }
                          }
                          handleUpdate(task.id, props)
                        }}
                        className="rounded-full border-0 bg-transparent text-xs font-medium cursor-pointer"
                      >
                        {statusOptions.map((s) => (
                          <option key={s.name} value={s.name}>{s.name}</option>
                        ))}
                      </select>
                    </td>
                    {priorityProp && (
                      <td className="px-4 py-3">
                        <select
                          value={priority}
                          onChange={(e) => handleUpdate(task.id, { [priorityProp]: { select: { name: e.target.value } } })}
                          className="rounded-full border-0 bg-transparent text-xs font-medium cursor-pointer"
                        >
                          <option value="">-</option>
                          {priorityOptions.map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    {assigneeProp && (
                      <td className="px-4 py-3 text-xs text-zinc-500">
                        {assigneeOptions.length > 0 ? (
                          <select
                            value={assignee}
                            onChange={(e) => {
                              const val = e.target.value
                              if (!val) {
                                handleUpdate(task.id, { [assigneeProp]: { people: [] } })
                              } else {
                                handleUpdate(task.id, { [assigneeProp]: { people: [{ name: val }] } })
                              }
                            }}
                            className="border-0 bg-transparent text-xs cursor-pointer"
                          >
                            <option value="">-</option>
                            {assigneeOptions.map((a) => (
                              <option key={a} value={a}>{a}</option>
                            ))}
                          </select>
                        ) : assignee || '-'}
                      </td>
                    )}
                    {dateProp && (
                      <td className="px-4 py-3 text-xs text-zinc-500">
                        {dueDate ? new Date(dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-'}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <a href={task.url} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-purple-600">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                        <button
                          onClick={() => {
                            if (confirm('Delete this task? It will be moved to Notion\'s trash.')) {
                              deleteMutation.mutate(task.id)
                            }
                          }}
                          className="text-zinc-300 hover:text-red-500"
                          title="Delete task"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* New Task Modal */}
      {newTaskStatus && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setNewTaskStatus(null)} />
          <div className="relative z-10 w-full max-w-sm">
            <NewTaskForm
              status={newTaskStatus}
              dbId={dbId}
              titleProp={titleProp}
              statusPropName={statusPropName}
              statusPropType={statusPropType}
              onClose={() => setNewTaskStatus(null)}
              onCreated={() => queryClient.invalidateQueries({ queryKey: ['notion-tasks', dbId] })}
            />
          </div>
        </div>
      )}
    </div>
  )
}
