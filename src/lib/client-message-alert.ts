/**
 * Slack notifications for inbound client messages on the Genisys GHL
 * sub-account.
 *
 * Detects new inbound messages from registered clients (matched by
 * phone / email / name on the active Client list) and posts a one-
 * line alert to the configured Slack channel — same workspace + bot
 * the appointment-delivery system uses.
 *
 * Format Alex asked for:
 *   "Client Name | Business Name sent you a message on GHL"
 *
 * Dedup ledger: ClientMessageAlert table stores one row per
 * (conversationId, lastMessageId) we've alerted on. Same
 * conversation, same lastMessageId on the next tick = already alerted,
 * skip. Reminder-system conversations are excluded — those belong on
 * /crm/messages, not this admin-side alert stream.
 *
 * Channel: configurable via env var SLACK_CLIENT_MESSAGE_ALERTS_CHANNEL
 * (defaults to "genisys-alerts" — the channel Alex pre-created and
 * invited the bot to). Resolved name → id once and cached in lib/slack.
 */
import { prisma } from './prisma'
import { getConversations, getConversationMessages } from './ghl'
import {
  postChannelMessage,
  resolveChannelIdByName,
  getMessagePermalink,
  formatSlackError,
} from './slack'

const VAULT_ENTRY_NAME = 'GHL Genisys Token'
const DEFAULT_CHANNEL_NAME =
  process.env.SLACK_CLIENT_MESSAGE_ALERTS_CHANNEL || 'genisys-alerts'

type SyncResult = {
  /** Conversations scanned this tick. */
  scanned: number
  /** New alerts actually posted to Slack. */
  alerted: number
  /** Already-alerted conversations skipped via the unique constraint. */
  skipped: number
  /** Conversations that didn't match a registered client. */
  unmatched: number
  /** Conversations whose latest message was outbound (we don't alert
   *  on our own replies). */
  outbound: number
  /** Slack post failures (channel resolution / API errors). */
  failed: number
}

