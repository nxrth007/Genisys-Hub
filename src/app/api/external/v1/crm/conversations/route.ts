import { NextRequest } from 'next/server'
import { getConversations, listSubAccounts } from '@/lib/ghl'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { normalizeConversation, requireUser, type RawObj } from '../_shared'

/**
 * GET /api/external/v1/crm/conversations
 *   ?subAccount=<vaultName>   one sub-account (fast)
 *   ?subAccount=all           every sub-account (slow — fans out)
 *   &cursor=<ISO>             page older than this (GHL startAfterDate)
 *   &limit=1..100
 *
 * Defaults to a single sub-account because the Hub's all-at-once version
 * resolves tokens sequentially and is the slowest endpoint it has. The
 * frontend picks a sub-account and loads just that one.
 */
export const GET = withExternalApi(async (req, auth) => {
  const denied = requireUser(auth)
  if (denied) throw new Error(denied)

  const params = req.nextUrl.searchParams
  const wanted = (params.get('subAccount') ?? '').trim()
  const cursor = params.get('cursor') ?? undefined
  const limit = Math.min(100, Math.max(1, Number(params.get('limit') ?? 50)))

  const { subaccounts, errors } = await listSubAccounts()

  const targets =
    !wanted || wanted === 'all'
      ? subaccounts
      : subaccounts.filter((s) => s.vaultName === wanted)

  if (wanted && wanted !== 'all' && targets.length === 0) {
    throw new Error(`Unknown sub-account "${wanted}".`)
  }

  const groups = await Promise.all(
    targets.map(async (s) => {
      try {
        const payload = (await getConversations(s.vaultName, {
          limit,
          cursor,
        })) as RawObj
        const raw = (payload.conversations ?? []) as RawObj[]
        const conversations = raw.map(normalizeConversation)

        // GHL under-returns, so a full page isn't a reliable "has more"
        // signal — emit a cursor whenever the page had anything at all.
        const oldest = conversations
          .map((c) => c.lastMessageDate)
          .filter(Boolean)
          .sort()[0]

        return {
          subAccount: s,
          conversations,
          nextCursor: conversations.length > 0 ? (oldest ?? null) : null,
          error: null as string | null,
        }
      } catch (err) {
        // One dead sub-account must not blank the whole view.
        return {
          subAccount: s,
          conversations: [],
          nextCursor: null,
          error: err instanceof Error ? err.message : 'Failed to load',
        }
      }
    }),
  )

  return { groups, errors }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
