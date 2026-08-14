import { NextRequest } from 'next/server'
import { createContactNote, listSubAccounts } from '@/lib/ghl'
import { externalWrite, WriteError } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * POST /api/external/v1/opportunities/note
 * body: { subAccount, contactId, body }
 *
 * Adds a note to a contact. Writes into GHL, so it shows up for whoever
 * opens that contact there — worth knowing before typing anything you
 * would not put in the CRM itself.
 */
export const POST = externalWrite(async ({ auth, body }) => {
  const contactId = String(body.contactId ?? '').trim()
  const text = String(body.body ?? '').trim()
  const subAccount = String(body.subAccount ?? '').trim()

  if (!contactId) throw new WriteError('contactId is required.')
  if (!text) throw new WriteError('The note is empty.')
  if (text.length > 5000) throw new WriteError('That note is too long.')

  const { subaccounts } = await listSubAccounts()
  const target = subAccount
    ? subaccounts.find((s) => s.vaultName === subAccount)
    : subaccounts[0]
  if (!target) throw new WriteError('Unknown sub-account.', 404)

  // Stamp the author: GHL notes made through the API are otherwise
  // anonymous, and "who wrote this" is the first question about a note.
  const stamped = `${text}\n\n— ${auth.user.name ?? auth.user.email} (via Genisys CRM)`

  try {
    await createContactNote(contactId, target.vaultName, stamped)
  } catch (err) {
    throw new WriteError(
      err instanceof Error ? err.message : 'GoHighLevel rejected the note.',
      502,
    )
  }

  return { contactId, saved: true }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
