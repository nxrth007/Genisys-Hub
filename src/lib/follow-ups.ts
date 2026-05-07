/**
 * Follow-up candidate unifier.
 *
 * Pulls "threads worth following up on" from three sources, scores
 * each, and buckets them by urgency:
 *   1. Gmail (synced into the Email table for both connected accounts —
 *      alex@leadgenisys.com and ethan@leadgenisys.com — both folders)
 *   2. GHL conversations on the Genisys sub-account (location-wide,
 *      filtered to ones that match a registered Client by phone /
 *      email / name — same matching logic the #genisys-alerts Slack
 *      feature and /api/crm/client-conversations use)
 *   3. (deferred to v2: existing Callback rows; for now those
 *      continue to surface in the Today follow-up widget separately)
 *
 * Bucketing rules (each thread lands in exactly one bucket, in
 * priority order):
 *   - "awaiting" — latest message is INBOUND (they sent us something
 *                  we haven't replied to). Only surfaced once it's
 *                  ≥ 2 hours old so Ethan isn't pestered about a
 *                  minute-ago email he's still reading.
 *   - "suggest"  — latest message is OUTBOUND from us, ≥ 3 days
 *                  old, no reply. We nudged, they went quiet.
 *   - "stale"    — no activity ≥ 14 days, ≤ 60 days. Worth re-
 *                  engaging before the lead goes cold.
 *
 * Past 60 days = dropped entirely. An inbox full of 5,000 stale
 * threads from 2024 isn't useful and would drown out actionable
 * rows. Per-user dismissals (FollowUpDismissal) also drop here.
 *
 * Data freshness: this reads from the Email table as-synced. There
 * isn't a Gmail cron yet — admin runs `/api/gmail/sync` on demand.
 * The /follow-ups page exposes a "Refresh" button that triggers a
 * sync before recomputing. Worth wiring a cron later.
 */
import { prisma } from './prisma'
import { getConversations, getConversationMessages } from './ghl'

const VAULT_ENTRY_NAME = 'GHL Genisys Token'
const STAFF_DOMAIN_RE = /@(leadgenisys\.com|trustware\.io)$/i
const NOREPLY_RE = /noreply|no-reply|notifications?@|donotreply/i

// Bucket thresholds — keep as constants so they're easy to tune.
const AWAITING_MIN_AGE_MS = 2 * 60 * 60 * 1000 // 2h
const SUGGEST_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000 // 3d
const STALE_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14d
const HORIZON_MS = 60 * 24 * 60 * 60 * 1000 // 60d (drop anything older)

// Email lookback — pull last 60 days when computing buckets so the
// "stale" cutoff at 60d is reachable. Anything older isn't useful.
const EMAIL_LOOKBACK_MS = HORIZON_MS

export type FollowUpBucket = 'awaiting' | 'suggest' | 'stale'

export type FollowUpCandidate = {
  /** Source-prefixed thread id, used for dismissal + dedup. */
  threadKey: string
  /** "gmail" | "ghl" — drives which action to expose (inline reply
   *  for gmail, click-through for ghl). */
  source: 'gmail' | 'ghl'
  /** Gmail account email (for gmail-source rows) so the reply
   *  endpoint knows which mailbox to send from. */
  accountEmail?: string
  /** Display label for the contact (best-available human name). */
  contactName: string
  /** Email for gmail rows, contact phone or email for ghl rows. */
  contactHandle: string
  /** Last subject line (gmail) or "" (ghl). */
  subject: string
  /** ≤ 200-char preview of the latest message body. */
  preview: string
  /** Direction of the LATEST message in the thread. */
  latestDirection: 'inbound' | 'outbound'
  /** Latest message timestamp (ISO). */
  latestAt: string
  /** Days since latest message (rounded). Sort key for buckets. */
  daysSinceLatest: number
  /** Number of messages in the thread (1 = single email, no back-
   *  and-forth yet). Surfaced so admin can spot cold-emails. */
  messageCount: number
  /** Bucket this candidate belongs to. */
  bucket: FollowUpBucket
  /** GHL extras — set when source='ghl'. The page uses these to
   *  build the click-through URL. */
  ghl?: {
    conversationId: string
    subAccountVaultName: string
  }
  /** Gmail extras — set when source='gmail'. The reply endpoint
   *  threads against gmailThreadId + uses gmailMessageId for the
   *  In-Reply-To header. */
  gmail?: {
    gmailThreadId: string
    /** message id of the latest message — passed as inReplyTo on send. */
    inReplyToMessageId: string
    /** Linked Client name if the email matches a registered client's
     *  contactEmail. Helps surface "this prospect is already in our
     *  client roster" context. */
    matchedClientName?: string | null
  }
}

