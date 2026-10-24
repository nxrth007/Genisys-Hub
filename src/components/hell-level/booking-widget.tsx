'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PublicCalendar } from '@/lib/hl/booking'
import { Linked } from './public-form'

/**
 * The booking page a lead sees (hosted at /hl/b/<calendarId>, embedded on the
 * client's site): a month, the open times that day in the visitor's own
 * timezone, then their details and the consent boxes. Also the picker for
 * moving an existing booking (mode "reschedule"). Plain and light like the
 * forms, in the calendar's colour.
 */

type SlotRow = { start: string; end: string }

const dateKey = (iso: string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const timeOf = (iso: string, tz: string, hour12 = true) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12 }).format(new Date(iso))
const longDate = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso))
const zoneName = (tz: string) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz
  } catch {
    return tz
  }
}
/** Where a sticky-contact calendar keeps the booker's details, on their own device. */
const STICKY = 'hl-booker'
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']

export function visitorZone(fallback: string) {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback
  } catch {
    return fallback
  }
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
  const weekStart = calendar.weekStartsOn ?? 0
  const first = (new Date(Date.UTC(month.y, month.m, 1)).getUTCDay() - weekStart + 7) % 7
  const days = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate()
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  const canBack = month.y > now.getFullYear() || (month.y === now.getFullYear() && month.m > now.getMonth())
  const shift = (d: number) => {
    setDay(null)
    setMonth(({ y, m }) => ({ y: m + d < 0 ? y - 1 : m + d > 11 ? y + 1 : y, m: (m + d + 12) % 12 }))
  }
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_200px]">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <button type="button" onClick={() => shift(-1)} disabled={!canBack} className="grid h-8 w-8 place-items-center rounded-full text-[#344054] hover:bg-[#F2F4F7] disabled:opacity-30" aria-label="Previous month">
            ‹
          </button>
          <p className="text-[15px] font-semibold text-[#101828]">{new Date(Date.UTC(month.y, month.m, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</p>
          <button type="button" onClick={() => shift(1)} className="grid h-8 w-8 place-items-center rounded-full text-[#344054] hover:bg-[#F2F4F7]" aria-label="Next month">
            ›
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((_, i, all) => all[(i + weekStart) % 7]).map((d, i) => (
            <p key={i} className="py-1 text-[11px] font-medium text-[#98A2B3]">
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
                className={`mx-auto grid h-10 w-10 place-items-center rounded-full text-[14px] transition ${active ? 'bg-[var(--hl-c)] font-semibold text-white' : open ? 'bg-[color-mix(in_srgb,var(--hl-c)_10%,white)] font-semibold text-[var(--hl-c)] hover:bg-[color-mix(in_srgb,var(--hl-c)_18%,white)]' : 'text-[#D0D5DD]'}`}
              >
                {d}
              </button>
            )
          })}
        </div>
        <label className="mt-4 flex items-center gap-2 text-[12px] text-[#667085]">
          Times in
          <select value={tz} onChange={(e) => onTz(e.target.value)} className="rounded-md border border-[#D0D5DD] bg-white px-2 py-1 text-[12px] text-[#344054]">
            {[...new Set([tz, calendar.timezone, ...ZONES])].map((z) => (
              <option key={z} value={z}>
                {zoneName(z)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-col gap-2">
        {q.isLoading ? (
          <p className="py-6 text-center text-[13px] text-[#667085]">Loading times…</p>
        ) : q.error ? (
          <p className="rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{(q.error as Error).message}</p>
        ) : !shown ? (
          <p className="py-6 text-center text-[13px] text-[#667085]">No open times this month. Try the next one.</p>
        ) : (
          <>
            <p className="text-[13px] font-medium text-[#344054]">{longDate(byDay.get(shown)![0].start, tz)}</p>
            <div className="flex max-h-[340px] flex-col gap-2 overflow-y-auto pr-1">
              {byDay.get(shown)!.map((s) => (
                <button
                  key={s.start}
                  type="button"
                  onClick={() => onPick(s.start)}
                  className={`rounded-lg border px-3 py-2.5 text-[14px] font-semibold transition ${picked === s.start ? 'border-[var(--hl-c)] bg-[var(--hl-c)] text-white' : 'border-[color-mix(in_srgb,var(--hl-c)_45%,white)] text-[var(--hl-c)] hover:border-[var(--hl-c)]'}`}
                >
                  {timeOf(s.start, tz, calendar.hour12 !== false)}
                </button>
              ))}
            </div>
          </>
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

export function Booked({ calendar, start, end, tz, manageUrl, headline, series = [] }: { calendar: PublicCalendar; start: string; end: string; tz: string; manageUrl?: string | null; headline: string; series?: { start: string; end: string }[] }) {
  const event = { title: `${calendar.name} with ${calendar.business}`, start, end, location: calendar.location || undefined, description: manageUrl ? `Reschedule or cancel: ${manageUrl}` : undefined }
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-[var(--hl-c)] text-white">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <p className="text-[20px] font-semibold text-[#101828]">{headline}</p>
      <p className="text-[15px] text-[#344054]">
        {longDate(start, tz)}
        <br />
        {timeOf(start, tz, calendar.hour12 !== false)} – {timeOf(end, tz, calendar.hour12 !== false)} ({zoneName(tz)})
      </p>
      {calendar.location && <p className="text-[13px] text-[#667085]">{calendar.location}</p>}
      {series.length > 0 && (
        <div className="w-full max-w-sm rounded-lg bg-[#F9FAFB] px-4 py-3 text-left text-[13.5px] text-[#344054]">
          <p className="font-semibold text-[#101828]">And the rest of the series</p>
          <ul className="mt-1 space-y-0.5">
            {series.map((x) => (
              <li key={x.start}>
                {longDate(x.start, tz)}, {timeOf(x.start, tz, calendar.hour12 !== false)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-2 flex flex-wrap justify-center gap-2 text-[13px]">
        <a href={googleHref(event)} target="_blank" rel="noreferrer" className="rounded-lg border border-[#D0D5DD] px-3 py-2 font-medium text-[#344054] hover:bg-[#F9FAFB]">
          Add to Google Calendar
        </a>
        <a href={icsHref(event)} download="appointment.ics" className="rounded-lg border border-[#D0D5DD] px-3 py-2 font-medium text-[#344054] hover:bg-[#F9FAFB]">
          Add to Apple / Outlook
        </a>
      </div>
      {manageUrl && (
        <p className="mt-1 text-[12.5px] text-[#667085]">
          Need to change it?{' '}
          <a href={manageUrl} target="_top" className="font-medium text-[var(--hl-c)] underline">
            Reschedule or cancel
          </a>
        </p>
      )}
    </div>
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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!picked) return
    const missing = calendar.consents.find((c) => c.required && !ticked[key(c.kind)])
    if (missing) {
      setError({ text: 'Please check the box to agree before booking.', field: key(missing.kind) })
      return
    }
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
        setError({ text: data.error || 'Something went wrong. Please try again.', field: data.field })
        if (data.field === 'start') {
          setPicked(null)
          setStep('pick')
        }
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
      setDone({ start: data.start ?? picked, end: data.end ?? picked, manageUrl: data.manageUrl ?? null, series: Array.isArray(data.series) ? data.series : [] })
    } catch {
      setError({ text: 'Couldn’t book. Check your connection and try again.' })
    } finally {
      setBusy(false)
    }
  }

  if (done) return <Booked calendar={calendar} start={done.start} end={done.end} tz={tz} manageUrl={done.manageUrl} headline={calendar.thankYou ?? 'You’re booked!'} series={done.series} />

  const input = 'w-full rounded-lg border border-[#D0D5DD] bg-white px-3.5 py-2.5 text-[15px] text-[#101828] outline-none transition placeholder:text-[#98A2B3] focus:border-[var(--hl-c)] focus:ring-4 focus:ring-[color-mix(in_srgb,var(--hl-c)_15%,transparent)]'
  return (
    <div className="flex flex-col gap-5">
      {calendar.recurring && <p className="rounded-lg bg-[#F9FAFB] px-3.5 py-2.5 text-[13.5px] text-[#344054]">{calendar.recurring}. Pick the first time; the rest are booked with it.</p>}
      {step === 'pick' ? (
        <>
          {calendar.durations?.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-[#344054]">Length</span>
              {calendar.durations.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setDuration(m)
                    setPicked(null)
                  }}
                  className={`rounded-full border px-3 py-1 text-[13px] transition ${m === duration ? 'border-[var(--hl-c)] bg-[color-mix(in_srgb,var(--hl-c)_10%,white)] font-semibold text-[var(--hl-c)]' : 'border-[#D0D5DD] text-[#344054] hover:bg-[#F9FAFB]'}`}
                >
                  {m % 60 === 0 ? `${m / 60} hr` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`}
                </button>
              ))}
            </div>
          )}
          {team.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-[#344054]">With</span>
              {[{ key: '', name: 'Anyone' }, ...team].map((m) => (
                <button
                  key={m.key || 'anyone'}
                  type="button"
                  onClick={() => {
                    setMember(m.key)
                    setPicked(null)
                  }}
                  className={`rounded-full border px-3 py-1 text-[13px] transition ${m.key === member ? 'border-[var(--hl-c)] bg-[color-mix(in_srgb,var(--hl-c)_10%,white)] font-semibold text-[var(--hl-c)]' : 'border-[#D0D5DD] text-[#344054] hover:bg-[#F9FAFB]'}`}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
          <SlotPicker calendar={calendar} tz={tz} onTz={setTz} picked={picked} onPick={setPicked} duration={calendar.durations?.length > 1 ? duration : undefined} member={member || undefined} />
          {error && <p className="rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error.text}</p>}
          <button
            type="button"
            disabled={!picked}
            onClick={() => {
              setError(null)
              setStep('details')
            }}
            className="rounded-lg bg-[var(--hl-c)] px-4 py-3 text-[15px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40"
          >
            {picked ? `Continue with ${timeOf(picked, tz, calendar.hour12 !== false)}` : 'Pick a time'}
          </button>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
          <div className="flex items-start justify-between gap-3 rounded-lg bg-[#F9FAFB] px-3.5 py-3 text-[14px] text-[#344054]">
            <span>
              <span className="block font-semibold text-[#101828]">{longDate(picked!, tz)}</span>
              {timeOf(picked!, tz, calendar.hour12 !== false)} ({zoneName(tz)})
            </span>
            <button type="button" onClick={() => setStep('pick')} className="text-[13px] font-medium text-[var(--hl-c)] underline">
              Change
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-[#344054]">
                First name<span className="text-[#D92D20]"> *</span>
              </span>
              <input className={input} value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} autoComplete="given-name" aria-invalid={error?.field === 'firstName'} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-[#344054]">Last name</span>
              <input className={input} value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} autoComplete="family-name" />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-[#344054]">
              Mobile phone<span className="text-[#D92D20]"> *</span>
            </span>
            <input className={input} type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" aria-invalid={error?.field === 'phone'} />
          </label>
          {calendar.askEmail && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-[#344054]">
                Email{calendar.requireEmail && <span className="text-[#D92D20]"> *</span>}
              </span>
              <input className={input} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" aria-invalid={error?.field === 'email'} />
            </label>
          )}
          {calendar.askNotes && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-[#344054]">Anything we should know?</span>
              <textarea className={input} rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </label>
          )}
          <input id="hl-hp" name="_hp" tabIndex={-1} autoComplete="off" className="absolute -left-[9999px] h-0 w-0 opacity-0" aria-hidden />
          {calendar.consents.map((c) => (
            <label key={c.kind} className="flex items-start gap-2.5 text-[12px] leading-snug text-[#475467]">
              <input type="checkbox" checked={!!ticked[key(c.kind)]} onChange={(e) => setTicked((t) => ({ ...t, [key(c.kind)]: e.target.checked }))} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--hl-c)]" aria-invalid={error?.field === key(c.kind)} />
              <span>
                <Linked text={c.text} legal={calendar.legal} />
                {c.required && <span className="text-[#D92D20]"> *</span>}
              </span>
            </label>
          ))}
          {error && <p className="rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error.text}</p>}
          <button type="submit" disabled={busy} className="mt-1 rounded-lg bg-[var(--hl-c)] px-4 py-3 text-[15px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60">
            {busy ? 'Booking…' : 'Book it'}
          </button>
        </form>
      )}
    </div>
  )
}
