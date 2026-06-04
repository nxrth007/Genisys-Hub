'use client'

import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { Target, MessageSquare, ClipboardList } from 'lucide-react'

/**
 * Team #1 dashboard. Currently a tile-launcher for the few
 * surfaces Team #1 users have access to:
 *   - Team chat (new in Phase 4 of the 2026-06-03 cutover)
 *   - EOD reports (planned in Task #4 — placeholder for now)
 *
 * Full sidebar shell (Task #4) replaces this when it ships.
 */
export default function TeamDashboard() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="h-6 w-6 text-blue-600" />
            <h1 className="text-lg font-bold">Genisys Hub · Team #1</h1>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: '/signin/team' })}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl p-6">
        <p className="mb-6 text-sm text-zinc-500">
          Welcome to Team #1. Pick what you&apos;re working on.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/team/chat"
            className="group flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-5 transition hover:border-blue-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700"
          >
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-blue-50 p-2 dark:bg-blue-950">
                <MessageSquare className="h-5 w-5 text-blue-600" />
              </div>
              <h2 className="text-base font-semibold">Team chat</h2>
            </div>
            <p className="text-xs text-zinc-500">
              Talk to your team. Send photos. Replaces Microsoft Teams.
            </p>
          </Link>

          <Link
            href="/team/eod"
            className="group flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-5 transition hover:border-blue-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700"
          >
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-emerald-50 p-2 dark:bg-emerald-950">
                <ClipboardList className="h-5 w-5 text-emerald-600" />
              </div>
              <h2 className="text-base font-semibold">EOD reports</h2>
            </div>
            <p className="text-xs text-zinc-500">
              Submit your end-of-shift recap. Same form Mary uses.
            </p>
          </Link>
        </div>
      </main>
    </div>
  )
}
