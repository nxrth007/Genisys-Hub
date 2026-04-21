import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { syncAppointmentCreate } from '@/lib/appointment-sync'
import { findConflicts } from '@/lib/appointment-conflicts'

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
    include: {
      client: { select: { id: true, name: true, state: true, color: true } },
    },
  })
  return NextResponse.json({ appointments })
}

type AppointmentInput = {
  apptDateTime?: string
  clientId?: string
  customerName?: string
  customerPhone?: string
  address?: string | null
  email?: string | null
  monthlyBill?: string | null
  utilityProvider?: string | null
  roofType?: string | null
  roofAge?: string | null
  status?: string
  estimatedDealValue?: string | null
  notes?: string | null
  callRecordingLink?: string | null
  /**
   * IDs of conflicts the agent has already acknowledged (ticked "Book anyway"
   * for) on the client. If a server-side re-check finds conflicts that
   * aren't in this list, a new booking slipped in during the form-fill
   * and we bounce back a 409 so the UI can re-prompt.
   */
  acknowledgedConflictIds?: string[]
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
  if (!body.clientId || !body.clientId.trim()) {
    return NextResponse.json(
      { error: 'Please select which client this appointment is for.' },
      { status: 400 }
    )
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

  // Verify the client exists + is active before we commit the FK.
  const client = await prisma.client.findFirst({
    where: { id: body.clientId, active: true },
    select: { id: true },
  })
  if (!client) {
    return NextResponse.json(
      { error: 'That client is not available. Refresh and try again.' },
      { status: 400 }
    )
  }

  const status = body.status && ALLOWED_STATUS.has(body.status) ? body.status : 'booked'

  // Server-side conflict re-check to close the race where two agents both
  // submit after each saw "no conflicts" in their form. Running inside a
  // transaction shrinks (but doesn't eliminate) the race window; the
  // acknowledged-ids comparison handles the "you accepted conflict A, but
  // someone just booked conflict B" case by returning 409 with the new set.
  const acknowledgedSet = new Set(body.acknowledgedConflictIds || [])

  let appt
  try {
    appt = await prisma.$transaction(async (tx) => {
      const currentConflicts = await findConflicts({
        apptDateTime: parsedDate,
        excludeId: undefined,
        tx,
      })
      const unacknowledged = currentConflicts.filter(
        (c) => !acknowledgedSet.has(c.id)
      )
      if (unacknowledged.length > 0) {
        // Throw a sentinel error with the conflict payload — caught below
        // and returned as 409. Any other throw is a real server error.
        const err = new Error('conflict') as Error & {
          __conflict?: true
          conflicts?: typeof currentConflicts
        }
        err.__conflict = true
        err.conflicts = currentConflicts
        throw err
      }

      return tx.appointment.create({
        data: {
          agentUserId: session.user.id,
          clientId: client.id,
          apptDateTime: parsedDate,
          customerName: body.customerName!.trim(),
          customerPhone: body.customerPhone!.trim(),
          address: body.address?.trim() || null,
          email: body.email?.trim() || null,
          monthlyBill: body.monthlyBill?.trim() || null,
          utilityProvider: body.utilityProvider?.trim() || null,
          roofType: body.roofType?.trim() || null,
          roofAge: body.roofAge?.trim() || null,
          status,
          estimatedDealValue: body.estimatedDealValue?.trim() || null,
          notes: body.notes?.trim() || null,
          callRecordingLink: body.callRecordingLink?.trim() || null,
        },
      })
    })
  } catch (err) {
    if ((err as { __conflict?: boolean }).__conflict) {
      return NextResponse.json(
        {
          error:
            'Another booking just landed in this time slot. Review the updated conflicts and confirm if you still want to proceed.',
          conflicts:
            (err as { conflicts?: unknown }).conflicts || [],
          code: 'CONFLICT_RACE',
        },
        { status: 409 }
      )
    }
    throw err
  }

  // Fire-and-forget sheets sync. Errors are surfaced on the appointment
  // record's syncError field for the UI; we don't block the client response.
  syncAppointmentCreate(appt.id).catch((err) =>
    console.error('[appointments POST] sync scheduling failed:', err)
  )

  return NextResponse.json({ ok: true, appointment: appt })
}
