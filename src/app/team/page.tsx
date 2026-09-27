'use client'

import Link from 'next/link'
import { signOut } from 'next-auth/react'
import {
  Target,
  MessageSquare,
  ClipboardList,
  PhoneCall,
  Activity,
} from 'lucide-react'

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
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border bg-card px-6 py-4 border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="h-6 w-6 text-primary" />
            <h1 className="text-lg font-bold">Genisys Hub · Team #1</h1>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: '/signin/team' })}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground/85 transition hover:bg-muted border-border bg-card text-foreground hover:bg-muted"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl p-6">
        <p className="mb-6 text-sm text-muted-foreground">
          Welcome to Team #1. Pick what you&apos;re working on.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/team/chat"
            className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-5 transition hover:border-primary/50 border-border bg-card hover:border-primary/50"
          >
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-primary-soft p-2 bg-primary-soft">
                <MessageSquare className="h-5 w-5 text-primary" />
              </div>
              <h2 className="text-base font-semibold">Team chat</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Talk to your team. Send photos. Replaces Microsoft Teams.
            </p>
          </Link>

          <Link
            href="/team/eod"
            className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-5 transition hover:border-primary/50 border-border bg-card hover:border-primary/50"
          >
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-success/15 p-2 bg-success/15">
                <ClipboardList className="h-5 w-5 text-success" />
              </div>
              <h2 className="text-base font-semibold">EOD reports</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Submit your end-of-shift recap. Same form Mary uses.
            </p>
          </Link>

          <Link
            href="/team/callbacks"
            className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-5 transition hover:border-primary/50 border-border bg-card hover:border-primary/50"
          >
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-warning/15 p-2 bg-warning/15">
                <PhoneCall className="h-5 w-5 text-warning" />
              </div>
              <h2 className="text-base font-semibold">Callbacks</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Log prospects who asked you to call them back. Overdue + due-today
              surface first.
            </p>
          </Link>

          <Link
            href="/team/live-report"
            className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-5 transition hover:border-primary/50 border-border bg-card hover:border-primary/50"
          >
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-destructive/10 p-2 bg-destructive/10">
                <Activity className="h-5 w-5 text-destructive" />
              </div>
              <h2 className="text-base font-semibold">Live Report</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Real-time mirror of the dialer dashboard. Display only —
              refreshes every minute.
            </p>
          </Link>
        </div>
      </main>
    </div>
  )
}
