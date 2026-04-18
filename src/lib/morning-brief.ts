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

/**
 * Format a time range compactly. If start + end are in the same half of
 * the day (both AM or both PM), drop the first AM/PM to save space —
 * "8:00-8:20 PM" reads better than "8:00 PM-8:20 PM". Single time when
 * no end is provided.
 */
function formatTimeRange(startIso: string, endIso: string): string {
  if (!startIso) return ''
  const start = new Date(startIso)
  const startStr = start.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  if (!endIso) return startStr
  const end = new Date(endIso)
  const endStr = end.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const startAmPm = startStr.slice(-2)
  const endAmPm = endStr.slice(-2)
  if (startAmPm === endAmPm) {
    // "8:00 PM" + "8:20 PM" → "8:00-8:20 PM"
    return `${startStr.slice(0, -3)}-${endStr}`
  }
  return `${startStr}-${endStr}`
}

function priorityLabel(p: string): string {
  const s = (p || '').toLowerCase()
  if (
    s.includes('high') ||
    s.includes('p0') ||
    s.includes('p1') ||
    s.includes('critical') ||
    s.includes('urgent')
  )
    return ' (high)'
  if (s.includes('low') || s.includes('p3')) return ' (low)'
  return ''
}

/** Sort rank: high=0, normal=1, low=2. Used to put urgent tasks first. */
function priorityRank(p: string): number {
  const s = (p || '').toLowerCase()
  if (
    s.includes('high') ||
    s.includes('p0') ||
    s.includes('p1') ||
    s.includes('critical') ||
    s.includes('urgent')
  )
    return 0
  if (s.includes('low') || s.includes('p3')) return 2
  return 1
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
  lines.push(`Good morning ${params.firstName}`)
  lines.push(`Genisys Daily Brief — ${dateStr}`)
  lines.push('')

  if (params.events.length > 0) {
    lines.push(`Meetings (${params.events.length}):`)
    for (const ev of params.events) {
      const when = formatTimeRange(ev.startTime, ev.endTime)
      lines.push(`• ${when}  ${ev.title}`)
    }
    lines.push('')
  } else {
    lines.push('Meetings: none today')
    lines.push('')
  }

  if (params.tasks.length > 0) {
    // Sort by priority (high → normal → low) so urgent work lands at the
    // top where Ethan/Alex look first.
    const sorted = [...params.tasks].sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority)
    )
    lines.push(`To-dos (${sorted.length}):`)
    for (const t of sorted) {
      lines.push(`• ${t.title}${priorityLabel(t.priority)}`)
    }
    lines.push('')
  } else {
    lines.push('To-dos: all clear')
    lines.push('')
  }

  lines.push('genisys-hub.onrender.com/today')

  return lines.join('\n')
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
  conversationId?: string
  normalizedPhone: string
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

  // Greeting uses the recipient's name. When a notionAssignee is set it's
  // effectively the recipient ("Ethan") — prefer that over firstName which
  // on the test path is the schedule owner's name, not the recipient's.
  const greetName =
    (params.notionAssignee?.trim().split(/\s+/)[0] ||
      params.firstName?.trim().split(/\s+/)[0] ||
      'there')

  const message = formatSmsBrief({
    firstName: greetName,
    events,
    tasks,
  })

  const sendResult = await sendSmsToPhone('GHL Genisys Token', {
    phone: params.phone,
    message,
    firstName: greetName === 'there' ? undefined : greetName,
  })

  return {
    ok: true,
    eventCount: events.length,
    taskCount: tasks.length,
    contactId: sendResult.contactId,
    messageId: sendResult.messageId,
    conversationId: sendResult.conversationId,
    normalizedPhone: sendResult.normalizedPhone,
  }
}
