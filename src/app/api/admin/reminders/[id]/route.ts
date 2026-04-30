import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendSmsToPhone } from '@/lib/ghl'
import { customerFirstNameForSms, renderTemplate } from '@/lib/reminders'
import {
  REMINDER_TYPES,
  DEFAULT_TEMPLATES,
  type ReminderType,
} from '@/lib/reminders-constants'
import { formatInTimezone } from '@/lib/timezone'

/**
 * PATCH /api/admin/reminders/:id
 *
 * Per-row admin mutations. Body shape:
 *   { action: 'cancel' }     — mark a pending reminder cancelled
 *   { action: 'send-now' }   — fire it immediately, regardless of
 *                              scheduledFor + quiet hours. Useful
 *                              for manual one-offs or recovering a
 *                              missed reminder.
 *
 * Admin-only — middleware gates /api/admin/* to role=admin.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await params

  let body: { action?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const action = body.action

  const reminder = await prisma.appointmentReminder.findUnique({
    where: { id },
  })
  if (!reminder) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  if (action === 'cancel') {
    if (reminder.status !== 'pending') {
      return NextResponse.json(
        { error: `Can't cancel a ${reminder.status} reminder` },
        { status: 400 }
      )
    }
    const updated = await prisma.appointmentReminder.update({
      where: { id },
      data: { status: 'cancelled' },
    })
    return NextResponse.json({ reminder: updated })
  }

  if (action === 'send-now') {
    if (reminder.status === 'sent') {
      return NextResponse.json(
        { error: 'Already sent' },
        { status: 400 }
      )
    }
    const config = await prisma.remindersConfig.findUnique({
      where: { id: 'singleton' },
    })
    if (!config) {
      return NextResponse.json(
        { error: 'reminders config missing' },
        { status: 500 }
      )
    }

    // Resolve the active template (per-client → global → default)
    // — same fallback the cron uses, kept inline so the route
    // doesn't have to depend on the cron-side helper.
    if (!REMINDER_TYPES.includes(reminder.reminderType as ReminderType)) {
      return NextResponse.json(
        { error: 'unknown reminder type' },
        { status: 400 }
      )
    }
    let templateBody = DEFAULT_TEMPLATES[reminder.reminderType as ReminderType]
    let templateEnabled = true
    if (reminder.clientId) {
      const t = await prisma.reminderTemplate.findUnique({
        where: {
          clientId_reminderType: {
            clientId: reminder.clientId,
            reminderType: reminder.reminderType,
          },
        },
      })
      if (t) {
        templateBody = t.body
        templateEnabled = t.enabled
      }
    }
    if (templateEnabled) {
      const global = await prisma.reminderTemplate.findFirst({
        where: { clientId: null, reminderType: reminder.reminderType },
      })
      if (global && reminder.clientId === null) {
        templateBody = global.body
        templateEnabled = global.enabled
      }
    }
    if (!templateEnabled) {
      return NextResponse.json(
        { error: 'Template for this reminder is disabled' },
        { status: 400 }
      )
    }

    // Atomic claim + send. Same pattern the cron uses so a manual
    // send-now during a tick can't race with the cron picking the
    // same row.
    const claim = await prisma.appointmentReminder.updateMany({
      where: { id, status: { in: ['pending', 'failed', 'skipped'] } },
      data: { status: 'sending' },
    })
    if (claim.count === 0) {
      return NextResponse.json(
        { error: 'Row was claimed by another process; refresh.' },
        { status: 409 }
      )
    }

    try {
      const messageBody = renderTemplate(templateBody, {
        customerName: customerFirstNameForSms(reminder.customerName),
        customerFullName: reminder.customerName,
        clientName: reminder.clientName ?? 'our partner',
        address: reminder.address ?? '',
        agentName: reminder.agentName ?? '',
        apptDate: formatInTimezone(reminder.apptDateTime, reminder.customerTimezone, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        }),
        apptTime: formatInTimezone(reminder.apptDateTime, reminder.customerTimezone, {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }),
        apptDateTime: formatInTimezone(
          reminder.apptDateTime,
          reminder.customerTimezone,
          {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          }
        ),
      })
      const result = await sendSmsToPhone(config.vaultEntryName, {
        phone: reminder.customerPhone,
        message: messageBody,
        firstName: customerFirstNameForSms(reminder.customerName),
        lastName: lastWordOf(reminder.customerName),
      })
      const updated = await prisma.appointmentReminder.update({
        where: { id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          messageBody,
          ghlContactId: result.contactId,
          ghlMessageId: result.messageId ?? null,
          ghlConversationId: result.conversationId ?? null,
          errorMessage: null,
        },
      })
      return NextResponse.json({ reminder: updated })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Send failed'
      const updated = await prisma.appointmentReminder.update({
        where: { id },
        data: { status: 'failed', errorMessage: message },
      })
      return NextResponse.json({ reminder: updated, error: message }, {
        status: 500,
      })
    }
  }

  return NextResponse.json(
    { error: 'unknown action; expected cancel | send-now' },
    { status: 400 }
  )
}

function lastWordOf(name: string): string | undefined {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return undefined
  return parts.slice(-1)[0]
}
