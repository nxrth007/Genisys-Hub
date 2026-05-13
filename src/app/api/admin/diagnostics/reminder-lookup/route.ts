import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/diagnostics/reminder-lookup?phone=9097322032
 *
 * Admin-only debug endpoint. Given a customer phone (or name fragment),
 * returns every AppointmentReminder + every Appointment that matches,
 * with the sourceKey + appointmentId visible so we can tell which sync
 * path each reminder came from.
 *
 * Built to chase a specific bug: customer shows up with 8 reminders
 * in the Reminders UI but only 1 Appointment in the DB. Either the
 * master sheet has 2 rows for the same person (rows 42 and 43 both
 * scheduled), or the DB+sheet paths both fired without the content-
 * key dedupe catching them. This endpoint surfaces the sourceKey on
 * each row so we can tell at a glance.
 *
 * Returns:
 *   {
 *     appointments: [{ id, apptDateTime, customerName, customerPhone, ... }],
 *     reminders: [{ id, sourceKey, reminderType, scheduledFor, status, appointmentId, sheetTabTitle, sheetRowNumber, apptDateTime, customerName, customerPhone }],
 *     summary: { dbKeyed, sheetKeyed, distinctApptTimes }
 *   }
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string }).role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const phone = (req.nextUrl.searchParams.get('phone') ?? '').trim()
  const name = (req.nextUrl.searchParams.get('name') ?? '').trim()
  if (!phone && !name) {
    return NextResponse.json(
      { error: 'pass ?phone=... or ?name=... (or both)' },
      { status: 400 },
    )
  }

  // Loose phone match — strip non-digits and look for the digit
  // sequence as a substring of the stored value. Handles "(909) 732-
  // 2032" matching "9097322032", and vice versa.
  const phoneDigits = phone.replace(/\D/g, '')
  const apptWhere: Record<string, unknown> = {}
  const reminderWhere: Record<string, unknown> = {}
  const ors: Array<Record<string, unknown>> = []
  if (phoneDigits) {
    ors.push({ customerPhone: { contains: phoneDigits } })
    // Phone in sheet form like "(909) 732-2032" — match the last 7
    // digits to keep false-positives down.
    if (phoneDigits.length >= 7) {
      ors.push({
        customerPhone: { contains: phoneDigits.slice(-7) },
      })
    }
  }
  if (name) {
    ors.push({ customerName: { contains: name, mode: 'insensitive' } })
  }
  if (ors.length > 0) {
    apptWhere.OR = ors
    reminderWhere.OR = ors
  }

  const [appointments, reminders] = await Promise.all([
    prisma.appointment.findMany({
      where: apptWhere,
      orderBy: { apptDateTime: 'asc' },
      select: {
        id: true,
        apptDateTime: true,
        customerName: true,
        customerPhone: true,
        address: true,
        status: true,
        createdAt: true,
        bookedByName: true,
        agentSheetRowNumber: true,
        masterSheetRowNumber: true,
        client: { select: { name: true } },
      },
    }),
    prisma.appointmentReminder.findMany({
      where: reminderWhere,
      orderBy: [{ apptDateTime: 'asc' }, { scheduledFor: 'asc' }],
      select: {
        id: true,
        sourceKey: true,
        reminderType: true,
        scheduledFor: true,
        status: true,
        appointmentId: true,
        sheetTabTitle: true,
        sheetRowNumber: true,
        apptDateTime: true,
        customerName: true,
        customerPhone: true,
        clientName: true,
      },
    }),
  ])

  const dbKeyed = reminders.filter((r) => r.sourceKey.startsWith('db:')).length
  const sheetKeyed = reminders.filter((r) =>
    r.sourceKey.startsWith('sheet:'),
  ).length
  const distinctApptTimes = new Set(
    reminders.map((r) => r.apptDateTime.toISOString()),
  )

  return NextResponse.json({
    appointments,
    reminders,
    summary: {
      appointmentRows: appointments.length,
      reminderRows: reminders.length,
      dbKeyed,
      sheetKeyed,
      distinctApptTimes: Array.from(distinctApptTimes),
      distinctSourceKeys: Array.from(
        new Set(reminders.map((r) => r.sourceKey)),
      ),
    },
  })
}
