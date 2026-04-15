import { Settings } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function SettingsPage() {
  return (
    <ModulePlaceholder
      icon={Settings}
      title="Settings"
      summary="Connect accounts, manage users, configure defaults."
      features={[
        'Connect Gmail accounts (alex@, ethan@leadgenisys.com)',
        'Connect additional calendars (Trustware via separate Google OAuth)',
        'Register GHL sub-accounts and map their Private Integration tokens',
        'Team members + role management',
        'Per-user SMS brief configuration (time, timezone, what to include)',
      ]}
    />
  )
}
