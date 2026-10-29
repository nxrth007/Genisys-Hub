import { notFound } from 'next/navigation'
import { publicStatus } from '@/lib/tracker/store'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Your onboarding status',
  robots: { index: false, follow: false },
}

/**
 * /status/[token] — a client's read-only onboarding status. Public: the
 * signed token in the link is the access (src/lib/tracker/token.ts). Shows
 * only stage, step statuses and the next step; never notes, emails or ids.
 */
export default async function StatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const status = await publicStatus(token)
  if (!status) notFound()
  return (
    <main className="mx-auto max-w-lg px-5 py-12">
      <p className="text-xs uppercase tracking-wide text-neutral-500">Onboarding status</p>
      <h1 className="mt-1 text-2xl font-semibold">{status.business}</h1>
      <div className="mt-6 rounded-lg border border-neutral-200 p-4">
        <p className="text-sm text-neutral-500">Current stage</p>
        <p className="text-base font-medium">{status.currentStage ?? 'Complete'}</p>
        <p className="mt-3 text-sm text-neutral-500">Next step</p>
        <p className="text-base">{status.nextStep}</p>
      </div>
      <ul className="mt-6 space-y-2">
        {status.steps.map((s) => (
          <li key={s.label} className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-sm">
            <span>{s.label}</span>
            <span className={s.status === 'done' ? 'text-green-600' : 'text-neutral-500'}>{s.status === 'done' ? '✅ Done' : 'Pending'}</span>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-xs text-neutral-400">Last updated {new Date(status.updatedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}</p>
    </main>
  )
}
