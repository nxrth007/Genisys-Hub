import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  getContact,
  getConversation,
  getConversationMessages,
  getConversations,
} from '@/lib/ghl'

/**
 * GET /api/crm/conversations/[subName]/[convId]
 *
 * Fetches a single conversation, but returns the contact's UNIFIED
 * message stream — every message across every conversation tied to
 * the same contactId, merged + sorted by dateAdded.
 *
 * Why: GHL stores SMS and Email as separate conversation containers
 * for the same contact. Joe Moder's SMS thread and his email thread
 * "Lead Genisys Follow Up" have distinct conversation IDs even
 * though they're with the same person. A conversation-id-scoped
 * fetch (the original implementation) showed only one container's
 * messages, leaving Alex with "I see this email in GHL but not in
 * the Hub." Aggregating by contactId matches the contact-centric
 * view GHL's native UI shows.
 *
 * `subName` is the URL-encoded vault entry name of the sub-account
 * that owns the conversation; `convId` is the entry-point conversation
 * (the one Alex clicked on). The response is the same shape as before
 * — `{ conversation, messages, contact }` — so the page UI doesn't
 * need to change.
 */
type GhlMessage = Record<string, unknown> & {
  id?: string
  dateAdded?: string
  conversationId?: string
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ subName: string; convId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { subName, convId } = await ctx.params
  const vaultName = decodeURIComponent(subName)

  try {
    const convData = await getConversation(convId, vaultName)
    const conversation = (convData.conversation || convData) as Record<
      string,
      unknown
    >
    const contactId = conversation.contactId as string | undefined

    // Without a contactId we can't aggregate — fall back to the
    // single-conversation path so the page still works.
    if (!contactId) {
      const msgData = await getConversationMessages(convId, vaultName)
      const messages = extractMessages(msgData)
      return NextResponse.json({ conversation, messages, contact: null })
    }

    // Gather every conversation tied to this contact (SMS / Email /
    // anything else GHL stores separately). Cap at 25 — way more than
    // any real contact will accumulate, and bounds the per-conversation
    // messages fanout below.
    let allConversationIds: string[] = [convId]
    type FoundConvo = {
      id: string
      lastMessageType: string | null
      lastMessageDate: string | null
      type: string | null
    }
    let foundConvos: FoundConvo[] = [
      {
        id: convId,
        lastMessageType:
          (conversation.lastMessageType as string | undefined) ?? null,
        lastMessageDate:
          (conversation.lastMessageDate as string | undefined) ?? null,
        type: (conversation.type as string | undefined) ?? null,
      },
    ]
    try {
      const otherConvos = (await getConversations(vaultName, {
        contactId,
        limit: 25,
      })) as {
        conversations?: Array<{
          id?: string
          lastMessageType?: string
          lastMessageDate?: string
          type?: string
        }>
      }
      const incoming = (otherConvos.conversations ?? []).filter(
        (c): c is { id: string } & Record<string, unknown> =>
          typeof c.id === 'string',
      )
      const seenIds = new Set<string>([convId])
      for (const c of incoming) {
        if (seenIds.has(c.id)) continue
        seenIds.add(c.id)
        foundConvos.push({
          id: c.id,
          lastMessageType:
            (c.lastMessageType as string | undefined) ?? null,
          lastMessageDate:
            (c.lastMessageDate as string | undefined) ?? null,
          type: (c.type as string | undefined) ?? null,
        })
      }
      allConversationIds = foundConvos.map((c) => c.id)
    } catch (err) {
      // contactId search failed — degrade to the single-conversation
      // path rather than blowing up the whole page.
      console.error(
        '[crm conversation detail] contactId search failed:',
        err,
      )
    }

    // Fetch messages for every conversation in parallel + the contact
    // record. Per-conversation 100 limit is GHL's per-page ceiling;
    // a single contact rarely has >100 messages in any one container,
    // and even if they do we get the most recent 100 per container.
    const [contactRes, ...messagePages] = await Promise.all([
      getContact(contactId, vaultName).catch(() => null),
      ...allConversationIds.map((id) =>
        getConversationMessages(id, vaultName, 100).catch((err) => {
          console.error(
            `[crm conversation detail] messages fetch failed for ${id}:`,
            err,
          )
          return null
        }),
      ),
    ])

    // Merge + dedup messages by id (defensive — if GHL ever returns
    // a message under multiple conversations during a re-id event,
    // we don't want it twice in the unified list). Sort oldest-first
    // so the page's existing reverse-render shows newest-first.
    const seen = new Set<string>()
    const merged: GhlMessage[] = []
    // Per-conversation diagnostics so we can debug "where did
    // message X go" without blind-guessing. Built alongside the
    // merge in the same pass.
    type PerConvoDiag = {
      id: string
      lastMessageType: string | null
      lastMessageDate: string | null
      messageCount: number
      messageTypes: Record<string, number>
      firstMessageDate: string | null
      lastMessageDateInPage: string | null
    }
    const perConvo: PerConvoDiag[] = []
    for (let i = 0; i < messagePages.length; i++) {
      const page = messagePages[i]
      const cid = allConversationIds[i] ?? '(unknown)'
      const meta =
        foundConvos.find((c) => c.id === cid) ??
        ({
          id: cid,
          lastMessageType: null,
          lastMessageDate: null,
          type: null,
        } as FoundConvo)
      const diag: PerConvoDiag = {
        id: cid,
        lastMessageType: meta.lastMessageType,
        lastMessageDate: meta.lastMessageDate,
        messageCount: 0,
        messageTypes: {},
        firstMessageDate: null,
        lastMessageDateInPage: null,
      }
      if (page) {
        const msgs = extractMessages(page)
        diag.messageCount = msgs.length
        for (const m of msgs) {
          const t =
            (typeof m.messageType === 'string' && m.messageType) ||
            (typeof m.type === 'string' && m.type) ||
            (typeof m.type === 'number' ? `numeric:${m.type}` : null) ||
            'unknown'
          diag.messageTypes[t] = (diag.messageTypes[t] ?? 0) + 1
          if (typeof m.dateAdded === 'string') {
            if (!diag.firstMessageDate || m.dateAdded < diag.firstMessageDate) {
              diag.firstMessageDate = m.dateAdded
            }
            if (
              !diag.lastMessageDateInPage ||
              m.dateAdded > diag.lastMessageDateInPage
            ) {
              diag.lastMessageDateInPage = m.dateAdded
            }
          }
          const id = m.id
          if (id) {
            if (seen.has(id)) continue
            seen.add(id)
          }
          merged.push(m)
        }
      }
      perConvo.push(diag)
    }
    merged.sort((a, b) => {
      const at = a.dateAdded ? new Date(a.dateAdded).getTime() : 0
      const bt = b.dateAdded ? new Date(b.dateAdded).getTime() : 0
      return at - bt
    })

    const contact =
      contactRes &&
      ((contactRes as { contact?: unknown }).contact ?? contactRes)

    return NextResponse.json({
      conversation,
      messages: merged,
      contact,
      /** Diagnostic for debugging "messages X is missing from the
       *  thread" cases. The thread page surfaces this as a
       *  collapsible footer so admin can see exactly which GHL
       *  conversation containers were found for the contact, what
       *  type each was, and how many messages got pulled per
       *  container. If only the entry-point convo shows up here,
       *  GHL's contactId search isn't returning the email/SMS
       *  sibling — different problem than the merger logic. */
      diagnostics: {
        mergedConversationCount: allConversationIds.length,
        totalMessages: merged.length,
        perConversation: perConvo,
      },
    })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch conversation'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Normalize the message-list shape — GHL has historically returned
 *  both `{ messages: [...] }` and `{ messages: { messages: [...] } }`
 *  depending on version. Accept either; default to []. */
function extractMessages(payload: unknown): GhlMessage[] {
  const root = payload as { messages?: unknown }
  const nested = root?.messages as
    | { messages?: unknown[] }
    | unknown[]
    | undefined
  if (Array.isArray(nested)) return nested as GhlMessage[]
  const inner = (nested as { messages?: unknown[] } | undefined)?.messages
  return (inner ?? []) as GhlMessage[]
}
