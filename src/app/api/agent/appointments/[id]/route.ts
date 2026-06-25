import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { syncAppointmentUpdate, syncAppointmentDelete } from '@/lib/appointment-sync'
import {
  upsertRemindersForAppointment,
  sendRescheduleConfirmation,
} from '@/lib/reminders'
import { postRescheduleToClientChannel } from '@/lib/client-delivery'
import { deliverAppointmentAsSms } from '@/lib/client-alert'
import { triggerDispatchAutomations } from '@/lib/dispatch-automations'
import { normalizeRoofAge } from '@/lib/normalize'
import { snapshotSolarFromCache } from '@/lib/solar'
import {
  diffSnapshots,
  recordAppointmentEdit,
} from '@/lib/appointment-edit-log'
import { qualifyingTimestampFor } from '@/lib/appointment-qualification'

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
  'dispatched',
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

  // Pull the pre-edit snapshot for the audit log. Only the fields the
  // PATCH can actually modify — anything else (createdAt, agentUserId,
  // etc.) isn't user-editable, so capturing it would just be noise.
  const before = await prisma.appointment.findFirst({
    where: { id, agentUserId: session.user.id },
    select: {
      id: true,
      apptDateTime: true,
      customerName: true,
      customerPhone: true,
      address: true,
      email: true,
      monthlyBill: true,
      utilityProvider: true,
      roofType: true,
      roofAge: true,
      estimatedDealValue: true,
      notes: true,
      callRecordingLink: true,
      bookedByName: true,
      status: true,
      clientId: true,
      client: { select: { id: true, name: true } },
    },
  })
  if (!before) return NextResponse.json({ error: 'not found' }, { status: 404 })

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
    // PPA invoicing qualifying timestamp — only stamps when the
    // editor's role is admin/member/client_active (NOT agent).
    // Mary (role=agent) editing her own appointment to "showed"
    // doesn't bill the client; she'd need Alex/Ethan to confirm
    // via call-center, or the client themselves to confirm via
    // their dashboard.
    const role = (session.user as { role?: string }).role
    const qualifyingAt = qualifyingTimestampFor(role, body.status)
    if (qualifyingAt) {
      data.qualifyingStatusUpdatedAt = qualifyingAt
    }
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

  // Audit log — diff before vs after on the editable fields and
  // write a row if anything actually changed. Fire-and-forget so a
  // slow write here doesn't stall the user's save. Nothing about
  // this is on the critical path; if it fails, the appointment
  // edit still landed correctly.
  const auditKeys = [
    'apptDateTime',
    'customerName',
    'customerPhone',
    'address',
    'email',
    'monthlyBill',
    'utilityProvider',
    'roofType',
    'roofAge',
    'estimatedDealValue',
    'notes',
    'callRecordingLink',
    'bookedByName',
    'status',
    'clientId',
  ] as const
  const changes = diffSnapshots(
    before as unknown as Record<string, unknown>,
    updated as unknown as Record<string, unknown>,
    auditKeys,
  )
  if (Object.keys(changes).length > 0) {
    // Pull editor's display name from the session user record. Snapshot
    // both at write time so the log row reads cleanly even if the user
    // gets removed later.
    const editor = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { name: true, email: true },
    })
    void recordAppointmentEdit({
      appointmentId: updated.id,
      clientId: updated.clientId,
      clientName: before.client?.name ?? null,
      editorUserId: session.user.id,
      editorEmail: editor?.email ?? null,
      editorName: editor?.name ?? null,
      customerName: updated.customerName,
      customerPhone: updated.customerPhone,
      apptDateTime: updated.apptDateTime,
      source: 'agent-form',
      changes,
    })
  }

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

  // Did this edit FLIP the appointment into "dispatched"?
  const becameDispatched =
    before.status !== 'dispatched' && updated.status === 'dispatched'

  if (becameDispatched) {
    // Agent dispatched their own appointment from the edit form — fire
    // the full client-facing set (Slack channel post, client SMS/email)
    // and arm the four same-day customer reminders. Confirmation
    // already went out at booking.
    triggerDispatchAutomations(updated.id)
  } else {
    // Plain edit — refresh customer-SMS reminder snapshots so a fixed
    // name / phone / appt time is picked up before the next dispatch
    // tick. The gated upsert only re-arms the timed reminders if the
    // appt is already dispatched; otherwise it just touches the
    // confirmation snapshot.
    void upsertRemindersForAppointment(updated.id).catch((err) =>
      console.error('[appointments PATCH] reminders refresh threw:', err),
    )

    // Roll the client-alert buffer forward ONLY when the appt is
    // already dispatched (a pending client alert can only exist after
    // dispatch now) — so a corrected typo reaches the client, not a
    // premature send for a not-yet-dispatched appointment.
    if (updated.status === 'dispatched') {
      void deliverAppointmentAsSms(updated.id).then((result) => {
        if (result.status !== 'disabled' && result.status !== 'skipped') {
          console.log(
            `[appointments PATCH] client-alert ${result.status}${result.reason ? ` (${result.reason})` : ''} for ${updated.id}`,
          )
        }
      }).catch((err) =>
        console.error('[appointments PATCH] client-alert refresh threw:', err),
      )
    }
  }

  // Reschedule flow parity with the master-tracker path: when the
  // appointment TIME actually moved, notify the client's Slack
  // channel of the new time, and on an explicit "rescheduled" mark
  // text the customer their new time. The reminder re-arm already
  // ran via upsertRemindersForAppointment above. All fire-and-forget.
  const timeChanged =
    before.apptDateTime.getTime() !== updated.apptDateTime.getTime()
  if (timeChanged) {
    void postRescheduleToClientChannel(updated.id).catch((err) =>
      console.error(
        '[appointments PATCH] reschedule channel post threw:',
        err,
      ),
    )
    if (updated.status === 'rescheduled') {
      void sendRescheduleConfirmation({
        customerName: updated.customerName,
        customerPhone: updated.customerPhone,
        clientName: before.client?.name ?? null,
        apptDateTime: updated.apptDateTime,
        address: updated.address,
      }).catch((err) =>
        console.error(
          '[appointments PATCH] reschedule confirmation threw:',
          err,
        ),
      )
    }
  }

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
