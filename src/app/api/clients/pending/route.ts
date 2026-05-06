import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/clients/pending
 *
 * Lists clients awaiting admin review (lifecycle="pending"). Powers
 * the Pending tab on /clients/onboarding. Includes the linked client_*
 * user so admin can see who registered + when, and email comms can
 * pre-fill the right address on approve/deny.
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

  const clients = await prisma.client.findMany({
    where: { lifecycle: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      state: true,
      color: true,
      package: true,
      contactName: true,
      contactRole: true,
      contactEmail: true,
      contactPhone: true,
      address: true,
      servicingZipcodes: true,
      createdAt: true,
      users: {
        select: {
          id: true,
          email: true,
          role: true,
          createdAt: true,
        },
      },
    },
  })

  return NextResponse.json({ clients })
}
