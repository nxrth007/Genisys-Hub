import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  fetchVicidialLists,
  fetchVicidialListLeads,
  normalizePhone10,
} from '@/lib/vicidial-lists'

/**
 * GET /api/admin/vicidial/search?q=...
 *
 * Cross-list lead search — "is this person/phone anywhere in our
 * dialer data, and in which list?" Walks every list's (cached)
 * lead parse and returns matches grouped with their list context.
 *
 * Cost note: the FIRST search after a deploy/restart warms all the
 * per-list caches in parallel — the big lists are ~10MB of HTML
 * each, so that can take ~15-60s. Subsequent searches inside the
 * 10-minute cache window are instant. The UI sets expectations.
 *
 * q matching: 3+ chars; digits-only inputs also match normalized
 * phone equality/prefix, text matches name/city substring. Capped
 * at 200 results total.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  if (q.length < 3) {
    return NextResponse.json(
      { error: 'Search needs at least 3 characters.' },
      { status: 400 },
    )
  }
  const qLower = q.toLowerCase()
  const qDigits = q.replace(/\D/g, '')

  const lists = await fetchVicidialLists()
  if (!lists.ok) {
    return NextResponse.json(lists, { status: 502 })
  }

  // Warm/read every list's lead cache in parallel. Failures on one
  // list (e.g. an empty default list that parses to zero rows)
  // don't sink the search — they're reported per-list instead.
  const perList = await Promise.all(
    lists.lists.map(async (l) => ({
      list: l,
      result: await fetchVicidialListLeads(l.listId).catch((err) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : 'fetch failed',
        fetchedAt: new Date().toISOString(),
      })),
    })),
  )

  const MAX = 200
  const matches: Array<Record<string, unknown>> = []
  const failedLists: Array<{ listId: string; name: string; error: string }> = []

  for (const { list, result } of perList) {
    if (!result.ok) {
      // "Parsed 0 leads" on an empty list is expected noise, not a
      // failure worth surfacing.
      if (!/Parsed 0 leads/i.test(result.error)) {
        failedLists.push({ listId: list.listId, name: list.name, error: result.error })
      }
      continue
    }
    for (const lead of result.leads) {
      if (matches.length >= MAX) break
      let hit = false
      if (qDigits.length >= 4) {
        const leadPhone = normalizePhone10(lead.phone) || lead.phone.replace(/\D/g, '')
        hit = leadPhone.includes(qDigits)
      }
      if (!hit) {
        hit =
          lead.name.toLowerCase().includes(qLower) ||
          lead.city.toLowerCase().includes(qLower) ||
          lead.leadId === q
      }
      if (hit) {
        matches.push({ ...lead, listName: list.name, listIdActual: list.listId })
      }
    }
    if (matches.length >= MAX) break
  }

  return NextResponse.json(
    {
      ok: true,
      q,
      matches,
      truncated: matches.length >= MAX,
      failedLists,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
