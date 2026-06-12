import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { fetchVicidialLists } from '@/lib/vicidial-lists'
import { STATE_NAME_TO_CODE, STATE_CODE_TO_NAME } from '@/lib/address'

/**
 * Pull a US state out of a Vicidial list's name/description. The
 * BPO names lists like "CA - SCRUBED", "CO-SCRUBED", "UTAH-SCRUBED"
 * — sometimes a 2-letter code token, sometimes a spelled-out name.
 * Returns the canonical full state name ("Utah") or null.
 */
function detectStateFromList(name: string, description: string): string | null {
  const haystack = `${name} ${description}`.toLowerCase()
  // Spelled-out names first, longest first so "west virginia" wins
  // over "virginia".
  const sortedNames = Object.keys(STATE_NAME_TO_CODE).sort(
    (a, b) => b.length - a.length,
  )
  for (const n of sortedNames) {
    if (haystack.includes(n)) return STATE_CODE_TO_NAME[STATE_NAME_TO_CODE[n]]
  }
  // 2-letter code as its own token ("CA - SCRUBED" → CA, "CO-SCRUBED"
  // → CO). Token split on anything non-alphanumeric so hyphens and
  // spaces both delimit.
  for (const token of `${name} ${description}`.split(/[^A-Za-z0-9]+/)) {
    const up = token.toUpperCase()
    if (up.length === 2 && STATE_CODE_TO_NAME[up]) return STATE_CODE_TO_NAME[up]
  }
  return null
}

/**
 * GET /api/admin/vicidial/lists
 *
 * Parsed Vicidial Lists listing (admin.php?ADD=100 + the leads-
 * counts variant), each row enriched with its Hub client link
 * (VicidialListLink) so /leads can show + edit the mapping inline.
 * Admin + member, same gate as the Vicidial users mirror. Lib
 * caches the scrape 5 minutes; the link join is a cheap local
 * query on every call so assignments show up immediately.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const result = await fetchVicidialLists()
  if (!result.ok) {
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const [links, clients] = await Promise.all([
    prisma.vicidialListLink.findMany({
      include: {
        client: { select: { id: true, name: true, color: true } },
      },
    }),
    // Active clients with a state on file — the pool for the
    // state-detection column. Client.state stores canonical full
    // names ("Utah") via canonicalizeStateName at intake.
    prisma.client.findMany({
      where: { active: true, state: { not: null } },
      select: { id: true, name: true, color: true, state: true },
    }),
  ])
  const linkByListId = new Map(links.map((l) => [l.listId, l]))
  const clientsByState = new Map<string, { id: string; name: string; color: string }[]>()
  for (const c of clients) {
    const key = (c.state ?? '').toLowerCase()
    if (!key) continue
    const arr = clientsByState.get(key) ?? []
    arr.push({ id: c.id, name: c.name, color: c.color })
    clientsByState.set(key, arr)
  }

  return NextResponse.json(
    {
      ...result,
      lists: result.lists.map((l) => {
        const link = linkByListId.get(l.listId)
        // State auto-detection: parse the state from the list's
        // name ("CO-SCRUBED" → Colorado) and surface every Hub
        // client operating in that state — two clients in the same
        // state both show. Purely informational; the explicit
        // VicidialListLink assignment stays the source of truth.
        const stateDetected = detectStateFromList(l.name, l.description)
        const stateClients = stateDetected
          ? (clientsByState.get(stateDetected.toLowerCase()) ?? [])
          : []
        return {
          ...l,
          linkedClientId: link?.client?.id ?? null,
          linkedClientName: link?.client?.name ?? null,
          linkedClientColor: link?.client?.color ?? null,
          stateDetected,
          stateClients,
        }
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
