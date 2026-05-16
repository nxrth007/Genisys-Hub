import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { listSubAccounts, getConversations } from '@/lib/ghl'
import { prisma } from '@/lib/prisma'

/**
 * Sub-accounts to hide from the CRM page. Case-insensitive substring
 * match against the GHL location name AND the vault entry name (so we
 * hide both successfully-resolved rows and resolution-error rows).
 *
 * We currently hide Brighton Solar + Spring Solar because we downgraded
 * the GHL plan and their sub-accounts are off the active tier — every
 * call against their PIT returns 401, which clutters the CRM. Remove
 * an entry from this list once the sub-account is reactivated and the
 * Private Integration token is re-issued in the vault.
 */
const HIDDEN_SUBACCOUNT_PATTERNS: readonly string[] = ['brighton', 'spring']

function isHiddenSubaccount(...candidates: Array<string | undefined>): boolean {
  return candidates.some((s) => {
    if (!s) return false
    const lower = s.toLowerCase()
    return HIDDEN_SUBACCOUNT_PATTERNS.some((p) => lower.includes(p))
  })
}

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
    const discovery = await listSubAccounts()
    // Drop hidden sub-accounts before we spend a round-trip per group
    // on conversation fetches. Filter both the resolved list and the
    // resolution-error list so the UI never surfaces them either way.
    const subaccounts = discovery.subaccounts.filter(
      (s) => !isHiddenSubaccount(s.locationName, s.vaultName),
    )
    const errors = discovery.errors.filter(
      (e) => !isHiddenSubaccount(e.vaultName),
    )
    const discoveredEntries = discovery.discoveredEntries

    // Fetch GHL conversations across sub-accounts in parallel, AND
    // pull the set of conversation IDs the reminder system has ever
    // touched. The two are joined locally to tag each conversation
    // with `source` so the UI can split "reminder line" threads
    // from everything else without an extra round-trip per row.
    const [results, reminderConvoIds] = await Promise.all([
      Promise.all(
        subaccounts.map(async (sub) => {
          try {
            const data = await getConversations(sub.vaultName, { limit })
            const conversations = (data.conversations || []) as Record<
              string,
              unknown
            >[]
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
        }),
      ),
      collectReminderConversationIds(),
    ])

    // Stamp each conversation with its source bucket. Anything we've
    // ever sent a reminder through is `reminder`; everything else
    // (sales outreach, manual GHL sends, prior-system threads) is
    // `other`. The UI uses this for filter chips on /crm.
    const tagged = results.map((g) => ({
      ...g,
      conversations: g.conversations.map((c) => {
        const id = typeof c.id === 'string' ? c.id : null
        const source: 'reminder' | 'other' =
          id && reminderConvoIds.has(id) ? 'reminder' : 'other'
        return { ...c, source }
      }),
    }))

    return NextResponse.json({
      groups: tagged,
      resolutionErrors: errors,
      discoveredEntries,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch conversations'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Build the set of conversation IDs the reminder system has ever
 * created or replied through. Every successful reminder send writes
 * ghlConversationId to AppointmentReminder; manual replies via
 * /api/crm/reminders/conversations/[convId] reuse the same id, so
 * the set covers both directions.
 */
async function collectReminderConversationIds(): Promise<Set<string>> {
  const rows = await prisma.appointmentReminder.findMany({
    where: { ghlConversationId: { not: null } },
    select: { ghlConversationId: true },
    distinct: ['ghlConversationId'],
  })
  return new Set(
    rows
      .map((r) => r.ghlConversationId)
      .filter((id): id is string => !!id),
  )
}
