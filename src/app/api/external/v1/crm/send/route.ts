import { NextRequest, NextResponse } from 'next/server'
import { sendMessage, startConversation } from '@/lib/ghl'
import { verifyExternalRequest } from '@/lib/external-api'
import { corsPreflight, withCors } from '@/lib/external-cors'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/external/v1/crm/send
 *
 * The one write the external API has. Everything else it exposes is
 * read-only; this actually sends an SMS or email to a real customer, so
 * it carries guards the read endpoints don't need:
 *
 *  - a signed-in account is required (the shared environment token has
 *    no person behind it and must never be able to message customers)
 *  - per-user rate limit, so a loop or a stuck retry can't spray someone
 *  - the sender is logged with the conversation, giving an audit trail
 *    of who sent what from outside the Hub
 *
 * Written as a plain route rather than through withExternalApi because
 * that wrapper is GET-shaped and swallows errors into a generic 500 —
 * here the caller needs to know exactly why a send failed.
 */

const MAX_MESSAGE = 20_000

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const fail = (message: string, status: number) =>
    withCors(NextResponse.json({ error: message }, { status }), origin)

  const auth = await verifyExternalRequest(req)
  if (!auth) return fail('Missing or invalid API token.', 401)

  if (!auth.user) {
    return fail(
      'Sending requires a signed-in account. The shared environment token cannot message customers.',
      403,
    )
  }

  // Keyed to the person, not the IP — several people share an office.
  const limit = checkRateLimit(`crm-send:${auth.user.id}`, 30, 60 * 1000)
  if (!limit.ok) {
    return fail(
      'Sending too quickly. Wait a moment and try again.',
      429,
    )
  }

  let body: {
    subAccount?: string
    conversationId?: string
    contactId?: string
    message?: string
    type?: string
  }
  try {
    body = await req.json()
  } catch {
    return fail('Invalid JSON body', 400)
  }

  const subAccount = String(body.subAccount ?? '').trim()
  const conversationId = String(body.conversationId ?? '').trim()
  const message = String(body.message ?? '').trim()
  const type = body.type === 'Email' ? 'Email' : 'SMS'

  const contactId = body.contactId ? String(body.contactId).trim() : ''

  // Either identifier is enough: an existing thread has a conversationId,
  // a first-ever message has only the contact.
  if (!subAccount || (!conversationId && !contactId)) {
    return fail('subAccount and either conversationId or contactId are required.', 400)
  }
  if (!message) return fail('Message cannot be empty.', 400)
  if (message.length > MAX_MESSAGE) {
    return fail(`Message is too long (max ${MAX_MESSAGE} characters).`, 400)
  }

  try {
    // No conversation yet — GHL creates one when posted with a contactId
    // alone, and returns its id so the UI can open the thread rather than
    // leaving the message somewhere the user can't find.
    const result = conversationId
      ? await sendMessage(subAccount, {
          conversationId,
          contactId: contactId || undefined,
          message,
          type,
        })
      : await startConversation(subAccount, { contactId, message, type })

    // Audit trail: this leaves the building, so record who sent it.
    const newConversationId =
      !conversationId && result && typeof result === 'object'
        ? ((result as { conversationId?: string | null }).conversationId ?? null)
        : null

    console.log(
      `[crm-send] ${auth.user.email} sent ${type} to ${
        conversationId || `contact ${contactId}`
      } via ${subAccount} (${message.length} chars)`,
    )

    return withCors(
      NextResponse.json({ ok: true, result, conversationId: newConversationId }),
      origin,
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Send failed.'
    console.error('[crm-send] failed:', detail)
    // Surface GHL's reason — "which sub-account is broken" is the whole
    // question when a send fails.
    return fail(detail, 502)
  }
}

export const OPTIONS = (req: NextRequest) => corsPreflight(req)