export async function syncClientMessageAlerts(): Promise<SyncResult> {
  const result: SyncResult = {
    scanned: 0,
    alerted: 0,
    skipped: 0,
    unmatched: 0,
    outbound: 0,
    failed: 0,
  }

  // Load active clients + lookup maps so per-conversation matching
  // is O(1). Mirrors /api/crm/client-conversations exactly so the
  // alert stream and the admin UI agree on what counts as a "client
  // conversation".
  const [clients, reminderConvoIds] = await Promise.all([
    prisma.client.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        contactName: true,
        contactEmail: true,
        contactPhone: true,
      },
    }),
    collectReminderConversationIds(),
  ])

  type ClientRow = (typeof clients)[number]
  const byPhone = new Map<string, ClientRow>()
  const byEmail = new Map<string, ClientRow>()
  const byName = new Map<string, ClientRow>()

  function digitsOnly(raw: string | null | undefined): string | null {
    if (!raw) return null
    const d = String(raw).replace(/\D/g, '')
    if (d.length < 10) return null
    return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  }

  for (const c of clients) {
    const p = digitsOnly(c.contactPhone)
    if (p) byPhone.set(p, c)
    const e = c.contactEmail?.trim().toLowerCase()
    if (e) byEmail.set(e, c)
    const n = c.contactName?.trim().toLowerCase()
    if (n) byName.set(n, c)
  }

  // First-run backfill guard. If the ledger is empty, this is the
  // first deploy of the alert system — every current inbound from a
  // registered client would otherwise look "new" and trip a Slack
  // alert. Mark them as already-alerted (insert ledger rows without
  // posting) so the next real inbound is the first one Alex hears
  // about. Same posture as the SMS-alert backfill on master enable.
  const ledgerCount = await prisma.clientMessageAlert.count()
  const isBackfillRun = ledgerCount === 0

  // Pull recent location-wide conversations (default limit 100, the
  // GHL ceiling). New inbound messages within the last few minutes
  // will be in there.
  let raw: unknown
  try {
    raw = await getConversations(VAULT_ENTRY_NAME, { limit: 100 })
  } catch (err) {
    console.error('[client-message-alert] GHL fetch failed:', err)
    return result
  }
  const conversations =
    ((raw as { conversations?: Record<string, unknown>[] }).conversations ?? [])

  // Resolve the Slack channel ID once per tick. If the name can't be
  // resolved (bot not in channel, channel renamed, typo in env), bail
  // — there's no point checking each conversation if we can't post.
  let channelId: string | null = null
  try {
    channelId = await resolveChannelIdByName(DEFAULT_CHANNEL_NAME)
  } catch (err) {
    console.error(
      `[client-message-alert] could not resolve #${DEFAULT_CHANNEL_NAME}:`,
      formatSlackError(err),
    )
    return result
  }
  if (!channelId) {
    console.warn(
      `[client-message-alert] #${DEFAULT_CHANNEL_NAME} not found — invite the bot or update SLACK_CLIENT_MESSAGE_ALERTS_CHANNEL`,
    )
    return result
  }

  for (const c of conversations) {
    const id = typeof c.id === 'string' ? c.id : null
    if (!id) continue
    if (reminderConvoIds.has(id)) continue

    result.scanned++

    // Match against the active-client list (same shape as
    // /api/crm/client-conversations).
    const rawPhone =
      (typeof c.phone === 'string' && c.phone) ||
      (typeof c.contactPhone === 'string' && c.contactPhone) ||
      null
    const rawEmail =
      (typeof c.email === 'string' && c.email) ||
      (typeof c.contactEmail === 'string' && c.contactEmail) ||
      null
    const rawName =
      (typeof c.fullName === 'string' && c.fullName) ||
      (typeof c.contactName === 'string' && c.contactName) ||
      null

    let hit: ClientRow | null = null
    const phoneKey = digitsOnly(rawPhone)
    if (phoneKey && byPhone.has(phoneKey)) hit = byPhone.get(phoneKey)!
    if (!hit && rawEmail) {
      const e = rawEmail.trim().toLowerCase()
      if (byEmail.has(e)) hit = byEmail.get(e)!
    }
    if (!hit && rawName) {
      const n = rawName.trim().toLowerCase()
      if (byName.has(n)) hit = byName.get(n)!
    }
    if (!hit) {
      result.unmatched++
      continue
    }

    // Pull the latest message for this conversation. We need the
    // direction (inbound vs outbound) and message id — neither is
    // reliably on the conversation summary. Tight limit (1) keeps
    // the cost down.
    let latestPage: unknown
    try {
      latestPage = await getConversationMessages(id, VAULT_ENTRY_NAME, 1)
    } catch (err) {
      console.error(
        `[client-message-alert] failed to fetch messages for ${id}:`,
        err,
      )
      result.failed++
      continue
    }
    const latest = pickLatestMessage(latestPage)
    if (!latest) continue

    const direction = String(latest.direction ?? '').toLowerCase()
    if (direction !== 'inbound') {
      // Latest message was an outbound reply — don't alert on our own
      // sends. The next inbound from the client will trip the alert.
      result.outbound++
      continue
    }

    const messageId = typeof latest.id === 'string' ? latest.id : null
    const messageDate = typeof latest.dateAdded === 'string'
      ? new Date(latest.dateAdded)
      : null

    // Dedup against the ledger. The common case on every tick is
    // "already alerted" — most active conversations sit there with the
    // same lastMessageId between inbound bursts, so we'd otherwise
    // re-attempt the same insert every minute. Two failure modes if
    // we just speculatively create-and-catch-P2002:
    //   - Prisma logs "prisma:error … Unique constraint failed" BEFORE
    //     our catch runs, so the Render logs fill with noise even
    //     though app behavior is correct.
    //   - Wasted INSERT round-trip every tick per active client convo.
    //
    // Cheap pre-check via findFirst on the (conversationId, lastMessageId)
    // unique pair (Postgres uses the unique index for the lookup). If
    // it exists, skip silently. Only attempt the INSERT for genuinely
    // new (conv, msgId) pairs.
    //
    // We keep the create's try/catch P2002 as a defensive race-condition
    // fallback — two concurrent ticks could both see null on findFirst
    // and both try to create. Single-instance Render makes this rare,
    // but it's free to leave the safety net in place.
    //
    // Post-claim flow (unchanged):
    //   1. Pre-claim the (conv, msgId) row (status="pending")
    //   2. Post to Slack
    //   3. Update the row with ts/permalink (status="delivered")
    // If step 2 fails, the placeholder row prevents retries on the
    // next tick — the message stays unalerted but stable. Acceptable
    // tradeoff: drop one alert rather than spam Slack on transient
    // outage. Admin can manually post in #genisys-alerts if needed.

    const existingClaim = await prisma.clientMessageAlert.findFirst({
      where: { conversationId: id, lastMessageId: messageId },
      select: { id: true },
    })
    if (existingClaim) {
      // Already alerted on this exact (conv, msgId). Common path.
      result.skipped++
      continue
    }

    let claim
    try {
      claim = await prisma.clientMessageAlert.create({
        data: {
          conversationId: id,
          clientId: hit.id,
          lastMessageId: messageId,
          lastMessageDate: messageDate,
          slackChannelId: channelId,
        },
      })
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err
          ? (err as { code?: string }).code
          : undefined
      if (code === 'P2002') {
        // Race: a concurrent tick claimed the same (conv, msgId)
        // between our findFirst and create. Treat as skip.
        result.skipped++
        continue
      }
      console.error('[client-message-alert] claim failed:', err)
      result.failed++
      continue
    }

    // First-run backfill: claim row already inserted above, but skip
    // the Slack post so historical messages don't blast the channel.
    // Subsequent ticks only see NEW (conv, msgId) pairs and post
    // normally.
    if (isBackfillRun) {
      result.skipped++
      continue
    }

    // Build the alert text. Spec: "Client Name | Business Name sent
    // you a message on GHL". `Client Name` here is the human contact
    // (Joe Moder), `Business Name` is the Client.name (Brokers
    // Unlimited).
    const contact = hit.contactName?.trim() || hit.name
    const business = hit.name
    const text = `*${contact}* | *${business}* sent you a message on GHL`

    try {
      const post = await postChannelMessage(channelId, text)
      if (!post.ok) {
        result.failed++
        continue
      }
      // Best-effort permalink fetch — useful so the ledger can later
      // surface "see Slack thread" links if we build that UI.
      const permalink = await getMessagePermalink(channelId, post.ts)
      await prisma.clientMessageAlert.update({
        where: { id: claim.id },
        data: {
          slackMessageTs: post.ts,
          permalink,
        },
      })
      result.alerted++
    } catch (err) {
      console.error('[client-message-alert] Slack post failed:', err)
      result.failed++
      // Leave the placeholder row in place — see comment above. Don't
      // delete it; we'd rather drop the alert than spam.
    }
  }

  return result
}

