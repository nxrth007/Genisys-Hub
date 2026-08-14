import { NextRequest } from 'next/server'
import {
  getContact,
  getContactNotes,
  getConversations,
  listSubAccounts,
} from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/opportunities/context?subAccount=&contactId=
 *
 * Everything the opportunity card's action row needs, in one call:
 * tags, notes, and the contact's conversation. Three round-trips fired
 * per card open would be slower and noisier than one.
 *
 * Each piece is independent — a contact with no conversation still has
 * notes worth showing — so a failure in one is swallowed rather than
 * failing the panel.
 */
type RawObj = Record<string, unknown>

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

export const GET = withExternalApi(async (req, auth) => {
  if (!auth.user) throw new Error('This requires a signed-in account.')

  const params = req.nextUrl.searchParams
  const contactId = (params.get('contactId') ?? '').trim()
  const wanted = (params.get('subAccount') ?? '').trim()
  if (!contactId) throw new Error('contactId is required.')

  const { subaccounts } = await listSubAccounts()
  const target = wanted
    ? subaccounts.find((s) => s.vaultName === wanted)
    : subaccounts[0]
  if (!target) throw new Error('Unknown sub-account.')

  const [contactRes, notesRes, convRes] = await Promise.allSettled([
    getContact(contactId, target.vaultName),
    getContactNotes(contactId, target.vaultName),
    getConversations(target.vaultName, { contactId, limit: 5 }),
  ])

  const contactRaw =
    contactRes.status === 'fulfilled' ? (contactRes.value as RawObj) : {}
  const contact = ((contactRaw.contact as RawObj) ?? contactRaw) as RawObj

  const tags = Array.isArray(contact.tags)
    ? (contact.tags.filter((t) => typeof t === 'string') as string[])
    : []

  const notesRaw =
    notesRes.status === 'fulfilled'
      ? (((notesRes.value as RawObj).notes ?? []) as RawObj[])
      : []
  const notes = notesRaw
    .map((n) => ({
      id: String(n.id ?? ''),
      body: str(n.body) ?? '',
      createdAt: str(n.dateAdded) ?? str(n.createdAt),
    }))
    .filter((n) => n.body)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  const convsRaw =
    convRes.status === 'fulfilled'
      ? (((convRes.value as RawObj).conversations ?? []) as RawObj[])
      : []
  const conversationId = convsRaw.length ? String(convsRaw[0].id ?? '') : null

  return {
    tags,
    notes,
    conversationId,
    subAccount: target.vaultName,
    phone: str(contact.phone),
    email: str(contact.email),
  }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
