'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Two-month calendar popover with quick-pick presets — ported from
 * Ethan's CRM mockup, no Radix dependency. Click the trigger pill to
 * open; pick a start day, then an end day (or click a preset on the
 * right). Clicking outside closes.
 *
 * Returns / accepts dates as a `{ start, end }` pair where both are
 * full Date objects in local time. Callers can derive ISO / day
 * counts as needed.
 */

export type DateRange = { start: Date; end: Date }

/**
 * `defaultRange(7)` → last 7 days inclusive (today + 6 prior).
 * Mirrors the helper exposed in the mockup so callers can write
 * `useState<DateRange>(() => defaultRange(7))` without importing the
 * date-fns dependency we'd otherwise need.
 */
export function defaultRange(days: number): DateRange {
  const end = endOfDay(new Date())
  const start = startOfDay(new Date())
  start.setDate(start.getDate() - (days - 1))
  return { start, end }
}

export function DateRangePicker({
  value,
  onChange,
  align = 'start',
  className,
}: {
  value: DateRange
  onChange: (next: DateRange) => void
  align?: 'start' | 'end'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [hoverDay, setHoverDay] = useState<Date | null>(null)
  const [pickStart, setPickStart] = useState<Date | null>(null)
  // Visible month (left side) — right side is always +1 month. Starts
  // anchored to the current value's start month so the active range is
  // visible the moment the popover opens.
  const [viewMonth, setViewMonth] = useState<Date>(() =>
    new Date(value.start.getFullYear(), value.start.getMonth(), 1)
  )
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Outside-click closes.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setPickStart(null)
        setHoverDay(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const months = useMemo(
    () => [
      viewMonth,
      new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1),
    ],
    [viewMonth]
  )

  function pickDay(day: Date) {
    if (!pickStart) {
      setPickStart(day)
      setHoverDay(null)
      return
    }
    // Second click finishes the range. Order doesn't matter — if the
    // user clicks an earlier day for the second pick, we swap the
    // bounds so start <= end.
    const [s, e] =
      day < pickStart ? [day, pickStart] : [pickStart, day]
    onChange({ start: startOfDay(s), end: endOfDay(e) })
    setPickStart(null)
    setHoverDay(null)
    setOpen(false)
  }

  // Quick-pick presets matching the mockup's footer row.
  const presets = [
    { label: 'Last 7 days', days: 7 },
    { label: 'Last 30 days', days: 30 },
    { label: 'This Month', range: thisMonthRange() },
    { label: 'Last Month', range: lastMonthRange() },
    { label: 'Last 90 days', days: 90 },
    { label: 'Last 12 months', days: 365 },
  ]

  return (
    <div ref={wrapRef} className={cn('relative inline-block', className)}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2 text-sm font-medium shadow-soft transition hover:bg-muted"
      >
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
        <span>{formatRangeLabel(value)}</span>
      </button>
      {open && (
        <div
          className={cn(
            'absolute z-30 mt-1 flex w-[640px] flex-col gap-4 rounded-2xl border border-border bg-popover p-4 shadow-pop',
            align === 'end' ? 'right-0' : 'left-0'
          )}
        >
          {/* Two-month grid */}
          <div className="grid grid-cols-2 gap-6">
            {months.map((m, i) => (
              <Month
                key={`${m.getFullYear()}-${m.getMonth()}`}
                month={m}
                showPrev={i === 0}
                showNext={i === 1}
                onPrev={() =>
                  setViewMonth(
                    (vm) => new Date(vm.getFullYear(), vm.getMonth() - 1, 1)
                  )
                }
                onNext={() =>
                  setViewMonth(
                    (vm) => new Date(vm.getFullYear(), vm.getMonth() + 1, 1)
                  )
                }
                pickStart={pickStart}
                hoverDay={hoverDay}
                value={value}
                onPickDay={pickDay}
                onHoverDay={setHoverDay}
              />
            ))}
          </div>

          {/* Presets row */}
          <div className="flex flex-wrap gap-1.5 border-t border-border-soft pt-3">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  const next =
                    'days' in p && p.days !== undefined
                      ? defaultRange(p.days)
                      : (p as { range: DateRange }).range
                  onChange(next)
                  setPickStart(null)
                  setOpen(false)
                }}
                className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium hover:bg-muted"
              >
                {p.label}
              </button>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            {formatRangeFull(value)}
          </p>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Month({
  month,
  showPrev,
  showNext,
  onPrev,
  onNext,
  pickStart,
  hoverDay,
  value,
  onPickDay,
  onHoverDay,
}: {
  month: Date
  showPrev: boolean
  showNext: boolean
  onPrev: () => void
  onNext: () => void
  pickStart: Date | null
  hoverDay: Date | null
  value: DateRange
  onPickDay: (d: Date) => void
  onHoverDay: (d: Date | null) => void
}) {
  const days = monthDays(month)
  const monthLabel = month.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  // Range to highlight — committed value when not mid-pick, or the
  // tentative range from pickStart → hoverDay during selection.
  const previewRange: DateRange | null =
    pickStart && hoverDay
      ? hoverDay < pickStart
        ? { start: startOfDay(hoverDay), end: endOfDay(pickStart) }
        : { start: startOfDay(pickStart), end: endOfDay(hoverDay) }
      : null
  const highlight = previewRange ?? value

  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-1">
        {showPrev ? (
          <button
            type="button"
            onClick={onPrev}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        ) : (
          <span className="h-6 w-6" />
        )}
        <p className="text-sm font-semibold">{monthLabel}</p>
        {showNext ? (
          <button
            type="button"
            onClick={onNext}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <span className="h-6 w-6" />
        )}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-y-0.5 text-center text-sm">
        {days.map((cell, i) => {
          if (!cell) return <span key={i} />
          const isStart = sameDay(cell, highlight.start)
          const isEnd = sameDay(cell, highlight.end)
          const inRange =
            cell >= startOfDay(highlight.start) &&
            cell <= endOfDay(highlight.end)
          const isPickAnchor = pickStart && sameDay(cell, pickStart)
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPickDay(cell)}
              onMouseEnter={() => onHoverDay(cell)}
              className={cn(
                'mx-auto flex h-8 w-8 items-center justify-center rounded-md text-sm transition',
                inRange && !isStart && !isEnd && 'bg-primary-soft text-primary',
                (isStart || isEnd || isPickAnchor) &&
                  'bg-primary text-primary-foreground font-semibold',
                !inRange &&
                  !isPickAnchor &&
                  'hover:bg-muted hover:text-foreground'
              )}
            >
              {cell.getDate()}
            </button>
          )
        })}
      </div>
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

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** Returns 42 cells (6 weeks × 7 days) padded with `null`s for the
 *  leading days from the previous month + trailing days from next.
 *  Empty cells render blank so the calendar grid keeps its rhythm. */
function monthDays(month: Date): Array<Date | null> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  const startDow = first.getDay() // 0 = Sunday
  const cells: Array<Date | null> = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= last.getDate(); d++) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), d))
  }
  while (cells.length < 42) cells.push(null)
  return cells
}

function thisMonthRange(): DateRange {
  const now = new Date()
  return {
    start: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: endOfDay(now),
  }
}

function lastMonthRange(): DateRange {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const end = new Date(now.getFullYear(), now.getMonth(), 0)
  return { start: startOfDay(start), end: endOfDay(end) }
}

function formatRangeLabel(r: DateRange): string {
  // "Apr 24, 2026 – Apr 30, 2026" — same shape as mockup's pill.
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  return `${fmt(r.start)} – ${fmt(r.end)}`
}

function formatRangeFull(r: DateRange): string {
  return `${r.start.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })} — ${r.end.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })}`
}
