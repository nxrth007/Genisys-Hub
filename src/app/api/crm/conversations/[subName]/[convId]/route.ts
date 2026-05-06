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
    // search. Why: GHL's contactId filter sometimes returns only the
    // entry-point conversation when a contact is split across separate
    // records by medium. Pulling the 100 most-recent location
    // conversations and filtering client-side by contactId / phone /
    // email / name catches sibling threads regardless of how GHL
    // grouped them internally.
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
        }>
      }
      const seenIds = new Set<string>([convId])
      const matchedIds: string[] = []
      for (const c of wideSearch.conversations ?? []) {
        if (typeof c.id !== 'string') continue
        if (seenIds.has(c.id)) continue

        // Match priority: contactId most specific → phone → email
        // → contactName. Name is a last-resort fallback because
        // collisions between distinct people are possible but
        // extremely unlikely at agency scale.
        let matched = false
        if (c.contactId === contactId) matched = true
        if (!matched) {
          const cPhone = digitsOnly(c.phone ?? c.contactPhone ?? null)
          if (cPhone && matchPhones.has(cPhone)) matched = true
        }
        if (!matched) {
          const cEmail = (c.email ?? c.contactEmail ?? '')
            .trim()
            .toLowerCase()
          if (cEmail && matchEmails.has(cEmail)) matched = true
        }
        if (!matched) {
          const cName = normalizeName(c.contactName ?? c.fullName ?? null)
          if (cName && matchNames.has(cName)) matched = true
        }
        if (!matched) continue

        seenIds.add(c.id)
        matchedIds.push(c.id)
      }
      allConversationIds = [convId, ...matchedIds]
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
    for (const page of messagePages) {
      if (!page) continue
      const msgs = extractMessages(page)
      for (const m of msgs) {
        const id = m.id
        if (id) {
          if (seen.has(id)) continue
          seen.add(id)
        }
        merged.push(m)
      }
    }
    merged.sort((a, b) => {
      const at = a.dateAdded ? new Date(a.dateAdded).getTime() : 0
      const bt = b.dateAdded ? new Date(b.dateAdded).getTime() : 0
      return at - bt
    })

    // Normalize SMS/MMS attachments straight off the conv-message —
    // these come back inline on /conversations/{id}/messages so no
    // hydration is needed for them.
    for (const m of merged) {
      const atts = extractAttachmentUrls(
        (m as { attachments?: unknown }).attachments,
      )
      if (atts.length > 0) {
        ;(m as { attachments?: string[] }).attachments = atts
      }
    }

    // Hydrate emails. We fetch /conversations/messages/email/{id} for
    // every TYPE_EMAIL up to the cap because:
    //  1. Inbound email bodies aren't always on the conv-message.
    //  2. Email attachments only live on the per-message endpoint —
    //     not on the conv-message at all — so without this we have
    //     no way to know an email had a PDF/image attached.
    // Note: conv-message id ≠ email-message id (different ID spaces);
    // real email IDs live at meta.email.messageIds[].
    const HYDRATE_CAP = 20
    const emailIdsToHydrate: string[] = []
    const convMsgIdByEmailId = new Map<string, string>()
    for (const m of merged) {
      const mtUpper = String(m.messageType ?? '').toUpperCase()
      const isEmail =
        mtUpper === 'TYPE_EMAIL' ||
        (typeof m.type === 'number' && m.type === 3)
      if (!isEmail) continue
      const convMsgId = typeof m.id === 'string' ? m.id : null
      const emailIds = extractEmailMessageIdsFromConvMessage(
        m as Record<string, unknown>,
      )
      for (const eid of emailIds) {
        if (emailIdsToHydrate.includes(eid)) continue
        emailIdsToHydrate.push(eid)
        if (convMsgId) convMsgIdByEmailId.set(eid, convMsgId)
        if (emailIdsToHydrate.length >= HYDRATE_CAP) break
      }
      if (emailIdsToHydrate.length >= HYDRATE_CAP) break
    }
    if (emailIdsToHydrate.length > 0) {
      const hydrated = await Promise.all(
        emailIdsToHydrate.map((id) =>
          getEmailMessage(id, vaultName)
            .then((res) => ({
              id,
              body: extractEmailBody(res),
              attachments: extractEmailAttachments(res),
            }))
            .catch(() => ({
              id,
              body: null as string | null,
              attachments: [] as string[],
            })),
        ),
      )
      const bodyByConvMsgId = new Map<string, string>()
      const attsByConvMsgId = new Map<string, string[]>()
      for (const h of hydrated) {
        const convMsgId = convMsgIdByEmailId.get(h.id)
        if (!convMsgId) continue
        if (h.body && h.body.trim() && !bodyByConvMsgId.has(convMsgId)) {
          bodyByConvMsgId.set(convMsgId, h.body)
        }
        if (h.attachments.length > 0) {
          const existing = attsByConvMsgId.get(convMsgId) ?? []
          attsByConvMsgId.set(convMsgId, [...existing, ...h.attachments])
        }
      }
      for (const m of merged) {
        const id = typeof m.id === 'string' ? m.id : null
        if (!id) continue
        if (bodyByConvMsgId.has(id)) m.body = bodyByConvMsgId.get(id)!
        if (attsByConvMsgId.has(id)) {
          // Dedup — an inline image referenced both by conv-message
          // attachments AND email-detail attachments shouldn't render
          // twice.
          const combined = [
            ...(((m as { attachments?: string[] }).attachments) ?? []),
            ...attsByConvMsgId.get(id)!,
          ]
          ;(m as { attachments?: string[] }).attachments = Array.from(
            new Set(combined),
          )
        }
      }
    }

    return NextResponse.json({
      conversation,
      messages: merged,
      contact: entryContact,
    })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch conversation'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Pull every email-message id we can find off a TYPE_EMAIL conv-message.
 *  The conv-message `id` itself is NOT a valid email-message id —
 *  /conversations/messages/email/{id} returns 400 if you pass it.
 *  Real email-message ids live at meta.email.messageIds[]; the other
 *  paths are defensive against shape drift across GHL versions. */
