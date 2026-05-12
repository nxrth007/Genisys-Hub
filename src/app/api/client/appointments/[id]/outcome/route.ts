import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { syncAppointmentUpdate } from '@/lib/appointment-sync'

/**
 * PATCH /api/client/appointments/[id]/outcome
 *
 * Lets the client (the agency client, not the homeowner) mark an
 * appointment as Won or Lost — the one piece of pipeline state where
 * THEY are the source of truth, not Mary. Closes the feedback loop
 * automatically so Mary doesn't have to call them back to ask.
 *
 * Authorization: appointment.clientId must match the caller's
 * session.user.clientId. A client can never touch another client's
 * pipeline regardless of what id they put in the URL.
 *
 * State machine guard: only flips between {showed, won, lost}. A client
 * can't mark a booked-but-not-yet-happened appointment as Won, nor
 * resurrect a no_show / cancelled appointment. Mary owns those.
 *
 * Body: { outcome: 'won' | 'lost' | 'clear' }
 *   - 'won'   → status = 'won'
 *   - 'lost'  → status = 'lost'
 *   - 'clear' → status = 'showed'  (oops, misclicked the wrong row)
 */
const ALLOWED_INCOMING_STATUS = new Set(['showed', 'won', 'lost'])

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'client_active') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const clientId = session.user.clientId
  if (!clientId) {
    return NextResponse.json(
      { error: 'no client linked to this account' },
      { status: 400 },
    )
  }

  const { id } = await ctx.params
  let body: { outcome?: unknown }
  try {
    body = (await req.json()) as { outcome?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const outcome = typeof body.outcome === 'string' ? body.outcome : ''
  let nextStatus: 'won' | 'lost' | 'showed'
  if (outcome === 'won') nextStatus = 'won'
  else if (outcome === 'lost') nextStatus = 'lost'
  else if (outcome === 'clear') nextStatus = 'showed'
  else {
    return NextResponse.json(
      { error: 'outcome must be "won", "lost", or "clear"' },
      { status: 400 },
    )
  }

  // Double-check ownership AND current status in a single read so we
  // don't accidentally let a client flip a no_show into Won.
  const appt = await prisma.appointment.findFirst({
    where: { id, clientId },
    select: { id: true, status: true },
  })
  if (!appt) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!ALLOWED_INCOMING_STATUS.has(appt.status)) {
    return NextResponse.json(
      {
        error:
          'This appointment can only be marked Won/Lost after it has been recorded as showed. Reach out to your account manager if you think this is wrong.',
      },
      { status: 409 },
    )
  }

  const updated = await prisma.appointment.update({
    where: { id },
    data: { status: nextStatus },
    select: { id: true, status: true },
  })

  // Mirror the agent-side PATCH: sync the status flip out to the
  // master + agent sheets so admin's view doesn't drift from the
  // client's. Fire-and-forget — a transient Sheets API hiccup
  // shouldn't fail the user's click.
  syncAppointmentUpdate(updated.id).catch((err) =>
    console.error(
      `[client/appointments/outcome] sheet sync failed for ${updated.id}:`,
      err,
    ),
  )

  return NextResponse.json({ ok: true, appointment: updated })
}
