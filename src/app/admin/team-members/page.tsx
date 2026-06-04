'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  Loader2,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * /admin/team-members — single screen for Team #1 approval +
 * call-center number assignment. Mirrors the agent-approval surface
 * but uses the new callCenterNumber field instead of email.
 *
 * Roles in order: team_pending (top, needs action), team_member
 * (approved + working), team_denied (rejected, kept for audit but
 * dimmed). Each pending row exposes:
 *   - Their lookup code (so admin can confirm identity when the
 *     user messages "approve me, my code is 7K2X9F")
 *   - The Approve button → modal asks for call-center number
 *   - The Deny button (with confirm)
 * Active rows expose Reset password, Change call-center number,
 * Delete.
 *
 * Admin-only — page-level role gate via the admin layout chrome.
 * The PATCH endpoint enforces the same in case anyone bypasses.
 */

type Member = {
  id: string
  name: string | null
  role: 'team_pending' | 'team_member' | 'team_denied'
  servicingState: string | null
  teamNumber: number | null
  callCenterNumber: string | null
  registrationLookupCode: string | null
  createdAt: string
  updatedAt: string
}

export default function TeamMembersPage() {
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery<{ members: Member[] }>({
    queryKey: ['admin-team-members'],
    queryFn: async () => {
      const res = await fetch('/api/admin/team-members')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load')
      }
      return res.json()
    },
  })

  // The approval modal is open when this is set. Same value drives
  // the change-call-center-number flow on active members.
  const [assigning, setAssigning] = useState<
    | { member: Member; action: 'approve' | 'set_call_center_number' }
    | null
  >(null)
  const [resetting, setResetting] = useState<Member | null>(null)

  const members = data?.members ?? []
  const pending = useMemo(
    () => members.filter((m) => m.role === 'team_pending'),
    [members],
  )
  const active = useMemo(
    () => members.filter((m) => m.role === 'team_member'),
    [members],
  )
  const denied = useMemo(
    () => members.filter((m) => m.role === 'team_denied'),
    [members],
  )

  const denyMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/team-members/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deny' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Deny failed')
      return d
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-team-members'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/team-members/${id}`, {
        method: 'DELETE',
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Delete failed')
      return d
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-team-members'] }),
  })

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
      </div>

      <header className="flex items-start gap-3">
        <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
          <Users className="h-6 w-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team #1 members</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Approve pending registrations and assign call-center numbers.
            Mary&apos;s team logs in with their assigned number, not email —
            give them the number out-of-band (WhatsApp / in-person) after you
            approve.
          </p>
        </div>
      </header>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error instanceof Error ? error.message : 'Failed to load'}
        </div>
      )}

      {isLoading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : (
        <>
          <Section
            title="Pending approval"
            tone="amber"
            empty="No pending Team #1 registrations."
            badgeCount={pending.length}
          >
            {pending.map((m) => (
              <PendingRow
                key={m.id}
                member={m}
                onApprove={() =>
                  setAssigning({ member: m, action: 'approve' })
                }
                onDeny={() => {
                  if (
                    confirm(
                      `Deny ${m.name ?? 'this user'}? They won't be able to sign in.`,
                    )
                  ) {
                    denyMutation.mutate(m.id)
                  }
                }}
                denying={
                  denyMutation.isPending && denyMutation.variables === m.id
                }
              />
            ))}
          </Section>

          <Section
            title="Active members"
            tone="emerald"
            empty="No approved Team #1 members yet."
            badgeCount={active.length}
          >
            {active.map((m) => (
              <ActiveRow
                key={m.id}
                member={m}
                onChangeNumber={() =>
                  setAssigning({ member: m, action: 'set_call_center_number' })
                }
                onResetPassword={() => setResetting(m)}
                onDelete={() => {
                  if (
                    confirm(
                      `Permanently delete ${m.name ?? 'this user'}? Their EOD reports stay (the user link just nulls out).`,
                    )
                  ) {
                    deleteMutation.mutate(m.id)
                  }
                }}
                deleting={
                  deleteMutation.isPending && deleteMutation.variables === m.id
                }
              />
            ))}
          </Section>

          {denied.length > 0 && (
            <Section
              title="Denied"
              tone="zinc"
              empty="No denied registrations."
              badgeCount={denied.length}
            >
              {denied.map((m) => (
                <DeniedRow
                  key={m.id}
                  member={m}
                  onDelete={() => {
                    if (
                      confirm(`Permanently delete ${m.name ?? 'this user'}?`)
                    ) {
                      deleteMutation.mutate(m.id)
                    }
                  }}
                  deleting={
                    deleteMutation.isPending &&
                    deleteMutation.variables === m.id
                  }
                />
              ))}
            </Section>
          )}
        </>
      )}

      {assigning && (
        <AssignNumberModal
          member={assigning.member}
          action={assigning.action}
          onClose={() => setAssigning(null)}
          onSuccess={() => {
            setAssigning(null)
            qc.invalidateQueries({ queryKey: ['admin-team-members'] })
          }}
        />
      )}

      {resetting && (
        <ResetPasswordModal
          member={resetting}
          onClose={() => setResetting(null)}
          onSuccess={() => setResetting(null)}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Rows                                                                       */
/* -------------------------------------------------------------------------- */

function PendingRow({
  member,
  onApprove,
  onDeny,
  denying,
}: {
  member: Member
  onApprove: () => void
  onDeny: () => void
  denying: boolean
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="font-semibold">{member.name ?? '(no name)'}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          {member.servicingState && <span>{member.servicingState}</span>}
          {member.registrationLookupCode && (
            <>
              <span>·</span>
              <span>
                Lookup code:{' '}
                <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {member.registrationLookupCode}
                </span>
              </span>
            </>
          )}
          <span>·</span>
          <span>{formatRelative(member.createdAt)}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onApprove}
          className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-800 transition hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        >
          <CheckCircle2 className="h-3 w-3" />
          Approve + assign number
        </button>
        <button
          type="button"
          onClick={onDeny}
          disabled={denying}
          className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300"
        >
          {denying ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          Deny
        </button>
      </div>
    </li>
  )
}

function ActiveRow({
  member,
  onChangeNumber,
  onResetPassword,
  onDelete,
  deleting,
}: {
  member: Member
  onChangeNumber: () => void
  onResetPassword: () => void
  onDelete: () => void
  deleting: boolean
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="font-semibold">{member.name ?? '(no name)'}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          {member.callCenterNumber ? (
            <span>
              Call-center number:{' '}
              <span className="rounded bg-blue-50 px-1 py-0.5 font-mono text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                {member.callCenterNumber}
              </span>
            </span>
          ) : (
            <span className="text-rose-600">No number assigned</span>
          )}
          {member.servicingState && (
            <>
              <span>·</span>
              <span>{member.servicingState}</span>
            </>
          )}
          <span>·</span>
          <span>Approved {formatRelative(member.updatedAt)}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onChangeNumber}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Change number
        </button>
        <button
          type="button"
          onClick={onResetPassword}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <KeyRound className="h-3 w-3" />
          Reset password
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:bg-zinc-900 dark:text-rose-300"
        >
          {deleting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
          Delete
        </button>
      </div>
    </li>
  )
}

function DeniedRow({
  member,
  onDelete,
  deleting,
}: {
  member: Member
  onDelete: () => void
  deleting: boolean
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 opacity-60">
      <div className="min-w-0">
        <p className="font-semibold">{member.name ?? '(no name)'}</p>
        <p className="mt-0.5 text-[11px] text-zinc-500">
          Denied {formatRelative(member.updatedAt)}
        </p>
      </div>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:bg-zinc-900 dark:text-rose-300"
      >
        {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        Delete
      </button>
    </li>
  )
}

function Section({
  title,
  tone,
  empty,
  badgeCount,
  children,
}: {
  title: string
  tone: 'amber' | 'emerald' | 'zinc'
  empty: string
  badgeCount: number
  children: React.ReactNode
}) {
  const toneClass =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
      : tone === 'emerald'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
        : 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300'
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div
        className={cn(
          'flex items-center justify-between border-b px-4 py-2 text-xs font-semibold uppercase tracking-wider',
          toneClass,
        )}
      >
        <span>{title}</span>
        <span className="rounded-full bg-white/60 px-2 py-0.5 text-[10px] font-bold dark:bg-black/30">
          {badgeCount}
        </span>
      </div>
      {badgeCount === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-zinc-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {children}
        </ul>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Modals                                                                     */
/* -------------------------------------------------------------------------- */

function AssignNumberModal({
  member,
  action,
  onClose,
  onSuccess,
}: {
  member: Member
  action: 'approve' | 'set_call_center_number'
  onClose: () => void
  onSuccess: () => void
}) {
  const [value, setValue] = useState(member.callCenterNumber ?? '')
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/team-members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, callCenterNumber: value }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Save failed')
      return d
    },
    onSuccess,
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">
          {action === 'approve'
            ? `Approve ${member.name ?? 'this user'}`
            : `Change call-center number for ${member.name ?? 'this user'}`}
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Digits only. This number becomes their sign-in username. Tell them
          their number out-of-band (WhatsApp / in-person) — there&apos;s no
          automated email.
        </p>
        <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Call-center number
        </label>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 4082"
          autoFocus
          className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        {mutation.isError && (
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
            {(mutation.error as Error).message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!value.trim() || mutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {mutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {action === 'approve' ? 'Approve' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ResetPasswordModal({
  member,
  onClose,
  onSuccess,
}: {
  member: Member
  onClose: () => void
  onSuccess: () => void
}) {
  const [pw, setPw] = useState('')
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/team-members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_password', newPassword: pw }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Reset failed')
      return d
    },
    onSuccess: () => {
      alert(
        `Password reset. Tell ${member.name ?? 'the user'} their new password through Mary / WhatsApp.`,
      )
      onSuccess()
    },
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">
          Reset password for {member.name ?? 'this user'}
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Min 8 characters. You&apos;ll need to communicate the new password to
          them out-of-band — there&apos;s no email recovery flow for Team #1.
        </p>
        <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
          New password
        </label>
        <input
          type="text"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
          className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        {mutation.isError && (
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
            {(mutation.error as Error).message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={pw.length < 8 || mutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime()
    const diff = Date.now() - then
    if (diff < 60_000) return 'just now'
    if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`
    if (diff < 24 * 60 * 60_000)
      return `${Math.round(diff / (60 * 60_000))}h ago`
    return `${Math.round(diff / (24 * 60 * 60_000))}d ago`
  } catch {
    return iso
  }
}
