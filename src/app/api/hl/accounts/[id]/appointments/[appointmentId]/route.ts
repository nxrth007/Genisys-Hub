import { NextResponse, after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { deleteBlock, updateAppointment, type StaffAppointmentChange } from '@/lib/hl/appointments'
import { fireStatusTrigger } from '@/lib/hl/booking'
import { syncAppointmentToGoogle } from '@/lib/hl/google-calendar'
import { hlError, jsonBody, hlAccountGuard } from '@/lib/hl/http'
import { publicBase } from '@/lib/hl/twilio'

type Ctx = { params: Promise<{ id: string; appointmentId: string }> }

async function owned(id: string, appointmentId: string) {
  const a = await prisma.hlAppointment.findUnique({ where: { id: appointmentId }, select: { accountId: true } })
  return !!a && a.accountId === id
}

/**
 * PATCH { status?, start?, end?, duration?, assignedUserId?, title?, address?, notes?, ignoreAvailability?, series? }:
 * change an appointment from the calendar. A new status fires "Appointment status". { status: 'cancelled',
 * series: 'following' } cancels the rest of its series too.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id, appointmentId } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  if (!(await owned(id, appointmentId))) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })
  try {
    const body = (await jsonBody(req)) as unknown as StaffAppointmentChange
    const { statusChanged, moved, alsoCancelled } = await updateAppointment(id, appointmentId, body, guard.email)
    // A move is GHL's "rescheduled" (automations and the calendar's notifications); then any new status.
    after(async () => {
      try {
        if (moved && statusChanged !== 'cancelled') await fireStatusTrigger(appointmentId, 'rescheduled')
        if (statusChanged) await fireStatusTrigger(appointmentId, statusChanged)
        // Other changes (its title, team member, location) go to Google Calendar too.
        if (!moved && !statusChanged) await syncAppointmentToGoogle(appointmentId)
        for (const x of alsoCancelled) await syncAppointmentToGoogle(x)
      } catch (err) {
        console.error('[hell-level] appointment automations failed:', err)
      }
    })
    const updated = await prisma.hlAppointment.findUniqueOrThrow({ where: { id: appointmentId } })
    return NextResponse.json({ appointment: { ...updated, manageUrl: updated.token ? `${publicBase()}/hl/a/${updated.token}` : null } })
  } catch (err) {
    return hlError(err, 'appointment')
  }
}

/** DELETE: blocked-off time only (appointments are cancelled, so their automations stop). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id, appointmentId } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  if (!(await owned(id, appointmentId))) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })
  try {
    await deleteBlock(id, appointmentId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'delete blocked time')
  }
}
