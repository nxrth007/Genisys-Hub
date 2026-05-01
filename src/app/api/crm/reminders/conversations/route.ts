import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { listReminderConversations } from '@/lib/reminders-conversations'

/**
 * GET /api/crm/reminders/conversations
 *
 * Returns the de-duplicated list of GHL conversations the reminder
 * system has ever created. Hub-stored data only — no GHL round-trip
 * per row, so the list view stays snappy. Detail view (and replies)
 * call GHL through the per-conversation route below.
 *
 * Reachable by: any signed-in user (staff + agents). Mary uses this
 * from /agent/messages; Alex uses it from /crm/messages.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const conversations = await listReminderConversations()
  return NextResponse.json({ conversations })
}
