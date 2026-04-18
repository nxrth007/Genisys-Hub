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
import { buildAndSendBrief, buildAndSendSmsBrief } from './morning-brief'

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
  const schedules = await prisma.scheduledSms.findMany({
    where: { enabled: true },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          timezone: true,
          phoneNumber: true,
        },
      },
    },
  })

  for (const schedule of schedules) {
    const { user } = schedule
    if (!user.email) continue

    const now = new Date()
    // Per-schedule timezone overrides the owner's — critical when admin
    // and recipient live in different time zones (e.g. Alex in ET
    // scheduling Ethan's brief at 9 AM PT).
    const effectiveTz =
      schedule.timezone || user.timezone || 'America/New_York'
    const userTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: effectiveTz,
    })
    if (userTime !== schedule.timeOfDay) continue

    if (schedule.lastSentAt) {
      const lastSent = new Date(schedule.lastSentAt)
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      if (lastSent >= todayStart) continue
    }

    try {
      if (schedule.channel === 'ghl_sms') {
        const phone = schedule.recipientPhone || user.phoneNumber
        if (!phone) {
          console.warn(
            `[scheduler] Skipping GHL SMS brief for ${user.email}: no phone configured`
          )
          continue
        }
        // SMS greeting uses the recipient's name, not the schedule owner's.
        // Prefer the Notion assignee (it IS the recipient in the common case),
        // fall back to the owner's first name when the schedule has no assignee.
        const firstName =
          schedule.notionAssignee?.trim().split(/\s+/)[0] ||
          user.name?.trim().split(/\s+/)[0]
        console.log(
          `[scheduler] Sending GHL SMS brief to ${phone} (owner: ${user.email})`
        )
        await buildAndSendSmsBrief({
          phone,
          firstName,
          notionAssignee: schedule.notionAssignee,
        })
      } else {
        console.log(`[scheduler] Sending Slack brief to ${user.email}`)
        await buildAndSendBrief(user.email)
      }

      await prisma.scheduledSms.update({
        where: { id: schedule.id },
        data: { lastSentAt: new Date() },
      })
      console.log(`[scheduler] Brief sent for ${user.email}`)
    } catch (err) {
      console.error(
        `[scheduler] Failed to send brief for ${user.email}:`,
        err
      )
    }
  }
}