export type FollowUpResults = {
  awaiting: FollowUpCandidate[]
  suggest: FollowUpCandidate[]
  stale: FollowUpCandidate[]
  /** Aggregate counts so the page header doesn't have to .length. */
  counts: { awaiting: number; suggest: number; stale: number; total: number }
  /** When this snapshot was computed. */
  computedAt: string
  /** Last Gmail sync per account. Lets the UI surface "last synced
   *  X minutes ago" so Ethan knows whether to refresh. */
  lastSyncByAccount: Record<string, string>
}

/** Compute the full follow-up landscape for a user. The dismissal
 *  filter is per-user; the underlying email + GHL data is shared. */
export async function computeFollowUps(
  userId: string,
): Promise<FollowUpResults> {
  const now = Date.now()

  // -- Gmail side ----------------------------------------------------------
  const accounts = await prisma.gmailAccount.findMany({
    select: { id: true, email: true, updatedAt: true },
  })
  const accountIds = accounts.map((a) => a.id)
  const accountEmailLookup = new Map(accounts.map((a) => [a.id, a.email]))
  const ourEmails = new Set(accounts.map((a) => a.email.toLowerCase()))

  const lastSyncByAccount: Record<string, string> = {}
  for (const a of accounts) lastSyncByAccount[a.email] = a.updatedAt.toISOString()

  // Pull the lookback window once. We don't strictly need bodyHtml
  // here — `snippet` covers the preview. Bytes saved.
  const emails =
    accountIds.length > 0
      ? await prisma.email.findMany({
          where: {
            accountId: { in: accountIds },
            date: { gte: new Date(now - EMAIL_LOOKBACK_MS) },
          },
          orderBy: { date: 'desc' },
          select: {
            id: true,
            gmailMessageId: true,
            threadId: true,
            accountId: true,
            from: true,
            fromName: true,
            to: true,
            subject: true,
            snippet: true,
            date: true,
            folder: true,
          },
        })
      : []

  // Group by Gmail threadId. Each group becomes a single candidate.
  type EmailRow = (typeof emails)[number]
  const byThread = new Map<string, EmailRow[]>()
  for (const e of emails) {
    if (!e.threadId) continue
    const list = byThread.get(e.threadId) ?? []
    list.push(e)
    byThread.set(e.threadId, list)
  }

  // Pre-load every registered client's contactEmail so we can label
  // "this thread matches Brokers Unlimited" on the card.
  const clients = await prisma.client.findMany({
    where: { active: true, contactEmail: { not: null } },
    select: { id: true, name: true, contactEmail: true },
  })
  const clientByEmail = new Map<string, string>()
  for (const c of clients) {
    const e = c.contactEmail?.trim().toLowerCase()
    if (e) clientByEmail.set(e, c.name)
  }

  const gmailCandidates: FollowUpCandidate[] = []
  for (const [threadId, msgs] of byThread.entries()) {
    // Sort newest first.
    msgs.sort((a, b) => b.date.getTime() - a.date.getTime())
    const latest = msgs[0]
    if (!latest) continue

    const accountEmail = accountEmailLookup.get(latest.accountId)
    if (!accountEmail) continue

    // Identify the "other party" — the participant that ISN'T one of
    // our connected accounts. We use the from-side of the LATEST
    // inbound message when present (that's the most accurate human
    // name), else the to-side of an outbound.
    const otherEmail = inferOtherParty(msgs, ourEmails)
    if (!otherEmail) continue
    if (STAFF_DOMAIN_RE.test(otherEmail)) continue // internal noise
    if (NOREPLY_RE.test(otherEmail)) continue // newsletters / no-reply

    // Find latest in each direction. "from in ourEmails" = outbound,
    // else inbound.
    let lastInbound: EmailRow | null = null
    let lastOutbound: EmailRow | null = null
    for (const m of msgs) {
      const isOutbound = ourEmails.has(m.from.toLowerCase())
      if (isOutbound) {
        if (!lastOutbound || m.date > lastOutbound.date) lastOutbound = m
      } else {
        if (!lastInbound || m.date > lastInbound.date) lastInbound = m
      }
    }

    const latestDirection: 'inbound' | 'outbound' = ourEmails.has(
      latest.from.toLowerCase(),
    )
      ? 'outbound'
      : 'inbound'
    const latestAt = latest.date
    const ageMs = now - latestAt.getTime()
    if (ageMs > HORIZON_MS) continue // older than 60d, drop

    const bucket = pickBucket({
      latestDirection,
      ageMs,
      lastInbound: lastInbound?.date ?? null,
      lastOutbound: lastOutbound?.date ?? null,
    })
    if (!bucket) continue

    const matchedClientName = clientByEmail.get(otherEmail.toLowerCase()) ?? null
    const inboundLatestForName = msgs.find(
      (m) => !ourEmails.has(m.from.toLowerCase()),
    )
    const contactName =
      inboundLatestForName?.fromName?.trim() ||
      latest.fromName?.trim() ||
      otherEmail

    gmailCandidates.push({
      threadKey: `gmail:${threadId}`,
      source: 'gmail',
      accountEmail,
      contactName,
      contactHandle: otherEmail,
      subject: latest.subject || '(no subject)',
      preview: (latest.snippet || '').slice(0, 200),
      latestDirection,
      latestAt: latestAt.toISOString(),
      daysSinceLatest: Math.round(ageMs / (24 * 60 * 60 * 1000)),
      messageCount: msgs.length,
      bucket,
      gmail: {
        gmailThreadId: threadId,
        inReplyToMessageId: latest.gmailMessageId,
        matchedClientName,
      },
    })
  }

  // -- GHL side ------------------------------------------------------------
  // Pull location-wide convs, match to active clients, fetch latest
  // message per match for direction + dates. Reuses the same matcher
  // /api/crm/client-conversations + client-message-alert apply.
  const ghlCandidates = await collectGhlFollowUps(now)

  // -- Filter dismissed ----------------------------------------------------
  const dismissals = await prisma.followUpDismissal.findMany({
    where: { userId },
    select: { threadKey: true },
  })
  const dismissed = new Set(dismissals.map((d) => d.threadKey))

  const all = [...gmailCandidates, ...ghlCandidates].filter(
    (c) => !dismissed.has(c.threadKey),
  )

  const awaiting = all
    .filter((c) => c.bucket === 'awaiting')
    .sort((a, b) => b.daysSinceLatest - a.daysSinceLatest) // oldest waiting first
  const suggest = all
    .filter((c) => c.bucket === 'suggest')
    .sort((a, b) => b.daysSinceLatest - a.daysSinceLatest)
  const stale = all
    .filter((c) => c.bucket === 'stale')
    .sort((a, b) => a.daysSinceLatest - b.daysSinceLatest) // freshest stale first

  return {
    awaiting,
    suggest,
    stale,
    counts: {
      awaiting: awaiting.length,
      suggest: suggest.length,
      stale: stale.length,
      total: awaiting.length + suggest.length + stale.length,
    },
    computedAt: new Date(now).toISOString(),
    lastSyncByAccount,
  }
}

