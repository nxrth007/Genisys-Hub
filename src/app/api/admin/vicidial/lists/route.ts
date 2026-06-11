import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { fetchVicidialLists } from '@/lib/vicidial-lists'

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

  const links = await prisma.vicidialListLink.findMany({
    include: {
      client: { select: { id: true, name: true, color: true } },
    },
  })
  const linkByListId = new Map(links.map((l) => [l.listId, l]))

  return NextResponse.json(
    {
      ...result,
      lists: result.lists.map((l) => {
        const link = linkByListId.get(l.listId)
        return {
          ...l,
          linkedClientId: link?.client?.id ?? null,
          linkedClientName: link?.client?.name ?? null,
          linkedClientColor: link?.client?.color ?? null,
        }
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
