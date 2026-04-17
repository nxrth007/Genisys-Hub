'use client'

import { useParams } from 'next/navigation'
import { TaskBoard } from '@/components/notion/task-board'

/**
 * Thin wrapper: the Kanban lives in a reusable component so the Today page
 * can embed the same board. This route just extracts the db id from the URL
 * and renders the full-page variant.
 */
export default function TaskBoardPage() {
  const params = useParams()
  const id = params.id as string
  return <TaskBoard dbId={id} variant="page" />
}
