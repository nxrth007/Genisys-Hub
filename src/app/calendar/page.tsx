'use client'

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  User,
  Mail,
  Phone,
  MapPin,
  Video,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock3,
  AlertCircle,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type CalendarEvent = {
  id?: string
  title?: string
  name?: string
  startTime?: string
  endTime?: string
  calendarName?: string
  calendarId?: string
  subAccountName?: string
  vaultName?: string
  contactId?: string
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  status?: string
  appointmentStatus?: string
  notes?: string
  address?: string
}

type SubAccount = {
  vaultName: string
  locationId: string
  locationName: string
}

type Filter = 'all' | 'upcoming' | 'past'

// Color palette per sub-account (hash-based, stable). Purple is the brand
// accent so it's not in this palette — we want sub-accounts visually
// distinct from primary UI chrome.
const COLORS = [
  { bg: 'bg-sky-50', border: 'border-sky-300', text: 'text-sky-800', dot: 'bg-sky-500' },
  { bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-800', dot: 'bg-emerald-500' },
  { bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-800', dot: 'bg-amber-500' },
  { bg: 'bg-rose-50', border: 'border-rose-300', text: 'text-rose-800', dot: 'bg-rose-500' },
  { bg: 'bg-pink-50', border: 'border-pink-300', text: 'text-pink-800', dot: 'bg-pink-500' },
  { bg: 'bg-cyan-50', border: 'border-cyan-300', text: 'text-cyan-800', dot: 'bg-cyan-500' },
]

function colorForSub(subName: string): typeof COLORS[number] {
  let hash = 0
  for (let i = 0; i < subName.length; i++) hash = (hash * 31 + subName.charCodeAt(i)) & 0xfffffff
  return COLORS[hash % COLORS.length]
}

function getMonthRange(year: number, month: number) {
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 0, 23, 59, 59)
  return {
    startMs: start.getTime().toString(),
    endMs: end.getTime().toString(),
    label: start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  }
}

function getStatusStyle(status: string | undefined) {
  const s = status?.toLowerCase() || ''
  switch (s) {
    case 'confirmed':
      return {
        icon: CheckCircle2,
        color: 'text-green-600',
        bg: 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800',
        label: 'Confirmed',
      }
    case 'cancelled':
      return {
        icon: XCircle,
        color: 'text-red-600',
        bg: 'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800',
        label: 'Cancelled',
      }
    case 'showed':
      return {
        icon: CheckCircle2,
        color: 'text-blue-600',
        bg: 'bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800',
        label: 'Showed',
      }
    case 'won':
      return {
        icon: CheckCircle2,
        color: 'text-green-700',
        bg: 'bg-green-100 border-green-300 dark:bg-green-900 dark:border-green-700',
        label: 'Won',
      }
    case 'lost':
      return {
        icon: XCircle,
        color: 'text-stone-700',
        bg: 'bg-stone-100 border-stone-300 dark:bg-stone-800 dark:border-stone-600',
        label: 'Lost',
      }
    case 'noshow':
    case 'no_show':
      return {
        icon: XCircle,
        color: 'text-orange-600',
        bg: 'bg-orange-50 border-orange-200 dark:bg-orange-950 dark:border-orange-800',
        label: 'No Show',
      }
    default:
      return {
        icon: Clock3,
        color: 'text-zinc-500',
        bg: 'bg-zinc-50 border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700',
        label: status || 'Pending',
      }
  }
}

function formatEventDate(dateStr: string) {
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function formatEventTime(dateStr: string) {
  try {
    const d = new Date(dateStr)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function CalendarPage() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [filter, setFilter] = useState<Filter>('all')
  const [subFilters, setSubFilters] = useState<Set<string>>(new Set())

  const range = useMemo(() => getMonthRange(year, month), [year, month])

  const { data, isLoading, error } = useQuery<{
    events: CalendarEvent[]
    subAccounts: SubAccount[]
  }>({
    queryKey: ['calendar-events', year, month],
    queryFn: async () => {
      const params = new URLSearchParams({
        startTime: range.startMs,
        endTime: range.endMs,
      })
      const res = await fetch(`/api/calendar/events?${params}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load calendar')
      }
      return res.json()
    },
  })

  const allEvents = data?.events ?? []
  const subAccounts = data?.subAccounts ?? []
  const nowMs = Date.now()

  // Apply filters
  const events = useMemo(() => {
    return allEvents.filter((e) => {
      // Sub-account filter
      if (subFilters.size > 0 && e.vaultName && !subFilters.has(e.vaultName)) return false
      // Time filter
      if (!e.startTime) return filter === 'all'
      const ms = new Date(e.startTime).getTime()
      if (filter === 'upcoming') return ms >= nowMs
      if (filter === 'past') return ms < nowMs
      return true
    })
  }, [allEvents, filter, subFilters, nowMs])

  // Group by date, then order day-blocks so:
  //   1. Today appears first
  //   2. Future days follow ascending (tomorrow → day after → ...)
  //   3. Past days descending at the bottom (yesterday → day before → ...)
  const grouped = useMemo(() => {
    const buckets = new Map<
      string, // date key (formatted)
      {
        key: string
        events: CalendarEvent[]
        dayStart: number // ms at 00:00 of that day, for sorting
      }
    >()

    for (const ev of events) {
      if (!ev.startTime) continue
      const d = new Date(ev.startTime)
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      const key = formatEventDate(ev.startTime)
      if (!buckets.has(key)) buckets.set(key, { key, events: [], dayStart })
      buckets.get(key)!.events.push(ev)
    }

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayMs = todayStart.getTime()

    const entries = Array.from(buckets.values())
    entries.sort((a, b) => {
      const aIsToday = a.dayStart === todayMs
      const bIsToday = b.dayStart === todayMs
      if (aIsToday !== bIsToday) return aIsToday ? -1 : 1
      const aFuture = a.dayStart > todayMs
      const bFuture = b.dayStart > todayMs
      if (aFuture !== bFuture) return aFuture ? -1 : 1 // future before past
      if (aFuture) return a.dayStart - b.dayStart // future ascending
      return b.dayStart - a.dayStart // past descending
    })

    // Sort events within each day by time (earliest first)
    for (const entry of entries) {
      entry.events.sort(
        (a, b) =>
          new Date(a.startTime || 0).getTime() - new Date(b.startTime || 0).getTime()
      )
    }

    return entries
  }, [events])

  // Stats
  const stats = useMemo(() => {
    const statusCount = (s: string) =>
      allEvents.filter(
        (e) => (e.appointmentStatus || e.status || '').toLowerCase() === s
      ).length
    return {
      total: allEvents.length,
      confirmed: statusCount('confirmed'),
      // Won/lost are outcomes of an appointment the customer attended,
      // so they count toward "showed" for the calendar stat.
      showed:
        statusCount('showed') + statusCount('won') + statusCount('lost'),
      cancelled: statusCount('cancelled') + statusCount('noshow') + statusCount('no_show'),
    }
  }, [allEvents])

  function prevMonth() {
    if (month === 0) {
      setMonth(11)
      setYear(year - 1)
    } else setMonth(month - 1)
  }

  function nextMonth() {
    if (month === 11) {
      setMonth(0)
      setYear(year + 1)
    } else setMonth(month + 1)
  }

  function goToday() {
    setYear(now.getFullYear())
    setMonth(now.getMonth())
  }

  function toggleSubFilter(vaultName: string) {
    setSubFilters((prev) => {
      const next = new Set(prev)
      if (next.has(vaultName)) next.delete(vaultName)
      else next.add(vaultName)
      return next
    })
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
            <CalendarIcon className="h-6 w-6 text-blue-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Calendar</h2>
            <p className="text-sm text-zinc-500">Appointments from all GHL sub-accounts</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            className="rounded-lg border border-zinc-200 p-2 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-semibold min-w-[160px] text-center">{range.label}</span>
          <button
            onClick={nextMonth}
            className="rounded-lg border border-zinc-200 p-2 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={goToday}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
          >
            Today
          </button>
        </div>
      </div>

      {/* Stats */}
      {!isLoading && allEvents.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total" value={stats.total} className="border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" />
          {/* Monthly total — same source as Total today (allEvents is
              already filtered to the selected month server-side). Kept
              as a distinct card so we can split the meaning later: e.g.
              Total = all-time / YTD, Monthly Total = the month visible
              in the calendar. Replaces the old "Showed" card while we
              fix outcome tracking. */}
          <StatCard
            label="Monthly Total"
            value={stats.total}
            className="border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-400"
          />
          <StatCard
            label="Confirmed"
            value={stats.confirmed}
            className="border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400"
          />
          <StatCard
            label="Cancelled / No Show"
            value={stats.cancelled}
            className="border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
          />
        </div>
      )}

      {/* Filters row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        {/* Time filter */}
        <div className="flex gap-2">
          {(['all', 'upcoming', 'past'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                filter === f
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400'
              )}
            >
              {f === 'all' ? 'All' : f === 'upcoming' ? 'Upcoming' : 'Past'}
            </button>
          ))}
        </div>

        {/* Sub-account filter */}
        {subAccounts.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {subAccounts.map((sub) => {
              const color = colorForSub(sub.locationName)
              const active = subFilters.size === 0 || subFilters.has(sub.vaultName)
              return (
                <button
                  key={sub.vaultName}
                  onClick={() => toggleSubFilter(sub.vaultName)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all',
                    active
                      ? `${color.bg} ${color.border} ${color.text}`
                      : 'border-zinc-200 text-zinc-400 opacity-50 dark:border-zinc-800'
                  )}
                >
                  <span className={cn('h-2 w-2 rounded-full', color.dot)} />
                  {sub.locationName}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Events list */}
      <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        ) : error ? (
          <div className="px-6 py-12 text-center">
            <AlertCircle className="mx-auto h-8 w-8 text-red-400 mb-3" />
            <p className="text-sm font-medium text-red-700 dark:text-red-300">Could not load appointments</p>
            <p className="text-xs text-zinc-500 mt-1">{(error as Error).message}</p>
          </div>
        ) : events.length === 0 ? (
          <div className="px-6 py-12 text-center text-zinc-500">
            <CalendarIcon className="mx-auto h-10 w-10 mb-3 text-zinc-300" />
            <p className="font-medium">No appointments for {range.label}</p>
            <p className="text-sm mt-1">Try a different month or clear filters.</p>
          </div>
        ) : (
          <div>
            {grouped.map((group) => {
              const isToday =
                group.dayStart ===
                new Date(new Date().setHours(0, 0, 0, 0)).getTime()
              return (
                <div key={group.key}>
                  <div
                    className={cn(
                      'sticky top-0 z-10 border-b px-6 py-2',
                      isToday
                        ? 'bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800'
                        : 'bg-zinc-50 border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700'
                    )}
                  >
                    <p
                      className={cn(
                        'text-xs font-semibold uppercase tracking-wide',
                        isToday ? 'text-blue-700 dark:text-blue-300' : 'text-zinc-500'
                      )}
                    >
                      {isToday ? 'Today · ' : ''}
                      {group.key}
                    </p>
                  </div>
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {group.events.map((event) => (
                      <EventRow
                        key={event.id || event.startTime}
                        event={event}
                        nowMs={nowMs}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  className,
}: {
  label: string
  value: number
  className?: string
}) {
  return (
    <div className={cn('rounded-lg border p-3', className)}>
      <p className="text-xs">{label}</p>
      <p className="text-xl font-bold">{value}</p>
    </div>
  )
}

function EventRow({ event, nowMs }: { event: CalendarEvent; nowMs: number }) {
  const status = getStatusStyle(event.appointmentStatus || event.status)
  const StatusIcon = status.icon
  const isPast = event.startTime ? new Date(event.startTime).getTime() < nowMs : false
  const color = colorForSub(event.subAccountName || '')
  const duration =
    event.endTime && event.startTime
      ? Math.round(
          (new Date(event.endTime).getTime() - new Date(event.startTime).getTime()) / 60000
        )
      : 0

  return (
    <div className={cn('px-6 py-4', isPast && 'opacity-60')}>
      <div className="flex items-start gap-4">
        {/* Time column */}
        <div className="w-24 shrink-0">
          <p className="text-sm font-bold">{formatEventTime(event.startTime || '')}</p>
          {event.endTime && (
            <p className="text-xs text-zinc-500">{formatEventTime(event.endTime)}</p>
          )}
          {duration > 0 && <p className="text-[10px] text-zinc-400 mt-0.5">{duration} min</p>}
        </div>

        {/* Status indicator */}
        <div className={cn('rounded-full p-1.5 flex-shrink-0', status.bg)}>
          <StatusIcon className={cn('h-4 w-4', status.color)} />
        </div>

        {/* Details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-sm">{event.title || event.name || 'Appointment'}</p>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium border',
                status.bg
              )}
            >
              {status.label}
            </span>
            {event.subAccountName && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                  color.bg,
                  color.border,
                  color.text
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', color.dot)} />
                {event.subAccountName}
              </span>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            {event.contactName && (
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" /> {event.contactName}
              </span>
            )}
            {event.contactEmail && (
              <span className="flex items-center gap-1">
                <Mail className="h-3 w-3" /> {event.contactEmail}
              </span>
            )}
            {event.contactPhone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" /> {event.contactPhone}
              </span>
            )}
            {event.calendarName && (
              <span className="flex items-center gap-1">
                <CalendarIcon className="h-3 w-3" /> {event.calendarName}
              </span>
            )}
          </div>

          {/* Google Meet / URL-based meeting link */}
          {event.address && event.address.startsWith('http') && (
            <div className="mt-2">
              <a
                href={event.address}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 transition-colors"
              >
                <Video className="h-3.5 w-3.5" />
                Join Meeting
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          {/* Physical address */}
          {event.address && !event.address.startsWith('http') && (
            <p className="mt-1 text-xs text-zinc-500 flex items-center gap-1">
              <MapPin className="h-3 w-3" /> {event.address}
            </p>
          )}

          {event.notes && (
            <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
              {String(event.notes).replace(/<[^>]*>/g, ' ').trim()}
            </p>
          )}
        </div>

        <Clock className="h-3 w-3 text-zinc-300 flex-shrink-0 mt-1" />
      </div>
    </div>
  )
}
