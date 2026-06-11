/**
 * Slack alerts for customer replies to appointment-reminder SMS.
 *
 * The day-before reminder asks "Reply Y to confirm or N to
 * reschedule" (copy plan, 2026-06-11). Replies land in GHL and are
 * visible in CRM → Messages, but nobody gets pinged — so an "N"
 * sat unseen until the appointment no-showed. This job closes the
 * loop: every inbound reply on a reminder thread posts to Slack,
 * with negative replies framed as a call-to-action so the call
 * center can rebook the slot while it's still savable.
 *
 * Mechanics mirror client-message-alert.ts (the proven pattern):
 *   1. Build the watch set: conversations whose reminders sent
 *      within the last 14 days (bounded universe).
 *   2. One location-wide getConversations(limit 100) call — recent
 *      inbound activity surfaces conversations near the top, so we
 *      never poll every watched thread individually.
 *   3. For watched conversations in that page, fetch the single
 *      latest message; alert only when it's inbound and the
 *      (conversationId, messageId) pair isn't already in the
 *      ReminderReplyAlert ledger.
 *   4. First-run backfill guard: empty ledger = claim rows without
 *      posting, so deploying this doesn't blast Slack with alerts
 *      for replies that arrived weeks ago.
 *
 * Note the mirror-image relationship with client-message-alert:
 * that job EXCLUDES reminder conversations from its stream; this
 * one alerts ONLY on them. Between the two, every inbound GHL
 * message lands in exactly one alert stream.
 *
 * Channel: SLACK_REMINDER_REPLY_ALERTS_CHANNEL env var, defaulting
 * to the same #genisys-alerts the other alert streams use.
 */
import { prisma } from './prisma'
import { getConversations, getConversationMessages } from './ghl'
import { formatInTimezone } from './timezone'
import {
  postChannelMessage,
  resolveChannelIdByName,
  getMessagePermalink,
  formatSlackError,
} from './slack'

const DEFAULT_CHANNEL_NAME =
  process.env.SLACK_REMINDER_REPLY_ALERTS_CHANNEL || 'genisys-alerts'

/** Only watch conversations whose most recent reminder sent within
 *  this window. Replies to months-old threads are stale context —
 *  they still show in CRM → Messages, just don't page anyone. */
const WATCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

export type ReplyClassification = 'negative' | 'positive' | 'other'

type SyncResult = {
  /** Conversations in the watch set (recent reminder sends). */
  watched: number
  /** Watched conversations that appeared in the recent-100 page. */
  scanned: number
  /** Alerts posted to Slack this tick. */
  alerted: number
  /** Of those alerted, how many classified negative. */
  negative: number
  /** Already-alerted (conv, msgId) pairs skipped. */
  skipped: number
  /** Watched conversations whose latest message was our own send. */
  outbound: number
  /** GHL/Slack failures. */
  failed: number
}

export async function syncReminderReplyAlerts(): Promise<SyncResult> {
  const result: SyncResult = {
    watched: 0,
    scanned: 0,
    alerted: 0,
    negative: 0,
    skipped: 0,
    outbound: 0,
    failed: 0,
  }

  // Reminder sends go out through RemindersConfig.vaultEntryName's
  // GHL sub-account — conversations live there, so reads must use
  // the same token (NOT necessarily the client-message-alert one).
  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
    select: { vaultEntryName: true },
  })
  const vaultEntryName = config?.vaultEntryName ?? 'GHL Genisys Token'

  // Watch set: most recent reminder context per conversation. Rows
  // arrive newest-first so the first occurrence per conversation is
  // the freshest snapshot (current appt time after reschedules).
  const recentReminders = await prisma.appointmentReminder.findMany({
    where: {
      ghlConversationId: { not: null },
      sentAt: { gte: new Date(Date.now() - WATCH_WINDOW_MS) },
    },
    orderBy: { sentAt: 'desc' },
    select: {
      ghlConversationId: true,
      customerName: true,
      customerPhone: true,
      customerTimezone: true,
      clientName: true,
      apptDateTime: true,
    },
  })
  type Ctx = (typeof recentReminders)[number]
  const watch = new Map<string, Ctx>()
  for (const r of recentReminders) {
    if (!r.ghlConversationId) continue
    if (!watch.has(r.ghlConversationId)) watch.set(r.ghlConversationId, r)
  }
  result.watched = watch.size
  if (watch.size === 0) return result

  // First-run backfill guard — see module doc-comment.
  const ledgerCount = await prisma.reminderReplyAlert.count()
  const isBackfillRun = ledgerCount === 0

  let channelId: string | null = null
  try {
    channelId = await resolveChannelIdByName(DEFAULT_CHANNEL_NAME)
  } catch (err) {
    console.error(
      `[reminder-reply-alert] could not resolve #${DEFAULT_CHANNEL_NAME}:`,
      formatSlackError(err),
    )
    return result
  }
  if (!channelId) {
    console.warn(
      `[reminder-reply-alert] #${DEFAULT_CHANNEL_NAME} not found — invite the bot or set SLACK_REMINDER_REPLY_ALERTS_CHANNEL`,
    )
    return result
  }

  let raw: unknown
  try {
    raw = await getConversations(vaultEntryName, { limit: 100 })
  } catch (err) {
    console.error('[reminder-reply-alert] GHL fetch failed:', err)
    return result
  }
  const conversations =
    (raw as { conversations?: Record<string, unknown>[] }).conversations ?? []

  for (const c of conversations) {
    const id = typeof c.id === 'string' ? c.id : null
    if (!id) continue
    const ctx = watch.get(id)
    if (!ctx) continue

    result.scanned++

    let latestPage: unknown
    try {
      latestPage = await getConversationMessages(id, vaultEntryName, 1)
    } catch (err) {
      console.error(
        `[reminder-reply-alert] failed to fetch messages for ${id}:`,
        err,
      )
      result.failed++
      continue
    }
    const latest = pickLatestMessage(latestPage)
    if (!latest) continue

    const direction = String(latest.direction ?? '').toLowerCase()
    if (direction !== 'inbound') {
      // Our own reminder send (or a manual CRM reply) is the latest
      // activity — nothing to alert on. The customer's next inbound
      // bumps the conversation back into the recent page.
      result.outbound++
      continue
    }

    const messageId = typeof latest.id === 'string' ? latest.id : null
    const messageDate =
      typeof latest.dateAdded === 'string' ? new Date(latest.dateAdded) : null
    const body = typeof latest.body === 'string' ? latest.body.trim() : ''

    // Dedup pre-check (cheap index lookup), then claim. Same
    // findFirst-then-create-with-P2002-fallback shape as
    // client-message-alert — see the long comment there for why.
    const existing = await prisma.reminderReplyAlert.findFirst({
      where: { conversationId: id, messageId },
      select: { id: true },
    })
    if (existing) {
      result.skipped++
      continue
    }

    const classification = classifyReply(body)

    let claim
    try {
      claim = await prisma.reminderReplyAlert.create({
        data: {
          conversationId: id,
          messageId,
          messageBody: body.slice(0, 1000) || null,
          messageDate,
          classification,
          customerName: ctx.customerName,
          customerPhone: ctx.customerPhone,
          clientName: ctx.clientName,
          apptDateTime: ctx.apptDateTime,
          slackChannelId: channelId,
        },
      })
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err
          ? (err as { code?: string }).code
          : undefined
      if (code === 'P2002') {
        result.skipped++
        continue
      }
      console.error('[reminder-reply-alert] claim failed:', err)
      result.failed++
      continue
    }

    if (isBackfillRun) {
      result.skipped++
      continue
    }

    const text = buildAlertText(classification, body, ctx)
    try {
      const post = await postChannelMessage(channelId, text)
      if (!post.ok) {
        result.failed++
        continue
      }
      const permalink = await getMessagePermalink(channelId, post.ts)
      await prisma.reminderReplyAlert.update({
        where: { id: claim.id },
        data: { slackMessageTs: post.ts, permalink },
      })
      result.alerted++
      if (classification === 'negative') result.negative++
    } catch (err) {
      console.error('[reminder-reply-alert] Slack post failed:', err)
      result.failed++
      // Claim row stays — drop one alert rather than retry-spam.
    }
  }

  return result
}

