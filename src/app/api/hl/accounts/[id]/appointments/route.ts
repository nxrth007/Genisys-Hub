import { NextResponse, after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createAppointment, fireMadeTriggers, type StaffAppointmentInput } from '@/lib/hl/appointments'
import { googleBusy } from '@/lib/hl/google-calendar'
import { hlAccountOr404, hlError, hlGuard, jsonBody } from '@/lib/hl/http'
import { staffOf } from '@/lib/hl/staff'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET ?from=ISO&to=ISO: calendars, staff, and the appointments (and blocked-off time) in the range (default: this month
 * ± a week), with the busy times on the team's connected Google Calendars (`outside`).
 */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const sp = new URL(req.url).searchParams
  const now = new Date()
  const from = sp.get('from') ? new Date(sp.get('from')!) : new Date(now.getFullYear(), now.getMonth(), -6)
  const to = sp.get('to') ? new Date(sp.get('to')!) : new Date(now.getFullYear(), now.getMonth() + 1, 7)
  const [calendars, appointments, staff] = await Promise.all([
    prisma.hlCalendar.findMany({ where: { accountId: id }, orderBy: { name: 'asc' } }),
    prisma.hlAppointment.findMany({
      // Overlapping the range, so an evening that runs past midnight still shows.
      where: { accountId: id, startTime: { lt: to }, endTime: { gt: from } },
      orderBy: { startTime: 'asc' },
      take: 3000,
      include: { contact: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } }, calendar: { select: { id: true, name: true } } },
    }),
    staffOf(id),
  ])
  const outside = await googleBusy(id, staff.map((s) => s.ghlId ?? s.id), from, to).catch(() => [])
  return NextResponse.json({ calendars, appointments, staff, timezone: account.timezone, from, to, outside: outside.map((b) => ({ start: b.start, end: b.end, member: b.member })) })
}

/**
 * POST { kind: 'appointment' | 'block', calendarId, contactId | contact, start, end | duration,
 * assignedUserId?, title?, address?, notes?, status?, ignoreAvailability? }: an appointment booked
 * by staff (fires "appointment booked"), or blocked-off time.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = (await jsonBody(req)) as unknown as StaffAppointmentInput
    const made = await createAppointment(id, body, guard.email)
    after(() => fireMadeTriggers(id, made).catch((err) => console.error('[hell-level] appointment automations failed:', err)))
    return NextResponse.json(made)
  } catch (err) {
    return hlError(err, 'new appointment')
  }
}
