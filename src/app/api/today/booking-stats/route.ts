import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/today/booking-stats
 * Lightweight counter endpoint for the Today page stat cards — how many
 * Appointment rows were booked today, over the last 7 days, and lifetime.
 * "Today" is in the viewer's timezone (User.timezone, fallback ET).
 *
 * Staff-only (middleware already blocks role=agent from anything outside
 * /agent/*).
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Resolve the viewer's timezone so the "today" window matches what they
  // see on the clock, not what the Render box sees. Defaults to Eastern
  // to match the schema default.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { timezone: true },
  })
  const timeZone = user?.timezone || 'America/New_York'

  const now = new Date()
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const { fromZonedTime } = await import('date-fns-tz')
  const startOfToday = fromZonedTime(`${ymd}T00:00:00`, timeZone)
  const startOfWeekAgo = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000)
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000)

  const [bookedToday, bookedYesterday, bookedLast7Days, bookedTotal] = await Promise.all([
    prisma.appointment.count({ where: { createdAt: { gte: startOfToday } } }),
    prisma.appointment.count({
      where: { createdAt: { gte: startOfYesterday, lt: startOfToday } },
    }),
    prisma.appointment.count({ where: { createdAt: { gte: startOfWeekAgo } } }),
    prisma.appointment.count(),
  ])

  // Trend = (today - yesterday) / yesterday, rendered as a % delta. Null
  // if yesterday was 0 so the UI can omit the badge rather than render "∞".
  const trend =
    bookedYesterday > 0
      ? Math.round(((bookedToday - bookedYesterday) / bookedYesterday) * 100)
      : null

  return NextResponse.json({
    bookedToday,
    bookedYesterday,
    bookedLast7Days,
    bookedTotal,
    trend,
  })
}
