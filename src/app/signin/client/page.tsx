'use client'

/**
 * Client sign-in page.
 *
 * Mirrors /signin/agent in style + flow, just routed at /signin/client
 * and lands the user on /client (the per-client master tracker) on
 * success. The same Credentials provider in src/auth.ts handles both
 * agents and clients — role-based routing in middleware.ts decides
 * where they land.
 *
 * Phase 1 only — registration link is intentionally absent here; the
 * self-onboarding flow ships in Phase 2.
 */
import { useState, Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { Building2, AlertCircle } from 'lucide-react'

function ClientSignInInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const res = await signIn('credentials', {
      email: email.trim(),
      password,
      redirect: false,
    })

    setSubmitting(false)

    // Phase 2 will route client_pending / client_onboarding /
    // client_denied to dedicated pages. For now we surface a clear
    // inline error so admin can spot setup issues during the
    // existing-clients credential rollout.
    if (res?.error) {
      const code = res.error.toLowerCase()
      if (code.includes('client_pending') || code.includes('client_onboarding')) {
        setError(
          'Your account is awaiting onboarding. We will email you once setup is complete.',
        )
        return
      }
      if (code.includes('client_denied')) {
        setError(
          'This account is no longer active. Reach out to your account manager.',
        )
        return
      }
      setError('Invalid email or password.')
      return
    }

    const next = searchParams.get('callbackUrl') || '/client'
    router.push(next)
    router.refresh()
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-gradient-to-b from-zinc-50 to-zinc-100 px-4 py-6 dark:from-zinc-950 dark:to-zinc-900">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-pop sm:p-8 border-border bg-card">
        {/* Logo. Source art is black on transparent — `dark:invert`
            flips it to white in dark mode without us having to ship a
            second asset. Sized to match the visual weight of the
            old icon-plus-text header. */}
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
        <div className="mb-6 flex items-center justify-center gap-2 text-sm font-medium text-primary">
          <Building2 className="h-4 w-4" />
          Client sign in
        </div>

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
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
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
            disabled={submitting || !email || !password}
            className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="text-right text-xs">
            <Link
              href="/signin/client/forgot-password"
              className="text-muted-foreground hover:text-primary hover:underline"
            >
              Forgot password?
            </Link>
          </p>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          New to Lead Genisys?{' '}
          <Link
            href="/signin/client/register"
            className="font-medium text-primary hover:underline"
          >
            Register
          </Link>
        </p>

        {/* Staff sign-in link intentionally removed (2026-05-12) —
            clients shouldn't see internal sign-in surfaces, and Alex
            doesn't want them clicking through to a screen they can't
            use. Staff still reach /signin directly by URL. */}
      </div>
    </div>
  )
}

export default function ClientSignInPage() {
  return (
    <Suspense>
      <ClientSignInInner />
    </Suspense>
  )
}
