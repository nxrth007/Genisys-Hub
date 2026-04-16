/**
 * Morning brief builder.
 *
 * Aggregates today's tasks + calendar events into a formatted Slack message,
 * then sends it as a DM to the specified user by email.
 *
 * Used by:
 *   1. Manual trigger via POST /api/today/brief (for testing)
 *   2. Scheduled cron via src/lib/scheduler.ts (daily, per-user)
 */
import { prisma } from './prisma'
import { sendDmByEmail } from './slack'

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
