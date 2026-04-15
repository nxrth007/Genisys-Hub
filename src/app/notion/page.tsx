import { BookOpen } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function NotionPage() {
  return (
    <ModulePlaceholder
      icon={BookOpen}
      title="Notion"
      summary="Manage your Notion workspace from the Hub. Task board with drag-and-drop, quick capture, bulk actions — the stuff Notion's own UI is bad at."
      features={[
        'Task board with drag-and-drop (via @dnd-kit)',
        'Saved views pinned to the sidebar',
        'Two-way sync between a Notion database and the Hub Tasks model',
        'Cmd/Ctrl+K quick-capture — drop a task anywhere from any page',
        'Multi-select bulk actions (status change, assignee, due date)',
      ]}
    />
  )
}
