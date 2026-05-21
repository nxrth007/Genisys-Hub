'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Target, Users, AlertCircle } from 'lucide-react'
import { STATE_CODE_TO_NAME } from '@/lib/address'

/**
 * Team #N self-registration. Per Alex's 2026-05-20 spec the form
 * collects Name, Servicing State, email, WhatsApp number, and a
 * password (since this uses Credentials auth — Google SSO is for
 * staff). All four "spec" fields are required; the password is
 * required because we need something to bcrypt for sign-in. State +
 * WhatsApp are editable later from /team/profile.
 *
 * On submit, we POST to /api/team/register which creates a User with
 * role="team_pending" and teamNumber=1 (we're hardcoding Team #1 for
 * now — if a second team ever exists we'll either split the
 * registration page or add a team picker). Admin gets a notification
 * email; the prospect lands on the team-flavored pending screen.
 */
export default function TeamRegisterPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [servicingState, setServicingState] = useState('')
  const [whatsappNumber, setWhatsappNumber] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sorted alphabetically by full name for the dropdown. Computed
  // once at module-eval-time inside useMemo so the sort doesn't
  // happen on every render.
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
    if (!whatsappNumber.trim()) {
      setError('WhatsApp number is required so admin can reach you.')
      return
    }

    setSubmitting(true)

    const res = await fetch('/api/team/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        servicingState,
        whatsappNumber: whatsappNumber.trim(),
        password,
      }),
    })

    const data = await res.json().catch(() => ({}))
    setSubmitting(false)

    if (!res.ok) {
      setError(data.error || 'Registration failed. Please try again.')
      return
    }

    router.push('/signin/team/pending?just_registered=1')
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
          Your registration will be reviewed by a Genisys admin before you can
          sign in. State and WhatsApp can be edited later from your profile.
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
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              WhatsApp number
            </label>
            <input
              type="tel"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
              required
              placeholder="+1 555 123 4567"
              autoComplete="tel"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
            <p className="mt-1 text-[10px] text-zinc-400">
              Include country code. Admin uses this to reach you.
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
            <p className="mt-1 text-[10px] text-zinc-400">At least 8 characters.</p>
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
              !email ||
              !servicingState ||
              !whatsappNumber ||
              !password ||
              !confirmPassword
            }
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Register'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-zinc-500">
          Already registered?{' '}
          <Link href="/signin/team" className="font-medium text-blue-600 hover:underline">
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
