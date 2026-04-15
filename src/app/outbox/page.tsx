import { Send } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function OutboxPage() {
  return (
    <ModulePlaceholder
      icon={Send}
      title="Outbox"
      summary="Queued and sent outbound email. Review AI drafts before they go, track replies, re-draft if the thread keeps going."
      features={[
        'Draft queue with approve / edit / discard',
        'Sent email history with reply tracking',
        'Auto-drafts for common patterns (follow-ups, first-touch)',
        'Style learning — drafts get better the more you use them',
      ]}
    />
  )
}
