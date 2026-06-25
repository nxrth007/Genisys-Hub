import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { triggerDispatchAutomations } from '@/lib/dispatch-automations'

/**
 * POST /api/call-center/dispatch-status  body { rowNumber, dispatchStatus }
 *
 * Sets an appointment's Hub-only Dispatch Status (the master-tracker
 * dropdown). This is the automation gate: the moment it flips INTO
 * 'dispatched', the client details + the four same-day customer
 * reminders fire (once — only on the transition). Moving into a hold
 * state (not_dispatched / reschedule_requested) cancels the
 * appointment's pending timed reminders so the customer stops getting
 * texts. Other values are plain markers.
 *
 * DB-only — the dispatch status is NOT a Google Sheet column, so this
 * never touches the sheet. Keyed by masterSheetRowNumber (the row id
 * the master tracker uses). Open to the staff who run the tracker:
 * admin + the call-center agents.
 */
const ALLOWED_ROLES = new Set(['admin', 'member', 'agent', 'team_member'])

const VALID_STATUSES = new Set([
  'not_dispatched',
  'dispatched',
  'confirmed',
  'reschedule_requested',
  'needs_review',
])

// "Confirmed" is the go state: only it fires automations + arms the
// timed reminders. Moving into any of these non-go states cancels the
// appointment's pending timed reminders (confirmation already went out
// at booking and is left alone). needs_review is a passive flag and is
// intentionally NOT here, so it doesn't stop reminders on its own.
const HOLD_STATES = new Set([
  'not_dispatched',
  'dispatched',
  'reschedule_requested',
])

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { rowNumber?: unknown; dispatchStatus?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rowNumber = Number(body.rowNumber)
  if (!Number.isInteger(rowNumber) || rowNumber <= 0) {
    return NextResponse.json(
      { error: 'a valid rowNumber is required' },
      { status: 400 },
    )
  }
  const dispatchStatus =
    typeof body.dispatchStatus === 'string' ? body.dispatchStatus : ''
  if (!VALID_STATUSES.has(dispatchStatus)) {
    return NextResponse.json(
      { error: `dispatchStatus must be one of: ${[...VALID_STATUSES].join(', ')}` },
      { status: 400 },
    )
  }

  const appt = await prisma.appointment.findFirst({
    where: { masterSheetRowNumber: rowNumber },
    select: { id: true, dispatchStatus: true },
  })
  if (!appt) {
    return NextResponse.json(
      {
        error:
          'No Hub appointment is linked to this row yet, so its dispatch status can’t be set. (Sheet-only rows sync to the Hub on the next pass — try again shortly.)',
      },
      { status: 404 },
    )
  }

  // "Confirmed" is the automation gate (NOT "dispatched" — that's just a
  // lifecycle marker). Fire once, on the transition INTO confirmed.
  const becameConfirmed =
    dispatchStatus === 'confirmed' && appt.dispatchStatus !== 'confirmed'

  await prisma.appointment.update({
    where: { id: appt.id },
    data: { dispatchStatus },
  })

  if (becameConfirmed) {
    // Fire client details + arm the four same-day reminders. Once, on
    // the transition into confirmed.
    triggerDispatchAutomations(appt.id)
  } else if (HOLD_STATES.has(dispatchStatus)) {
    // Hold state — stop any pending timed reminders so the customer
    // doesn't keep getting texts (confirmation already sent, left as-is).
    await prisma.appointmentReminder.updateMany({
      where: {
        sourceKey: `db:appointment:${appt.id}`,
        reminderType: { not: 'confirmation' },
        status: 'pending',
      },
      data: {
        status: 'skipped',
        errorMessage: `held — dispatch status set to "${dispatchStatus}"`,
      },
    })
  }

  return NextResponse.json({ ok: true, rowNumber, dispatchStatus })
}
