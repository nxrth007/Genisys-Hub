'use client'

import { signIn } from 'next-auth/react'
import { Target } from 'lucide-react'

export default function SignInPage() {
  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-blue-600" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <p className="mb-6 text-center text-sm text-zinc-500">
          Sign in with your leadgenisys.com Google account.
        </p>
        <button
          onClick={() => signIn('google', { callbackUrl: '/' })}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Continue with Google
        </button>
        <p className="mt-4 text-center text-xs text-zinc-400">
          Only @leadgenisys.com and @trustware.io accounts can sign in.
        </p>
      </div>
    </div>
  )
}
