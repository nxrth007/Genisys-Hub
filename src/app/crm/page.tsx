import { MessageSquare } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function CrmPage() {
  return (
    <ModulePlaceholder
      icon={MessageSquare}
      title="CRM — GoHighLevel"
      summary="Conversations across all 4 GHL sub-accounts, grouped in the sidebar so the Genisys account is clearly separated from the 3 client accounts."
      features={[
        'Sidebar groups: Genisys / Client A / Client B / Client C',
        'Private Integration tokens per sub-account (not legacy API keys)',
        'Lead pipeline view: new → contacted → booked → closed',
        'Rule-based lead scoring (upgrade to ML once enough outcomes are labeled)',
        'One-click push of hot leads to the correct GHL sub-account',
      ]}
    />
  )
}
