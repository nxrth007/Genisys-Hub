'use client'

import { Suspense, useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import {
  Loader2,
  PhoneCall,
  ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatCard } from '@/components/ui/stat-card'
import { Chip } from '@/components/ui/chip'
import { Avatar } from '@/components/ui/avatar'

/**
 * Call Center → Appointments tab. Stripped down to the mockup
 * essentials per Ethan's feedback ("just make it look exactly like
 * this. that's it. ... I don't need any of this"):
 *
 *   - 4 KPI cards across the top
 *   - "Appointments" list of today's bookings (first row highlighted
 *     with a Join pill; subsequent rows with a Details pill)
 *
 * Deep filtering, search, attention strips, funnels, and the full
 * editable table all live on /call-center/master-tracker — that's
 * the place for digging into history. This page is the at-a-glance
 * "what's happening today" view.
 *
 * Date range comes from URL search params written by the shared
 * /call-center layout's DateRangePicker (?since=...&until=...). The
 * picker's range scopes the stats; the appointments list always
 * shows today regardless, since "today" is what the agent acts on
 * right now.
 */

type Appointment = {
  id: string
  apptDateTime: string
  customerName: string
  customerPhone: string
  status: string
  estimatedDealValue: string | null
  notes: string | null
  createdAt: string
  agent: { id: string; name: string | null; email: string }
  client: { id: string; name: string; state: string | null; color: string } | null
}

const STATUS_TONE: Record<string, 'mint' | 'amber' | 'pink' | 'blue' | 'muted'> = {
  booked: 'blue',
  rescheduled: 'amber',
  showed: 'mint',
  no_show: 'pink',
  cancelled: 'muted',
}

const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  showed: 'Showed',
  no_show: 'No-show',
  cancelled: 'Cancelled',
}

export default function CallCenterPage() {
  // useSearchParams is CSR-only in Next 16. Wrapping the consumer
  // in <Suspense> lets the page's static prerender succeed; the
  // skeleton fallback hydrates with the real URL state on the
  // client. The same pattern is used in the layout.
  return (
    <Suspense fallback={<AppointmentsSkeleton />}>
      <AppointmentsView />
    </Suspense>
  )
}

function AppointmentsView() {
  const params = useSearchParams()
  const since = params.get('since')
  const until = params.get('until')

  // Pull every appointment in the active filter window. The list
  // section below filters down to today; the stat cards aggregate
  // across the whole window.
  const apptsQuery = useQuery<{ appointments: Appointment[] }>({
    queryKey: ['call-center-appointments', since, until],
    queryFn: async () => {
      const sp = new URLSearchParams()
      if (since) sp.set('since', since)
      if (until) sp.set('until', until)
      const res = await fetch(`/api/call-center/appointments?${sp.toString()}`)
      if (!res.ok) throw new Error('Failed to load appointments')
      return res.json()
    },
  })
  const appointments = apptsQuery.data?.appointments ?? []

  const stats = useMemo(() => {
    const now = new Date()
    const startOfToday = startOfDay(now)
    const endOfToday = endOfDay(now)

    let apptsSetToday = 0
    let showed = 0
    let completed = 0
    const activeAgents = new Set<string>()

    for (const a of appointments) {
      const created = new Date(a.createdAt)
      if (created >= startOfToday && created <= endOfToday) apptsSetToday++
      if (a.status === 'showed') {
        showed++
        completed++
      }
      if (a.status === 'no_show') completed++
      if (a.agent?.id) activeAgents.add(a.agent.id)
    }

    return {
      apptsSetToday,
      showRate: completed > 0 ? Math.round((showed / completed) * 100) : null,
      totalInRange: appointments.length,
      activeAgents: activeAgents.size,
    }
  }, [appointments])

  // Today's appointments (by appointment date, ascending). This is
  // independent of the URL date range — the call center always wants
  // today's slate front-and-center.
  const todaysAppointments = useMemo(() => {
    const now = new Date()
    const startOfToday = startOfDay(now)
    const endOfToday = endOfDay(now)
    return appointments
      .filter((a) => {
        const d = new Date(a.apptDateTime)
        return d >= startOfToday && d <= endOfToday
      })
      .sort(
        (a, b) =>
          new Date(a.apptDateTime).getTime() -
          new Date(b.apptDateTime).getTime()
      )
  }, [appointments])

  return (
    <div className="space-y-6">
      {/* ---- 4 stat cards (mockup row) ---- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Appts set today"
          value={stats.apptsSetToday}
          subtitle={
            stats.apptsSetToday === 0 ? 'nothing yet' : 'logged today'
          }
          tone="amber"
          progress={stats.apptsSetToday > 0 ? 100 : 0}
        />
        <StatCard
          label="Avg show rate"
          value={stats.showRate != null ? `${stats.showRate}%` : '—'}
          subtitle="across completed bookings"
          tone="green"
          progress={stats.showRate ?? null}
        />
        <StatCard
          label="Appts in range"
          value={stats.totalInRange}
          subtitle="filter window above"
          tone="blue"
        />
        <StatCard
          label="Active agents"
          value={stats.activeAgents}
          subtitle={
            stats.activeAgents === 1
              ? 'has booked recently'
              : 'have booked recently'
          }
          tone="indigo"
        />
      </div>

      {/* ---- Today's appointments list (mockup pattern) ---- */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-soft">
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-semibold tracking-tight">
            Appointments
          </h2>
          <div className="flex items-center gap-2">
            <Chip tone="blue">
              {todaysAppointments.length} scheduled today
            </Chip>
            <Link
              href="/call-center/master-tracker"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              All time <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>

        {apptsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : apptsQuery.isError ? (
          <p className="py-12 text-center text-sm text-destructive">
            Couldn&apos;t load appointments. Try refreshing.
          </p>
        ) : todaysAppointments.length === 0 ? (
          <div className="py-12 text-center">
            <PhoneCall className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">
              No appointments scheduled for today.
            </p>
          </div>
        ) : (
          <ul className="mt-4 flex flex-col">
            {todaysAppointments.map((a, i) => {
              const when = new Date(a.apptDateTime)
              const isFirst = i === 0
              const display = a.agent.name || a.agent.email
              return (
                <li
                  key={a.id}
                  className={cn(
                    'flex items-center gap-4 border-t border-border-soft py-3.5 first:border-t-0 first:pt-0'
                  )}
                >
                  <div className="w-20 flex-shrink-0">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatTime(when)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.client?.name || 'No client'}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {a.customerName}
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        · {a.customerPhone}
                      </span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Agent: {display}
                    </p>
                  </div>
                  <Chip tone={STATUS_TONE[a.status] ?? 'muted'}>
                    {STATUS_LABEL[a.status] ?? a.status}
                  </Chip>
                  <Link
                    href={`/call-center/master-tracker?focus=${a.id}`}
                    className={cn(
                      'rounded-full px-3.5 py-1.5 text-xs font-semibold transition',
                      isFirst
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'border border-border bg-card text-foreground/80 hover:bg-muted'
                    )}
                  >
                    {isFirst ? 'Open' : 'Details'}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

/* ---- Helpers ----------------------------------------------------------- */

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/** SSR-safe placeholder shown while the Suspense boundary is
 *  resolving useSearchParams on the client. Matches the rough
 *  visual rhythm of the loaded page so the layout doesn't shift. */
function AppointmentsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-[124px] animate-pulse rounded-2xl border border-border bg-card shadow-soft"
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl border border-border bg-card shadow-soft" />
    </div>
  )
}
