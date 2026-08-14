'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Loader2,
  LogOut,
  KeyRound,
  ShieldCheck,
  UserX,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type CrmUser = {
  id: string
  name: string | null
  email: string
  role: string
  approvedAt: string | null
  createdAt: string
  activeSessions: number
  lastSeenAt: string | null
  hasPassword: boolean
  isOwner: boolean
}

type ActionFn = (payload: Record<string, unknown>) => void

function when(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

/**
 * Module-level, deliberately: a component declared inside a render body
 * is a new type on every render, so React remounts it and any state
 * inside resets.
 */
function UserRow({
  u,
  busy,
  onAction,
}: {
  u: CrmUser
  busy: boolean
  onAction: ActionFn
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">
          {u.name ?? '—'}
          {u.activeSessions > 0 && (
            <span className="ml-2 text-[11px] font-normal text-emerald-600 dark:text-emerald-400">
              {u.activeSessions} active session
              {u.activeSessions === 1 ? '' : 's'}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {u.email} · requested {when(u.createdAt)}
          {u.lastSeenAt ? ` · last seen ${when(u.lastSeenAt)}` : ''}
        </p>
      </div>

      <div className="flex flex-shrink-0 flex-wrap gap-1.5">
        {u.role === 'crm_pending' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction({ action: 'approve', id: u.id })}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            Approve
          </button>
        )}

        {u.role === 'crm_user' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction({ action: 'signOut', id: u.id })}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold transition hover:bg-muted disabled:opacity-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        )}

        {u.role === 'crm_denied' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction({ action: 'approve', id: u.id })}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold transition hover:bg-muted disabled:opacity-50"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Restore
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `Remove ${u.email}'s access? They are signed out immediately.`,
                )
              )
                return
              onAction({ action: 'deny', id: u.id })
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300"
          >
            <UserX className="h-3.5 w-3.5" />
            {u.role === 'crm_pending' ? 'Deny' : 'Revoke'}
          </button>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  list,
  empty,
  busy,
  onAction,
}: {
  title: string
  list: CrmUser[]
  empty: string
  busy: boolean
  onAction: ActionFn
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title} · {list.length}
      </p>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((u) => (
            <UserRow key={u.id} u={u} busy={busy} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  )
}


/**
 * Owner account row.
 *
 * Owners sign in to the CRM as themselves — their Hub role is untouched,
 * because `role` is a single column and overwriting it would revoke
 * their Hub access. All they need is a password, since Hub sign-in uses
 * Google SSO and leaves passwordHash empty.
 *
 * "Staff" is intentionally not this. That term is reserved for a future
 * scoped role with limited access, which doesn't exist yet.
 */
function OwnerRow({
  u,
  busy,
  onAction,
}: {
  u: CrmUser
  busy: boolean
  onAction: ActionFn
}) {
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const tooShort = pw.length > 0 && pw.length < 10

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {u.name ?? '—'}
            <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {u.role}
            </span>
            {u.activeSessions > 0 && (
              <span className="ml-2 text-[11px] font-normal text-emerald-600 dark:text-emerald-400">
                {u.activeSessions} active session
                {u.activeSessions === 1 ? '' : 's'}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {u.email} ·{' '}
            {u.hasPassword
              ? 'owner password set'
              : 'no owner password yet — cannot sign in'}
          </p>
        </div>

        <div className="flex flex-shrink-0 flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold transition hover:bg-muted"
          >
            <KeyRound className="h-3.5 w-3.5" />
            {u.hasPassword ? 'Change owner password' : 'Set owner password'}
          </button>
          {u.activeSessions > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction({ action: 'signOut', id: u.id })}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold transition hover:bg-muted disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-border-soft pt-3">
          <div className="min-w-[220px] flex-1">
            <input
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="At least 10 characters"
              className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
            {tooShort && (
              <p className="mt-1 text-[11px] text-destructive">
                Must be at least 10 characters.
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={busy || pw.length < 10}
            onClick={() => {
              onAction({ action: 'setPassword', id: u.id, password: pw })
              setPw('')
              setOpen(false)
            }}
            className="rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            Save password
          </button>
        </div>
      )}
    </div>
  )
}

export function CrmAccessClient() {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'err'
    text: string
  } | null>(null)

  const { data, isLoading } = useQuery<{ ok: true; users: CrmUser[] }>({
    queryKey: ['crm-users'],
    queryFn: async () => {
      const res = await fetch('/api/admin/crm-users')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Failed to load')
      return d
    },
    refetchInterval: 30_000,
  })

  const act = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch('/api/admin/crm-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Action failed')
      return d as { message?: string }
    },
    onSuccess: (d) => {
      setNotice({ tone: 'ok', text: d.message || 'Done.' })
      queryClient.invalidateQueries({ queryKey: ['crm-users'] })
    },
    onError: (e) =>
      setNotice({
        tone: 'err',
        text: e instanceof Error ? e.message : 'Action failed',
      }),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  const users = data?.users ?? []
  const pending = users.filter((u) => u.role === 'crm_pending')
  const active = users.filter((u) => u.role === 'crm_user')
  const denied = users.filter((u) => u.role === 'crm_denied')
  const owners = users.filter((u) => u.isOwner)

  return (
    <div className="flex flex-col gap-6">
      {notice && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-xl border p-3 text-sm',
            notice.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
          )}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)}>
            <X className="h-4 w-4 opacity-60 hover:opacity-100" />
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          {pending.length} request{pending.length === 1 ? '' : 's'} waiting for
          approval. Nobody can sign in until you approve them.
        </div>
      )}

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Owner accounts · {owners.length}
        </p>
        <p className="mb-2 text-xs text-muted-foreground">
          Hub admin and member accounts. They sign in to the CRM as
          themselves and keep their Hub role — they just need an owner
          password, since Hub sign-in uses Google. Scoped Staff roles with
          limited access will be a separate thing later.
        </p>
        {owners.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No owner accounts found.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {owners.map((u) => (
              <OwnerRow
                key={u.id}
                u={u}
                busy={act.isPending}
                onAction={act.mutate}
              />
            ))}
          </div>
        )}
      </div>

      <Section
        title="Awaiting approval"
        list={pending}
        empty="No pending requests."
        busy={act.isPending}
        onAction={act.mutate}
      />
      <Section
        title="Has access"
        list={active}
        empty="Nobody has CRM access yet."
        busy={act.isPending}
        onAction={act.mutate}
      />
      {denied.length > 0 && (
        <Section
          title="Removed"
          list={denied}
          empty=""
          busy={act.isPending}
          onAction={act.mutate}
        />
      )}
    </div>
  )
}
