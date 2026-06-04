import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/agents
 * Returns every agent (pending, approved, denied) with basic stats.
 * Admin-only — middleware enforces role=admin before reaching this handler.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const agents = await prisma.user.findMany({
    where: {
      role: { in: ['agent_pending', 'agent', 'agent_denied'] },
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      agentSheetTab: true,
      approvedAt: true,
      managesTeamNumber: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { appointments: true } },
    },
    orderBy: [
      // Pending first (they need attention), then approved by most recent
      { role: 'asc' },
      { createdAt: 'desc' },
    ],
  })

  return NextResponse.json({ agents })
}
