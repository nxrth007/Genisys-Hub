/**
 * In-process cron scheduler for recurring jobs.
 *
 * Started via src/instrumentation.ts when the server boots. Runs inside the
 * same Node process as Next.js — no separate worker, no external cron service.
 *
 * Jobs:
 *   - Morning brief: checks every minute, sends Slack DM to users whose
 *     ScheduledSms.timeOfDay matches the current time in their timezone.
 *     (Named ScheduledSms from the Prisma model, but delivery is now via Slack.)
 */
import cron from 'node-cron'
import { prisma } from './prisma'
import { buildAndSendBrief } from './morning-brief'

let initialized = false

export function initScheduler() {
  if (initialized) return
  initialized = true

  console.log('[scheduler] Starting morning brief cron (every minute)')

  // Tick every minute, check if any user's brief is due.
  cron.schedule('* * * * *', async () => {
    try {
      await checkAndSendBriefs()
    } catch (err) {
      console.error('[scheduler] Brief check failed:', err)
    }
  })
}

async function checkAndSendBriefs() {
  // Get all enabled scheduled briefs with their user info.
  const schedules = await prisma.scheduledSms.findMany({
    where: { enabled: true },
    include: { user: { select: { id: true, email: true, timezone: true } } },
  })

  for (const schedule of schedules) {
    const { user } = schedule
    if (!user.email) continue

    // Check if the current time in the user's timezone matches their configured time.
    const now = new Date()
    const userTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: user.timezone || 'America/New_York',
    })

    // userTime = "07:00", schedule.timeOfDay = "07:00"
    if (userTime !== schedule.timeOfDay) continue

    // Don't send if we already sent today.
    if (schedule.lastSentAt) {
      const lastSent = new Date(schedule.lastSentAt)
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      if (lastSent >= todayStart) continue
    }

    // Send the brief.
    try {
      console.log(`[scheduler] Sending morning brief to ${user.email}`)
      await buildAndSendBrief(user.email)

      // Mark as sent today.
      await prisma.scheduledSms.update({
        where: { id: schedule.id },
        data: { lastSentAt: new Date() },
      })

      console.log(`[scheduler] Morning brief sent to ${user.email}`)
    } catch (err) {
      console.error(`[scheduler] Failed to send brief to ${user.email}:`, err)
    }
  }
}