/**
 * Advisory classification of a reply body. Every inbound reply
 * alerts regardless of bucket — this only picks the urgency framing
 * (a misread "other" still shows the full text to a human).
 *
 * Order matters: bare Y/N first (the exact ask in the day-before
 * copy), then strong negative phrases, then positive phrases, then
 * weak negatives LAST — so "no problem, see you then" matches "see
 * you" (positive) before its "no" can mark it negative.
 */
export function classifyReply(raw: string): ReplyClassification {
  const t = raw.trim().toLowerCase()
  if (!t) return 'other'
  if (/^n\W*$/.test(t)) return 'negative'
  if (/^y\W*$/.test(t)) return 'positive'
  if (
    /\b(cancel(?:l?ed|l?ing)?|resched(?:ule[ds]?|uling)?|can'?t|cannot|won'?t|unable|not (?:going|coming|able|interested)|no longer|wrong number|stop)\b/.test(
      t,
    )
  ) {
    return 'negative'
  }
  if (
    /\b(yes|yeah|yep|yup|confirm(?:ed)?|see you|sounds good|that works|i'?ll be (?:there|here)|ok(?:ay)?)\b/.test(
      t,
    )
  ) {
    return 'positive'
  }
  if (/\b(no|nope|nah)\b/.test(t)) return 'negative'
  return 'other'
}

function buildAlertText(
  classification: ReplyClassification,
  body: string,
  ctx: {
    customerName: string
    customerPhone: string
    customerTimezone: string
    clientName: string | null
    apptDateTime: Date
  },
): string {
  const apptStr = formatInTimezone(ctx.apptDateTime, ctx.customerTimezone, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const quoted = body.length > 200 ? `${body.slice(0, 200)}…` : body || '(empty message)'
  const contextLine = [
    `Appt: ${apptStr}`,
    ctx.clientName,
    ctx.customerPhone,
  ]
    .filter(Boolean)
    .join(' · ')

  if (classification === 'negative') {
    return [
      `:rotating_light: *${ctx.customerName}* replied *"${quoted}"* to their appointment reminder — *call them back to save the slot.*`,
      contextLine,
    ].join('\n')
  }
  if (classification === 'positive') {
    return [
      `:white_check_mark: *${ctx.customerName}* confirmed their appointment.`,
      contextLine,
    ].join('\n')
  }
  return [
    `:speech_balloon: *${ctx.customerName}* replied to a reminder: "${quoted}" — review + reply from CRM → Messages.`,
    contextLine,
  ].join('\n')
}

/** Same shape-tolerant latest-message picker client-message-alert
 *  uses — GHL nests `messages` inconsistently. */
function pickLatestMessage(payload: unknown): {
  id?: string
  body?: string
  direction?: string
  dateAdded?: string
} | null {
  const root = payload as { messages?: unknown }
  const nested = root?.messages as
    | { messages?: unknown[] }
    | unknown[]
    | undefined
  const arr: unknown[] = Array.isArray(nested)
    ? (nested as unknown[])
    : ((nested as { messages?: unknown[] } | undefined)?.messages ?? [])
  if (arr.length === 0) return null
  return arr[0] as {
    id?: string
    body?: string
    direction?: string
    dateAdded?: string
  }
}
