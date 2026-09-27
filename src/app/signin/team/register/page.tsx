'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Target, Users, AlertCircle, CheckCircle2 } from 'lucide-react'
import { STATE_CODE_TO_NAME } from '@/lib/address'

/**
 * Team #N self-registration — 2026-06-03 cutover version.
 *
 * Collects ONLY:
 *   - Name
 *   - Servicing state
 *   - Password + confirm
 *
 * No email, no WhatsApp, no phone — per Alex's spec ("I don't need
 * their phone numbers or anything anymore"). Approval handshake
 * runs out-of-band: server returns a 6-char lookup code on submit
 * which the user shows to their supervisor, supervisor approves
 * via /admin/team-members and assigns a call-center number, then
 * tells the user that number through Mary / WhatsApp. User signs
 * in with the number + password they set here.
 */
export default function TeamRegisterPage() {
  const [name, setName] = useState('')
  const [servicingState, setServicingState] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Once we have the lookup code from the server we replace the
  // whole form with the "save this code" success screen — sending
  // a registered user back to the empty form would be confusing.
  const [lookupCode, setLookupCode] = useState<string | null>(null)

  const stateOptions = useMemo(
    () =>
      Object.entries(STATE_CODE_TO_NAME).sort(([, a], [, b]) =>
        a.localeCompare(b),
      ),
    [],
  )

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (!servicingState) {
      setError('Pick the state you are servicing.')
      return
    }

    setSubmitting(true)

    const res = await fetch('/api/team/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        servicingState,
        password,
      }),
    })

    const data = await res.json().catch(() => ({}))
    setSubmitting(false)

    if (!res.ok) {
      setError(data.error || 'Registration failed. Please try again.')
      return
    }

    setLookupCode(typeof data.lookupCode === 'string' ? data.lookupCode : null)
  }

  if (lookupCode) {
    return (
      <div className="flex min-h-[calc(100vh-64px)] items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 border-border bg-card">
          <div className="mb-4 flex items-center justify-center">
            <CheckCircle2 className="h-12 w-12 text-success" />
          </div>
          <h1 className="text-center text-xl font-bold">
            Registration received
          </h1>
          <p className="mt-3 text-center text-sm text-muted-foreground text-foreground/85">
            Your supervisor will approve you and give you your call-center
            number. Save this code — they may ask for it to find your
            account.
          </p>

          <div className="mt-5 rounded-lg border-2 border-dashed border-success/30 bg-success/15 px-4 py-5 text-center border-success/30 bg-success/15">
            <p className="eyebrow text-success">
              Your lookup code
            </p>
            <p className="mt-1 select-all font-mono text-3xl font-bold tracking-[0.3em] text-success">
              {lookupCode}
            </p>
          </div>

          <div className="mt-6 space-y-2 text-xs text-muted-foreground">
            <p>
              <strong className="text-foreground/85 text-foreground">
                Next steps:
              </strong>
            </p>
            <ol className="list-decimal space-y-1 pl-4">
              <li>Send your supervisor this code so they can approve you.</li>
              <li>
                They will give you your <strong>call-center number</strong>{' '}
                when you are approved.
              </li>
              <li>
                Use that number + the password you just set to sign in here.
              </li>
            </ol>
          </div>

          <Link
            href="/signin/team"
            className="mt-6 block w-full rounded-lg bg-foreground px-4 py-2.5 text-center text-sm font-medium text-background transition-colors hover:bg-foreground/90"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 border-border bg-card">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-primary" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-primary">
          <Users className="h-4 w-4" />
          Team #1 registration
        </div>
        <p className="mb-6 text-center text-xs text-muted-foreground">
          After you register, your supervisor will give you a call-center
          number to sign in with. Use that number — not an email.
        </p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              autoComplete="name"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Servicing state
            </label>
            <select
              value={servicingState}
              onChange={(e) => setServicingState(e.target.value)}
              required
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            >
              <option value="">— Choose a state —</option>
              {stateOptions.map(([code, fullName]) => (
                <option key={code} value={code}>
                  {fullName} ({code})
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              The state your calls are targeting. You can change this later.
            </p>
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
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              At least 8 characters.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Confirm password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
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
            disabled={
              submitting ||
              !name ||
              !servicingState ||
              !password ||
              !confirmPassword
            }
            className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Register'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Already have your call-center number?{' '}
          <Link
            href="/signin/team"
            className="font-medium text-primary hover:underline"
          >
            Sign in
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-muted-foreground/70">
          <Link href="/signin" className="hover:underline">
            ← Back to main sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
