import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/reminders
 *
 * Staff-accessible (admin or member; agents blocked by middleware)
 * paginated list of AppointmentReminder rows. Powers the Call Center
 * → Reminders tab. Mirrors /api/admin/reminders but lives under the
 * call-center namespace so member staff (Ethan) can browse without
 * needing admin role.
 *
 * Filters: status, clientId, reminderType, search query (matches
 * customerName / customerPhone). Latest-first by scheduledFor so
 * the page leads with what's about to fire.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const status = sp.get('status')
  const clientId = sp.get('clientId')
  const reminderType = sp.get('reminderType')
  const q = sp.get('q')?.trim()
  const limit = Math.min(500, Math.max(1, parseInt(sp.get('limit') || '100', 10)))

  const where: Record<string, unknown> = {}
  if (status && status !== 'all') where.status = status
  if (clientId && clientId !== 'all') where.clientId = clientId
  if (reminderType && reminderType !== 'all') where.reminderType = reminderType
  if (q) {
    where.OR = [
      { customerName: { contains: q, mode: 'insensitive' } },
      { customerPhone: { contains: q } },
    ]
  }

  const reminders = await prisma.appointmentReminder.findMany({
    where,
    orderBy: { scheduledFor: 'desc' },
    take: limit,
    include: {
      client: { select: { id: true, name: true, color: true } },
    },
  })

  // Counts per status for the filter chips, computed off the *full*
  // unfiltered set so the chip badges show real totals.
  const allCounts = await prisma.appointmentReminder.groupBy({
    by: ['status'],
    _count: { _all: true },
  })
  const counts: Record<string, number> = {}
  for (const c of allCounts) counts[c.status] = c._count._all

  return NextResponse.json({ reminders, counts })
}
