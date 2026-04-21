'use client'

import { useMemo, useState, useEffect } from 'react'
import { Check } from 'lucide-react'

/**
 * Clean two-dropdown date/time picker. Replaces the native datetime-local
 * input (visually cramped) and the earlier chip-row experiment (too busy).
 *
 * UX:
 *   [ Date ▼ ]  [ Time ▼ ]
 *   "Tuesday, April 22 at 2:00 PM"   ← confirmation pill
 *
 * Each dropdown has a rich preset list. Pick "Other…" at the bottom of
 * either dropdown to reveal a native date/time input.
 *
 * Emits "YYYY-MM-DDTHH:mm" (same as datetime-local) so upstream conflict
 * detection + server submission keep working.
 */

type Props = {
  value: string // "YYYY-MM-DDTHH:mm" or ""
  onChange: (next: string) => void
  disabled?: boolean
}

const OTHER_DATE = '__OTHER_DATE__'
const OTHER_TIME = '__OTHER_TIME__'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return d
}

/** Label a date for the dropdown: "Today · Apr 21", "Wed · Apr 23", etc. */
function labelForDate(d: Date, offsetFromToday: number): string {
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (offsetFromToday === 0) return `Today · ${dateStr}`
  if (offsetFromToday === 1) return `Tomorrow · ${dateStr}`
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' })
  return `${weekday} · ${dateStr}`
}

/** 8 AM → 9 PM in 30-min steps. Covers virtually every solar-call slot. */
const TIME_OPTIONS: Array<{ value: string; label: string }> = (() => {
  const out: Array<{ value: string; label: string }> = []
  for (let hour = 8; hour <= 21; hour++) {
    for (const minute of [0, 30]) {
      const value = `${pad(hour)}:${pad(minute)}`
      // Build a Date just to format the label consistently in 12-hour form.
      const labelDate = new Date()
      labelDate.setHours(hour, minute, 0, 0)
      const label = labelDate.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
      out.push({ value, label })
    }
  }
  return out
})()

export function AppointmentDateTimePicker({ value, onChange, disabled }: Props) {
  const [datePart, timePart] = useMemo(() => {
    if (!value) return ['', '']
    const [d, t] = value.split('T')
    return [d || '', (t || '').slice(0, 5)]
  }, [value])

  // The preset list covers today + the next 21 days. If the current value
  // falls outside that range (e.g. editing an appointment booked a month
  // out), the dropdown shows "Other" by default and the native picker
  // below displays the actual date.
  const dateOptions = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return Array.from({ length: 22 }, (_, i) => {
      const d = addDays(today, i)
      return { value: toLocalDate(d), label: labelForDate(d, i) }
    })
  }, [])

  const dateInPresets = datePart && dateOptions.some((o) => o.value === datePart)
  const timeInPresets = timePart && TIME_OPTIONS.some((o) => o.value === timePart)

  // "Other" is shown when the value doesn't match any preset. Track it
  // separately so picking Other, then typing in the input, doesn't snap
  // the dropdown back to a preset mid-type.
  const [dateMode, setDateMode] = useState<'preset' | 'other'>(
    datePart && !dateInPresets ? 'other' : 'preset'
  )
  const [timeMode, setTimeMode] = useState<'preset' | 'other'>(
    timePart && !timeInPresets ? 'other' : 'preset'
  )

  // When the value changes externally (edit-mode prefill, or a reset),
  // rehydrate the mode to match.
  useEffect(() => {
    setDateMode(datePart && !dateInPresets ? 'other' : 'preset')
    setTimeMode(timePart && !timeInPresets ? 'other' : 'preset')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function emit(date: string, time: string) {
    if (!date && !time) {
      onChange('')
      return
    }
    const d = date || toLocalDate(new Date())
    const t = time || '10:00'
    onChange(`${d}T${t}`)
  }

  function onDateSelect(next: string) {
    if (next === OTHER_DATE) {
      setDateMode('other')
      return
    }
    setDateMode('preset')
    emit(next, timePart)
  }
  function onTimeSelect(next: string) {
    if (next === OTHER_TIME) {
      setTimeMode('other')
      return
    }
    setTimeMode('preset')
    emit(datePart, next)
  }

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

  const selectCls =
    'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-purple-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950'

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Date
          </label>
          <select
            value={dateMode === 'other' ? OTHER_DATE : datePart}
            onChange={(e) => onDateSelect(e.target.value)}
            disabled={disabled}
            className={selectCls}
          >
            <option value="">Select a date…</option>
            {dateOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            <option value={OTHER_DATE}>Other date…</option>
          </select>
          {dateMode === 'other' && (
            <input
              type="date"
              value={datePart}
              onChange={(e) => emit(e.target.value, timePart)}
              disabled={disabled}
              className={`${selectCls} mt-2`}
            />
          )}
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Time
          </label>
          <select
            value={timeMode === 'other' ? OTHER_TIME : timePart}
            onChange={(e) => onTimeSelect(e.target.value)}
            disabled={disabled}
            className={selectCls}
          >
            <option value="">Select a time…</option>
            {TIME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            <option value={OTHER_TIME}>Custom time…</option>
          </select>
          {timeMode === 'other' && (
            <input
              type="time"
              value={timePart}
              onChange={(e) => emit(datePart, e.target.value)}
              disabled={disabled}
              step={900}
              className={`${selectCls} mt-2`}
            />
          )}
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
