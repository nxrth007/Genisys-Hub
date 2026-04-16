'use client'

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  User,
  X,
  AlertCircle,
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
  status?: string
  notes?: string
  appointmentStatus?: string
  address?: string
}

type SubAccount = {
  vaultName: string
  locationId: string
  locationName: string
}

// Stable color palette per sub-account (hash-based)
const COLORS = [
  { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-800', dot: 'bg-blue-500' },
  { bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-800', dot: 'bg-emerald-500' },
  { bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-800', dot: 'bg-amber-500' },
  { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-800', dot: 'bg-purple-500' },
  { bg: 'bg-pink-50', border: 'border-pink-300', text: 'text-pink-800', dot: 'bg-pink-500' },
  { bg: 'bg-cyan-50', border: 'border-cyan-300', text: 'text-cyan-800', dot: 'bg-cyan-500' },
]

function colorForSub(subName: string): typeof COLORS[number] {
  let hash = 0
  for (let i = 0; i < subName.length; i++) hash = (hash * 31 + subName.charCodeAt(i)) & 0xfffffff
  return COLORS[hash % COLORS.length]
}

export default function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)

  const weekEnd = useMemo(() => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + 7)
    return d
  }, [weekStart])

  const { data, isLoading, error } = useQuery<{
    events: CalendarEvent[]
    subAccounts: SubAccount[]
  }>({
    queryKey: ['calendar-events', weekStart.toISOString(), weekEnd.toISOString()],
    queryFn: async () => {
      const params = new URLSearchParams({
        startTime: weekStart.toISOString(),
        endTime: weekEnd.toISOString(),
      })
      const res = await fetch(`/api/calendar/events?${params}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load events')
      }
      return res.json()
    },
  })

  const subAccounts = data?.subAccounts ?? []
  const allEvents = data?.events ?? []

  // Apply sub-account filter (empty filter set = show all)
  const events = useMemo(() => {
    if (activeFilters.size === 0) return allEvents
    return allEvents.filter((e) => e.vaultName && activeFilters.has(e.vaultName))
  }, [allEvents, activeFilters])

  // Group events by day of the week
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart)
      day.setDate(day.getDate() + i)
      map.set(day.toDateString(), [])
    }
    for (const ev of events) {
      if (!ev.startTime) continue
      const key = new Date(ev.startTime).toDateString()
      const list = map.get(key)
      if (list) list.push(ev)
    }
    return map
  }, [events, weekStart])

  function toggleFilter(vaultName: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(vaultName)) next.delete(vaultName)
      else next.add(vaultName)
      return next
    })
  }

  function goPrev() {
    const d = new Date(weekStart)
    d.setDate(d.getDate() - 7)
    setWeekStart(d)
  }

  function goNext() {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + 7)
    setWeekStart(d)
  }

  function goToday() {
    setWeekStart(startOfWeek(new Date()))
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
            <Calendar className="h-6 w-6 text-blue-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Calendar</h2>
            <p className="text-sm text-zinc-500">
              Events from all your GHL sub-accounts. Google Calendar events sync into GHL automatically.
            </p>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={goPrev}
              className="rounded-md border border-zinc-200 p-2 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={goToday}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
            >
              Today
            </button>
            <button
              onClick={goNext}
              className="rounded-md border border-zinc-200 p-2 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <span className="ml-3 text-sm font-semibold">{formatWeekRange(weekStart)}</span>
          </div>

          {subAccounts.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {subAccounts.map((sub) => {
                const color = colorForSub(sub.locationName)
                const active = activeFilters.size === 0 || activeFilters.has(sub.vaultName)
                return (
                  <button
                    key={sub.vaultName}
                    onClick={() => toggleFilter(sub.vaultName)}
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
      </div>

      {/* Week grid */}
      {isLoading ? (
        <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          Loading events…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950">
          <div className="flex items-start gap-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">Could not load calendar</div>
              <div className="text-xs mt-1">{(error as Error).message}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {Array.from(eventsByDay.entries()).map(([dayKey, dayEvents]) => {
            const day = new Date(dayKey)
            const isToday = day.toDateString() === new Date().toDateString()

            return (
              <div
                key={dayKey}
                className={cn(
                  'rounded-xl border bg-white overflow-hidden min-h-[300px] flex flex-col dark:bg-zinc-900',
                  isToday
                    ? 'border-blue-400 dark:border-blue-600'
                    : 'border-zinc-200 dark:border-zinc-800'
                )}
              >
                <div
                  className={cn(
                    'px-3 py-2 text-center border-b',
                    isToday
                      ? 'bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800'
                      : 'border-zinc-100 dark:border-zinc-800'
                  )}
                >
                  <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                    {day.toLocaleDateString('en-US', { weekday: 'short' })}
                  </div>
                  <div className={cn('text-lg font-semibold', isToday && 'text-blue-600')}>
                    {day.getDate()}
                  </div>
                </div>
                <div className="flex-1 p-1.5 space-y-1.5 overflow-y-auto">
                  {dayEvents.length === 0 ? (
                    <div className="text-[10px] text-zinc-300 text-center py-4">—</div>
                  ) : (
                    dayEvents.map((ev) => {
                      const color = colorForSub(ev.subAccountName || '')
                      return (
                        <button
                          key={ev.id || ev.startTime}
                          onClick={() => setSelectedEvent(ev)}
                          className={cn(
                            'w-full rounded-md border px-2 py-1.5 text-left text-[11px] leading-tight transition-all hover:shadow-sm',
                            color.bg,
                            color.border,
                            color.text
                          )}
                        >
                          <div className="font-medium truncate">
                            {ev.title || ev.name || 'Untitled'}
                          </div>
                          <div className="opacity-75 mt-0.5 flex items-center gap-1">
                            <Clock className="h-2.5 w-2.5" />
                            {formatTime(ev.startTime)}
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedEvent && (
        <EventDetailModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  )
}

function EventDetailModal({
  event,
  onClose,
}: {
  event: CalendarEvent
  onClose: () => void
}) {
  const color = colorForSub(event.subAccountName || '')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl bg-white shadow-xl dark:bg-zinc-900">
        <div className={cn('flex items-start justify-between p-5 border-b', color.border)}>
          <div className="flex items-center gap-2">
            <span className={cn('h-3 w-3 rounded-full', color.dot)} />
            <span className="text-xs text-zinc-500">{event.subAccountName}</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <h3 className="text-lg font-semibold">{event.title || event.name || 'Untitled'}</h3>

          <DetailRow icon={Clock} label="Time">
            {formatDateTime(event.startTime)}
            {event.endTime && ` — ${formatTime(event.endTime)}`}
          </DetailRow>

          {event.calendarName && (
            <DetailRow icon={Calendar} label="Calendar">
              {event.calendarName}
            </DetailRow>
          )}

          {(event.appointmentStatus || event.status) && (
            <DetailRow icon={User} label="Status">
              <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                {event.appointmentStatus || event.status}
              </span>
            </DetailRow>
          )}

          {event.address && (
            <DetailRow icon={User} label="Location">
              {event.address}
            </DetailRow>
          )}

          {event.notes && (
            <div>
              <div className="text-xs font-medium text-zinc-500 mb-1">Notes</div>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                {event.notes}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className="h-4 w-4 text-zinc-400 mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-500">{label}</div>
        <div className="text-zinc-700 dark:text-zinc-300 break-words">{children}</div>
      </div>
    </div>
  )
}

// ---- helpers ----

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay() // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day // treat Monday as start
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function formatWeekRange(start: Date): string {
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const sameMonth = start.getMonth() === end.getMonth()
  const startStr = start.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
  const endStr = end.toLocaleDateString('en-US', {
    month: sameMonth ? undefined : 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return `${startStr} – ${endStr}`
}

function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return iso
  }
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
