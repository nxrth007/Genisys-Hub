import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { fetchVicidialListLeads } from '@/lib/vicidial-lists'

/**
 * GET /api/admin/vicidial/lists/[id]/leads?offset=0&limit=50&q=&status=
 *
 * Paginated slice of a list's leads. The lib fetches + parses the
 * full Vicidial search result (≤10k rows, 10-min cache) and this
 * route slices server-side so the browser never downloads 10k rows
 * at once. `q` filters name/phone/city substring (case-insensitive);
 * `status` filters exact status code.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'invalid list id' }, { status: 400 })
  }

  const sp = req.nextUrl.searchParams
  const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0)
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50', 10) || 50))
  const q = (sp.get('q') || '').trim().toLowerCase()
  const status = (sp.get('status') || '').trim().toUpperCase()

  const result = await fetchVicidialListLeads(id)
  if (!result.ok) {
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  let filtered = result.leads
  if (status) filtered = filtered.filter((l) => l.status.toUpperCase() === status)
  if (q) {
    filtered = filtered.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.phone.toLowerCase().includes(q) ||
        l.city.toLowerCase().includes(q) ||
        l.leadId.includes(q),
    )
  }

  return NextResponse.json(
    {
      ok: true,
      listId: result.listId,
      totalParsed: result.totalParsed,
      totalFiltered: filtered.length,
      offset,
      limit,
      leads: filtered.slice(offset, offset + limit),
      fetchedAt: result.fetchedAt,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
