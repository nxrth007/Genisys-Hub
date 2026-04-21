import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/clients
 * Returns the active client list (Brighton Capital Solar, Spring Solar, …).
 * Used by both the agent appointment form and staff filters.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const clients = await prisma.client.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, state: true, color: true },
  })
  return NextResponse.json({ clients })
}
