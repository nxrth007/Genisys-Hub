import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/agent/appointments  → own appointments, most recent first
 * POST /api/agent/appointments  → create a new booking for the signed-in agent
 *
 * Middleware has already checked that role === 'agent' (or staff). We
 * still double-check server-side so a staff user calling this endpoint
 * can only see their own appointments (they won't have any unless they
 * booked as an agent for testing).
 */

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const appointments = await prisma.appointment.findMany({
    where: { agentUserId: session.user.id },
    orderBy: { apptDateTime: 'desc' },
  })
  return NextResponse.json({ appointments })
}

type AppointmentInput = {
  apptDateTime?: string
  customerName?: string
  customerPhone?: string
  address?: string | null
  email?: string | null
  monthlyBill?: string | null
  utilityProvider?: string | null
  roofType?: string | null
  roofAge?: string | null
  status?: string
  notes?: string | null
  callRecordingLink?: string | null
}

const ALLOWED_STATUS = new Set([
  'booked',
  'rescheduled',
  'showed',
  'no_show',
  'cancelled',
])

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: AppointmentInput
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.apptDateTime) {
    return NextResponse.json({ error: 'Appointment date/time is required.' }, { status: 400 })
  }
  if (!body.customerName || !body.customerName.trim()) {
    return NextResponse.json({ error: "Customer's name is required." }, { status: 400 })
  }
  if (!body.customerPhone || !body.customerPhone.trim()) {
    return NextResponse.json({ error: "Customer's phone number is required." }, { status: 400 })
  }

  const parsedDate = new Date(body.apptDateTime)
  if (isNaN(parsedDate.getTime())) {
    return NextResponse.json({ error: 'Invalid date/time format.' }, { status: 400 })
  }

  const status = body.status && ALLOWED_STATUS.has(body.status) ? body.status : 'booked'

  const appt = await prisma.appointment.create({
    data: {
      agentUserId: session.user.id,
      apptDateTime: parsedDate,
      customerName: body.customerName.trim(),
      customerPhone: body.customerPhone.trim(),
      address: body.address?.trim() || null,
      email: body.email?.trim() || null,
      monthlyBill: body.monthlyBill?.trim() || null,
      utilityProvider: body.utilityProvider?.trim() || null,
      roofType: body.roofType?.trim() || null,
      roofAge: body.roofAge?.trim() || null,
      status,
      notes: body.notes?.trim() || null,
      callRecordingLink: body.callRecordingLink?.trim() || null,
    },
  })

  // Sheets sync happens in Phase 5 — fire-and-forget from here once wired up.
  // For now, store the appointment locally; Phase 5 will add the append call.

  return NextResponse.json({ ok: true, appointment: appt })
}
