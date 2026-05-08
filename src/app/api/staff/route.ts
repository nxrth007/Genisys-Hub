import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/staff
 *
 * List of internal staff users (admin + member roles), used by
 * filters that scope a view to a specific teammate (e.g. the
 * Assignee dropdown on /today). Sorted by name.
 *
 * Returns:
 *   - users: id + display name + email + role for every staff
 *     member. Excludes agents (Mary etc.) and clients — those
 *     have their own surfaces.
 *   - me: same shape, for the caller — so client UIs can
 *     default the dropdown to "me" without a separate session
 *     fetch.
 *
 * Staff-only because the list reveals workspace membership which
 * isn't appropriate for client / agent roles to see.
 */
export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial
  const session = await auth()
  const meId = session?.user?.id

  const users = await prisma.user.findMany({
    where: { role: { in: ['admin', 'member'] } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  })

  const me = meId ? users.find((u) => u.id === meId) ?? null : null

  return NextResponse.json({ users, me })
}
