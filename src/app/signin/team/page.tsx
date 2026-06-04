'use client'

import { useState, Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Target, Users, AlertCircle } from 'lucide-react'

/**
 * Team #N sign-in. Same credentials-auth shape as /signin/agent but
 * lands approved members on /team (their locked-down EOD-only
 * surface) and routes pending/denied to the team-flavored pending /
 * denied screens. Mirror of the agent sign-in page; intentionally
 * separate URL so Mary's offshore agents never accidentally land in
 * the regular agent sign-in (and vice versa).
 */
function TeamSignInInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [callCenterNumber, setCallCenterNumber] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    // Strip non-digits client-side so "ext. 4082" and "4082" both
    // resolve to the canonical form the server expects. Same
    // canonicalization the API uses when admin assigns the number.
    const canon = callCenterNumber.replace(/\D/g, '')
    const res = await signIn('credentials', {
      callCenterNumber: canon,
      password,
      redirect: false,
    })

    setSubmitting(false)

    // NextAuth maps authorize() throws to res.error. Team #N has its
    // own two pending / denied error codes so we can land them on
    // team-flavored screens instead of the agent ones.
    if (res?.error) {
      if (
        res.error === 'team_pending' ||
        res.error.toLowerCase().includes('team_pending')
      ) {
        router.push('/signin/team/pending')
        return
      }
      if (
        res.error === 'team_denied' ||
        res.error.toLowerCase().includes('team_denied')
      ) {
        router.push('/signin/team/denied')
        return
      }
      setError('Invalid call-center number or password.')
      return
    }

    // Success — middleware will bounce non-team_member roles, so we
    // just push to /team. If someone with the wrong role somehow used
    // this form, they'd land on their own screen via the middleware.
    const next = searchParams.get('callbackUrl') || '/team'
    router.push(next)
    router.refresh()
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-blue-600" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-6 flex items-center justify-center gap-2 text-sm font-medium text-blue-600">
          <Users className="h-4 w-4" />
          Team #1 sign in
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Call-center number
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={callCenterNumber}
              onChange={(e) => setCallCenterNumber(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              placeholder="e.g. 4082"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
            <p className="mt-1 text-[10px] text-zinc-400">
              Your supervisor gave you this when you were approved.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !callCenterNumber || !password}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-3 text-center text-xs">
          <Link
            href="/signin/team/forgot-password"
            className="font-medium text-blue-600 hover:underline"
          >
            Forgot password?
          </Link>
        </p>

        <p className="mt-4 text-center text-xs text-zinc-500">
          New to Team #1?{' '}
          <Link href="/signin/team/register" className="font-medium text-blue-600 hover:underline">
            Register here
          </Link>
        </p>

        <p className="mt-6 text-center text-xs text-zinc-400">
          <Link href="/signin" className="hover:underline">
            ← Back to main sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function TeamSignInPage() {
  return (
    <Suspense>
      <TeamSignInInner />
    </Suspense>
  )
}
