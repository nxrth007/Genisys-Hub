import { NextRequest } from 'next/server'
import { getConversations, listSubAccounts } from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { normalizeConversation, requireUser, type RawObj } from '../_shared'

/**
 * GET /api/external/v1/crm/find-conversation?contactId=&subAccount=
 *
 * The existing conversation for a contact, or null. Lets the CRM open the
 * right thread when arriving from an opportunity, and tell the difference
 * between "no conversation yet" and "failed to load" — which look
 * identical from an empty list.
 *
 * When no sub-account is given, every one is searched: a contact belongs
 * to a location, and the caller often knows the contact without knowing
 * which location it came from.
 */
export const GET = withExternalApi(async (req, auth) => {
  const denied = requireUser(auth)
  if (denied) throw new Error(denied)

  const params = req.nextUrl.searchParams
  const contactId = (params.get('contactId') ?? '').trim()
  const wanted = (params.get('subAccount') ?? '').trim()
  if (!contactId) throw new Error('contactId is required.')

  const { subaccounts } = await listSubAccounts()
  const targets = wanted
    ? subaccounts.filter((s) => s.vaultName === wanted)
    : subaccounts

  for (const s of targets) {
    try {
      const payload = (await getConversations(s.vaultName, {
        contactId,
        limit: 5,
      })) as RawObj
      const raw = (payload.conversations ?? []) as RawObj[]
      if (raw.length > 0) {
        return {
          found: true,
          subAccount: s.vaultName,
          conversation: normalizeConversation(raw[0]),
        }
      }
    } catch {
      // A dead sub-account shouldn't stop the search at the others.
    }
  }

  return { found: false, subAccount: targets[0]?.vaultName ?? null, conversation: null }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
