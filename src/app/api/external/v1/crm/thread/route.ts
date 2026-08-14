import { NextRequest } from 'next/server'
import {
  getContact,
  getConversation,
  getConversationMessages,
} from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import {
  normalizeConversation,
  normalizeMessage,
  requireUser,
  type RawObj,
} from '../_shared'

/**
 * GET /api/external/v1/crm/thread?subAccount=<vaultName>&convId=<id>
 *
 * One conversation with its messages and contact.
 *
 * Deliberately simpler than the Hub's thread route, which also searches
 * the whole location for sibling conversations and hydrates up to 20
 * email bodies. That version issues dozens of GHL calls per open and is
 * the slowest thing in the app; this reads one conversation so the
 * frontend stays responsive.
 */
export const GET = withExternalApi(async (req, auth) => {
  const denied = requireUser(auth)
  if (denied) throw new Error(denied)

  const params = req.nextUrl.searchParams
  const subAccount = (params.get('subAccount') ?? '').trim()
  const convId = (params.get('convId') ?? '').trim()

  if (!subAccount || !convId) {
    throw new Error('subAccount and convId are both required.')
  }

  const convRaw = (await getConversation(convId, subAccount)) as RawObj
  const conversation = normalizeConversation(
    ((convRaw.conversation as RawObj) ?? convRaw) as RawObj,
  )

  const msgPayload = (await getConversationMessages(
    convId,
    subAccount,
    100,
  )) as RawObj

  // GHL returns either { messages: [...] } or { messages: { messages: [...] } }.
  const inner = msgPayload.messages as RawObj | RawObj[] | undefined
  const rawMessages: RawObj[] = Array.isArray(inner)
    ? inner
    : (((inner as RawObj)?.messages as RawObj[]) ?? [])

  const messages = rawMessages
    .map(normalizeMessage)
    .sort((a, b) => (a.dateAdded ?? '').localeCompare(b.dateAdded ?? ''))

  let contact: Record<string, string | null> | null = null
  if (conversation.contactId) {
    try {
      const raw = (await getContact(conversation.contactId, subAccount)) as RawObj
      const c = ((raw.contact as RawObj) ?? raw) as RawObj
      const pick = (k: string) =>
        typeof c[k] === 'string' && (c[k] as string).trim()
          ? (c[k] as string)
          : null
      contact = {
        id: pick('id'),
        firstName: pick('firstName'),
        lastName: pick('lastName'),
        email: pick('email'),
        phone: pick('phone'),
        companyName: pick('companyName'),
        source: pick('source'),
        dateAdded: pick('dateAdded'),
        city: pick('city'),
        state: pick('state'),
      }
    } catch {
      // A missing contact shouldn't hide the messages.
      contact = null
    }
  }

  return { conversation, messages, contact }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
