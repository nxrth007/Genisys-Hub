'use client'

/**
 * Public "forgot my password" entry point. The form is anonymous —
 * no session needed. POST /api/client/forgot-password generates a
 * one-time token, emails it, and returns 200 regardless of whether
 * the email actually corresponds to a client account (anti-
 * enumeration). The success screen reflects that posture: "if an
 * account exists for this email, we just sent a reset link."
 */
import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Building2, AlertCircle, CheckCircle2 } from 'lucide-react'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/client/forgot-password', {
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

        {sent ? (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-success/15">
              <CheckCircle2 className="h-5 w-5 text-success" />
            </div>
            <h1 className="text-base font-semibold">Check your email</h1>
            <p className="mt-2 text-xs text-muted-foreground">
              If an account exists for <span className="font-medium">{email}</span>,
              we just sent a reset link. The link expires in 1 hour.
            </p>
            <p className="mt-4 text-xs text-muted-foreground/70">
              Didn&apos;t see it? Check your spam folder, then request another
              link below.
            </p>
            <button
              type="button"
              onClick={() => {
                setSent(false)
                setEmail('')
              }}
              className="mt-3 text-xs font-medium text-primary hover:underline"
            >
              Send to a different email
            </button>
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-primary">
              <Building2 className="h-4 w-4" />
              Reset your password
            </div>
            <p className="mb-6 text-center text-xs text-muted-foreground">
              Enter the email you use to sign in. We&apos;ll send a link to
              choose a new password.
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
                  className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
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
                disabled={submitting || !email}
                className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          <Link href="/signin/client" className="hover:underline">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
