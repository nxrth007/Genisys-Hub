import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getManageableTeamNumber } from '@/lib/team-manager'

/**
 * GET /api/team/manage/members
 *
 * Manager-side list of pending + active + denied Team #N users,
 * scoped to whichever team the caller manages. Mary
 * (managesTeamNumber=1) sees Team #1; admin/member sees everything
 * via the same endpoint.
 *
 * Distinct from /api/admin/team-members because the manager has a
 * narrower permission surface (approve + deny + assign initial
 * number ONLY — no password reset, no number change on active
 * users, no delete). Keeping the endpoints separate keeps the
 * permission boundary obvious.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? null
  const team = await getManageableTeamNumber({
    userId: session.user.id,
    role,
  })
  if (team === null) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const users = await prisma.user.findMany({
    where: {
      role: { in: ['team_pending', 'team_member', 'team_denied'] },
      teamNumber: team,
    },
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
    teamNumber: team,
    members: users.map((u) => ({
      ...u,
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    })),
  })
}
