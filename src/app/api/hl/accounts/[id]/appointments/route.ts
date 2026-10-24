import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlAccountOr404, hlGuard } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/** GET ?from=ISO&to=ISO: calendars, and the appointments in the range (default: this month ± a week). */
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
  const [calendars, appointments] = await Promise.all([
    prisma.hlCalendar.findMany({ where: { accountId: id }, orderBy: { name: 'asc' } }),
    prisma.hlAppointment.findMany({
      where: { accountId: id, startTime: { gte: from, lt: to } },
      orderBy: { startTime: 'asc' },
      take: 2000,
      include: { contact: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } }, calendar: { select: { id: true, name: true } } },
    }),
  ])
  return NextResponse.json({ calendars, appointments, from, to })
}
