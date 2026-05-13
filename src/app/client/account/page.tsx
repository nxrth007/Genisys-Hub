'use client'

/**
 * /client/account — client-facing account hub.
 *
 * What it shows: read-only profile (sign-in email, full name, business
 * name + package), plus an embedded change-password form so the
 * client can rotate credentials without leaving the page. Reached
 * from the "My Account" pill in the /client header.
 *
 * Why a separate page (vs. modal on /client): a deep-link target the
 * client can bookmark + share with their accountant. Keeps the main
 * /client view focused on appointments instead of bloating it with
 * settings UI.
 *
 * Middleware-gated to client_active (and forced-flow client_pending /
 * client_onboarding can't reach here — they don't see the header
 * pill yet either).
 */
import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Building2,
  Mail,
  User as UserIcon,
  CheckCircle2,
  AlertCircle,
  Loader2,
  KeyRound,
} from 'lucide-react'

type MeResponse = {
  user: {
    id: string
    email: string | null
    name: string | null
    role: string
  }
  client: {
    id: string
    name: string
    package: string
    state: string | null
  } | null
}

const PACKAGE_LABEL: Record<string, string> = {
  ppa: 'Pay-per-appointment',
  growth: 'Growth Pack',
  pro: 'Pro Pack',
  custom: 'Custom',
}

export default function ClientAccountPage() {
  const meQuery = useQuery<MeResponse>({
    queryKey: ['client-me'],
    queryFn: async () => {
      const res = await fetch('/api/client/me')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load your account')
      }
      return res.json()
    },
  })

  if (meQuery.isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (meQuery.isError || !meQuery.data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {(meQuery.error as Error)?.message ?? 'Failed to load your account'}
        </div>
      </div>
    )
  }

  const { user, client } = meQuery.data

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href="/client"
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dashboard
        </Link>

        <h1 className="mb-1 text-2xl font-bold tracking-tight">My account</h1>
        <p className="mb-6 text-sm text-zinc-500">
          Your sign-in details and password. Need to update your business
          info? Reach out in your Slack channel.
        </p>

        <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Profile
          </h2>
          <dl className="space-y-3">
            <ProfileRow
              icon={<Mail className="h-3.5 w-3.5" />}
              label="Sign-in email"
              value={user.email}
            />
            <ProfileRow
              icon={<UserIcon className="h-3.5 w-3.5" />}
              label="Your name"
              value={user.name}
            />
            <ProfileRow
              icon={<Building2 className="h-3.5 w-3.5" />}
              label="Business"
              value={client?.name}
              sub={client ? PACKAGE_LABEL[client.package] : null}
            />
          </dl>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            <KeyRound className="h-3.5 w-3.5" />
            Change password
          </h2>
          <p className="mb-4 text-[11px] text-zinc-500">
            Pick something at least 10 characters. You&apos;ll stay signed
            in after the change.
          </p>
          <ChangePasswordForm />
        </section>
      </div>
    </div>
  )
}

function ProfileRow({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode
  label: string
  value: string | null | undefined
  sub?: string | null
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-zinc-400">{icon}</span>
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] uppercase tracking-wide text-zinc-500">
          {label}
        </dt>
        <dd className="mt-0.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {value || (
            <span className="font-normal text-zinc-400">Not set</span>
          )}
        </dd>
        {sub && (
          <p className="mt-0.5 text-[11px] text-zinc-500">{sub}</p>
        )}
      </div>
    </div>
  )
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    if (newPassword.length < 10) {
      setError('New password must be at least 10 characters.')
      return
    }
    if (newPassword !== confirm) {
      setError('New passwords do not match.')
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
      setSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirm('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Current password
        </label>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          autoComplete="current-password"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
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
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
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
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          Password updated.
        </div>
      )}

      <button
        type="submit"
        disabled={
          submitting || !currentPassword || !newPassword || !confirm
        }
        className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
      >
        {submitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <KeyRound className="h-3.5 w-3.5" />
        )}
        Update password
      </button>
    </form>
  )
}
