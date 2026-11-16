'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { inkOn, shade } from '@/lib/hl/color'
import type { PublicCalendar } from '@/lib/hl/booking'
import { UsFlag, phoneTyping } from './brand-bits'
import { lengthText } from './booking-frame'
import { Linked } from './public-form'

/**
 * The booking page a lead sees (hosted at /hl/b/<calendarId>, embedded on the
 * client's site) inside BookingFrame: a month, the open times that day in the
 * visitor's own timezone (morning, afternoon, evening), then their details
 * and the consent boxes, then the confirmation with "Add to calendar". Also
 * the picker for moving an existing booking (ManageAppointment). In the
 * business's colour, with the chat widget's fields and buttons.
 */

type SlotRow = { start: string; end: string }

const dateKey = (iso: string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const timeOf = (iso: string, tz: string, hour12 = true) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12 }).format(new Date(iso))
const hourOf = (iso: string, tz: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)))
const longDate = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso))
const dayTitle = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso))
const shortDay = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso))
const zoneName = (tz: string) => {
  for (const style of ['longGeneric', 'long'] as const) {
    try {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value
      if (name) return name
    } catch {
      // older browsers: try the next style
    }
  }
  return tz
}
/** Where a sticky-contact calendar keeps the booker's details, on their own device. */
const STICKY = 'hl-booker'
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function visitorZone(fallback: string) {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback
  } catch {
    return fallback
  }
}

/** The brand button (Continue, Book): the chat widget's Send. */
const brandButton = (color: string): React.CSSProperties => ({
  background: `linear-gradient(135deg, ${shade(color, 0.1)}, ${color} 60%, ${shade(color, -0.06)})`,
  color: inkOn(color),
  boxShadow: `0 8px 18px -8px ${color}, inset 0 1px 0 rgba(255,255,255,.22)`,
})

