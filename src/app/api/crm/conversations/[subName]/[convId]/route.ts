import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  getConversation,
  getConversationMessages,
  getContact,
} from '@/lib/ghl'

/**
 * GET /api/crm/conversations/[subName]/[convId]
 * Fetches a single conversation plus its messages and (if available) the
 * associated contact details. `subName` is the URL-encoded vault entry name
 * of the sub-account that owns the conversation.
 */
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
    // Fetch conversation + messages in parallel
    const [convData, msgData] = await Promise.all([
      getConversation(convId, vaultName),
      getConversationMessages(convId, vaultName),
    ])

    const conversation = (convData.conversation || convData) as Record<string, unknown>
    // GHL's message endpoint has a nested shape: { messages: { messages: [...] } }
    // in some versions, and a flat { messages: [...] } in others. Handle both.
    const msgRoot = msgData as { messages?: unknown }
    const nested = msgRoot.messages as { messages?: unknown } | unknown[] | undefined
    const messages = (Array.isArray(nested)
      ? nested
      : (nested as { messages?: unknown[] } | undefined)?.messages || []) as Record<
      string,
      unknown
    >[]

    // Enrich with contact info if we have a contactId
    let contact: Record<string, unknown> | null = null
    const contactId = conversation.contactId as string | undefined
    if (contactId) {
      try {
        const contactData = await getContact(contactId, vaultName)
        contact = (contactData.contact || contactData) as Record<string, unknown>
      } catch {
        // Skip if contact lookup fails
      }
    }

    return NextResponse.json({ conversation, messages, contact })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch conversation'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
