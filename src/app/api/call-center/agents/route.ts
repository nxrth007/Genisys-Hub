import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/agents
 * Returns a lightweight list of approved agents (id, name, email, counts)
 * for staff to filter / drill into from the call-center monitoring view.
 * Staff-only (role=agent blocked by middleware).
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const agents = await prisma.user.findMany({
    where: { role: 'agent' },
    select: {
      id: true,
      name: true,
      email: true,
      approvedAt: true,
      agentSheetTab: true,
      _count: { select: { appointments: true } },
    },
    orderBy: { name: 'asc' },
  })

  return NextResponse.json({ agents })
}
