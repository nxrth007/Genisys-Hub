import { NextResponse, after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fireStatusTrigger, setStatus } from '@/lib/hl/booking'
import { hlError, hlGuard, jsonBody } from '@/lib/hl/http'
import { publicBase } from '@/lib/hl/twilio'

type Ctx = { params: Promise<{ id: string; appointmentId: string }> }

/** PATCH { status }: confirmed, showed, noshow, cancelled… (fires "Appointment status"). */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, appointmentId } = await params
  const a = await prisma.hlAppointment.findUnique({ where: { id: appointmentId }, select: { accountId: true, status: true } })
  if (!a || a.accountId !== id) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    const status = typeof body.status === 'string' ? body.status : ''
    const updated = await setStatus(appointmentId, status, guard.email)
    if (a.status !== status) after(() => fireStatusTrigger(appointmentId, status).catch((err) => console.error('[hell-level] status automations failed:', err)))
    return NextResponse.json({ appointment: { ...updated, manageUrl: updated.token ? `${publicBase()}/hl/a/${updated.token}` : null } })
  } catch (err) {
    return hlError(err, 'appointment status')
  }
}
