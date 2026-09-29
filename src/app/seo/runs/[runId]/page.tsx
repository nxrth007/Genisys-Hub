import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { canAccessSeo } from '@/lib/seo/access'
import { RunView } from './run-view'

/** /seo/runs/[runId] — one run: progress, review actions, plan, drafts, audit, changes, log. */
export default async function SeoRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const session = await auth()
  if (!canAccessSeo(session?.user?.email)) {
    redirect('/today')
  }
  const { runId } = await params

  return <RunView runId={runId} />
}
