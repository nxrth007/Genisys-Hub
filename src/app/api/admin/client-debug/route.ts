import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/client-debug?name=Brighton Capital Solar
 *
 * One-shot diagnosis of why a client's portal might be empty:
 * confirms the client record, how many DB appointments it has
 * (imported + total), and which login accounts are actually linked
 * to it. If the appointment count is healthy but no client_active
 * user is linked, that's the empty-dashboard cause.
 */
export async function GET(req: NextRequest) {
  const denial = await requireStaff()
  if (denial) return denial

  const name = (req.nextUrl.searchParams.get('name') || '').trim()
  if (!name) {
    return NextResponse.json({ error: 'name query param required' }, { status: 400 })
  }

  const client = await prisma.client.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true, active: true, lifecycle: true },
  })
  if (!client) {
    return NextResponse.json({ error: `no client named "${name}"` }, { status: 404 })
  }

  const [total, imported, hubBooked, linkedUsers] = await Promise.all([
    prisma.appointment.count({ where: { clientId: client.id } }),
    prisma.appointment.count({
      where: { clientId: client.id, importedFromSheet: true },
    }),
    prisma.appointment.count({
      where: { clientId: client.id, importedFromSheet: false },
    }),
    prisma.user.findMany({
      where: { clientId: client.id },
      select: { id: true, email: true, role: true, name: true },
    }),
  ])

  return NextResponse.json(
    {
      client,
      appointments: { total, imported, hubBooked },
      linkedLogins: linkedUsers,
      diagnosis:
        total === 0
          ? 'No DB appointments for this client — the import did not attribute any rows here.'
          : linkedUsers.some((u) => u.role === 'client_active')
            ? 'Appointments + an active client login both exist — dashboard should populate.'
            : 'Appointments exist but NO client_active login is linked to this client — that is why the portal is empty.',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
