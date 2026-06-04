import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/agent/me/manager-status
 *
 * Returns the caller's team-manager flag so /agent can decide
 * whether to render the "Manage Team #N" tile. Lightweight
 * single-column query — Mary's dashboard hits this on mount and
 * the tile renders if non-null.
 *
 * Open to any authenticated agent — the answer for non-managers
 * is just `null`, which is the correct steady-state value (no
 * tile renders).
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { managesTeamNumber: true },
  })
  return NextResponse.json({
    managesTeamNumber: user?.managesTeamNumber ?? null,
  })
}
