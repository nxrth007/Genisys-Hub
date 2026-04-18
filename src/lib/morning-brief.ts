/**
 * Morning brief builder.
 *
 * Aggregates today's tasks + calendar events into a formatted message,
 * delivered via one of two channels:
 *   - Slack DM (default): looks up the recipient by email in the workspace
 *   - GHL SMS: sends via GHL's Private Integration to a phone number,
 *     looking up or creating the GHL contact on the fly
 *
 * Used by:
 *   1. Manual trigger via POST /api/today/brief (for testing)
 *   2. Scheduled cron via src/lib/scheduler.ts (daily, per-user)
 */
import { prisma } from './prisma'
import { sendDmByEmail } from './slack'
import { sendSmsToPhone } from './ghl'
import { getKanbanTasksForAssignee, type KanbanTaskBrief } from './notion'

/**
 * Fetch today's incomplete tasks for a user (by email → userId).
 */
async function getTodayTasks(userEmail: string) {
  const user = await prisma.user.findUnique({ where: { email: userEmail } })
  if (!user) return []

  const today = new Date()
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000)

  return prisma.task.findMany({
    where: {
      userId: user.id,
      completedAt: null,
      OR: [
        { dueAt: { gte: startOfDay, lt: endOfDay } },
        { dueAt: null }, // undated tasks always show
      ],
    },
    orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
  })
}

/**
 * Fetch today's calendar events from GHL.
 * Wrapped in try/catch so a GHL outage doesn't block the whole brief.
 */
async function getTodayCalendarEvents(): Promise<
  Array<{ title: string; startTime: string; endTime: string; calendarName: string }>
> {
  try {
    // Dynamic import to avoid circular dependency with vault at startup
    const { getTodayEvents } = await import('./ghl')
    const data = await getTodayEvents('GHL Genisys Token')
    return (data.events || []).map((ev) => ({
      title: String(ev.title || ev.name || 'Untitled'),
      startTime: String(ev.startTime || ''),
      endTime: String(ev.endTime || ''),
      calendarName: String(ev.calendarName || ''),
    }))
  } catch (err) {
    console.warn('[morning-brief] Failed to fetch GHL calendar:', err)
    return []
  }
}

function formatTime(iso: string): string {
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

function priorityEmoji(p: string): string {
  if (p === 'high') return '🔴'
  if (p === 'low') return '⚪'
  return '🔵'
}

/**
 * Build a formatted Slack message from tasks + meetings.
 */
function formatBrief(
  tasks: Array<{ title: string; priority: string; dueAt: Date | null }>,
  events: Array<{ title: string; startTime: string; endTime: string; calendarName: string }>
): string {
  const lines: string[] = []
  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  lines.push(`*Genisys Hub — Daily Brief*`)
  lines.push(`${dateStr}\n`)

  // Meetings
  if (events.length > 0) {
    lines.push(`*Meetings (${events.length}):*`)
    for (const ev of events) {
      const time = formatTime(ev.startTime)
      const end = formatTime(ev.endTime)
      const timeStr = end ? `${time}–${end}` : time
      lines.push(`  • ${timeStr}  ${ev.title}`)
    }
    lines.push('')
  } else {
    lines.push(`*Meetings:* None scheduled today\n`)
  }

  // Tasks
  if (tasks.length > 0) {
    lines.push(`*Tasks (${tasks.length}):*`)
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      lines.push(`  ${priorityEmoji(t.priority)} ${i + 1}. ${t.title}`)
    }
    lines.push('')
  } else {
    lines.push(`*Tasks:* All clear\n`)
  }

  lines.push(`_View in hub: https://genisys-hub.onrender.com/today_`)

  return lines.join('\n')
}

/**
 * Build the brief and send it as a Slack DM.
 */
