import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/client/appointments
 *
 * Returns every appointment booked for the logged-in client. Read-only
 * — clients can see what we've delivered to them, but can't edit, mark
 * showed/no-show, or otherwise mutate state. That stays admin/agent.
 *
 * Filter is server-side on session.user.clientId so a tampered query
 * string can't leak another client's pipeline. Middleware already
 * blocks non-client_active roles before this handler runs; the
 * defensive checks here are belt-and-suspenders for future regressions.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'client_active') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const clientId = session.user.clientId
  if (!clientId) {
    // A client_active user with no clientId is a misconfigured row —
    // don't leak everyone's appointments by returning an unfiltered
    // list. Empty result + a hint lets admin spot the issue quickly.
    return NextResponse.json({
      appointments: [],
      client: null,
      warning: 'no client linked to this account',
    })
  }

  const [client, appointments] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        name: true,
        state: true,
        color: true,
        package: true,
        apptCap: true,
      },
    }),
    prisma.appointment.findMany({
      where: { clientId },
      orderBy: { apptDateTime: 'desc' },
      select: {
        id: true,
        apptDateTime: true,
        customerName: true,
        customerPhone: true,
        address: true,
        email: true,
        monthlyBill: true,
        utilityProvider: true,
        roofType: true,
        roofAge: true,
        status: true,
        estimatedDealValue: true,
        notes: true,
        bookedByName: true,
        createdAt: true,
      },
    }),
  ])

  return NextResponse.json({ client, appointments })
}
