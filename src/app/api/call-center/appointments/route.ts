import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/appointments
 * Returns every agent's appointments (staff-only; middleware already blocks
 * role=agent from reaching this route). Supports filters:
 *   status  — booked|rescheduled|showed|no_show|cancelled|all (default all)
 *   agent   — filter by a specific agent userId, "all" by default
 *   since   — ISO date; only appointments on/after this appt date
 *   until   — ISO date; only appointments on/before this appt date
 *   q       — free-text search across name / phone / address / email / notes
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const where: Record<string, unknown> = {}
  const status = sp.get('status')
  if (status && status !== 'all') where.status = status

  const agent = sp.get('agent')
  if (agent && agent !== 'all') where.agentUserId = agent

  const client = sp.get('client')
  if (client && client !== 'all') {
    // Sentinel "none" for "no client assigned" — lets staff see legacy rows.
    where.clientId = client === 'none' ? null : client
  }

  const since = sp.get('since')
  const until = sp.get('until')
  if (since || until) {
    const date: Record<string, Date> = {}
    if (since) {
      const d = new Date(since)
      if (!isNaN(d.getTime())) date.gte = d
    }
    if (until) {
      const d = new Date(until)
      if (!isNaN(d.getTime())) date.lte = d
    }
    where.apptDateTime = date
  }

  const q = sp.get('q')?.trim()
  if (q) {
    where.OR = [
      { customerName: { contains: q, mode: 'insensitive' } },
      { customerPhone: { contains: q } },
      { address: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { notes: { contains: q, mode: 'insensitive' } },
    ]
  }

  const appointments = await prisma.appointment.findMany({
    where,
    orderBy: { apptDateTime: 'desc' },
    take: 500,
    include: {
      agent: {
        select: { id: true, name: true, email: true },
      },
      client: {
        select: { id: true, name: true, state: true, color: true },
      },
    },
  })

  return NextResponse.json({ appointments })
}
