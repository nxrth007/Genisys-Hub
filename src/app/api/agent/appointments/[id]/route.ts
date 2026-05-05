import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { syncAppointmentUpdate, syncAppointmentDelete } from '@/lib/appointment-sync'
import { upsertRemindersForAppointment } from '@/lib/reminders'
import { normalizeRoofAge } from '@/lib/normalize'
import { snapshotSolarFromCache } from '@/lib/solar'

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
    include: {
      client: { select: { id: true, name: true, state: true, color: true } },
    },
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
  // strOrNull does plain trim(); roofAge gets the smarter normalizer
  // so "5" becomes "5 years" on its way into the DB (and from there
  // into the master sheet on next sync).
  if (body.roofAge !== undefined) data.roofAge = normalizeRoofAge(body.roofAge)
  const edv = strOrNull(body.estimatedDealValue)
  if (edv !== undefined) data.estimatedDealValue = edv
  const notes = strOrNull(body.notes)
  if (notes !== undefined) data.notes = notes
  const crl = strOrNull(body.callRecordingLink)
  if (crl !== undefined) data.callRecordingLink = crl
  const bbn = strOrNull(body.bookedByName)
  if (bbn !== undefined) data.bookedByName = bbn

  if (typeof body.status === 'string' && ALLOWED_STATUS.has(body.status)) {
    data.status = body.status
  }

  // Client reassignment. Allow null to clear (edge case), but reject
  // unknown/inactive IDs so the FK stays clean.
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

  const updated = await prisma.appointment.update({ where: { id }, data })

  // If the address moved (or was set for the first time), refresh
  // the solar snapshot from cache. Same cache-only contract as the
  // create path — never triggers a billable lookup. Lets a stored
  // appointment pick up solar data later if Mary checks it via the
  // edit form's "Check solar potential" button.
  if (typeof data.address === 'string' && data.address) {
    try {
      const summary = await snapshotSolarFromCache(data.address)
      if (summary) {
        await prisma.appointment.update({
          where: { id },
          data: { solarSummary: summary },
        })
      }
    } catch (err) {
      console.error('[appointments PATCH] solar snapshot failed:', err)
    }
  }

  // Fire-and-forget sheets re-sync. Preserves row numbers if we have them,
  // falls back to an append if sync had previously failed.
  syncAppointmentUpdate(updated.id).catch((err) =>
    console.error('[appointments PATCH] sync scheduling failed:', err)
  )

  // Refresh customer-SMS reminder snapshots — picks up edited
  // customer name / phone / appt time before the next dispatch
  // tick. The upsert reschedules pending reminders if apptDateTime
  // shifted, but leaves already-sent / skipped rows alone.
  void upsertRemindersForAppointment(updated.id).catch((err) =>
    console.error('[appointments PATCH] reminders refresh threw:', err),
  )

  return NextResponse.json({ ok: true, appointment: updated })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await ctx.params
  // Pull the row numbers + the agent's tab title BEFORE deleting so we can
  // clear the corresponding sheet rows afterward.
  const owned = await prisma.appointment.findFirst({
    where: { id, agentUserId: session.user.id },
    include: {
      agent: { select: { agentSheetTab: true } },
    },
  })
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await prisma.appointment.delete({ where: { id } })

  // Fire-and-forget sheet row clear.
  syncAppointmentDelete({
    agentTabTitle: owned.agent.agentSheetTab,
    agentRowNumber: owned.agentSheetRowNumber,
    masterRowNumber: owned.masterSheetRowNumber,
  }).catch((err) => console.error('[appointments DELETE] sync failed:', err))

  return NextResponse.json({ ok: true })
}
