import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'

/**
 * GET /api/admin/reminders
 *
 * Paginated list of AppointmentReminder rows for the Settings panel
 * + (eventually) a CRM messages tab. Filters: status, clientId,
 * reminderType. Latest-first by scheduledFor so the page leads with
 * what's about to fire (or just fired).
 */
export async function GET(req: NextRequest) {
  const denial = await requireStaff()
  if (denial) return denial

  const sp = req.nextUrl.searchParams
  const status = sp.get('status') // pending | sent | failed | skipped | cancelled | all
  const clientId = sp.get('clientId')
  const reminderType = sp.get('reminderType')
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50', 10)))

  const where: Record<string, unknown> = {}
  if (status && status !== 'all') where.status = status
  if (clientId) where.clientId = clientId
  if (reminderType) where.reminderType = reminderType

  const reminders = await prisma.appointmentReminder.findMany({
    where,
    orderBy: { scheduledFor: 'desc' },
    take: limit,
    include: {
      client: { select: { id: true, name: true, color: true } },
    },
  })

  return NextResponse.json({ reminders })
}
