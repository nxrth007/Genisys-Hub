'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * /team/manage — Mary's surface for approving Team #1 registrations
 * and assigning their initial call-center numbers.
 *
 * Narrower permission surface than /admin/team-members: approve +
 * deny only. Password reset, number change on active users, and
 * deletion stay admin-only by design (Mary explicitly asked Alex
 * to keep destructive paths gated to admin).
 *
 * Reached from a tile on /agent. Middleware permits this path for
 * agent role; the API endpoint validates that the caller's
 * User.managesTeamNumber matches the target's team before letting
 * the write through.
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

export default function TeamManagePage() {
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery<{
    teamNumber: number
    members: Member[]
  }>({
    queryKey: ['team-manage-members'],
    queryFn: async () => {
      const res = await fetch('/api/team/manage/members')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load')
      }
      return res.json()
    },
  })

  const [approving, setApproving] = useState<Member | null>(null)

  const members = data?.members ?? []
  const pending = useMemo(
    () => members.filter((m) => m.role === 'team_pending'),
    [members],
  )
  const active = useMemo(
    () => members.filter((m) => m.role === 'team_member'),
    [members],
  )

  const denyMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/team/manage/members/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deny' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Deny failed')
      return d
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-manage-members'] }),
  })

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/agent"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted text-foreground/85 hover:bg-muted"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dashboard
        </Link>
      </div>

      <header className="flex items-start gap-3">
        <div className="rounded-lg bg-primary-soft p-2.5 bg-primary-soft">
          <Users className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Team #{data?.teamNumber ?? 1} — manage
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Approve new registrations and assign their call-center numbers.
            Tell the user their number through WhatsApp or in-person once
            you&apos;ve approved them.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">
            Password resets, number changes, and removals are admin-only —
            contact Alex if any of those are needed.
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
            empty="No pending registrations."
            badgeCount={pending.length}
          >
            {pending.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-semibold">{m.name ?? '(no name)'}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    {m.servicingState && <span>{m.servicingState}</span>}
                    {m.registrationLookupCode && (
                      <>
                        <span>·</span>
                        <span>
                          Lookup code:{' '}
                          <span className="rounded bg-muted px-1 py-0.5 font-mono text-foreground/85 bg-surface-muted text-foreground/85">
                            {m.registrationLookupCode}
                          </span>
                        </span>
                      </>
                    )}
                    <span>·</span>
                    <span>{formatRelative(m.createdAt)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setApproving(m)}
                    className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/15 px-2.5 py-1 text-[11px] font-medium text-success transition hover:bg-success/15 border-success/30 bg-success/15 text-success"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    Approve + assign number
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          `Deny ${m.name ?? 'this user'}? They won't be able to sign in.`,
                        )
                      ) {
                        denyMutation.mutate(m.id)
                      }
                    }}
                    disabled={
                      denyMutation.isPending &&
                      denyMutation.variables === m.id
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50 border-destructive/30 bg-destructive/10 text-destructive"
                  >
                    {denyMutation.isPending &&
                    denyMutation.variables === m.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </Section>

          <Section
            title="Active members"
            tone="emerald"
            empty="No approved members yet."
            badgeCount={active.length}
          >
            {active.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-semibold">{m.name ?? '(no name)'}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    {m.callCenterNumber && (
                      <span>
                        Call-center number:{' '}
                        <span className="rounded bg-primary-soft px-1 py-0.5 font-mono text-primary bg-primary-soft text-primary">
                          {m.callCenterNumber}
                        </span>
                      </span>
                    )}
                    {m.servicingState && (
                      <>
                        <span>·</span>
                        <span>{m.servicingState}</span>
                      </>
                    )}
                  </div>
                </div>
                {/* No actions — managers can only approve/deny new
                    sign-ups. Reset password / change number / delete
                    stay admin-only. Active members are read-only in
                    this view. */}
                <p className="text-[10px] italic text-muted-foreground/70">
                  Need a change? Ask Alex.
                </p>
              </li>
            ))}
          </Section>
        </>
      )}

      {approving && (
        <ApproveModal
          member={approving}
          onClose={() => setApproving(null)}
          onSuccess={() => {
            setApproving(null)
            qc.invalidateQueries({ queryKey: ['team-manage-members'] })
          }}
        />
      )}
    </div>
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
  tone: 'amber' | 'emerald'
  empty: string
  badgeCount: number
  children: React.ReactNode
}) {
  const toneClass =
    tone === 'amber'
      ? 'border-warning/30 bg-warning/15 text-warning border-warning/30 bg-warning/15 text-warning'
      : 'border-success/30 bg-success/15 text-success border-success/30 bg-success/15 text-success'
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

function ApproveModal({
  member,
  onClose,
  onSuccess,
}: {
  member: Member
  onClose: () => void
  onSuccess: () => void
}) {
  const [value, setValue] = useState('')
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/team/manage/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', callCenterNumber: value }),
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
          Approve {member.name ?? 'this user'}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick a call-center number for them. They sign in with this number
          (not email). Tell them through WhatsApp or in-person.
        </p>
        <label className="mt-4 block eyebrow text-muted-foreground">
          Call-center number
        </label>
        <input
          type="text"
          inputMode="numeric"
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
            Approve
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
