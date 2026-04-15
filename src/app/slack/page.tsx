import { Hash } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function SlackPage() {
  return (
    <ModulePlaceholder
      icon={Hash}
      title="Slack"
      summary="Your main client communication channel, inside the Hub. Talk to clients without context-switching to the Slack app."
      features={[
        'Connect Slack workspace via OAuth',
        'Pick which channels to monitor (typically one per client)',
        'Unified reply view — keep Gmail, GHL, and Slack threads in one pane',
        'Searchable history, with messages retained in Postgres',
      ]}
    />
  )
}
