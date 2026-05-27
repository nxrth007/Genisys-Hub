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
 * Two modes:
 *
 *  1. Initial load (no `subAccount` param):
 *     Fetches conversations from every visible GHL sub-account in
 *     parallel, returns results grouped by sub-account. Same shape
 *     as before — this is the first paint of /crm.
 *
 *  2. Pagination (`?subAccount=X&cursor=ISO_DATE`):
 *     Fetches the next page for just that one sub-account using
 *     GHL's startAfterDate cursor. Returns a single group with the
 *     same shape, plus a nextCursor for follow-up fetches.
 *
 * Each response group includes `nextCursor` — the oldest message
 * date in the current page, suitable for the next "Load more"
 * fetch. Null means "no more conversations available."
 *
 * Query:
 *   ?limit=100        per-sub-account fetch size (default 100 — GHL's
 *                     per-request ceiling. Was 20 originally, bumped
 *                     2026-05-22 per Alex's spec since 20 was too tight
 *                     for the on-screen + client-side search use cases).
 *   ?subAccount=X     single sub-account vault name (pagination mode)
 *   ?cursor=ISO_DATE  GHL startAfterDate, used with subAccount
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Default per-sub-account batch size. 100 matches GHL's per-request
  // ceiling — bigger numbers just get capped server-side. Lower-end
  // callers can still pass ?limit=N to override.
  const limit = Number(req.nextUrl.searchParams.get('limit') || '100')
  const singleSubAccount = req.nextUrl.searchParams.get('subAccount') || null
  const cursor = req.nextUrl.searchParams.get('cursor') || undefined

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

    // Pagination mode — single sub-account + cursor. Skip the
    // batched fan-out and return just the requested page.
    const targetSubaccounts = singleSubAccount
      ? subaccounts.filter((s) => s.vaultName === singleSubAccount)
      : subaccounts
    if (singleSubAccount && targetSubaccounts.length === 0) {
      return NextResponse.json(
        { error: `Sub-account "${singleSubAccount}" not visible` },
        { status: 404 },
      )
    }

    // Fetch GHL conversations across sub-accounts in parallel, AND
    // pull the set of conversation IDs the reminder system has ever
    // touched. The two are joined locally to tag each conversation
    // with `source` so the UI can split "reminder line" threads
    // from everything else without an extra round-trip per row.
    const [results, reminderConvoIds] = await Promise.all([
      Promise.all(
        targetSubaccounts.map(async (sub) => {
          try {
            // Only pass cursor through in pagination mode — the
            // initial fan-out starts fresh for every sub-account.
            const data = await getConversations(sub.vaultName, {
              limit,
              ...(singleSubAccount && cursor ? { cursor } : {}),
            })
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
    //
    // Also compute nextCursor per group — the oldest lastMessageDate
    // in the current page. The frontend passes this back as ?cursor
    // for the "Load more" fetch (GHL's startAfterDate filter wants
    // a date, not an opaque cursor token). Null when the page is
    // empty or short (no more pages to load).
    const tagged = results.map((g) => {
      const conversations = g.conversations.map((c) => {
        const id = typeof c.id === 'string' ? c.id : null
        const source: 'reminder' | 'other' =
          id && reminderConvoIds.has(id) ? 'reminder' : 'other'
        return { ...c, source }
      })
      // Find the oldest message date for the cursor. We always
      // expose a nextCursor when the page is non-empty + at least
      // one conversation has a parseable lastMessageDate — the
      // original implementation gated this on `length >= limit`,
      // but GHL routinely returns slightly less than requested
      // even when there's more available, which hid the Load more
      // button entirely. If the user clicks Load more and the next
      // page truly is empty, that response will have no convs and
      // no cursor, which naturally hides the button.
      //
      // lastMessageDate from GHL ships as either an ISO string OR
      // a Unix-ms number depending on the endpoint version; coerce
      // both to an ISO string here so the cursor can be passed
      // back to GHL's startAfterDate filter on the next fetch.
      let nextCursor: string | null = null
      if (conversations.length > 0) {
        let oldestMs: number | null = null
        for (const c of g.conversations) {
          const raw = c.lastMessageDate
          if (raw == null) continue
          const parsed =
            typeof raw === 'string' || typeof raw === 'number'
              ? new Date(raw).getTime()
              : NaN
          if (isNaN(parsed)) continue
          if (oldestMs == null || parsed < oldestMs) oldestMs = parsed
        }
        if (oldestMs != null) {
          nextCursor = new Date(oldestMs).toISOString()
        }
      }
      return { ...g, conversations, nextCursor }
    })

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
