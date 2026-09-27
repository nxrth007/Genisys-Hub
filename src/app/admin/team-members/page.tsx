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
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted text-foreground/85 hover:bg-muted"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
      </div>

      <header className="flex items-start gap-3">
        <div className="rounded-lg bg-primary-soft p-2.5 bg-primary-soft">
          <Users className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team #1 members</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Approve pending registrations and assign call-center numbers.
            Mary&apos;s team logs in with their assigned number, not email —
            give them the number out-of-band (WhatsApp / in-person) after you
            approve.
          </p>
        </div>
      </header>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
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
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {member.servicingState && <span>{member.servicingState}</span>}
          {member.registrationLookupCode && (
            <>
              <span>·</span>
              <span>
                Lookup code:{' '}
                <span className="rounded bg-muted px-1 py-0.5 font-mono text-foreground/85 bg-surface-muted text-foreground/85">
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
          className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/15 px-2.5 py-1 text-[11px] font-medium text-success transition hover:bg-success/15 border-success/30 bg-success/15 text-success"
        >
          <CheckCircle2 className="h-3 w-3" />
          Approve + assign number
        </button>
        <button
          type="button"
          onClick={onDeny}
          disabled={denying}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50 border-destructive/30 bg-destructive/10 text-destructive"
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
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {member.callCenterNumber ? (
            <span>
              Call-center number:{' '}
              <span className="rounded bg-primary-soft px-1 py-0.5 font-mono text-primary bg-primary-soft text-primary">
                {member.callCenterNumber}
              </span>
            </span>
          ) : (
            <span className="text-destructive">No number assigned</span>
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
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground/85 transition hover:bg-muted border-border bg-card text-foreground hover:bg-muted"
        >
          Change number
        </button>
        <button
          type="button"
          onClick={onResetPassword}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground/85 transition hover:bg-muted border-border bg-card text-foreground hover:bg-muted"
        >
          <KeyRound className="h-3 w-3" />
          Reset password
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-card px-2.5 py-1 text-[11px] font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50 border-destructive/30 bg-card text-destructive"
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
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Denied {formatRelative(member.updatedAt)}
        </p>
      </div>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-card px-2.5 py-1 text-[11px] font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50 border-destructive/30 bg-card text-destructive"
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
      ? 'border-warning/30 bg-warning/15 text-warning border-warning/30 bg-warning/15 text-warning'
      : tone === 'emerald'
        ? 'border-success/30 bg-success/15 text-success border-success/30 bg-success/15 text-success'
        : 'border-border bg-surface-muted text-foreground/85 border-border bg-background text-foreground/85'
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card border-border bg-card">
      <div
        className={cn(
          'flex items-center justify-between border-b px-4 py-2 eyebrow',
          toneClass,
        )}
      >
        <span>{title}</span>
        <span className="rounded-md bg-card/60 px-2 py-0.5 text-[10px] font-bold dark:bg-black/30">
          {badgeCount}
        </span>
      </div>
      {badgeCount === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border-soft">
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
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-pop border-border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">
          {action === 'approve'
            ? `Approve ${member.name ?? 'this user'}`
            : `Change call-center number for ${member.name ?? 'this user'}`}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Digits only. This number becomes their sign-in username. Tell them
          their number out-of-band (WhatsApp / in-person) — there&apos;s no
          automated email.
        </p>
        <label className="mt-4 block eyebrow text-muted-foreground">
          Call-center number
        </label>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 4082"
          autoFocus
          className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background text-foreground"
        />
        {mutation.isError && (
          <p className="mt-2 text-xs text-destructive">
            {(mutation.error as Error).message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted text-foreground/85 hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!value.trim() || mutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-success px-3.5 py-1.5 text-sm font-semibold text-success-foreground transition hover:bg-success/90 disabled:opacity-50"
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
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-pop border-border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">
          Reset password for {member.name ?? 'this user'}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Min 8 characters. You&apos;ll need to communicate the new password to
          them out-of-band — there&apos;s no email recovery flow for Team #1.
        </p>
        <label className="mt-4 block eyebrow text-muted-foreground">
          New password
        </label>
        <input
          type="text"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
          className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-sm focus:border-primary/50 focus:outline-none border-border bg-background text-foreground"
        />
        {mutation.isError && (
          <p className="mt-2 text-xs text-destructive">
            {(mutation.error as Error).message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted text-foreground/85 hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={pw.length < 8 || mutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:bg-foreground/90 disabled:opacity-50"
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
