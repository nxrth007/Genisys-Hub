import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/team-members
 *
 * Lists every Team #1 (and future Team #N) user — pending, active,
 * and denied — for the admin approval UI. Returns the lookup code
 * for pending rows so admin can match a user's "show me your code"
 * out-of-band identification.
 *
 * Admin-only (member can read but not write — see PATCH route).
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

  const users = await prisma.user.findMany({
    where: { role: { in: ['team_pending', 'team_member', 'team_denied'] } },
    orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      role: true,
      servicingState: true,
      teamNumber: true,
      callCenterNumber: true,
      registrationLookupCode: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return NextResponse.json({
    members: users.map((u) => ({
      ...u,
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    })),
  })
}
