import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET    /api/agent/appointments/[id]  → one appointment (must be agent's own)
 * PATCH  /api/agent/appointments/[id]  → edit any field (per Alex's answer)
 * DELETE /api/agent/appointments/[id]  → remove the appointment
 *
 * Ownership is enforced server-side: the `where` clause requires both the
 * id and agentUserId match. A non-owning agent gets a 404.
 */

const ALLOWED_STATUS = new Set([
  'booked',
  'rescheduled',
  'showed',
  'no_show',
  'cancelled',
])

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await ctx.params
  const appt = await prisma.appointment.findFirst({
    where: { id, agentUserId: session.user.id },
  })
  if (!appt) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json({ appointment: appt })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await ctx.params

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const owned = await prisma.appointment.findFirst({
    where: { id, agentUserId: session.user.id },
    select: { id: true },
  })
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const data: Record<string, unknown> = {}

  // Only copy whitelisted fields. Type-check + trim strings.
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
  const notes = strOrNull(body.notes)
  if (notes !== undefined) data.notes = notes
  const crl = strOrNull(body.callRecordingLink)
  if (crl !== undefined) data.callRecordingLink = crl

  if (typeof body.status === 'string' && ALLOWED_STATUS.has(body.status)) {
    data.status = body.status
  }

  const updated = await prisma.appointment.update({ where: { id }, data })

  // Phase 5 will fire a sheets re-sync here.

  return NextResponse.json({ ok: true, appointment: updated })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await ctx.params
  const owned = await prisma.appointment.findFirst({
    where: { id, agentUserId: session.user.id },
    select: { id: true },
  })
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await prisma.appointment.delete({ where: { id } })

  // Phase 5 will also clear the sheet rows.

  return NextResponse.json({ ok: true })
}
