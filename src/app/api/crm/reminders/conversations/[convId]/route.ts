import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  getConversationMessages,
  sendMessage,
  type ConversationMessage,
} from '@/lib/ghl'
import { prisma } from '@/lib/prisma'
import { resolveReminderConversation } from '@/lib/reminders-conversations'

/**
 * GET  /api/crm/reminders/conversations/[convId]
 *   Pulls the live message thread from GHL — both outbound (our
 *   reminders) and inbound (customer replies). Augments each
 *   outbound message with the matching reminderType when we can
 *   correlate it to one of our AppointmentReminder rows.
 *
 * POST /api/crm/reminders/conversations/[convId]
 *   Sends a manual SMS reply on this thread. Body: { text }.
 *   Uses the contactId we recorded when the original reminder
 *   sent, plus the senderPhone from RemindersConfig (so the reply
 *   goes from the same agency line, not GHL's location default).
 */

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ convId: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { convId } = await ctx.params

  const meta = await resolveReminderConversation(convId)
  if (!meta) {
    return NextResponse.json(
      { error: 'No reminder ever created this conversation.' },
      { status: 404 },
    )
  }

  try {
    const result = await getConversationMessages(convId, meta.vaultEntryName)
    // GHL's response shape varies — sometimes nests another
    // `messages` key, sometimes ships a flat array. Same
    // normalization the existing /api/crm/conversations endpoint
    // does — pulled inline here so we don't have to refactor that
    // one to expose a helper.
    const root = result as { messages?: unknown }
    const nested = root.messages as
      | { messages?: ConversationMessage[] }
      | ConversationMessage[]
      | undefined
    const messages: ConversationMessage[] = Array.isArray(nested)
      ? nested
      : ((nested as { messages?: ConversationMessage[] } | undefined)
          ?.messages ?? [])

    // Correlate each outbound message back to the reminder row that
    // generated it (when we recorded the messageId). Lets the UI
    // show "1 day before" / "30 min before" badges next to the
    // outbound bubbles.
    const messageIds = messages
      .map((m) => (typeof m.id === 'string' ? m.id : null))
      .filter((id): id is string => !!id)
    const reminderTypeByMessageId = new Map<string, string>()
    if (messageIds.length > 0) {
      const reminders = await prisma.appointmentReminder.findMany({
        where: { ghlMessageId: { in: messageIds } },
        select: { ghlMessageId: true, reminderType: true },
      })
      for (const r of reminders) {
        if (r.ghlMessageId) {
          reminderTypeByMessageId.set(r.ghlMessageId, r.reminderType)
        }
      }
    }
    const enriched = messages.map((m) => ({
      ...m,
      reminderType:
        typeof m.id === 'string'
          ? reminderTypeByMessageId.get(m.id) ?? null
          : null,
    }))

    return NextResponse.json({
      conversationId: convId,
      customerName: meta.customerName,
      customerPhone: meta.customerPhone,
      contactId: meta.ghlContactId,
      messages: enriched,
    })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch conversation'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ convId: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { convId } = await ctx.params

  let body: { text?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) {
    return NextResponse.json(
      { error: 'Message text is required.' },
      { status: 400 },
    )
  }

  const meta = await resolveReminderConversation(convId)
  if (!meta) {
    return NextResponse.json(
      { error: 'No reminder ever created this conversation.' },
      { status: 404 },
    )
  }

  // Re-use the configured agency sender phone so manual replies
  // go from the same number customers expect. Falls back to GHL
  // location default when null (preserving prior behavior).
  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
    select: { senderPhone: true },
  })

  try {
    const result = await sendMessage(meta.vaultEntryName, {
      conversationId: convId,
      contactId: meta.ghlContactId,
      message: text,
      type: 'SMS',
      fromNumber: config?.senderPhone || undefined,
    })
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
