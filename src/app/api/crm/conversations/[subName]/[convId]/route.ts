import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  getContact,
  getConversation,
  getConversationMessages,
  getConversations,
  getEmailMessage,
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

    // Pull the contact so we know phone + email to match against.
    // Used as keys when scanning location-wide conversations below
    // so sibling threads (different GHL contact records that
    // happen to share phone or email) are still collected.
    let entryContact: Record<string, unknown> | null = null
    try {
      const cData = await getContact(contactId, vaultName)
      entryContact =
        (cData as { contact?: Record<string, unknown> }).contact ??
        (cData as Record<string, unknown>)
    } catch (err) {
      console.error('[crm conversation detail] contact lookup failed:', err)
    }

    function digitsOnly(raw: string | null | undefined): string | null {
      if (!raw) return null
      const d = String(raw).replace(/\D/g, '')
      if (d.length < 10) return null
      return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
    }
    const entryPhoneDigits = digitsOnly(
      (entryContact?.phone as string | undefined) ?? null,
    )
    const entryEmail = (
      (entryContact?.email as string | undefined) ?? ''
    )
      .trim()
      .toLowerCase()
    // Build a contact-name key too — GHL sometimes splits contact
    // records across mediums (SMS contact has phone X with no email,
    // email contact has email Y with no phone, both records named
    // "Joe Moder"). If contactId / phone / email don't all collide,
    // matching on the normalized name catches the split sibling.
    function normalizeName(raw: string | null | undefined): string | null {
      if (!raw) return null
      const trimmed = String(raw).trim().toLowerCase()
      if (trimmed.length < 3) return null
      return trimmed
    }
    const entryContactName = normalizeName(
      ((entryContact?.firstName as string | undefined) ?? '') +
        ' ' +
        ((entryContact?.lastName as string | undefined) ?? ''),
    )
    const fullEntryName = normalizeName(
      (entryContact?.contactName as string | undefined) ??
        (entryContact?.fullName as string | undefined) ??
        null,
    )
    // Also match the entry-conversation's own phone/email/name —
    // defensive when the contact record isn't fetched but the
    // conversation surfaces them directly.
    const conversationPhoneDigits = digitsOnly(
      (conversation.phone as string | undefined) ??
        (conversation.contactPhone as string | undefined) ??
        null,
    )
    const conversationEmail = (
      (conversation.email as string | undefined) ??
      (conversation.contactEmail as string | undefined) ??
      ''
    )
      .trim()
      .toLowerCase()
    const conversationContactName = normalizeName(
      (conversation.contactName as string | undefined) ??
        (conversation.fullName as string | undefined) ??
        null,
    )
    const matchPhones = new Set(
      [entryPhoneDigits, conversationPhoneDigits].filter(
        (p): p is string => !!p,
      ),
    )
    const matchEmails = new Set(
      [entryEmail, conversationEmail].filter(Boolean),
    )
    const matchNames = new Set(
      [entryContactName, fullEntryName, conversationContactName].filter(
        (n): n is string => !!n,
      ),
    )

    // Location-wide conversation search instead of contactId-filtered
    // search. Why: GHL's contactId filter was returning only the
    // entry-point conversation for some contacts (Alex confirmed via
    // diagnostics — Joe Moder's email-thread sibling conversation
    // wasn't surfacing because GHL split it across separate contact
    // records by medium). Pulling 100 most-recent location
    // conversations and filtering client-side by contactId + phone
    // digits + email catches all sibling threads regardless of how
    // GHL grouped them internally.
    type FoundConvo = {
      id: string
      lastMessageType: string | null
      lastMessageDate: string | null
      type: string | null
      matchedOn: 'self' | 'contactId' | 'phone' | 'email' | 'name'
    }
    // Rejected conversations — captured for diagnostics so admin
    // can see WHY non-matching threads got skipped (and confirm
    // whether the missing email-thread sibling is even in the
    // 100-most-recent location pull).
    type RejectedConvo = {
      id: string
      contactId: string | null
      contactName: string | null
      phone: string | null
      email: string | null
      lastMessageType: string | null
      lastMessageDate: string | null
    }
    const rejected: RejectedConvo[] = []
    let foundConvos: FoundConvo[] = [
      {
        id: convId,
        lastMessageType:
          (conversation.lastMessageType as string | undefined) ?? null,
        lastMessageDate:
          (conversation.lastMessageDate as string | undefined) ?? null,
        type: (conversation.type as string | undefined) ?? null,
        matchedOn: 'self',
      },
    ]
    let allConversationIds: string[] = [convId]
    try {
      const wideSearch = (await getConversations(vaultName, {
        limit: 100,
      })) as {
        conversations?: Array<{
          id?: string
          contactId?: string
          phone?: string
          contactPhone?: string
          email?: string
          contactEmail?: string
          contactName?: string
          fullName?: string
          lastMessageType?: string
          lastMessageDate?: string
          type?: string
        }>
      }
      const seenIds = new Set<string>([convId])
      for (const c of wideSearch.conversations ?? []) {
        if (typeof c.id !== 'string') continue
        if (seenIds.has(c.id)) continue

        // Match priority: contactId most specific → phone → email
        // → contactName. Last as a fallback because name collisions
        // between distinct people are possible (different "Joe
        // Smith"s) but extremely unlikely at agency scale, where
        // each registered contact is a known business owner.
        let matchedOn: FoundConvo['matchedOn'] | null = null
        if (c.contactId === contactId) matchedOn = 'contactId'
        if (!matchedOn) {
          const cPhone = digitsOnly(c.phone ?? c.contactPhone ?? null)
          if (cPhone && matchPhones.has(cPhone)) matchedOn = 'phone'
        }
        if (!matchedOn) {
          const cEmail = (c.email ?? c.contactEmail ?? '')
            .trim()
            .toLowerCase()
          if (cEmail && matchEmails.has(cEmail)) matchedOn = 'email'
        }
        if (!matchedOn) {
          const cName = normalizeName(c.contactName ?? c.fullName ?? null)
          if (cName && matchNames.has(cName)) matchedOn = 'name'
        }
        if (!matchedOn) {
          // Capture the rejected conversation so we can see what
          // we're skipping. Limit to 50 entries — bounds the
          // diagnostic payload but covers the realistic set.
          if (rejected.length < 50) {
            rejected.push({
              id: c.id,
              contactId: c.contactId ?? null,
              contactName: c.contactName ?? c.fullName ?? null,
              phone:
                digitsOnly(c.phone ?? c.contactPhone ?? null) ??
                (c.phone ?? c.contactPhone ?? null),
              email:
                (c.email ?? c.contactEmail ?? '').trim().toLowerCase() ||
                null,
              lastMessageType: c.lastMessageType ?? null,
              lastMessageDate: c.lastMessageDate ?? null,
            })
          }
          continue
        }

        seenIds.add(c.id)
        foundConvos.push({
          id: c.id,
          lastMessageType: c.lastMessageType ?? null,
          lastMessageDate: c.lastMessageDate ?? null,
          type: c.type ?? null,
          matchedOn,
        })
      }
      allConversationIds = foundConvos.map((c) => c.id)
    } catch (err) {
      console.error(
        '[crm conversation detail] location-wide conv search failed:',
        err,
      )
    }

    // Fetch messages for every matched conversation in parallel.
    // Per-conversation 100 limit is GHL's per-page ceiling; a single
    // contact rarely has >100 messages in any one container, and
    // even if they do we get the most recent 100 per container.
    // The contact record was already fetched above for the email/
    // phone matchers, so it's reused here rather than re-fetched.
    const messagePages = await Promise.all(
      allConversationIds.map((id) =>
        getConversationMessages(id, vaultName, 100).catch((err) => {
          console.error(
            `[crm conversation detail] messages fetch failed for ${id}:`,
            err,
          )
          return null
        }),
      ),
    )

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
      matchedOn: 'self' | 'contactId' | 'phone' | 'email' | 'name'
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
          matchedOn: 'self' as const,
        } as FoundConvo)
      const diag: PerConvoDiag = {
        id: cid,
        lastMessageType: meta.lastMessageType,
        lastMessageDate: meta.lastMessageDate,
        messageCount: 0,
        messageTypes: {},
        firstMessageDate: null,
        lastMessageDateInPage: null,
        matchedOn: meta.matchedOn,
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

    // Hydrate empty-body emails. The conversations/messages list
    // endpoint returns email metadata (id, type, direction, dates)
    // but inbound email body lives on the per-message email
    // endpoint. Without this, Joe Moder's reply rendered as a
    // "(no body returned by GHL)" placeholder even though GHL
    // had the content. Fanned out in parallel + capped so a 30-
    // email thread doesn't stall the response. Best-effort: any
    // single fetch failure leaves that bubble as the placeholder.
    const HYDRATE_CAP = 20
    const emailIdsToHydrate: string[] = []
    // First pass: emails missing a body — these we MUST hydrate so
    // the bubble doesn't render the empty placeholder.
    for (const m of merged) {
      const mtUpper = String(m.messageType ?? '').toUpperCase()
      const isEmail =
        mtUpper === 'TYPE_EMAIL' ||
        (typeof m.type === 'number' && m.type === 3)
      if (!isEmail) continue
      const hasBody =
        typeof m.body === 'string' && m.body.trim().length > 0
      if (hasBody) continue
      const id = typeof m.id === 'string' ? m.id : null
      if (!id) continue
      emailIdsToHydrate.push(id)
      if (emailIdsToHydrate.length >= HYDRATE_CAP) break
    }
    // DIAGNOSTIC SECOND PASS: ensure we always fetch ≥3 emails so the
    // raw-sample drawer has something to show. Without this, threads
    // where every TYPE_EMAIL already has a body (i.e. all-outbound
    // threads we send via the agency template) skip hydration entirely
    // and we never see GHL's response shape. Investigating whether
    // inbound replies are nested inside the parent outbound email's
    // detail payload — the "+ 3 replies earlier" we saw in GHL's
    // native UI but never in /conversations/{id}/messages.
    const SAMPLE_FORCE_CAP = 3
    if (emailIdsToHydrate.length < SAMPLE_FORCE_CAP) {
      for (const m of merged) {
        const mtUpper = String(m.messageType ?? '').toUpperCase()
        const isEmail =
          mtUpper === 'TYPE_EMAIL' ||
          (typeof m.type === 'number' && m.type === 3)
        if (!isEmail) continue
        const id = typeof m.id === 'string' ? m.id : null
        if (!id) continue
        if (emailIdsToHydrate.includes(id)) continue
        emailIdsToHydrate.push(id)
        if (emailIdsToHydrate.length >= SAMPLE_FORCE_CAP) break
      }
    }
    type RawEmailSample = {
      emailId: string
      topLevelKeys: string[]
      nestedEmailKeys: string[] | null
      rawJson: string // truncated to ~4kb so the response stays sane
    }
    const rawEmailSamples: RawEmailSample[] = []
    const RAW_SAMPLE_CAP = 3
    if (emailIdsToHydrate.length > 0) {
      const hydrated = await Promise.all(
        emailIdsToHydrate.map((id) =>
          getEmailMessage(id, vaultName)
            .then((res) => ({ id, raw: res, body: extractEmailBody(res) }))
            .catch((err) => ({
              id,
              raw: { __error: String(err) } as unknown,
              body: null as string | null,
            })),
        ),
      )
      const bodyById = new Map<string, string>()
      for (const h of hydrated) {
        if (h.body && h.body.trim()) bodyById.set(h.id, h.body)
        if (
          h.raw &&
          typeof h.raw === 'object' &&
          rawEmailSamples.length < RAW_SAMPLE_CAP
        ) {
          const root = h.raw as Record<string, unknown>
          const nestedEmail = root.email as Record<string, unknown> | undefined
          let rawJson: string
          try {
            rawJson = JSON.stringify(h.raw)
          } catch {
            rawJson = '[unserializable]'
          }
          if (rawJson.length > 4000) {
            rawJson = rawJson.slice(0, 4000) + '…[truncated]'
          }
          rawEmailSamples.push({
            emailId: h.id,
            topLevelKeys: Object.keys(root),
            nestedEmailKeys: nestedEmail ? Object.keys(nestedEmail) : null,
            rawJson,
          })
        }
      }
      if (bodyById.size > 0) {
        for (const m of merged) {
          const id = typeof m.id === 'string' ? m.id : null
          if (id && bodyById.has(id)) {
            m.body = bodyById.get(id)!
          }
        }
      }
    }

    // entryContact was fetched up top for the phone/email match
    // keys; reuse it here for the response payload instead of a
    // second round-trip.
    const contact = entryContact

    // Per-message summary surfaced in diagnostics — lets us spot
    // "GHL returned the message but body is empty" cases at a
    // glance. Only the fields we actually care about for debugging,
    // not the full payload (would balloon the response).
    const messageSummary = merged.map((m) => ({
      id: typeof m.id === 'string' ? m.id : null,
      messageType:
        (typeof m.messageType === 'string' && m.messageType) ||
        (typeof m.type === 'string' && m.type) ||
        (typeof m.type === 'number' ? `numeric:${m.type}` : null),
      direction: (m as { direction?: string }).direction ?? null,
      dateAdded: typeof m.dateAdded === 'string' ? m.dateAdded : null,
      bodyLength:
        typeof m.body === 'string'
          ? m.body.trim().length
          : 0,
      hasBody:
        typeof m.body === 'string' && m.body.trim().length > 0,
    }))

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
        messageSummary,
        /** Location-wide conversations that were returned by GHL
         *  but didn't match any of (contactId / phone / email /
         *  name). Surfaced so admin can scan for "this row's
         *  email-thread sibling but with a different contactId"
         *  cases. Capped at 50 entries to keep the response
         *  payload sane. */
        rejected,
        /** Up to 3 raw responses from /conversations/messages/email/{id}
         *  — used to figure out where GHL nests inbound email replies
         *  (the "+ 3 replies earlier" we saw in their native UI but
         *  not in /conversations/{id}/messages). Truncated to 4kb each. */
        rawEmailSamples,
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
/** Pull a renderable email body out of GHL's email-detail response.
 *  GHL has different shapes across versions; try the common ones in
 *  order of preference: HTML body if present, plain-text body,
 *  preview snippet. Returns null when nothing usable is there. */
function extractEmailBody(payload: unknown): string | null {
  const root = payload as Record<string, unknown> | null | undefined
  if (!root) return null
  const candidates: unknown[] = [
    (root.email as Record<string, unknown> | undefined)?.body,
    (root.email as Record<string, unknown> | undefined)?.html,
    (root.email as Record<string, unknown> | undefined)?.text,
    root.body,
    root.html,
    root.text,
    root.bodyText,
    root.preview,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c
  }
  return null
}

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