/** Drop a thread for the calling user. Idempotent — re-dismissing
 *  is a no-op. */
export async function dismissFollowUp(params: {
  userId: string
  threadKey: string
  contactLabel?: string | null
}) {
  await prisma.followUpDismissal.upsert({
    where: {
      userId_threadKey: {
        userId: params.userId,
        threadKey: params.threadKey,
      },
    },
    create: {
      userId: params.userId,
      threadKey: params.threadKey,
      contactLabel: params.contactLabel ?? null,
    },
    update: {
      contactLabel: params.contactLabel ?? null,
    },
  })
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                  */
/* -------------------------------------------------------------------------- */

type BucketInput = {
  latestDirection: 'inbound' | 'outbound'
  ageMs: number
  lastInbound: Date | null
  lastOutbound: Date | null
}

/** Decide which bucket a thread falls into. Returns null when no
 *  bucket applies (healthy thread / too fresh / etc.). */
function pickBucket(p: BucketInput): FollowUpBucket | null {
  // Stale takes priority — if no activity in 14d, it's stale
  // regardless of who sent the last message.
  if (p.ageMs >= STALE_MIN_AGE_MS) return 'stale'

  if (p.latestDirection === 'inbound') {
    return p.ageMs >= AWAITING_MIN_AGE_MS ? 'awaiting' : null
  }
  // Outbound latest. "Suggest" only if we never heard back AND it's
  // been at least 3 days. If lastInbound is also recent, this
  // conversation is healthy — don't surface.
  if (p.ageMs < SUGGEST_MIN_AGE_MS) return null
  return 'suggest'
}

/** Determine the "other party" email for a Gmail thread. We look at
 *  inbound messages first (from-address gives us the cleanest human
 *  identity); fall back to the to-address of an outbound. */
function inferOtherParty(
  msgs: Array<{ from: string; to: string }>,
  ourEmails: Set<string>,
): string | null {
  for (const m of msgs) {
    if (!ourEmails.has(m.from.toLowerCase())) {
      return m.from.toLowerCase()
    }
  }
  // No inbound — pick the to-address of the most recent outbound.
  for (const m of msgs) {
    const to = (m.to || '').toLowerCase()
    if (to && !ourEmails.has(to)) {
      // The to field can be a comma-separated list; take the first.
      const first = to.split(',')[0]?.trim() ?? ''
      return first || null
    }
  }
  return null
}

/** Pull GHL conversations on the Genisys sub-account, match to
 *  registered clients, fetch the latest message for direction, and
 *  bucket. Mirrors the matcher used by /api/crm/client-conversations
 *  and the Slack-alert sync. */
async function collectGhlFollowUps(
  now: number,
): Promise<FollowUpCandidate[]> {
  const out: FollowUpCandidate[] = []

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

  let raw: unknown
  try {
    raw = await getConversations(VAULT_ENTRY_NAME, { limit: 100 })
  } catch (err) {
    console.error('[follow-ups] GHL fetch failed:', err)
    return out
  }
  const conversations =
    ((raw as { conversations?: Record<string, unknown>[] }).conversations ?? [])

  for (const c of conversations) {
    const id = typeof c.id === 'string' ? c.id : null
    if (!id) continue
    if (reminderConvoIds.has(id)) continue

    // Match to a Client (same priorities as the rest of the codebase).
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
    if (!hit) continue

    // Use the conversation summary's lastMessageDate to decide
    // whether to even bother fetching messages. Cuts the API calls
    // down from ~30 to ~10 in typical usage.
    const lastDateRaw =
      typeof c.lastMessageDate === 'string' ? c.lastMessageDate : null
    if (!lastDateRaw) continue
    const lastDate = new Date(lastDateRaw)
    if (isNaN(lastDate.getTime())) continue
    const ageMs = now - lastDate.getTime()
    if (ageMs > HORIZON_MS) continue

    // Fetch latest 1 message for direction. (The summary doesn't
    // include direction reliably across GHL versions.)
    let latestPage: unknown
    try {
      latestPage = await getConversationMessages(id, VAULT_ENTRY_NAME, 1)
    } catch (err) {
      console.error(
        `[follow-ups] failed to fetch GHL messages for ${id}:`,
        err,
      )
      continue
    }
    const latest = pickLatestMessage(latestPage)
    if (!latest) continue

    const latestDirection: 'inbound' | 'outbound' =
      String(latest.direction ?? '').toLowerCase() === 'inbound'
        ? 'inbound'
        : 'outbound'

    const bucket = pickBucket({
      latestDirection,
      ageMs,
      lastInbound: null,
      lastOutbound: null,
    })
    if (!bucket) continue

    const contactName = (rawName?.trim() || hit.contactName?.trim() || hit.name)
    const handle = rawEmail || rawPhone || ''

    out.push({
      threadKey: `ghl:${id}`,
      source: 'ghl',
      contactName: `${contactName} · ${hit.name}`,
      contactHandle: handle,
      subject: '',
      preview:
        typeof c.lastMessageBody === 'string'
          ? c.lastMessageBody.slice(0, 200)
          : '',
      latestDirection,
      latestAt: lastDate.toISOString(),
      daysSinceLatest: Math.round(ageMs / (24 * 60 * 60 * 1000)),
      messageCount: 0, // we don't fetch the full thread for ghl rows
      bucket,
      ghl: {
        conversationId: id,
        subAccountVaultName: VAULT_ENTRY_NAME,
      },
    })
  }

  return out
}

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
  return arr[0] as { id?: string; direction?: string; dateAdded?: string }
}

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
