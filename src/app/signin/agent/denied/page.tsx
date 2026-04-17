'use client'

import { signOut } from 'next-auth/react'
import Link from 'next/link'
import { Target, XCircle } from 'lucide-react'

export default function AgentDeniedPage() {
  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-purple-600" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-4 flex items-center justify-center">
          <div className="rounded-full bg-red-100 p-3 dark:bg-red-950">
            <XCircle className="h-6 w-6 text-red-600" />
          </div>
        </div>
        <h2 className="mb-2 text-lg font-semibold">Registration not approved</h2>
        <p className="mb-6 text-sm text-zinc-500">
          Your agent registration was reviewed and not approved. If you think
          this is a mistake, please reach out to your Genisys contact.
        </p>
        <button
          onClick={() => signOut({ callbackUrl: '/signin' })}
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
