import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { syncAppointmentUpdate } from '@/lib/appointment-sync'

/**
 * PATCH /api/call-center/appointments/[id]
 *
 * Staff-only editing of any agent's appointment. Lets Alex/Ethan control
 * status + notes + other fields directly from the Call Center view
 * without logging in as the agent. Middleware already blocks role=agent
 * from reaching /api/call-center/*, so the session here is always staff.
 *
 * On success, fires the sheet sync so the master spreadsheet stays
 * consistent with the Hub DB.
 */

const ALLOWED_STATUS = new Set([
  'booked',
  'rescheduled',
  'showed',
  'no_show',
  'cancelled',
])

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const data: Record<string, unknown> = {}

  const str = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    return t.length > 0 ? t : undefined
  }
  const strOrNull = (v: unknown): string | null | undefined => {
    if (v === null) return null
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    return t.length > 0 ? t : null
  }

  if (body.apptDateTime) {
    const d = new Date(String(body.apptDateTime))
    if (!isNaN(d.getTime())) data.apptDateTime = d
  }
  const cn = str(body.customerName)
  if (cn !== undefined) data.customerName = cn
  const cp = str(body.customerPhone)
  if (cp !== undefined) data.customerPhone = cp

  const addr = strOrNull(body.address)
  if (addr !== undefined) data.address = addr
  const email = strOrNull(body.email)
  if (email !== undefined) data.email = email
  const mb = strOrNull(body.monthlyBill)
  if (mb !== undefined) data.monthlyBill = mb
  const up = strOrNull(body.utilityProvider)
  if (up !== undefined) data.utilityProvider = up
  const rt = strOrNull(body.roofType)
  if (rt !== undefined) data.roofType = rt
  const ra = strOrNull(body.roofAge)
  if (ra !== undefined) data.roofAge = ra
  const edv = strOrNull(body.estimatedDealValue)
  if (edv !== undefined) data.estimatedDealValue = edv
  const notes = strOrNull(body.notes)
  if (notes !== undefined) data.notes = notes
  const crl = strOrNull(body.callRecordingLink)
  if (crl !== undefined) data.callRecordingLink = crl

  if (typeof body.status === 'string' && ALLOWED_STATUS.has(body.status)) {
    data.status = body.status
  }

  // Client reassignment — staff can reclassify after the fact if an agent
  // picked wrong. Null = clear. Unknown/inactive IDs are rejected.
  if (body.clientId === null) {
    data.clientId = null
  } else if (typeof body.clientId === 'string' && body.clientId.trim()) {
    const client = await prisma.client.findFirst({
      where: { id: body.clientId, active: true },
      select: { id: true },
    })
    if (!client) {
      return NextResponse.json(
        { error: 'That client is not available.' },
        { status: 400 }
      )
    }
    data.clientId = client.id
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const existing = await prisma.appointment.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const updated = await prisma.appointment.update({ where: { id }, data })

  // Fire-and-forget sheet re-sync so the master spreadsheet reflects the
  // staff edit. Same pattern as the agent-facing PATCH.
  syncAppointmentUpdate(updated.id).catch((err) =>
    console.error('[call-center appointments PATCH] sync failed:', err)
  )

  return NextResponse.json({ ok: true, appointment: updated })
}
