import { Calendar } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function CalendarPage() {
  return (
    <ModulePlaceholder
      icon={Calendar}
      title="Calendar"
      summary="One view across Google Calendar (Genisys Workspace, via GHL), and Ethan's Trustware calendar. Either OAuth-connected or iCal-fallback if a Workspace admin blocks third-party apps."
      features={[
        'Day / week / month views with color-coding per source',
        'Event details panel with meeting link and attendees',
        'Connects into Today so meetings show up in the morning SMS brief',
        'iCal URL fallback for calendars where OAuth is blocked',
      ]}
    />
  )
}