/** Pull the single most-recent message out of GHL's
 *  /conversations/{id}/messages response. Same shape-tolerance as
 *  the rest of the codebase. */
function pickLatestMessage(
  payload: unknown,
): { id?: string; direction?: string; dateAdded?: string } | null {
  const root = payload as { messages?: unknown }
  const nested = root?.messages as
    | { messages?: unknown[] }
    | unknown[]
    | undefined
  const arr: unknown[] = Array.isArray(nested)
    ? (nested as unknown[])
    : ((nested as { messages?: unknown[] } | undefined)?.messages ?? [])
  if (arr.length === 0) return null
  // GHL returns messages newest-first by default. Take the head.
  return arr[0] as { id?: string; direction?: string; dateAdded?: string }
}

/** Same helper /api/crm/client-conversations and
 *  /api/crm/conversations use — the set of GHL conversation IDs the
 *  reminder system has ever sent through. We exclude those from the
 *  alert stream so admin doesn't get pinged for every outbound
 *  customer reminder. */
async function collectReminderConversationIds(): Promise<Set<string>> {
  const rows = await prisma.appointmentReminder.findMany({
    where: { ghlConversationId: { not: null } },
    select: { ghlConversationId: true },
  })
  const out = new Set<string>()
  for (const r of rows) {
    if (r.ghlConversationId) out.add(r.ghlConversationId)
  }
  return out
}
