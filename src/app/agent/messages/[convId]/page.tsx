'use client'

import { use } from 'react'
import { ReminderConversationDetail } from '../../../crm/messages/[convId]/page'

/**
 * Agent-side message thread. Same component as /crm/messages/
 * [convId]; the back-link points to /agent/messages so the agent
 * shell chrome stays intact.
 */
export default function AgentMessageThreadPage({
  params,
}: {
  params: Promise<{ convId: string }>
}) {
  const { convId } = use(params)
  return (
    <ReminderConversationDetail
      convId={decodeURIComponent(convId)}
      basePath="/agent/messages"
    />
  )
}
