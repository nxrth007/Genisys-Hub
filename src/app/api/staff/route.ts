import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/staff
 *
 * List of internal staff users (admin + member roles), used by
 * filters that scope a view to a specific teammate (e.g. the
 * Assignee dropdown on /today). Sorted by name.
 *
 * Returns id + display name + email + role. Excludes agents
 * (Mary etc.) and clients — those have their own surfaces.
 *
 * Staff-only because the list reveals workspace membership which
 * isn't appropriate for client / agent roles to see.
 */
export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial

  const users = await prisma.user.findMany({
    where: { role: { in: ['admin', 'member'] } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  })

  return NextResponse.json({ users })
}
