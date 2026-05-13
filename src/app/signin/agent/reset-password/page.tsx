'use client'

/**
 * Agent reset-password landing — the page the email link points at.
 * Mirrors /signin/client/reset-password exactly; reads the token from
 * the URL, asks for a new password, POSTs to /api/agent/reset-password.
 * On success, redirects back to /signin/agent so the agent can sign
 * in with their new credentials.
 */
import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Target,
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Headphones,
} from 'lucide-react'

function AgentResetPasswordInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [token, setToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const t = searchParams.get('token') ?? ''
    setToken(t)
    if (!t) {
      setError(
        'No reset token found in this URL. Use the link from your email — if it\'s expired, request a new one.',
      )
    }
  }, [searchParams])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword.length < 10) {
      setError('Password must be at least 10 characters.')
      return
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/agent/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Could not reset password.')
        return
      }
      setDone(true)
      // Pause briefly so they see the confirmation, then drop them
      // back on the sign-in page.
      setTimeout(() => {
        router.push('/signin/agent')
      }, 2000)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-gradient-to-b from-zinc-50 to-zinc-100 px-4 py-8 dark:from-zinc-950 dark:to-zinc-900">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-lg sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-blue-600" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>

        {done ? (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
            </div>
            <h1 className="text-base font-semibold">Password updated</h1>
            <p className="mt-2 text-xs text-zinc-500">
              Redirecting you to sign in…
            </p>
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-blue-600">
              <Headphones className="h-4 w-4" />
              Choose a new password
            </div>
            <p className="mb-6 flex items-center justify-center gap-1 text-center text-xs text-zinc-500">
              <KeyRound className="h-3 w-3" />
              Pick something only you know — 10+ characters.
            </p>

            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  New password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoFocus
                  minLength={10}
                  autoComplete="new-password"
                  className="w-full rounded-md border border-zinc-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Confirm new password
                </label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={10}
                  autoComplete="new-password"
                  className="w-full rounded-md border border-zinc-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
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
                disabled={submitting || !token || !newPassword || !confirm}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Saving…' : 'Set new password'}
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-center text-xs text-zinc-400">
          <Link href="/signin/agent" className="hover:underline">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function AgentResetPasswordPage() {
  return (
    <Suspense>
      <AgentResetPasswordInner />
    </Suspense>
  )
}
