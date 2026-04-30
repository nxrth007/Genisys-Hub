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
import { formatInTimezone, timezoneForAddress } from '@/lib/timezone'

/**
 * POST /api/admin/reminders/test
 *
 * Fires a one-off SMS using the reminder template machinery so admins
 * can verify GHL config + preview rendered copy before flipping the
 * master enable. Doesn't write an AppointmentReminder row.
 *
 * Body:
 *   {
 *     phone: string                    // E.164-ish; normalized server-side
 *     reminderType: ReminderType       // which template to render
 *     clientId?: string | null         // pick the per-client template
 *     customerName?: string            // for {customerName} fill
 *     address?: string                 // for {address} + timezone
 *     agentName?: string
 *   }
 */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: {
    phone?: unknown
    reminderType?: unknown
    clientId?: unknown
    customerName?: unknown
    address?: unknown
    agentName?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  if (!phone) return NextResponse.json({ error: 'phone is required' }, { status: 400 })

  const type = String(body.reminderType ?? '')
  if (!REMINDER_TYPES.includes(type as ReminderType)) {
    return NextResponse.json(
      { error: `reminderType must be one of: ${REMINDER_TYPES.join(', ')}` },
      { status: 400 }
    )
  }

  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config) {
    return NextResponse.json({ error: 'reminders config missing' }, { status: 500 })
  }

  const clientIdRaw =
    typeof body.clientId === 'string' && body.clientId ? body.clientId : null
  const customerName =
    typeof body.customerName === 'string' && body.customerName.trim()
      ? body.customerName.trim()
      : 'Test Customer'
  const address =
    typeof body.address === 'string' && body.address.trim()
      ? body.address.trim()
      : ''
  const agentName =
    typeof body.agentName === 'string' && body.agentName.trim()
      ? body.agentName.trim()
      : ''

  // Resolve template via the same fallback chain the dispatcher uses.
  let templateBody = DEFAULT_TEMPLATES[type as ReminderType]
  if (clientIdRaw) {
    const t = await prisma.reminderTemplate.findUnique({
      where: {
        clientId_reminderType: {
          clientId: clientIdRaw,
          reminderType: type,
        },
      },
    })
    if (t) templateBody = t.body
  }
  // Don't honor `enabled=false` for test sends — admin explicitly
  // asked to send this, even if the template is disabled in
  // production. Useful for previewing before flipping enabled on.

  // Resolve client name from DB if a client was picked, otherwise
  // use a sensible placeholder.
  let clientName = 'our partner'
  if (clientIdRaw) {
    const c = await prisma.client.findUnique({
      where: { id: clientIdRaw },
      select: { name: true },
    })
    if (c) clientName = c.name
  }

  const tz = timezoneForAddress(address)
  // Sample appointment timestamp = "tomorrow 2:30 PM in customer's
  // timezone." Good enough to preview {apptDate} / {apptTime} fills.
  const sample = new Date()
  sample.setDate(sample.getDate() + 1)
  sample.setHours(14, 30, 0, 0)

  const messageBody = renderTemplate(templateBody, {
    customerName: customerFirstNameForSms(customerName),
    customerFullName: customerName,
    clientName,
    address,
    agentName,
    apptDate: formatInTimezone(sample, tz, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }),
    apptTime: formatInTimezone(sample, tz, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }),
    apptDateTime: formatInTimezone(sample, tz, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }),
  })

  try {
    const result = await sendSmsToPhone(config.vaultEntryName, {
      phone,
      message: messageBody,
      firstName: customerFirstNameForSms(customerName),
    })
    return NextResponse.json({
      ok: true,
      messageBody,
      ghlContactId: result.contactId,
      ghlMessageId: result.messageId ?? null,
      ghlConversationId: result.conversationId ?? null,
      normalizedPhone: result.normalizedPhone,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed'
    // Surface the rendered body so the admin can see what *would*
    // have gone out even on a config / network failure.
    return NextResponse.json(
      { error: message, messageBody },
      { status: 500 }
    )
  }
}
