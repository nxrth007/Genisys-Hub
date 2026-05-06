import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getConversations } from '@/lib/ghl'

/**
 * GET /api/crm/client-conversations
 *
 * Powers the /crm/clients page. Pulls conversations from the agency's
 * Genisys GHL sub-account (the same one that sends SMS reminders, the
 * morning brief, and Client Alerts) and matches each one against the
 * registered Client records on (contactPhone, contactEmail, contactName).
 *
 * What it returns: conversations whose contact corresponds to one of
 * Alex's registered clients, sorted newest-message-first. Reminder
 * threads (customer SMS conversations) are intentionally excluded —
 * those live on /crm/messages and /crm's "Reminder line" filter.
 *
 * Query: ?limit=50 (raw GHL fetch ceiling — final list is whatever
 * subset matches).
 */
const VAULT_ENTRY_NAME = 'GHL Genisys Token'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const limit = Math.min(
    200,
    Math.max(1, Number(req.nextUrl.searchParams.get('limit') || '50')),
  )

  // Pull every active client + the reminder-conversation IDs in
  // parallel. The reminder set is what we'll exclude — so admin
  // doesn't see customer-reminder SMS threads in this view (those
  // are already first-class on /crm/messages).
  const [clients, reminderConvoIds] = await Promise.all([
    prisma.client.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        state: true,
        color: true,
        contactName: true,
        contactEmail: true,
        contactPhone: true,
      },
    }),
    collectReminderConversationIds(),
  ])

  // Build lookup maps so the per-conversation match check is O(1).
  // Phone is normalized to digit-only (strip + and country code) so
  // "+1 603-803-4828" / "(603) 803-4828" / "16038034828" all collide
  // on the same key.
  const byPhone = new Map<string, Client>()
  const byEmail = new Map<string, Client>()
  const byName = new Map<string, Client>()
  type Client = (typeof clients)[number]

  function digitsOnly(raw: string | null | undefined): string | null {
    if (!raw) return null
    const d = String(raw).replace(/\D/g, '')
    if (d.length < 10) return null
    // Drop a leading "1" so US country code matches both shapes.
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
    raw = await getConversations(VAULT_ENTRY_NAME, { limit })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch GHL conversations'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  const conversations =
    ((raw as { conversations?: Record<string, unknown>[] }).conversations ?? [])

  type Matched = {
    id: string
    contactId: string | null
    contactName: string | null
    contactPhone: string | null
    contactEmail: string | null
    lastMessageBody: string | null
    lastMessageDate: string | null
    lastMessageType: string | null
    unreadCount: number
    /** Which registered client this conversation matched. */
    client: {
      id: string
      name: string
      state: string | null
      color: string
    }
    /** Why we matched — useful when admin wonders "why is this
     *  thread tagged as Brokers Unlimited?" */
    matchedOn: 'phone' | 'email' | 'name'
  }

  const matched: Matched[] = []
  for (const c of conversations) {
    const id = typeof c.id === 'string' ? c.id : null
    if (!id) continue
    // Skip reminder-system threads — they belong on /crm/messages.
    if (reminderConvoIds.has(id)) continue

    // GHL's conversation list includes both `phone` (raw) and
    // sometimes a structured `contact` field. Normalize defensively.
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

    let hit: Client | null = null
    let matchedOn: Matched['matchedOn'] | null = null

    const pDigits = digitsOnly(rawPhone)
    if (pDigits && byPhone.has(pDigits)) {
      hit = byPhone.get(pDigits)!
      matchedOn = 'phone'
    }
    if (!hit && rawEmail) {
      const e = rawEmail.trim().toLowerCase()
      if (byEmail.has(e)) {
        hit = byEmail.get(e)!
        matchedOn = 'email'
      }
    }
    if (!hit && rawName) {
      const n = rawName.trim().toLowerCase()
      if (byName.has(n)) {
        hit = byName.get(n)!
        matchedOn = 'name'
      }
    }
    if (!hit || !matchedOn) continue

    matched.push({
      id,
      contactId: typeof c.contactId === 'string' ? c.contactId : null,
      contactName: rawName,
      contactPhone: rawPhone,
      contactEmail: rawEmail,
      lastMessageBody:
        typeof c.lastMessageBody === 'string' ? c.lastMessageBody : null,
      lastMessageDate:
        typeof c.lastMessageDate === 'string' ? c.lastMessageDate : null,
      lastMessageType:
        typeof c.lastMessageType === 'string' ? c.lastMessageType : null,
      unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
      client: {
        id: hit.id,
        name: hit.name,
        state: hit.state,
        color: hit.color,
      },
      matchedOn,
    })
  }

  // Newest-first by lastMessageDate. Conversations without a
  // lastMessageDate sort to the bottom (rare — GHL stamps every
  // thread the moment it's created).
  matched.sort((a, b) => {
    const aT = a.lastMessageDate ? new Date(a.lastMessageDate).getTime() : 0
    const bT = b.lastMessageDate ? new Date(b.lastMessageDate).getTime() : 0
    return bT - aT
  })

  return NextResponse.json({
    conversations: matched,
    /** Diagnostic counts so admin can sanity-check the filter is
     *  working (e.g. "200 fetched, 12 matched a registered client,
     *  rest were probably leads or unrelated threads"). */
    diagnostics: {
      ghlFetched: conversations.length,
      remindersExcluded: conversations.filter((c) =>
        typeof c.id === 'string' ? reminderConvoIds.has(c.id) : false,
      ).length,
      matched: matched.length,
      registeredClients: clients.length,
    },
  })
}

/** Same helper /api/crm/conversations uses — IDs the reminder
 *  system has ever sent through, so we exclude those threads here. */
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
