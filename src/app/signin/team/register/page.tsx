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
        <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-4 flex items-center justify-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-600" />
          </div>
          <h1 className="text-center text-xl font-bold">
            Registration received
          </h1>
          <p className="mt-3 text-center text-sm text-zinc-600 dark:text-zinc-300">
            Your supervisor will approve you and give you your call-center
            number. Save this code — they may ask for it to find your
            account.
          </p>

          <div className="mt-5 rounded-lg border-2 border-dashed border-emerald-300 bg-emerald-50 px-4 py-5 text-center dark:border-emerald-800 dark:bg-emerald-950/40">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              Your lookup code
            </p>
            <p className="mt-1 select-all font-mono text-3xl font-bold tracking-[0.3em] text-emerald-900 dark:text-emerald-200">
              {lookupCode}
            </p>
          </div>

          <div className="mt-6 space-y-2 text-xs text-zinc-500 dark:text-zinc-400">
            <p>
              <strong className="text-zinc-700 dark:text-zinc-200">
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
            className="mt-6 block w-full rounded-lg bg-blue-600 px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-blue-600" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-blue-600">
          <Users className="h-4 w-4" />
          Team #1 registration
        </div>
        <p className="mb-6 text-center text-xs text-zinc-500">
          After you register, your supervisor will give you a call-center
          number to sign in with. Use that number — not an email.
        </p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              autoComplete="name"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Servicing state
            </label>
            <select
              value={servicingState}
              onChange={(e) => setServicingState(e.target.value)}
              required
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="">— Choose a state —</option>
              {stateOptions.map(([code, fullName]) => (
                <option key={code} value={code}>
                  {fullName} ({code})
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-zinc-400">
              The state your calls are targeting. You can change this later.
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
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
            <p className="mt-1 text-[10px] text-zinc-400">
              At least 8 characters.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Confirm password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
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
            disabled={
              submitting ||
              !name ||
              !servicingState ||
              !password ||
              !confirmPassword
            }
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Register'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-zinc-500">
          Already have your call-center number?{' '}
          <Link
            href="/signin/team"
            className="font-medium text-blue-600 hover:underline"
          >
            Sign in
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-zinc-400">
          <Link href="/signin" className="hover:underline">
            ← Back to main sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
