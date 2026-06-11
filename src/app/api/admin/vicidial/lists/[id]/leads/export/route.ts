import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { fetchVicidialListLeads } from '@/lib/vicidial-lists'

/**
 * GET /api/admin/vicidial/lists/[id]/leads/export?q=&status=
 *
 * CSV download of a list's leads with the same q/status filters as
 * the browser view, sorted name A→Z. Streams nothing fancy — the
 * full filtered set (≤10k rows ≈ ~1MB CSV) as an attachment.
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
  const q = (sp.get('q') || '').trim().toLowerCase()
  const status = (sp.get('status') || '').trim().toUpperCase()

  const result = await fetchVicidialListLeads(id)
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 })
  }

  let rows = result.leads
  if (status) rows = rows.filter((l) => l.status.toUpperCase() === status)
  if (q) {
    rows = rows.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.phone.toLowerCase().includes(q) ||
        l.city.toLowerCase().includes(q) ||
        l.leadId.includes(q),
    )
  }
  rows = [...rows].sort((a, b) =>
    a.name && b.name
      ? a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      : a.name
        ? -1
        : 1,
  )

  const csvEscape = (v: string) =>
    /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const header = 'lead_id,status,name,phone,city,last_agent,list_id,last_call'
  const lines = rows.map((l) =>
    [l.leadId, l.status, l.name, l.phone, l.city, l.lastAgent, l.listId, l.lastCall]
      .map((v) => csvEscape(v ?? ''))
      .join(','),
  )
  const csv = [header, ...lines].join('\r\n')

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="vicidial-list-${id}-leads.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
