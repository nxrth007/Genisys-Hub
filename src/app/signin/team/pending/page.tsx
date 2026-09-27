'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { signOut } from 'next-auth/react'
import Link from 'next/link'
import { Target, Clock } from 'lucide-react'

/**
 * Team #N "awaiting approval" screen. Reached by:
 *   - a fresh registration (?just_registered=1) — celebrates the
 *     submission and tells them what's next
 *   - middleware bouncing a signed-in team_pending session — they
 *     tried to navigate somewhere and we want them parked here
 *   - the sign-in form catching a team_pending authorize() throw
 */
function PendingInner() {
  const params = useSearchParams()
  const justRegistered = params.get('just_registered') === '1'

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center border-border bg-card">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-primary" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-4 flex items-center justify-center">
          <div className="rounded-full bg-warning/15 p-3 bg-warning/15">
            <Clock className="h-6 w-6 text-warning" />
          </div>
        </div>
        <h2 className="mb-2 text-lg font-semibold">
          {justRegistered ? 'Registration received' : 'Awaiting approval'}
        </h2>
        <p className="mb-6 text-sm text-muted-foreground">
          {justRegistered
            ? "Thanks! Your Team #1 registration was submitted and a Genisys admin has been notified. You'll be able to sign in once they approve you — they'll reach out on the WhatsApp number you provided."
            : "Your Team #1 account is still pending approval. Come back a little later, or contact your manager on WhatsApp if you've been waiting a while."}
        </p>
        <button
          onClick={() => signOut({ callbackUrl: '/signin/team' })}
          className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground/85 hover:bg-muted border-border bg-card text-foreground hover:bg-muted"
        >
          Sign out
        </button>
        <p className="mt-4 text-xs text-muted-foreground/70">
          <Link href="/signin" className="hover:underline">
            ← Back to main sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function TeamPendingPage() {
  return (
    <Suspense>
      <PendingInner />
    </Suspense>
  )
}