function extractEmailMessageIdsFromConvMessage(
  m: Record<string, unknown>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (val: unknown) => {
    if (typeof val === 'string' && val && !seen.has(val)) {
      seen.add(val)
      out.push(val)
    }
    if (Array.isArray(val)) {
      for (const v of val) push(v)
    }
  }
  const meta = m.meta as Record<string, unknown> | undefined
  const metaEmail = meta?.email as Record<string, unknown> | undefined
  push(metaEmail?.messageIds)
  push(metaEmail?.messageId)
  push((m as { emailMessageIds?: unknown }).emailMessageIds)
  push((m as { emailMessageId?: unknown }).emailMessageId)
  return out
}

/** Normalize attachment URLs off any GHL-shaped attachments value.
 *  GHL has shipped both `attachments: string[]` (URLs) and
 *  `attachments: { url, name }[]` shapes depending on endpoint and
 *  version, so we accept both and dedup. Filters out empty / non-http
 *  values so a stray null doesn't break the front-end renderer. */
function extractAttachmentUrls(val: unknown): string[] {
  if (!val) return []
  if (!Array.isArray(val)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of val) {
    let url: string | null = null
    if (typeof item === 'string') {
      url = item
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      url =
        (typeof o.url === 'string' && o.url) ||
        (typeof o.fileUrl === 'string' && o.fileUrl) ||
        (typeof o.link === 'string' && o.link) ||
        null
    }
    if (!url) continue
    const trimmed = url.trim()
    if (!trimmed.startsWith('http')) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Pull attachment URLs off GHL's /messages/email/{id} response.
 *  Tries the documented `emailMessage.attachments` shape plus a few
 *  defensive fallbacks. */
function extractEmailAttachments(payload: unknown): string[] {
  const root = payload as Record<string, unknown> | null | undefined
  if (!root) return []
  const emailMessage = root.emailMessage as Record<string, unknown> | undefined
  const email = root.email as Record<string, unknown> | undefined
  return [
    ...extractAttachmentUrls(emailMessage?.attachments),
    ...extractAttachmentUrls(email?.attachments),
    ...extractAttachmentUrls(root.attachments),
  ]
}

/** Pull a renderable email body out of GHL's /messages/email/{id}
 *  response. The actual response shape is `{ emailMessage: { body } }`;
 *  the other candidates are defensive against shape drift. */
function extractEmailBody(payload: unknown): string | null {
  const root = payload as Record<string, unknown> | null | undefined
  if (!root) return null
  const emailMessage = root.emailMessage as Record<string, unknown> | undefined
  const email = root.email as Record<string, unknown> | undefined
  const candidates: unknown[] = [
    emailMessage?.body,
    emailMessage?.html,
    emailMessage?.text,
    email?.body,
    email?.html,
    email?.text,
    root.body,
    root.html,
    root.text,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c
  }
  return null
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
