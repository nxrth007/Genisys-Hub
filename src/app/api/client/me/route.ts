import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/client/me
 *
 * Lightweight "who am I" for client_* sessions. Used by the payment
 * step to know which package the caller picked, and by anything else
 * client-side that needs the linked Client without re-querying via
 * /api/client/appointments. No appointment data here — keeps the
 * response small.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Any client_* role is allowed — the caller might be in
  // onboarding (mid-funnel) rather than active.
  if (!session.user.role?.startsWith('client_')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const clientId = session.user.clientId
  const client = clientId
    ? await prisma.client.findUnique({
        where: { id: clientId },
        select: {
          id: true,
          name: true,
          state: true,
          package: true,
          lifecycle: true,
          contactName: true,
        },
      })
    : null

  return NextResponse.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
    },
    client,
  })
}
