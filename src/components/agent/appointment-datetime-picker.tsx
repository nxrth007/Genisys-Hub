'use client'

import { useMemo } from 'react'
import { Calendar, Clock, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Split date + time picker with one-tap shortcuts. Replaces the native
 * datetime-local input, which is visually cramped and slow to operate.
 *
 * Emits a "YYYY-MM-DDTHH:mm" string (same format as datetime-local) so
 * upstream logic — conflict detection, server submission, edit prefill —
 * doesn't need to change.
 */

type Props = {
  value: string // "YYYY-MM-DDTHH:mm" or ""
  onChange: (next: string) => void
  disabled?: boolean
}

/** Local "YYYY-MM-DD" for a given Date (respects the browser's own tz). */
function toLocalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "HH:mm" 24-hour format from a Date. */
function toLocalTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

/** Common solar-appointment time slots — evening is most common because
 *  the homeowner is usually home. */
const TIME_SHORTCUTS = [
  { label: '10 AM', value: '10:00' },
  { label: '12 PM', value: '12:00' },
  { label: '2 PM', value: '14:00' },
  { label: '4 PM', value: '16:00' },
  { label: '6 PM', value: '18:00' },
  { label: '7 PM', value: '19:00' },
]

export function AppointmentDateTimePicker({ value, onChange, disabled }: Props) {
  // Split the combined value back into date + time parts for the two inputs.
  // Blank strings when the value is empty so the inputs show their
  // placeholder instead of 1970-01-01.
  const [datePart, timePart] = useMemo(() => {
    if (!value) return ['', '']
    const [d, t] = value.split('T')
    // Strip seconds if they snuck in (e.g. "14:00:00").
    return [d || '', (t || '').slice(0, 5)]
  }, [value])

  function emit(date: string, time: string) {
    if (!date && !time) {
      onChange('')
      return
    }
    // Default either side if only one was set — saves an extra keystroke
    // when the agent uses a quick button before touching the other field.
    const d = date || toLocalDate(new Date())
    const t = time || '10:00'
    onChange(`${d}T${t}`)
  }

  function setDate(d: string) {
    emit(d, timePart)
  }
  function setTime(t: string) {
    emit(datePart, t)
  }

  const today = new Date()
  const dateShortcuts = [
    { label: 'Today', value: toLocalDate(today) },
    { label: 'Tomorrow', value: toLocalDate(addDays(today, 1)) },
    {
      label: addDays(today, 2).toLocaleDateString('en-US', { weekday: 'short' }),
      value: toLocalDate(addDays(today, 2)),
    },
    {
      label: addDays(today, 3).toLocaleDateString('en-US', { weekday: 'short' }),
      value: toLocalDate(addDays(today, 3)),
    },
  ]

  // Summary line — reassures the agent they picked what they intended,
  // especially in edge cases like "Tomorrow" at 11:59 PM crossing midnight.
  const summary = (() => {
    if (!datePart || !timePart) return null
    const d = new Date(`${datePart}T${timePart}`)
    if (isNaN(d.getTime())) return null
    return d.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  })()

  return (
    <div className="space-y-3">
      {/* Date row */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          <Calendar className="h-3 w-3" />
          Date
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dateShortcuts.map((s) => {
            const active = datePart === s.value
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => setDate(s.value)}
                disabled={disabled}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                  active
                    ? 'border-purple-600 bg-purple-600 text-white shadow-sm'
                    : 'border-zinc-200 bg-white text-zinc-700 hover:border-purple-300 hover:bg-purple-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-purple-700 dark:hover:bg-purple-950/40'
                )}
              >
                {s.label}
              </button>
            )
          })}
          <input
            type="date"
            value={datePart}
            onChange={(e) => setDate(e.target.value)}
            disabled={disabled}
            className="ml-1 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>
      </div>

      {/* Time row */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          <Clock className="h-3 w-3" />
          Time
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {TIME_SHORTCUTS.map((s) => {
            const active = timePart === s.value
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => setTime(s.value)}
                disabled={disabled}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                  active
                    ? 'border-purple-600 bg-purple-600 text-white shadow-sm'
                    : 'border-zinc-200 bg-white text-zinc-700 hover:border-purple-300 hover:bg-purple-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-purple-700 dark:hover:bg-purple-950/40'
                )}
              >
                {s.label}
              </button>
            )
          })}
          <input
            type="time"
            value={timePart}
            onChange={(e) => setTime(e.target.value)}
            disabled={disabled}
            // 15-minute step matches how most dispatchers talk about slots.
            step={900}
            className="ml-1 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>
      </div>

      {summary && (
        <div className="inline-flex items-center gap-2 rounded-md bg-purple-50 px-3 py-1.5 text-xs font-medium text-purple-700 dark:bg-purple-950 dark:text-purple-300">
          <Check className="h-3.5 w-3.5" />
          {summary}
        </div>
      )}
    </div>
  )
}
