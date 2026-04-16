import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { listSubAccounts, getConversations } from '@/lib/ghl'

/**
 * GET /api/crm/conversations
 * Fetches conversations from every GHL sub-account in parallel.
 * Returns results grouped by sub-account.
 *
 * Query: ?limit=20 (per sub-account)
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const limit = Number(req.nextUrl.searchParams.get('limit') || '20')

  try {
    const { subaccounts, errors, discoveredEntries } = await listSubAccounts()

    // Fetch all sub-accounts in parallel — don't let one slow/broken
    // sub-account block the others.
    const results = await Promise.all(
      subaccounts.map(async (sub) => {
        try {
          const data = await getConversations(sub.vaultName, { limit })
          const conversations = (data.conversations || []) as Record<string, unknown>[]
          return {
            subAccount: sub,
            conversations,
            error: null as string | null,
          }
        } catch (err) {
          return {
            subAccount: sub,
            conversations: [],
            error: err instanceof Error ? err.message : 'Failed to fetch',
          }
        }
      })
    )

    return NextResponse.json({
      groups: results,
      resolutionErrors: errors,
      discoveredEntries,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch conversations'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
