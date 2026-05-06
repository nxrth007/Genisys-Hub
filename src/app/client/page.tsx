'use client'

/**
 * Client master tracker.
 *
 * The only page client_active users can reach (middleware enforces).
 * Server pulls /api/client/appointments which filters by the session's
 * clientId — no way for one client to see another's pipeline.
 *
 * Read-only by design for Phase 1: clients can review the bookings
 * they've received, sort by date, and click through for details. Edits
 * (status changes, reschedules) stay on the staff/agent side.
 *
 * Visual style mirrors the call-center master tracker so a client who
 * gets shown around the agency portal during onboarding sees a
 * familiar layout.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Building2, Calendar, LogOut, Search } from 'lucide-react'
import { signOut } from 'next-auth/react'

type Appointment = {
  id: string
  apptDateTime: string
  customerName: string
  customerPhone: string
  address: string | null
  email: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
  status: string
  estimatedDealValue: string | null
  notes: string | null
  bookedByName: string | null
  createdAt: string
}

type ClientInfo = {
  id: string
  name: string
  state: string | null
  color: string
  package: string
  apptCap: number | null
}

export default function ClientHomePage() {
  const [search, setSearch] = useState('')
  const { data, isLoading, error } = useQuery<{
    client: ClientInfo | null
    appointments: Appointment[]
    warning?: string
  }>({
    queryKey: ['client-appointments'],
    queryFn: async () => {
      const res = await fetch('/api/client/appointments')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load appointments')
      }
      return res.json()
    },
  })

  const filtered = (data?.appointments ?? []).filter((a) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      a.customerName.toLowerCase().includes(q) ||
      a.customerPhone.toLowerCase().includes(q) ||
      (a.address ?? '').toLowerCase().includes(q) ||
      (a.utilityProvider ?? '').toLowerCase().includes(q)
    )
  })

  // Stat counts. "Upcoming" is workflow-state-based (booked or
  // rescheduled) rather than timestamp-based — cleaner semantics
  // for a client view (they care about pipeline state, not whether
  // the clock has crossed the appointment boundary by a few minutes)
  // and side-steps the react-hooks/purity rule against Date.now()
  // in render.
  const stats = useMemo(() => {
    const all = data?.appointments ?? []
    return {
      total: all.length,
      upcoming: all.filter(
        (a) => a.status === 'booked' || a.status === 'rescheduled',
      ).length,
      showed: all.filter((a) => a.status === 'showed').length,
      noShow: all.filter((a) => a.status === 'no_show').length,
    }
  }, [data?.appointments])

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header — minimal, client-facing. No agency-internal nav. */}
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Building2 className="h-5 w-5 text-blue-600" />
            <div>
              <h1 className="text-sm font-semibold">
                {data?.client?.name ?? 'Your appointments'}
              </h1>
              <p className="text-[11px] text-zinc-500">
                Booked appointments delivered to your business
              </p>
            </div>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: '/signin/client' })}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {data?.warning && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Heads up: your account isn&apos;t linked to a business yet.
            Reach out to your account manager and we&apos;ll get this sorted.
          </div>
        )}

        {/* Stats strip */}
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Upcoming" value={stats.upcoming} />
          <StatCard label="Showed" value={stats.showed} tone="green" />
          <StatCard label="No-show" value={stats.noShow} tone="rose" />
        </div>

        {/* Search */}
        <div className="mb-4 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone, address…"
              className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
            />
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-zinc-500">
              Loading…
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-red-600">
              {(error as Error).message}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-zinc-500">
              <Calendar className="h-6 w-6" />
              {search.trim()
                ? 'No appointments match that search.'
                : 'No appointments yet — they’ll show up here once we book them.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Date</th>
                  <th className="px-4 py-2 text-left font-semibold">Customer</th>
                  <th className="px-4 py-2 text-left font-semibold">Phone</th>
                  <th className="px-4 py-2 text-left font-semibold">Address</th>
                  <th className="px-4 py-2 text-left font-semibold">Bill</th>
                  <th className="px-4 py-2 text-left font-semibold">Utility</th>
                  <th className="px-4 py-2 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-950/50"
                  >
                    <td className="px-4 py-2 tabular-nums">
                      {formatDateTime(a.apptDateTime)}
                    </td>
                    <td className="px-4 py-2 font-medium">{a.customerName}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {a.customerPhone}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                      {a.address ?? '—'}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {a.monthlyBill ?? '—'}
                    </td>
                    <td className="px-4 py-2">{a.utilityProvider ?? '—'}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={a.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'green' | 'rose'
}) {
  const valueColor =
    tone === 'green'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'rose'
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-zinc-900 dark:text-zinc-50'
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${valueColor}`}>
        {value}
      </p>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    booked: {
      label: 'Booked',
      cls:
        'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
    },
    rescheduled: {
      label: 'Rescheduled',
      cls:
        'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
    },
    showed: {
      label: 'Showed',
      cls:
        'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
    },
    no_show: {
      label: 'No-show',
      cls:
        'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-900',
    },
    cancelled: {
      label: 'Cancelled',
      cls:
        'bg-zinc-100 text-zinc-600 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
    },
  }
  const m = map[status] ?? {
    label: status,
    cls:
      'bg-zinc-100 text-zinc-600 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  )
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
