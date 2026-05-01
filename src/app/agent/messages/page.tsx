'use client'

import { ReminderMessagesList } from '../../crm/messages/page'

/**
 * Agent-side reminder messages. Re-uses the same component the
 * /crm/messages page renders; only the basePath differs so the
 * "click into a thread" links route under /agent/* instead of
 * /crm/* (preserves the agent shell chrome rather than bouncing
 * Mary into the staff CRM layout).
 */
export default function AgentMessagesPage() {
  return <ReminderMessagesList basePath="/agent/messages" />
}
