'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { signOut } from 'next-auth/react'
import Link from 'next/link'
import { Target, Clock } from 'lucide-react'

function PendingInner() {
  const params = useSearchParams()
  const justRegistered = params.get('just_registered') === '1'

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-blue-600" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-4 flex items-center justify-center">
          <div className="rounded-full bg-amber-100 p-3 dark:bg-amber-950">
            <Clock className="h-6 w-6 text-amber-600" />
          </div>
        </div>
        <h2 className="mb-2 text-lg font-semibold">
          {justRegistered ? 'Registration received' : 'Awaiting approval'}
        </h2>
        <p className="mb-6 text-sm text-zinc-500">
          {justRegistered
            ? "Thanks! Your account was created and a Genisys admin has been notified. You'll be able to sign in once they approve you — usually within a business day."
            : "Your account is still pending approval. Come back a little later, or contact your Genisys admin if you've been waiting a while."}
        </p>
        <button
          onClick={() => signOut({ callbackUrl: '/signin/agent' })}
          className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Sign out
        </button>
        <p className="mt-4 text-xs text-zinc-400">
          <Link href="/signin" className="hover:underline">
            ← Back to main sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function AgentPendingPage() {
  return (
    <Suspense>
      <PendingInner />
    </Suspense>
  )
}
