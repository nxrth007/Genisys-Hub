'use client'

/**
 * Agent forgot-password entry. Mirrors /signin/client/forgot-password
 * exactly with branding tweaks — agents (e.g. Mary) need a self-serve
 * recovery path because they don't go through Google OAuth and there's
 * no admin in the loop for routine password rotation. POST to
 * /api/agent/forgot-password generates a token + emails the link.
 */
import { useState } from 'react'
import Link from 'next/link'
import { Target, AlertCircle, CheckCircle2, Headphones } from 'lucide-react'

export default function AgentForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/agent/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Could not send reset email.')
        return
      }
      setSent(true)
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

        {sent ? (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
            </div>
            <h1 className="text-base font-semibold">Check your email</h1>
            <p className="mt-2 text-xs text-zinc-500">
              If an agent account exists for{' '}
              <span className="font-medium">{email}</span>, we just sent a
              reset link. The link expires in 1 hour.
            </p>
            <p className="mt-4 text-xs text-zinc-400">
              Didn&apos;t see it? Check your spam folder, then request another
              link below.
            </p>
            <button
              type="button"
              onClick={() => {
                setSent(false)
                setEmail('')
              }}
              className="mt-3 text-xs font-medium text-blue-600 hover:underline"
            >
              Send to a different email
            </button>
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-blue-600">
              <Headphones className="h-4 w-4" />
              Agent password reset
            </div>
            <p className="mb-6 text-center text-xs text-zinc-500">
              Enter the email you use to sign in. We&apos;ll send a link to
              choose a new password.
            </p>

            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="email"
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
                disabled={submitting || !email}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-center text-xs text-zinc-400">
          <Link href="/signin/agent" className="hover:underline">
            ← Back to agent sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
