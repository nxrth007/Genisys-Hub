'use client'

import { signOut } from 'next-auth/react'
import { Target, Loader2 } from 'lucide-react'

/**
 * Temporary placeholder for the Team #N dashboard.
 *
 * Task 3 of the Team #1 rollout shipped the signin + registration
 * flow before the locked-down dashboard surface (Task 4) was built.
 * If admin approves a member during this window, they'd land here.
 * Better to show a friendly "coming soon" than a 404. Replace this
 * page entirely when /team/eod/* + TeamShell ship.
 */
export default function TeamDashboardPlaceholder() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-blue-600" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-4 flex items-center justify-center">
          <div className="rounded-full bg-blue-100 p-3 dark:bg-blue-950">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        </div>
        <h2 className="mb-2 text-lg font-semibold">Dashboard coming soon</h2>
        <p className="mb-6 text-sm text-zinc-500">
          You&apos;ve been approved for Team #1. Your dashboard is being
          finalized — check back shortly to submit your first end-of-day
          report.
        </p>
        <button
          onClick={() => signOut({ callbackUrl: '/signin/team' })}
          className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