const Chevron = ({ left }: { left?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={left ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
  </svg>
)
const Check = ({ size = 16, width = 2.6 }: { size?: number; width?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)
const Spinner = () => (
  <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
    <path d="M21 12a9 9 0 1 1-6.2-8.6" />
  </svg>
)

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="hl-in flex items-start gap-2 rounded-xl bg-[#FEF3F2] px-3.5 py-2.5 text-[13px] text-[#B42318]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <span>{children}</span>
    </p>
  )
}

/** Morning, afternoon and evening, so a long day of times is easy to scan. */
function byPartOfDay(slots: SlotRow[], tz: string) {
  const parts = [
    { label: 'Morning', items: [] as SlotRow[] },
    { label: 'Afternoon', items: [] as SlotRow[] },
    { label: 'Evening', items: [] as SlotRow[] },
  ]
  for (const s of slots) {
    const h = hourOf(s.start, tz)
    parts[h < 12 ? 0 : h < 17 ? 1 : 2].items.push(s)
  }
  return parts.filter((p) => p.items.length)
}

export function SlotPicker({
  calendar,
  tz,
  onTz,
  picked,
  onPick,
  duration,
  member,
}: {
  calendar: PublicCalendar
  tz: string
  onTz: (tz: string) => void
  picked: string | null
  onPick: (start: string) => void
  /** A length the booker picked (minutes); the calendar's own when there's no choice. */
  duration?: number
  /** The team member they picked (a service menu with staff selection). */
  member?: string
}) {
  const now = useMemo(() => new Date(), [])
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() })
  const [day, setDay] = useState<string | null>(null)
  const range = useMemo(() => {
    const from = new Date(Date.UTC(month.y, month.m, 1) - 86_400_000)
    const to = new Date(Date.UTC(month.y, month.m + 1, 1) + 86_400_000)
    return { from: from < now ? now : from, to }
  }, [month, now])
  const q = useQuery<{ slots: SlotRow[] }>({
    queryKey: ['hl-slots', calendar.id, range.from.toISOString(), range.to.toISOString(), duration ?? null, member ?? null],
    queryFn: async () => {
      const res = await fetch(`/api/hl/public/calendars/${calendar.id}?from=${range.from.toISOString()}&to=${range.to.toISOString()}${duration ? `&duration=${duration}` : ''}${member ? `&member=${encodeURIComponent(member)}` : ''}`)
      const data = (await res.json().catch(() => ({}))) as { slots?: SlotRow[]; error?: string }
      if (!res.ok) throw new Error(data.error || 'Couldn’t load the times.')
      return { slots: data.slots ?? [] }
    },
    staleTime: 30_000,
  })
  const prefix = `${month.y}-${String(month.m + 1).padStart(2, '0')}`
  const byDay = useMemo(() => {
    const m = new Map<string, SlotRow[]>()
    for (const s of q.data?.slots ?? []) {
      const k = dateKey(s.start, tz)
      if (!k.startsWith(prefix)) continue
      m.set(k, [...(m.get(k) ?? []), s])
    }
    return m
  }, [q.data, tz, prefix])
  const firstOpen = [...byDay.keys()].sort()[0] ?? null
  const shown = day && byDay.has(day) ? day : firstOpen
  const today = dateKey(now.toISOString(), tz)
  const weekStart = calendar.weekStartsOn ?? 0
  const first = (new Date(Date.UTC(month.y, month.m, 1)).getUTCDay() - weekStart + 7) % 7
  const days = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate()
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  const canBack = month.y > now.getFullYear() || (month.y === now.getFullYear() && month.m > now.getMonth())
  const monthName = new Date(Date.UTC(month.y, month.m, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const shift = (d: number) => {
    setDay(null)
    setMonth(({ y, m }) => ({ y: m + d < 0 ? y - 1 : m + d > 11 ? y + 1 : y, m: (m + d + 12) % 12 }))
  }
  const slots = shown ? (byDay.get(shown) ?? []) : []
  const color = calendar.color

  return (
    <div className="grid gap-7 md:grid-cols-[minmax(0,340px)_minmax(0,1fr)] md:gap-9">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[16px] font-semibold tracking-[-0.01em] text-[#101828]">{monthName}</p>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => shift(-1)} disabled={!canBack} className="grid h-9 w-9 place-items-center rounded-full text-[#344054] transition hover:bg-[#F2F4F7] disabled:pointer-events-none disabled:opacity-30" aria-label="Previous month">
              <Chevron left />
            </button>
            <button type="button" onClick={() => shift(1)} className="grid h-9 w-9 place-items-center rounded-full text-[#344054] transition hover:bg-[#F2F4F7]" aria-label="Next month">
              <Chevron />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-y-1.5 text-center">
          {WEEKDAYS.map((_, i, all) => all[(i + weekStart) % 7]).map((d) => (
            <p key={d} className="pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#98A2B3]">
              {d}
            </p>
          ))}
          {cells.map((d, i) => {
            if (d === null) return <span key={`x${i}`} />
            const k = `${prefix}-${String(d).padStart(2, '0')}`
            const open = byDay.has(k)
            const active = shown === k
            return (
              <button
                key={k}
                type="button"
                disabled={!open}
                onClick={() => setDay(k)}
                aria-pressed={active}
                aria-label={`${d}${open ? ', times open' : ''}`}
                className={`relative mx-auto grid h-10 w-10 place-items-center rounded-full text-[14px] tabular-nums transition sm:h-11 sm:w-11 ${
                  active
                    ? 'font-semibold'
                    : open
                      ? 'bg-[color-mix(in_srgb,var(--hl-c)_10%,white)] font-semibold text-[color-mix(in_srgb,var(--hl-c)_58%,black)] hover:bg-[color-mix(in_srgb,var(--hl-c)_18%,white)]'
                      : 'text-[#C3C8D0]'
                }`}
                style={active ? brandButton(color) : undefined}
              >
                {d}
                {k === today && <span className={`absolute bottom-1.5 h-1 w-1 rounded-full ${active ? 'bg-current' : open ? 'bg-[var(--hl-c)]' : 'bg-[#98A2B3]'}`} aria-hidden />}
              </button>
            )
          })}
        </div>
        <label className="mt-5 flex items-center gap-2 text-[12.5px] text-[#667085]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
          </svg>
          <span className="sr-only">Time zone</span>
          <select value={tz} onChange={(e) => onTz(e.target.value)} className="min-w-0 cursor-pointer rounded-lg border border-transparent bg-transparent py-1 pl-1 pr-6 text-[12.5px] font-medium text-[#475467] outline-none transition hover:border-[#E4E7EC] focus:border-[var(--hl-c)]">
            {[...new Set([tz, calendar.timezone, ...ZONES])].map((z) => (
              <option key={z} value={z}>
                {zoneName(z)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex min-w-0 flex-col">
        {q.isLoading ? (
          <div className="flex flex-col gap-3" aria-label="Loading times">
            <span className="hl-sk h-5 w-44 rounded-md" />
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className="hl-sk h-11 rounded-xl" />
              ))}
            </div>
          </div>
        ) : q.error ? (
          <Alert>{(q.error as Error).message}</Alert>
        ) : !shown ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[#E4E7EC] px-6 py-10 text-center">
            <p className="text-[14px] font-medium text-[#344054]">No open times in {monthName.split(' ')[0]}</p>
            <button type="button" onClick={() => shift(1)} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-semibold text-[var(--hl-c)] transition hover:bg-[color-mix(in_srgb,var(--hl-c)_8%,white)]">
              Try next month <Chevron />
            </button>
          </div>
        ) : (
          <div key={shown} className="hl-in flex min-w-0 flex-col">
            <p className="text-[16px] font-semibold tracking-[-0.01em] text-[#101828]">{dayTitle(slots[0].start, tz)}</p>
            <p className="mt-0.5 text-[12.5px] text-[#667085]">
              {slots.length} {slots.length === 1 ? 'time' : 'times'} available
            </p>
            <div className="mt-4 flex flex-col gap-4 md:max-h-[388px] md:overflow-y-auto md:pr-1">
              {byPartOfDay(slots, tz).map((part) => (
                <div key={part.label}>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#98A2B3]">{part.label}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {part.items.map((s) => {
                      const on = picked === s.start
                      return (
                        <button
                          key={s.start}
                          type="button"
                          data-slot
                          aria-pressed={on}
                          onClick={() => onPick(s.start)}
                          className={`flex h-11 items-center justify-center gap-1.5 rounded-xl text-[14px] font-semibold tabular-nums transition active:scale-[.98] ${
                            on ? '' : 'border border-[#E4E7EC] bg-white text-[#344054] hover:border-[var(--hl-c)] hover:bg-[color-mix(in_srgb,var(--hl-c)_6%,white)] hover:text-[color-mix(in_srgb,var(--hl-c)_58%,black)]'
                          }`}
                          style={on ? brandButton(color) : undefined}
                        >
                          {on && <Check size={14} />}
                          {timeOf(s.start, tz, calendar.hour12 !== false)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** .ics for "Add to calendar". */
function icsHref(c: { title: string; start: string; end: string; location?: string; description?: string }) {
  const f = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const esc = (s: string) => s.replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n')
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Genisys//Booking//EN', 'BEGIN:VEVENT', `UID:${f(c.start)}-${Math.abs(c.title.length * 7919)}@genisys`, `DTSTAMP:${f(new Date().toISOString())}`, `DTSTART:${f(c.start)}`, `DTEND:${f(c.end)}`, `SUMMARY:${esc(c.title)}`, ...(c.location ? [`LOCATION:${esc(c.location)}`] : []), ...(c.description ? [`DESCRIPTION:${esc(c.description)}`] : []), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(body)}`
}

function googleHref(c: { title: string; start: string; end: string; location?: string; description?: string }) {
  const f = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const p = new URLSearchParams({ action: 'TEMPLATE', text: c.title, dates: `${f(c.start)}/${f(c.end)}`, ...(c.location ? { location: c.location } : {}), ...(c.description ? { details: c.description } : {}) })
  return `https://calendar.google.com/calendar/render?${p}`
}

/** The confirmation: a check that pops, when and where, and "Add to calendar". */
export function Booked({
  calendar,
  start,
  end,
  tz,
  manageUrl,
  headline,
  message,
  series = [],
}: {
  calendar: PublicCalendar
  start: string
  end: string
  tz: string
  manageUrl?: string | null
  headline: string
  /** A line under the headline (the calendar's thank-you message). */
  message?: string | null
  series?: { start: string; end: string }[]
}) {
  const event = { title: `${calendar.name} with ${calendar.business}`, start, end, location: calendar.location || undefined, description: manageUrl ? `Reschedule or cancel: ${manageUrl}` : undefined }
  const h12 = calendar.hour12 !== false
  const extra = message?.replace(/^you[’']re booked!?\s*/i, '').trim()
  const button = 'flex h-11 items-center justify-center gap-2 rounded-xl border border-[#E4E7EC] bg-white px-4 text-[14px] font-semibold text-[#344054] transition hover:bg-[#F9FAFB]'
  return (
    <div className="hl-in mx-auto flex max-w-md flex-col items-center gap-4 py-4 text-center">
      <span className="hl-pop grid h-16 w-16 place-items-center rounded-full" style={brandButton(calendar.color)}>
        <Check size={30} width={2.8} />
      </span>
      <div>
        <p className="text-[24px] font-semibold tracking-[-0.015em] text-[#101828]">{headline}</p>
        {extra && <p className="mt-1 text-[14.5px] text-[#475467]">{extra}</p>}
      </div>
      <div className="w-full rounded-2xl border border-[#EAECF0] bg-[#FCFCFD] px-5 py-4 text-left">
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#98A2B3]">{calendar.name}</p>
        <p className="mt-1.5 text-[15.5px] font-semibold text-[#101828]">{longDate(start, tz)}</p>
        <p className="text-[14.5px] text-[#344054]">
          {timeOf(start, tz, h12)} – {timeOf(end, tz, h12)} <span className="text-[#667085]">({zoneName(tz)})</span>
        </p>
        {calendar.location && <p className="mt-1.5 text-[13.5px] text-[#667085]">{calendar.location}</p>}
        {series.length > 0 && (
          <div className="mt-3 border-t border-[#EAECF0] pt-3 text-[13.5px] text-[#344054]">
            <p className="font-semibold text-[#101828]">And the rest of the series</p>
            <ul className="mt-1 space-y-0.5">
              {series.map((x) => (
                <li key={x.start}>
                  {longDate(x.start, tz)}, {timeOf(x.start, tz, h12)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        <a href={googleHref(event)} target="_blank" rel="noreferrer" className={button}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" />
            <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
            <path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14z" />
            <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.4 3-4.1 5.6-4.1z" />
          </svg>
          Google Calendar
        </a>
        <a href={icsHref(event)} download="appointment.ics" className={button}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="17" rx="3" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          Apple / Outlook
        </a>
      </div>
      {manageUrl && (
        <p className="text-[13px] text-[#667085]">
          Need to change it?{' '}
          <a href={manageUrl} target="_top" className="font-semibold text-[var(--hl-c)] hover:underline">
            Reschedule or cancel
          </a>
        </p>
      )}
    </div>
  )
}

/** "1 Pick a time · 2 Your details". */
function Steps({ step }: { step: 1 | 2 }) {
  return (
    <ol className="flex items-center gap-2 text-[12.5px] font-medium">
      {(['Pick a time', 'Your details'] as const).map((label, i) => {
        const n = (i + 1) as 1 | 2
        const done = n < step
        const on = n === step
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className={`h-px w-6 ${done || on ? 'bg-[var(--hl-c)]' : 'bg-[#E4E7EC]'}`} aria-hidden />}
            <span
              className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold ${on || done ? '' : 'bg-[#F2F4F7] text-[#98A2B3]'}`}
              style={on || done ? { background: 'var(--hl-c)', color: 'var(--hl-ink)' } : undefined}
            >
              {done ? <Check size={11} width={3} /> : n}
            </span>
            <span className={on ? 'text-[#101828]' : 'text-[#98A2B3]'}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** The whole booking page: pick a time, give details, done. */
export function BookingWidget({ calendar, pageUrl, team = [] }: { calendar: PublicCalendar; pageUrl: string | null; team?: { key: string; name: string }[] }) {
  const [member, setMember] = useState('')
  const [tz, setTz] = useState(() => (typeof window === 'undefined' ? calendar.timezone : visitorZone(calendar.timezone)))
  const [picked, setPicked] = useState<string | null>(null)
  const [duration, setDuration] = useState(calendar.durations?.[0] ?? calendar.duration)
  const [step, setStep] = useState<'pick' | 'details'>('pick')
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', email: '', notes: '' })
  // Sticky contact: a returning booker's details come back (after the first paint, so it matches the server's page).
  useEffect(() => {
    if (!calendar.stickyContact) return
    try {
      const kept = JSON.parse(window.localStorage.getItem(STICKY) ?? '{}') as Record<string, unknown>
      const pick = (k: string) => (typeof kept[k] === 'string' ? (kept[k] as string) : '')
      setF((x) => ({ ...x, firstName: pick('firstName'), lastName: pick('lastName'), phone: pick('phone'), email: pick('email') }))
    } catch {
      // nothing kept, or storage blocked
    }
  }, [calendar.stickyContact])
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field?: string } | null>(null)
  const [done, setDone] = useState<{ start: string; end: string; manageUrl: string | null; series: { start: string; end: string }[] } | null>(null)
  const key = (kind: string) => (kind === 'marketing' ? 'marketing_consent' : 'sms_consent')
  const h12 = calendar.hour12 !== false
  const length = calendar.durations?.length > 1 ? duration : calendar.duration
  const endOf = (start: string) => new Date(new Date(start).getTime() + length * 60_000).toISOString()

  // Fixing what was flagged clears the flag.
  const set = (k: keyof typeof f, v: string) => {
    setF((x) => ({ ...x, [k]: v }))
    if (error?.field === k) setError(null)
  }
  function flag(text: string, field?: string) {
    setError({ text, field })
    if (!field) return
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-field="${field}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      el?.focus({ preventScroll: true })
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!picked) return
    if (!f.firstName.trim()) return flag('Please add your first name.', 'firstName')
    if (f.phone.replace(/\D/g, '').length < 10) return flag('Please add your mobile number.', 'phone')
    if (calendar.askEmail && calendar.requireEmail && !f.email.trim()) return flag('Please add your email.', 'email')
    const missing = calendar.consents.find((c) => c.required && !ticked[key(c.kind)])
    if (missing) return flag('Please check the box to agree before booking.', key(missing.kind))
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hl/public/calendars/${calendar.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: picked,
          ...(calendar.durations?.length > 1 ? { duration } : {}),
          ...(member ? { member } : {}),
          ...f,
          timezone: tz,
          ...Object.fromEntries(calendar.consents.map((c) => [key(c.kind), !!ticked[key(c.kind)]])),
          _page: pageUrl ?? document.referrer,
          _hp: (document.getElementById('hl-hp') as HTMLInputElement | null)?.value ?? '',
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; field?: string; start?: string; end?: string; manageUrl?: string; redirectUrl?: string | null; series?: { start: string; end: string }[] }
      if (!res.ok) {
        if (data.field === 'start') {
          setPicked(null)
          setStep('pick')
          setError({ text: data.error || 'That time was just taken. Please pick another.' })
          return
        }
        flag(data.error || 'Something went wrong. Please try again.', data.field)
        return
      }
      if (data.redirectUrl) {
        window.open(data.redirectUrl, '_top')
        return
      }
      if (calendar.stickyContact) {
        try {
          window.localStorage.setItem(STICKY, JSON.stringify({ firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email }))
        } catch {
          // private browsing: nothing kept
        }
      }
      ;(window as { fbq?: (...a: unknown[]) => void }).fbq?.('track', 'Schedule')
      setDone({ start: data.start ?? picked, end: data.end ?? endOf(picked), manageUrl: data.manageUrl ?? null, series: Array.isArray(data.series) ? data.series : [] })
    } catch {
      flag('Couldn’t book. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) return <Booked calendar={calendar} start={done.start} end={done.end} tz={tz} manageUrl={done.manageUrl} headline="You’re booked!" message={calendar.thankYou} series={done.series} />

  const field =
    'hl-field h-11 w-full rounded-xl border border-[#E4E7EC] bg-[#FCFCFD] px-3.5 text-[14.5px] text-[#101828] outline-none transition placeholder:text-[#98A2B3] focus:border-[var(--hl-c)] focus:bg-white focus:ring-4 focus:ring-[color-mix(in_srgb,var(--hl-c)_14%,transparent)] aria-[invalid=true]:border-[#FDA29B] aria-[invalid=true]:ring-4 aria-[invalid=true]:ring-[#FEE4E2]'
  const label = 'text-[12.5px] font-medium text-[#344054]'
  const chip = (on: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition ${on ? 'border-[var(--hl-c)] bg-[color-mix(in_srgb,var(--hl-c)_10%,white)] text-[color-mix(in_srgb,var(--hl-c)_58%,black)]' : 'border-[#E4E7EC] text-[#475467] hover:bg-[#F9FAFB]'}`

  return (
    <div className="flex flex-col gap-6">
      <Steps step={step === 'pick' ? 1 : 2} />
      {calendar.recurring && (
        <p className="flex items-start gap-2.5 rounded-xl bg-[color-mix(in_srgb,var(--hl-c)_7%,white)] px-3.5 py-3 text-[13.5px] text-[#344054]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--hl-c)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden>
            <path d="m17 2 4 4-4 4" />
            <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
            <path d="m7 22-4-4 4-4" />
            <path d="M21 13v1a4 4 0 0 1-4 4H3" />
          </svg>
          <span>{calendar.recurring}. Pick the first time; the rest are booked with it.</span>
        </p>
      )}
      {step === 'pick' ? (
        <>
          {(calendar.durations?.length > 1 || team.length > 1) && (
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {calendar.durations?.length > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-1 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-[#98A2B3]">Length</span>
                  {calendar.durations.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setDuration(m)
                        setPicked(null)
                      }}
                      className={chip(m === duration)}
                    >
                      {lengthText(m)}
                    </button>
                  ))}
                </div>
              )}
              {team.length > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-1 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-[#98A2B3]">With</span>
                  {[{ key: '', name: 'Anyone' }, ...team].map((m) => (
                    <button
                      key={m.key || 'anyone'}
                      type="button"
                      onClick={() => {
                        setMember(m.key)
                        setPicked(null)
                      }}
                      className={chip(m.key === member)}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <SlotPicker calendar={calendar} tz={tz} onTz={setTz} picked={picked} onPick={setPicked} duration={calendar.durations?.length > 1 ? duration : undefined} member={member || undefined} />
          {error && <Alert>{error.text}</Alert>}
          {/* On a phone the choice and Continue stay in view at the bottom. */}
          <div className="sticky bottom-0 -mx-5 -mb-5 flex items-center gap-3 border-t border-[#F2F4F7] bg-white/95 px-5 py-3 backdrop-blur sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
            {picked && (
              <p className="hl-in min-w-0 flex-1 text-[13.5px] leading-tight text-[#475467]">
                <span className="block truncate font-semibold text-[#101828]">{shortDay(picked, tz)}</span>
                <span className="block truncate">
                  {timeOf(picked, tz, h12)} – {timeOf(endOf(picked), tz, h12)}
                </span>
              </p>
            )}
            <button
              type="button"
              disabled={!picked}
              onClick={() => {
                setError(null)
                setStep('details')
              }}
              className={`flex h-12 items-center justify-center gap-2 rounded-xl px-6 text-[15px] font-semibold transition active:scale-[.99] disabled:cursor-not-allowed ${picked ? 'shrink-0 hover:brightness-[1.06] sm:ml-auto' : 'w-full bg-[#F2F4F7] text-[#98A2B3]'}`}
              style={picked ? brandButton(calendar.color) : undefined}
            >
              {picked ? (
                <>
                  Continue
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </>
              ) : (
                'Pick a time to continue'
              )}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} className="hl-in mx-auto flex w-full max-w-xl flex-col gap-4" noValidate>
          <div className="flex items-center gap-3 rounded-2xl bg-[color-mix(in_srgb,var(--hl-c)_7%,white)] px-4 py-3.5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={brandButton(calendar.color)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="4" width="18" height="17" rx="3" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </span>
            <span className="min-w-0 flex-1 text-[14px] leading-snug text-[#344054]">
              <span className="block font-semibold text-[#101828]">{longDate(picked!, tz)}</span>
              {timeOf(picked!, tz, h12)} – {timeOf(endOf(picked!), tz, h12)} · {zoneName(tz)}
            </span>
            <button type="button" onClick={() => setStep('pick')} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-[var(--hl-c)] transition hover:bg-white/70">
              Change
            </button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className={label}>
                First name<span className="text-[#D92D20]"> *</span>
              </span>
              <input className={field} data-field="firstName" value={f.firstName} onChange={(e) => set('firstName', e.target.value)} autoComplete="given-name" aria-invalid={error?.field === 'firstName'} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={label}>Last name</span>
              <input className={field} data-field="lastName" value={f.lastName} onChange={(e) => set('lastName', e.target.value)} autoComplete="family-name" />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className={label}>
              Mobile phone<span className="text-[#D92D20]"> *</span>
            </span>
            <span
              aria-invalid={error?.field === 'phone'}
              className="flex h-11 items-center rounded-xl border border-[#E4E7EC] bg-[#FCFCFD] transition focus-within:border-[var(--hl-c)] focus-within:bg-white focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--hl-c)_14%,transparent)] aria-[invalid=true]:border-[#FDA29B] aria-[invalid=true]:ring-4 aria-[invalid=true]:ring-[#FEE4E2]"
            >
              <span className="flex items-center gap-1.5 border-r border-[#EAECF0] pl-3 pr-2.5 text-[14px] text-[#475467]" aria-hidden>
                <UsFlag />
                +1
              </span>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                data-field="phone"
                value={f.phone}
                onChange={(e) => set('phone', phoneTyping(e.target.value))}
                placeholder="(555) 555-0123"
                className="hl-field h-full min-w-0 flex-1 bg-transparent px-3 text-[14.5px] text-[#101828] outline-none placeholder:text-[#C3C8D0]"
              />
            </span>
          </label>
          {calendar.askEmail && (
            <label className="flex flex-col gap-1.5">
              <span className={label}>
                Email{calendar.requireEmail && <span className="text-[#D92D20]"> *</span>}
              </span>
              <input className={field} type="email" data-field="email" value={f.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" aria-invalid={error?.field === 'email'} />
            </label>
          )}
          {calendar.askNotes && (
            <label className="flex flex-col gap-1.5">
              <span className={label}>Anything we should know?</span>
              <textarea className={`${field} h-auto min-h-[88px] resize-none py-2.5`} rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
            </label>
          )}
          <input id="hl-hp" name="_hp" tabIndex={-1} autoComplete="off" className="absolute -left-[9999px] h-0 w-0 opacity-0" aria-hidden />
          {calendar.consents.length > 0 && (
            <div className="flex flex-col gap-2.5 border-t border-[#F2F4F7] pt-4">
              {calendar.consents.map((c) => (
                <label key={c.kind} className="flex cursor-pointer items-start gap-2.5 text-[11.5px] leading-[1.5] text-[#667085]">
                  <input
                    type="checkbox"
                    data-field={key(c.kind)}
                    checked={!!ticked[key(c.kind)]}
                    onChange={(e) => {
                      setTicked((t) => ({ ...t, [key(c.kind)]: e.target.checked }))
                      if (error?.field === key(c.kind)) setError(null)
                    }}
                    className="mt-[1px] h-4 w-4 shrink-0 cursor-pointer rounded accent-[var(--hl-c)] aria-[invalid=true]:outline-2 aria-[invalid=true]:outline-offset-1 aria-[invalid=true]:outline-[#F04438]"
                    aria-invalid={error?.field === key(c.kind)}
                  />
                  <span className="[&_a]:text-[#475467]">
                    <Linked text={c.text} legal={calendar.legal} />
                    {c.required && <span className="text-[#D92D20]"> *</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
          {error && <Alert>{error.text}</Alert>}
          <button type="submit" disabled={busy} className="mt-1 flex h-12 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold transition hover:brightness-[1.06] active:scale-[.99] disabled:opacity-70" style={brandButton(calendar.color)}>
            {busy ? <Spinner /> : 'Book appointment'}
          </button>
        </form>
      )}
    </div>
  )
}
