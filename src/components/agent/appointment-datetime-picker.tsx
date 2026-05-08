'use client'

import { useMemo, useState, useEffect } from 'react'
import { Check } from 'lucide-react'
import {
  AGENT_TIMEZONE,
  todayInTz,
  addDaysToDateString,
} from '@/lib/timezone'

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

// The Date side no longer uses an OTHER sentinel — the calendar input
// is always visible. Time still has the toggle to keep its preset list
// useful without forcing a fiddly mobile time picker on every booking.
const OTHER_TIME = '__OTHER_TIME__'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Label a date for the dropdown: "Today · Apr 21", "Wed · Apr 23".
 *
 * Takes the YYYY-MM-DD string directly. Building the Date via
 * `new Date(`${dateStr}T12:00:00`)` anchors at LOCAL noon, which is
 * always on the same calendar day as `dateStr` for any timezone
 * `toLocaleDateString` might pick — no day-flip risk from a midnight
 * round-trip. (We only use `toLocaleDateString` here for the visual
 * "May 8" formatting; the *value* sent on selection is the
 * tz-anchored YYYY-MM-DD string built upstream.)
 */
function labelForDate(dateStr: string, offsetFromToday: number): string {
  const d = new Date(`${dateStr}T12:00:00`)
  const formatted = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
  if (offsetFromToday === 0) return `Today · ${formatted}`
  if (offsetFromToday === 1) return `Tomorrow · ${formatted}`
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' })
  return `${weekday} · ${formatted}`
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
  // out), the dropdown shows "Select a date…" by default and the native
  // calendar input below displays the actual date.
  //
  // "Today" is anchored to AGENT_TIMEZONE (US Pacific) — NOT the
  // viewer's browser zone. Mary works from Manila but her bookings
  // are for US customers, so "today" needs to be the US calendar
  // day. At 6 PM Manila on May 8, US Pacific still reads May 7 —
  // which matches what Mary's customer sees. Without the anchor
  // the picker tips to "tomorrow" for ~15 hours of every Manila
  // workday. (Reported by Mary 2026-05-07.)
  const dateOptions = useMemo(() => {
    const todayStr = todayInTz(AGENT_TIMEZONE)
    return Array.from({ length: 22 }, (_, i) => {
      const dateStr = addDaysToDateString(todayStr, i)
      return { value: dateStr, label: labelForDate(dateStr, i) }
    })
  }, [])

  const dateInPresets = datePart && dateOptions.some((o) => o.value === datePart)
  const timeInPresets = timePart && TIME_OPTIONS.some((o) => o.value === timePart)

  // For the *time* side we still toggle between preset / other modes —
  // typing into a time input is fiddlier and the preset list covers
  // most needs. The date side now always shows the native calendar
  // input below the dropdown (per agent feedback: hunting for it
  // behind the "Other date…" option was confusing).
  const [timeMode, setTimeMode] = useState<'preset' | 'other'>(
    timePart && !timeInPresets ? 'other' : 'preset'
  )

  // When the value changes externally (edit-mode prefill, or a reset),
  // rehydrate the time mode to match.
  useEffect(() => {
    setTimeMode(timePart && !timeInPresets ? 'other' : 'preset')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function emit(date: string, time: string) {
    if (!date && !time) {
      onChange('')
      return
    }
    // Same Manila-anchor reasoning as dateOptions — if the agent
    // picked a time but no date, "today" must mean Mary's today.
    const d = date || todayInTz(AGENT_TIMEZONE)
    const t = time || '10:00'
    onChange(`${d}T${t}`)
  }

  function onDateSelect(next: string) {
    // The dropdown is now purely a preset shortcut — picking a preset
    // updates the value and the calendar input below mirrors it.
    // There is no longer an "Other date" sentinel to handle here.
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
    'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950'

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Date
          </label>
          {/* Quick-pick dropdown for "Today / Tomorrow / next 3 weeks". */}
          <select
            // When the typed-in date doesn't match a preset, the
            // dropdown falls back to "Select a date…" so it doesn't
            // misrepresent the active value — the calendar input below
            // is the source of truth either way.
            value={dateInPresets ? datePart : ''}
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
          </select>
          {/* Calendar input is always visible — agents can either
              pick a preset above or jump straight to a specific date
              via the OS date picker. The two views stay in sync. */}
          <input
            type="date"
            value={datePart}
            onChange={(e) => emit(e.target.value, timePart)}
            disabled={disabled}
            className={`${selectCls} mt-2`}
            aria-label="Pick a specific date"
          />
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
        <div className="inline-flex items-center gap-2 rounded-md bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          <Check className="h-3.5 w-3.5" />
          {summary}
        </div>
      )}
    </div>
  )
}
