import { CheckCircle2 } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function TodayPage() {
  return (
    <ModulePlaceholder
      icon={CheckCircle2}
      title="Today"
      summary="Your daily brief. Tasks + meetings from Google Calendar (via GHL) and Ethan's Trustware calendar, checkable one at a time."
      features={[
        "Today's tasks with check-off",
        "Meetings pulled from connected calendars (Genisys + Trustware)",
        'Per-user morning SMS brief via Twilio (time and timezone configurable)',
        'Optional two-way sync to a Notion "Tasks" database',
        'Reply "done N" by SMS to mark task #N complete',
      ]}
    />
  )
}