export async function buildAndSendBrief(recipientEmail: string) {
  const [tasks, events] = await Promise.all([
    getTodayTasks(recipientEmail),
    getTodayCalendarEvents(),
  ])

  const message = formatBrief(
    tasks.map((t) => ({ title: t.title, priority: t.priority, dueAt: t.dueAt })),
    events
  )

  const result = await sendDmByEmail({ email: recipientEmail, text: message })

  if (!result) {
    throw new Error(
      `No Slack user found for ${recipientEmail}. Make sure they're a member of the workspace.`
    )
  }

  return {
    ok: true,
    taskCount: tasks.length,
    eventCount: events.length,
    channel: result.channel,
    ts: result.ts,
  }
}

// -------------------------------------------------------------------------
// SMS brief — Notion Kanban tasks + today's meetings, delivered via GHL
// -------------------------------------------------------------------------

/**
 * Fetch the Notion DB id that's been pinned as the Today task board
 * (see /api/settings/today-task-board).
 */
async function getPinnedTaskBoardId(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: 'today_task_board_db_id' },
  })
  return row?.value || null
}

/** Compact plain-text formatter — no markdown, fits inside a single SMS
 *  where possible. SMS concatenation handles the rest. */
function formatSmsBrief(params: {
  firstName: string
  events: Array<{ title: string; startTime: string; endTime: string }>
  tasks: KanbanTaskBrief[]
}): string {
  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  const lines: string[] = []
  lines.push(`Good morning ${params.firstName} — Genisys Daily Brief`)
  lines.push(dateStr)
  lines.push('')

  if (params.events.length > 0) {
    lines.push(`Meetings (${params.events.length}):`)
    for (const ev of params.events) {
      const start = formatTime(ev.startTime)
      const end = formatTime(ev.endTime)
      const timeStr = end ? `${start}-${end}` : start
      lines.push(`  ${timeStr}  ${ev.title}`)
    }
    lines.push('')
  } else {
    lines.push('Meetings: none today')
    lines.push('')
  }

  if (params.tasks.length > 0) {
    lines.push(`To-dos (${params.tasks.length}):`)
    for (let i = 0; i < params.tasks.length; i++) {
      const t = params.tasks[i]
      const prefix = priorityPrefix(t.priority)
      lines.push(`  ${prefix}${i + 1}. ${t.title}`)
    }
    lines.push('')
  } else {
    lines.push('To-dos: all clear')
    lines.push('')
  }

  lines.push('https://genisys-hub.onrender.com/today')

  return lines.join('\n')
}

function priorityPrefix(p: string): string {
  const s = (p || '').toLowerCase()
  if (s.includes('high') || s.includes('p0') || s.includes('p1')) return '! '
  if (s.includes('low') || s.includes('p3')) return '. '
  return ''
}

/**
 * Build and send the morning brief as an SMS via GHL. Pulls today's
 * meetings from the GHL calendar and the Notion Kanban's To-Do tasks
 * for the given assignee name.
 */
export async function buildAndSendSmsBrief(params: {
  phone: string
  firstName?: string
  notionAssignee?: string | null
}): Promise<{
  ok: true
  eventCount: number
  taskCount: number
  contactId: string
  messageId?: string
}> {
  const events = await getTodayCalendarEvents()

  let tasks: KanbanTaskBrief[] = []
  if (params.notionAssignee) {
    try {
      const dbId = await getPinnedTaskBoardId()
      if (dbId) {
        tasks = await getKanbanTasksForAssignee(dbId, params.notionAssignee, {
          todoOnly: true,
          max: 15,
        })
      }
    } catch (err) {
      console.warn('[morning-brief] Notion task fetch failed:', err)
      // Continue without task list — better to send a partial brief than nothing.
    }
  }

  const message = formatSmsBrief({
    firstName: params.firstName || params.notionAssignee || 'there',
    events,
    tasks,
  })

  const { contactId, messageId } = await sendSmsToPhone('GHL Genisys Token', {
    phone: params.phone,
    message,
    firstName: params.firstName,
  })

  return {
    ok: true,
    eventCount: events.length,
    taskCount: tasks.length,
    contactId,
    messageId,
  }
}
