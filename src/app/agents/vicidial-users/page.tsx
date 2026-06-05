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
        className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 transition hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Agents
      </Link>

      <header className="flex items-start gap-3">
        <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
          <Users className="h-6 w-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vicidial Users</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
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
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                {orphanedHubMembers.length} Hub team member
                {orphanedHubMembers.length === 1 ? '' : 's'} with no matching
                Vicidial user
              </p>
              <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
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
                  <li key={m.id} className="font-mono text-amber-900 dark:text-amber-200">
                    {m.name ?? '(no name)'} →{' '}
                    <span className="rounded bg-amber-100 px-1 dark:bg-amber-900">
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
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
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
        <div className="relative flex flex-1 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-800">
          <Search className="h-3.5 w-3.5 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user ID, name, group…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-zinc-400"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {vicidialQuery.isLoading || membersQuery.isLoading ? (
        <div className="flex items-center justify-center py-16 text-zinc-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading…
        </div>
      ) : vicidialQuery.data && !vicidialQuery.data.ok ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Couldn&apos;t load Vicidial users
              </p>
              <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                {vicidialQuery.data.error}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
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
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                  >
                    <td className="px-4 py-2 font-mono text-xs">{u.userId}</td>
                    <td className="px-4 py-2 font-medium">{u.fullName}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {u.userLevel ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                      {u.userGroup}
                    </td>
                    <td className="px-4 py-2">
                      {u.active ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" />
                          Yes
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400">
                          <X className="h-3 w-3" />
                          No
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {link ? (
                        <Link
                          href={`/admin/team-members`}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {link.name ?? '(no name)'}
                        </Link>
                      ) : (
                        <span className="text-[11px] text-zinc-400">
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
                    className="px-4 py-8 text-center text-xs text-zinc-500"
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
        <p className="text-center text-[10px] text-zinc-400">
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
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
          : tone === 'blue'
            ? 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
            : tone === 'zinc'
              ? 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300'
              : 'border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200',
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
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
    <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 focus:border-blue-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
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
