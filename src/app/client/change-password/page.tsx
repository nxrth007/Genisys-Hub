'use client'

/**
 * Forced first-login password-change screen.
 *
 * Middleware traps any client_active user with mustChangePassword=true
 * here until they pick their own password. Once the API clears the
 * flag, the next request flows through to /client.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, AlertCircle, KeyRound } from 'lucide-react'

export default function ClientChangePasswordPage() {
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword.length < 10) {
      setError('New password must be at least 10 characters.')
      return
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/client/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Failed to update password.')
        return
      }
      // Refresh forces middleware to re-evaluate with the cleared
      // mustChangePassword flag, then push to /client.
      router.refresh()
      router.push('/client')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-6 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Building2 className="h-7 w-7 text-blue-600" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-blue-600">
          <KeyRound className="h-4 w-4" />
          Set a new password
        </div>
        <p className="mb-6 text-center text-xs text-zinc-500">
          You signed in with a temporary password. Please pick your own
          before continuing.
        </p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Current (temporary) password
            </label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoFocus
              autoComplete="current-password"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              New password (10+ characters)
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={10}
              autoComplete="new-password"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
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
            disabled={submitting || !currentPassword || !newPassword || !confirm}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save password'}
          </button>
        </form>
      </div>
    </div>
  )
}
