import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { syncAppointmentUpdate } from '@/lib/appointment-sync'
import { recordAppointmentEdit, diffSnapshots } from '@/lib/appointment-edit-log'
import { sendStatusUpdateAlert } from '@/lib/status-update-alert'
import { getPublicOrigin } from '@/lib/gmail'

/**
 * PATCH /api/client/appointments/[id]/outcome
 *
 * Lets the agency client (not the homeowner) update an appointment's
 * status from their /client dashboard.
 *
 * Two phases of client ownership:
 *   1. Show outcome: did the prospect actually show up?
 *        Valid transitions: {booked, rescheduled, showed, no_show}
 *                       → {showed, no_show}
 *      Mary owns booked/rescheduled until the appointment time has
 *      passed; the client owns showed/no_show because only they
 *      know if the prospect actually walked in.
 *
 *   2. Deal outcome: did we close the sit-down?
 *        Valid transitions: {showed, won, lost} → {won, lost, showed}
 *      'clear' resets won/lost back to plain showed (oops, misclicked).
 *
 * The client can also attach free-form notes via the `notes` field,
 * stored in Appointment.clientNotes — separate from Appointment.notes
 * (Mary's notes) so neither perspective overwrites the other.
 *
 * Authorization: appointment.clientId must match the caller's
 * session.user.clientId. A client can never touch another client's
 * pipeline regardless of what id they put in the URL.
 *
 * Cancelled appointments are terminal for the client — admin owns
 * resurrection if they need it.
 *
 * Body: {
 *   outcome: 'showed' | 'no_show' | 'won' | 'lost' | 'clear',
 *   notes?: string,   // optional, replaces clientNotes when present
 * }
 */

/** Transitions the client is allowed to make.
 *  Source status → set of target statuses they can set it to. */
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  // Pre-appointment — client decides if it happened.
  booked: new Set(['showed', 'no_show']),
  rescheduled: new Set(['showed', 'no_show']),
  // Post-appointment "did they show" corrections AND deal outcomes.
  showed: new Set(['showed', 'no_show', 'won', 'lost']),
  no_show: new Set(['showed', 'no_show']),
  // Won / lost can be cleared back to showed (the 'clear' outcome)
  // or flipped between each other.
  won: new Set(['won', 'lost', 'showed']),
  lost: new Set(['won', 'lost', 'showed']),
  // cancelled is terminal for the client — admin owns resurrection.
}

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
  let body: { outcome?: unknown; notes?: unknown }
  try {
    body = (await req.json()) as { outcome?: unknown; notes?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Resolve the requested outcome → concrete target status.
  const outcomeRaw = typeof body.outcome === 'string' ? body.outcome : ''
  let targetStatus: 'showed' | 'no_show' | 'won' | 'lost'
  if (outcomeRaw === 'showed') targetStatus = 'showed'
  else if (outcomeRaw === 'no_show') targetStatus = 'no_show'
  else if (outcomeRaw === 'won') targetStatus = 'won'
  else if (outcomeRaw === 'lost') targetStatus = 'lost'
  else if (outcomeRaw === 'clear') targetStatus = 'showed'
  else {
    return NextResponse.json(
      {
        error:
          'outcome must be one of "showed", "no_show", "won", "lost", or "clear"',
      },
      { status: 400 },
    )
  }

  // Notes — optional. When the caller sends `notes`, we overwrite
  // clientNotes (treating each update as a fresh client write). When
  // they omit it, we leave the existing clientNotes alone. Empty
  // string is treated as "clear my notes".
  let nextNotes: string | null | undefined
  if (typeof body.notes === 'string') {
    const trimmed = body.notes.trim()
    nextNotes = trimmed.length > 0 ? trimmed : null
  } else if (body.notes === null) {
    nextNotes = null
  } else {
    nextNotes = undefined // signal "don't touch"
  }

  // Pull the existing row so we can validate the transition AND
  // capture a before-snapshot for the edit log.
  const before = await prisma.appointment.findFirst({
    where: { id, clientId },
    select: {
      id: true,
      status: true,
      clientNotes: true,
      clientId: true,
      apptDateTime: true,
      customerName: true,
      customerPhone: true,
      address: true,
      client: { select: { name: true } },
    },
  })
  if (!before) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const allowed = ALLOWED_TRANSITIONS[before.status] ?? new Set<string>()
  if (!allowed.has(targetStatus)) {
    return NextResponse.json(
      {
        error: `Can't change this appointment from "${before.status}" to "${targetStatus}". Reach out to your account manager if you think this is wrong.`,
      },
      { status: 409 },
    )
  }

  // Build the update payload — only include clientNotes when the
  // caller actually sent a value (or null to clear). Always stamp
  // clientStatusUpdatedAt so the master tracker can show "client
  // updated 5 min ago".
  //
  // Reset the review state on every client update — if Ethan already
  // marked the previous version of this update reviewed, the client
  // posting a new outcome / new notes should re-surface the row as
  // unreviewed so it doesn't slip past admin. Mirrors how Gmail
  // re-bolds a thread when a new message lands.
  const data: Record<string, unknown> = {
    status: targetStatus,
    clientStatusUpdatedAt: new Date(),
    clientStatusReviewedAt: null,
    clientStatusReviewedById: null,
  }
  if (nextNotes !== undefined) {
    data.clientNotes = nextNotes
  }

  const updated = await prisma.appointment.update({
    where: { id },
    data,
    select: {
      id: true,
      status: true,
      clientNotes: true,
      clientStatusUpdatedAt: true,
    },
  })

  // Audit log — same shape as Hub-form / master-tracker edits so the
  // /agents → "Appointment edits" tab surfaces client-side changes
  // alongside Mary's. The editor is the client_active user, not Mary.
  const editorEmail = session.user.email ?? null
  const editorName =
    (session.user as { name?: string | null }).name ?? null
  const changes = diffSnapshots(
    { status: before.status, clientNotes: before.clientNotes },
    { status: updated.status, clientNotes: updated.clientNotes },
    ['status', 'clientNotes'] as const,
  )
  if (Object.keys(changes).length > 0) {
    void recordAppointmentEdit({
      appointmentId: updated.id,
      clientId: before.clientId,
      clientName: before.client?.name ?? null,
      editorUserId: session.user.id,
      editorEmail,
      editorName,
      customerName: before.customerName,
      customerPhone: before.customerPhone,
      apptDateTime: before.apptDateTime,
      source: 'agent-form',
      changes,
    })
  }

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

  // Slack alert to #genisys-alerts so admin sees the update on
  // their phone instead of having to remember to refresh the
  // triage page. Strictly fire-and-forget — sendStatusUpdateAlert
  // catches every error internally, but we still detach with void
  // + catch so a missed catch can't poison the response.
  void sendStatusUpdateAlert({
    appointmentId: updated.id,
    clientName: before.client?.name ?? 'Unknown client',
    customerName: before.customerName,
    customerPhone: before.customerPhone,
    address: before.address,
    apptDateTime: before.apptDateTime,
    previousStatus: before.status,
    newStatus: updated.status,
    notes: updated.clientNotes,
    actorLabel: editorName ?? editorEmail ?? 'a client login',
    hubOrigin: getPublicOrigin(req),
  }).catch((err) =>
    console.error(
      `[client/appointments/outcome] Slack alert failed for ${updated.id}:`,
      err,
    ),
  )

  return NextResponse.json({ ok: true, appointment: updated })
}
