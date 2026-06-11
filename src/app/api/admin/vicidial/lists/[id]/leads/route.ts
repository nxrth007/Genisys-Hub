import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { fetchVicidialListLeads, normalizePhone10 } from '@/lib/vicidial-lists'

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

  // Sort AFTER filtering, BEFORE slicing — pagination has to walk a
  // stable order. Default: name A→Z (Alex, 2026-06-11). Vicidial's
  // own page returns insertion order, which is useless for finding
  // a person. Nameless leads sink to the bottom rather than
  // clumping under "" at the top.
  const sort = (sp.get('sort') || 'name').toLowerCase()
  const dir = sp.get('dir') === 'desc' ? -1 : 1
  filtered = [...filtered].sort((a, b) => {
    if (sort === 'name') {
      if (!a.name && !b.name) return 0
      if (!a.name) return 1
      if (!b.name) return -1
      return dir * a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
    }
    if (sort === 'lastcall') return dir * a.lastCall.localeCompare(b.lastCall)
    if (sort === 'status') return dir * a.status.localeCompare(b.status)
    if (sort === 'leadid') return dir * (Number(a.leadId) - Number(b.leadId))
    return 0
  })

  // Appointment cross-reference — which of these dialer leads
  // became Hub appointments (matched by normalized phone). The
  // Appointment table is small (hundreds), so one full phone pull
  // per request is cheap; the lead side is the cached parse. Two
  // outputs: a `booked` flag on each returned row, and a whole-list
  // bookedCount → the list's real conversion number.
  const appts = await prisma.appointment.findMany({
    select: { customerPhone: true },
  })
  const apptPhones = new Set(
    appts.map((a) => normalizePhone10(a.customerPhone)).filter(Boolean),
  )
  let bookedCount = 0
  for (const l of result.leads) {
    const p = normalizePhone10(l.phone)
    if (p && apptPhones.has(p)) bookedCount++
  }

  return NextResponse.json(
    {
      ok: true,
      listId: result.listId,
      totalParsed: result.totalParsed,
      totalFiltered: filtered.length,
      bookedCount,
      offset,
      limit,
      leads: filtered.slice(offset, offset + limit).map((l) => ({
        ...l,
        booked: apptPhones.has(normalizePhone10(l.phone)),
      })),
      fetchedAt: result.fetchedAt,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
