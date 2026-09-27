'use client'

import { useState, Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Target, Headphones, AlertCircle } from 'lucide-react'

function AgentSignInInner() {
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

    // NextAuth returns { error: '...' } when authorize() throws or returns null.
    // We map specific error codes to user-facing routes.
    if (res?.error) {
      if (res.error === 'pending' || res.error.toLowerCase().includes('pending')) {
        router.push('/signin/agent/pending')
        return
      }
      if (res.error === 'denied' || res.error.toLowerCase().includes('denied')) {
        router.push('/signin/agent/denied')
        return
      }
      setError('Invalid email or password.')
      return
    }

    // Success — middleware will enforce role-based routing, so we just
    // route to /agent; non-agents will get bounced appropriately.
    const next = searchParams.get('callbackUrl') || '/agent'
    router.push(next)
    router.refresh()
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 border-border bg-card">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-primary" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-6 flex items-center justify-center gap-2 text-sm font-medium text-primary">
          <Headphones className="h-4 w-4" />
          Agent sign in
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
        </form>

        <p className="mt-3 text-center text-xs">
          <Link
            href="/signin/agent/forgot-password"
            className="font-medium text-primary hover:underline"
          >
            Forgot password?
          </Link>
        </p>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          New agent?{' '}
          <Link href="/signin/agent/register" className="font-medium text-primary hover:underline">
            Register here
          </Link>
        </p>

        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          <Link href="/signin" className="hover:underline">
            ← Back to main sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function AgentSignInPage() {
  return (
    <Suspense>
      <AgentSignInInner />
    </Suspense>
  )
}
