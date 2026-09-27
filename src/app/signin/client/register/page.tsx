'use client'

/**
 * Client self-registration — step 1 of the onboarding funnel.
 *
 * Just email + password. The business + contact details get collected
 * on the next screen (/signin/client/onboarding-form), which the user
 * lands on automatically after signin. Two-step intentionally:
 *   - keeps step 1 dead-simple so signup feels frictionless
 *   - separates auth from business identity so admin can deny a spam
 *     account before it blasts the Hub with bogus client data
 */
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import Link from 'next/link'
import Image from 'next/image'
import { Building2, AlertCircle } from 'lucide-react'

export default function ClientRegisterPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 10) {
      setError('Password must be at least 10 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/client/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Registration failed.')
        return
      }

      // Auto-signin so the user lands on the onboarding form without
      // having to re-type credentials.
      const auth = await signIn('credentials', {
        email: email.trim(),
        password,
        redirect: false,
      })
      if (auth?.error) {
        // Most likely cause: this email already belongs to a non-
        // client account (staff / agent). The register endpoint
        // returned 200 to avoid leaking that, but signin won't pass.
        setError(
          'We could not sign you in. If this email already has another Genisys Hub account, contact support.',
        )
        return
      }
      // Hard reload (not router.push) so the new session cookie is
      // fully picked up by middleware on the next request. With
      // router.push, NextAuth's credentials cookie sometimes hasn't
      // finished writing before the form-submit fetch fires, which
      // leads to a stale-session 403 from middleware.
      //
      // Lands on /client (the new flow as of 2026-05-11). The
      // /client page renders a pre-pay welcome + plan picker while
      // the user is still client_pending; after admin approval the
      // SAME route renders the onboarding form, then the live
      // tracker. One destination, content adapts to role.
      window.location.assign('/client')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-gradient-to-b from-zinc-50 to-zinc-100 px-4 py-6 dark:from-zinc-950 dark:to-zinc-900">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-pop sm:p-8 border-border bg-card">
        <div className="mb-5 flex items-center justify-center">
          <Image
            src="/genisys-logo.png"
            alt="Lead Genisys"
            width={450}
            height={150}
            priority
            className="h-auto w-40 sm:w-44 dark:invert"
          />
        </div>
        <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-primary">
          <Building2 className="h-4 w-4" />
          Create a client account
        </div>
        <p className="mb-6 text-center text-xs text-muted-foreground">
          Step 1 of 2 — set up your sign-in. We&apos;ll ask for business
          details on the next screen.
        </p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Password (10+ characters)
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={10}
              autoComplete="new-password"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Confirm password
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={10}
              autoComplete="new-password"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive border-destructive/30 bg-destructive/10 text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !email || !password || !confirm}
            className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {submitting ? 'Creating account…' : 'Continue'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Already have an account?{' '}
          <Link
            href="/signin/client"
            className="font-medium text-primary hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
