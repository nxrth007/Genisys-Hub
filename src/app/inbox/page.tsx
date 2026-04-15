import { Inbox } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function InboxPage() {
  return (
    <ModulePlaceholder
      icon={Inbox}
      title="Inbox"
      summary="Unified inbox for the Genisys mailboxes (alex@ and ethan@leadgenisys.com). Messages from the legacy leadgenisys@gmail.com show up here automatically via the forwarding rule."
      features={[
        'Gmail OAuth per account, multi-account supported',
        'Lead classification (Claude) — flag which emails are sales leads',
        'AI drafts that sound like you (retrieval over past sent messages)',
        'Search + filter + archive',
        'One-click convert email → GHL contact in the right sub-account',
      ]}
    />
  )
}
