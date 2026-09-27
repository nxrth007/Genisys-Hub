'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Search,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * /agents/vicidial-users — mirror of the Vicidial admin Users
 * listing, with a cross-reference column that flags which Hub
 * Team #1 members are linked to a real Vicidial user_id and which
 * aren't.
 *
 * Why both lists side-by-side: today the Hub team-member admin
 * surface lets Alex assign a free-form "call center number"
 * string. That string is supposed to map to a Vicidial user_id
 * (the 850xxx codes), but there's no enforcement. This page makes
 * mismatches visible so they can be fixed before anyone tries to
 * route calls through the wrong identity.
 */

type VicidialUser = {
  userId: string
  fullName: string
  userLevel: number | null
  userGroup: string
  active: boolean
}

type VicidialUsersResponse =
  | { ok: true; users: VicidialUser[]; fetchedAt: string }
  | { ok: false; error: string; fetchedAt: string }

type TeamMember = {
  id: string
  name: string | null
  role: string
  callCenterNumber: string | null
}

type TeamMembersResponse = { members: TeamMember[] }

export default function VicidialUsersPage() {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all')

  const vicidialQuery = useQuery<VicidialUsersResponse>({
    queryKey: ['admin-vicidial-users'],
    queryFn: async () => {
      const res = await fetch('/api/admin/vicidial/users')
      if (!res.ok) throw new Error('Failed to load')
      return res.json()
    },
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  })

  // Hub-side team members — for the cross-reference column.
  const membersQuery = useQuery<TeamMembersResponse>({
    queryKey: ['admin-team-members'],
    queryFn: async () => {
      const res = await fetch('/api/admin/team-members')
      if (!res.ok) throw new Error('Failed to load team members')
      return res.json()
    },
  })

  // Map Vicidial user_id → Hub team_member for fast lookup.
  // We match on the canonical (digits-only) call-center number
  // since that's how the Hub stores it. Vicidial userIds like
  // "850001" match Hub callCenterNumber "850001" exactly.
  const hubLinkByVicidialId = useMemo(() => {
    const map = new Map<string, TeamMember>()
    for (const m of membersQuery.data?.members ?? []) {
      if (m.callCenterNumber) {
        map.set(m.callCenterNumber, m)
      }
    }
    return map
  }, [membersQuery.data])

  // Same lookup the other way — to flag Hub members whose
  // assigned number doesn't match any Vicidial user.
  const vicidialIdSet = useMemo(() => {
    const s = new Set<string>()
    if (vicidialQuery.data?.ok) {
      for (const u of vicidialQuery.data.users) s.add(u.userId)
    }
    return s
  }, [vicidialQuery.data])

  const orphanedHubMembers = useMemo(() => {
    return (membersQuery.data?.members ?? []).filter(
      (m) =>
        m.role === 'team_member' &&
        m.callCenterNumber &&
        !vicidialIdSet.has(m.callCenterNumber),
    )
  }, [membersQuery.data, vicidialIdSet])

  const vicidialUsers = vicidialQuery.data?.ok
    ? vicidialQuery.data.users
    : []

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return vicidialUsers
      .filter((u) => {
        if (filter === 'active' && !u.active) return false
        if (filter === 'inactive' && u.active) return false
        return true
      })
      .filter((u) => {
        if (!q) return true
        return (
          u.userId.toLowerCase().includes(q) ||
          u.fullName.toLowerCase().includes(q) ||
          u.userGroup.toLowerCase().includes(q)
        )
      })
  }, [vicidialUsers, search, filter])

  const stats = useMemo(() => {
    let active = 0
    let inactive = 0
    let linked = 0
    for (const u of vicidialUsers) {
      if (u.active) active++
      else inactive++
      if (hubLinkByVicidialId.has(u.userId)) linked++
    }
    return { total: vicidialUsers.length, active, inactive, linked }
  }, [vicidialUsers, hubLinkByVicidialId])

  return (
    <div className="space-y-6 p-6">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Agents
      </Link>

      <header className="flex items-start gap-3">
        <div className="rounded-lg bg-primary-soft p-2.5 bg-primary-soft">
          <Users className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vicidial Users</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Live mirror of the BPO&apos;s dialer Users listing. Cross-
            referenced against Hub Team #1 assignments so unlinked numbers
            are visible at a glance.
          </p>
        </div>
      </header>

      {/* Orphan warning — Hub Team #1 members whose assigned number
          isn't in the Vicidial Users list. Usually a typo or stale
          assignment; admin should fix it before the user tries to
          dial. Only renders when both queries succeeded. */}
      {vicidialQuery.data?.ok && orphanedHubMembers.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/15 p-4 border-warning/30 bg-warning/15">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-warning">
                {orphanedHubMembers.length} Hub team member
                {orphanedHubMembers.length === 1 ? '' : 's'} with no matching
                Vicidial user
              </p>
              <p className="mt-1 text-xs text-warning">
                Their assigned call-center number doesn&apos;t appear in
                Vicidial&apos;s Users list. Update the number in{' '}
                <Link
                  href="/admin/team-members"
                  className="underline"
                >
                  /admin/team-members
                </Link>{' '}
                or add the missing user to Vicidial.
              </p>
              <ul className="mt-2 space-y-0.5 text-xs">
                {orphanedHubMembers.map((m) => (
                  <li key={m.id} className="font-mono text-warning">
                    {m.name ?? '(no name)'} →{' '}
                    <span className="rounded bg-warning/15 px-1 bg-warning/15">
                      {m.callCenterNumber}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Total users" value={stats.total} />
        <SummaryCard label="Active" value={stats.active} tone="emerald" />
        <SummaryCard label="Inactive" value={stats.inactive} tone="zinc" />
        <SummaryCard
          label="Linked to Hub"
          value={stats.linked}
          tone={stats.linked > 0 ? 'blue' : 'zinc'}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 border-border bg-card">
        <FilterSelect
          label="Status"
          value={filter}
          onChange={(v) => setFilter(v as 'all' | 'active' | 'inactive')}
          options={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />
        <div className="relative flex flex-1 items-center gap-2 rounded-md border border-border bg-surface-muted px-2 py-1 border-border bg-surface-muted">
          <Search className="h-3.5 w-3.5 text-muted-foreground/70" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user ID, name, group…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="rounded-full p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {vicidialQuery.isLoading || membersQuery.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading…
        </div>
      ) : vicidialQuery.data && !vicidialQuery.data.ok ? (
        <div className="rounded-xl border border-warning/30 bg-warning/15 p-4 border-warning/30 bg-warning/15">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
            <div>
              <p className="text-sm font-semibold text-warning">
                Couldn&apos;t load Vicidial users
              </p>
              <p className="mt-1 text-xs text-warning">
                {vicidialQuery.data.error}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-muted text-[11px] uppercase tracking-wide text-muted-foreground border-border bg-background">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">User ID</th>
                <th className="px-4 py-2 text-left font-semibold">Full name</th>
                <th className="px-4 py-2 text-left font-semibold">Level</th>
                <th className="px-4 py-2 text-left font-semibold">Group</th>
                <th className="px-4 py-2 text-left font-semibold">Active</th>
                <th className="px-4 py-2 text-left font-semibold">Hub link</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => {
                const link = hubLinkByVicidialId.get(u.userId)
                return (
                  <tr
                    key={u.userId}
                    className="border-b border-border-soft last:border-0 border-border"
                  >
                    <td className="px-4 py-2 font-mono text-xs">{u.userId}</td>
                    <td className="px-4 py-2 font-medium">{u.fullName}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {u.userLevel ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {u.userGroup}
                    </td>
                    <td className="px-4 py-2">
                      {u.active ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
                          <CheckCircle2 className="h-3 w-3" />
                          Yes
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground/70">
                          <X className="h-3 w-3" />
                          No
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {link ? (
                        <Link
                          href={`/admin/team-members`}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline text-primary"
                        >
                          {link.name ?? '(no name)'}
                        </Link>
                      ) : (
                        <span className="text-[11px] text-muted-foreground/70">
                          unlinked
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {filteredUsers.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-xs text-muted-foreground"
                  >
                    No users match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {vicidialQuery.data?.ok && (
        <p className="text-center text-[10px] text-muted-foreground/70">
          Display only. Mirror refreshes every 5 minutes — last update{' '}
          {formatRelative(vicidialQuery.data.fetchedAt)}.
        </p>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'emerald' | 'zinc' | 'blue'
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        tone === 'emerald'
          ? 'border-success/30 bg-success/15 text-success border-success/30 bg-success/15 text-success'
          : tone === 'blue'
            ? 'border-primary/30 bg-primary-soft text-primary border-primary/30 bg-primary-soft text-primary'
            : tone === 'zinc'
              ? 'border-border bg-surface-muted text-foreground/85 border-border bg-background text-foreground/85'
              : 'border-border bg-card text-foreground border-border bg-card text-foreground',
      )}
    >
      <p className="eyebrow opacity-70">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="flex items-center gap-1.5 eyebrow text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground/85 transition hover:bg-muted focus:border-primary/50 focus:outline-none border-border bg-surface-muted text-foreground"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime()
    const diff = Date.now() - then
    if (diff < 60_000) return 'just now'
    if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`
    return `${Math.round(diff / (60 * 60_000))}h ago`
  } catch {
    return iso
  }
}
