'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { Ban, CalendarPlus, ChevronLeft, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { asCalendarSettings, durationsOf } from '@/lib/hl/calendar-shared'
import type { StaffRow } from '@/lib/hl/staff'
import { contactLabel, useAccount } from './bits'
import { confirmAction } from './confirm'
import { Badge, Button, ErrorNote, Field, Input, Modal, Select, Spinner, Tabs, Textarea, copyText, hlFetch } from './ui'

/**
 * GHL's Calendar View: day, week and month, filtered by calendar and team
 * member, in the user's timezone (My preference) or the business's. Click a
 * time to book it, or block it off; click an appointment to change it.
 */

export type Appt = {
  id: string
  title: string
  startTime: string
  endTime: string
  status: string
  assignedTo: string | null
  assignedUserId: string | null
  address: string | null
  notes: string | null
  source: string | null
  token: string | null
  calendarId: string | null
  meta: unknown
  contact: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null } | null
  calendar: { id: string; name: string } | null
}
export type Cal = { id: string; name: string; kind: string | null; isActive: boolean; settings: unknown }
export type RangeData = { calendars: Cal[]; appointments: Appt[]; staff: StaffRow[]; timezone: string }

export const STATUS_COLOR: Record<string, 'green' | 'blue' | 'red' | 'gray' | 'amber'> = { confirmed: 'blue', showed: 'green', noshow: 'red', cancelled: 'gray', new: 'amber', invalid: 'gray' }
const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmed', showed: 'Showed', noshow: 'No-show', cancelled: 'Cancelled', new: 'Unconfirmed', invalid: 'Invalid' }
const HOUR_PX = 48
const DAY_MS = 86_400_000

/** "2026-10-26" + n days. */
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10)
}
const weekdayOf = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
const dateLabel = (date: string, o: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })
const startOfDay = (date: string, tz: string) => fromZonedTime(`${date}T00:00:00`, tz)
const timeIn = (iso: string | Date, tz: string) => formatInTimeZone(new Date(iso), tz, 'h:mm a')
const lengthLabel = (m: number) => (m % 60 === 0 ? `${m / 60} hr` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`)
const membersOf = (a: Appt): string[] => {
  const m = (a.meta as { members?: unknown } | null)?.members
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : a.assignedUserId ? [a.assignedUserId] : []
}
const colorOf = (a: Appt, cals: Cal[]) => {
  const c = cals.find((x) => x.id === a.calendarId)
  const color = asCalendarSettings(c?.settings).eventColor
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#155EEF'
}

export function useRange(accountId: string, from: Date, to: Date, enabled = true) {
  return useQuery<RangeData>({
    queryKey: ['hl', 'appointments', accountId, from.toISOString(), to.toISOString()],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/appointments?from=${from.toISOString()}&to=${to.toISOString()}`),
    enabled,
  })
}

type Prefs = { prefs: { weekStartsOn: number }; me: { timezone?: string } }

export function CalendarView({ accountId }: { accountId: string }) {
  const prefs = useQuery<Prefs>({ queryKey: ['hl', 'calendar-prefs', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-preferences`) })
  const [view, setView] = useState<'day' | 'week' | 'month'>('week')
  const [anchor, setAnchor] = useState<string | null>(null)
  const [calFilter, setCalFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [creating, setCreating] = useState<{ kind: 'appointment' | 'block'; date?: string; time?: string } | null>(null)
  const [open, setOpen] = useState<Appt | null>(null)
  const account = useAccount(accountId)
  const weekStart = prefs.data?.prefs.weekStartsOn ?? 0
  // The user's own timezone (My preference), else the business's.
  const tz = prefs.data?.me.timezone || account.data?.account.timezone || 'America/New_York'
  const today = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd')
  const at = anchor ?? today
  const dates = useMemo(() => {
    if (view === 'day') return [at]
    if (view === 'week') {
      const first = addDays(at, -((weekdayOf(at) - weekStart + 7) % 7))
      return Array.from({ length: 7 }, (_, i) => addDays(first, i))
    }
    const monthStart = `${at.slice(0, 7)}-01`
    const first = addDays(monthStart, -((weekdayOf(monthStart) - weekStart + 7) % 7))
    return Array.from({ length: 42 }, (_, i) => addDays(first, i))
  }, [view, at, weekStart])
  const from = startOfDay(dates[0], tz)
  const to = startOfDay(addDays(dates[dates.length - 1], 1), tz)
  const q = useRange(accountId, from, to, !!prefs.data && !!account.data)
  const cals = q.data?.calendars ?? []
  const staff = q.data?.staff ?? []
  const shown = (q.data?.appointments ?? []).filter((a) => (!calFilter || a.calendarId === calFilter) && (!userFilter || membersOf(a).includes(userFilter)))
  const step = (dir: number) => setAnchor(view === 'day' ? addDays(at, dir) : view === 'week' ? addDays(at, 7 * dir) : (() => {
    const [y, m] = at.split('-').map(Number)
    const d = new Date(Date.UTC(y, m - 1 + dir, 1))
    return d.toISOString().slice(0, 10)
  })())
  const title =
    view === 'day'
      ? dateLabel(at, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : view === 'week'
        ? `${dateLabel(dates[0], { month: 'short', day: 'numeric' })} – ${dateLabel(dates[6], { month: 'short', day: 'numeric', year: 'numeric' })}`
        : dateLabel(`${at.slice(0, 7)}-15`, { month: 'long', year: 'numeric' })

  return (
    <div className="flex flex-col gap-4 px-6 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setAnchor(null)}>
          Today
        </Button>
        <Button size="sm" aria-label="Previous" onClick={() => step(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button size="sm" aria-label="Next" onClick={() => step(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <h1 className="ml-1 text-[18px] font-semibold text-foreground">{title}</h1>
        <span className="font-mono text-[11px] text-muted-foreground">{tz.replace(/_/g, ' ')}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select className="h-8 w-auto text-[12.5px]" value={calFilter} onChange={(e) => setCalFilter(e.target.value)}>
            <option value="">All calendars</option>
            {cals.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name.trim()}
              </option>
            ))}
          </Select>
          <Select className="h-8 w-auto text-[12.5px]" value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
            <option value="">All users</option>
            {staff.map((s) => (
              <option key={s.id} value={s.ghlId ?? s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <div className="flex rounded-md border border-border p-0.5">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button key={v} type="button" onClick={() => setView(v)} className={cn('rounded px-3 py-1 font-mono text-[12px] capitalize', view === v ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
                {v}
              </button>
            ))}
          </div>
          <Button size="sm" icon={<Ban className="h-3.5 w-3.5" />} onClick={() => setCreating({ kind: 'block', date: view === 'month' ? today : at })}>
            Block time
          </Button>
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating({ kind: 'appointment', date: view === 'month' ? today : at })}>
            New appointment
          </Button>
        </div>
      </div>
      {q.isLoading || !prefs.data || !account.data ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : view === 'month' ? (
        <MonthGrid
          dates={dates}
          month={at.slice(0, 7)}
          today={today}
          tz={tz}
          appts={shown}
          cals={cals}
          onOpen={setOpen}
          onDay={(d) => {
            setAnchor(d)
            setView('day')
          }}
        />
      ) : (
        <TimeGrid dates={dates} today={today} tz={tz} appts={shown} cals={cals} onOpen={setOpen} onPick={(date, time) => setCreating({ kind: 'appointment', date, time })} />
      )}
      <ErrorNote error={q.error || prefs.error} />
      {creating && q.data && (
        <NewAppointment
          accountId={accountId}
          data={q.data}
          tz={tz}
          initial={creating}
          calendarId={calFilter}
          userId={userFilter}
          onClose={() => setCreating(null)}
        />
      )}
      {open && q.data && <AppointmentDrawer accountId={accountId} a={open} data={q.data} tz={tz} onClose={() => setOpen(null)} />}
    </div>
  )
}

function MonthGrid({ dates, month, today, tz, appts, cals, onOpen, onDay }: { dates: string[]; month: string; today: string; tz: string; appts: Appt[]; cals: Cal[]; onOpen: (a: Appt) => void; onDay: (d: string) => void }) {
  const byDay = new Map<string, Appt[]>()
  for (const a of appts) {
    const k = formatInTimeZone(new Date(a.startTime), tz, 'yyyy-MM-dd')
    byDay.set(k, [...(byDay.get(k) ?? []), a])
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid grid-cols-7 border-b border-border">
        {dates.slice(0, 7).map((d) => (
          <p key={d} className="eyebrow px-2 py-2 text-muted-foreground">
            {dateLabel(d, { weekday: 'short' })}
          </p>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {dates.map((d) => {
          const list = byDay.get(d) ?? []
          return (
            <div key={d} className={cn('min-h-[110px] border-b border-r border-border-soft p-1.5 [&:nth-child(7n)]:border-r-0', !d.startsWith(month) && 'bg-surface-muted/40')}>
              <button type="button" onClick={() => onDay(d)} className={cn('mb-1 w-fit rounded px-1.5 font-mono text-[11px] hover:bg-muted', d === today ? 'bg-primary text-primary-foreground hover:bg-primary' : d.startsWith(month) ? 'text-foreground/80' : 'text-muted-foreground/50')}>
                {Number(d.slice(8))}
              </button>
              <div className="flex flex-col gap-0.5">
                {list.slice(0, 3).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onOpen(a)}
                    className={cn('flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] transition hover:bg-muted', a.status === 'cancelled' && 'text-muted-foreground line-through')}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: a.source === 'block' ? '#98A2B3' : colorOf(a, cals) }} />
                    <span className="truncate">
                      {timeIn(a.startTime, tz)} {a.source === 'block' ? a.title : a.contact ? contactLabel(a.contact) : a.title}
                    </span>
                  </button>
                ))}
                {list.length > 3 && (
                  <button type="button" onClick={() => onDay(d)} className="px-1.5 text-left font-mono text-[10.5px] text-muted-foreground hover:text-foreground">
                    +{list.length - 3} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Overlapping appointments side by side: a column each, as wide as their overlap allows. */
function layout(items: { a: Appt; start: number; end: number }[]) {
  const sorted = [...items].sort((x, y) => x.start - y.start || y.end - x.end)
  const placed: { a: Appt; start: number; end: number; col: number; cols: number }[] = []
  let cluster: typeof placed = []
  let clusterEnd = -Infinity
  const close = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1))
    for (const c of cluster) c.cols = cols
    cluster = []
  }
  for (const it of sorted) {
    if (it.start >= clusterEnd) {
      close()
      clusterEnd = -Infinity
    }
    const used = cluster.filter((c) => c.end > it.start).map((c) => c.col)
    let col = 0
    while (used.includes(col)) col++
    const p = { ...it, col, cols: 1 }
    cluster.push(p)
    placed.push(p)
    clusterEnd = Math.max(clusterEnd, it.end)
  }
  close()
  return placed
}

function TimeGrid({ dates, today, tz, appts, cals, onOpen, onPick }: { dates: string[]; today: string; tz: string; appts: Appt[]; cals: Cal[]; onOpen: (a: Appt) => void; onPick: (date: string, time: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // Start the day at 7 AM, like GHL.
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const columns = dates.map((d) => {
    const start = startOfDay(d, tz).getTime()
    const end = startOfDay(addDays(d, 1), tz).getTime()
    const items = appts
      .map((a) => ({ a, start: Math.max(new Date(a.startTime).getTime(), start), end: Math.min(new Date(a.endTime).getTime(), end) }))
      .filter((x) => x.end > x.start)
    return { date: d, start, end, placed: layout(items) }
  })
  const pxPerMs = HOUR_PX / 3_600_000
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid border-b border-border" style={{ gridTemplateColumns: `56px repeat(${dates.length}, minmax(0, 1fr))` }}>
        <span />
        {dates.map((d) => (
          <p key={d} className={cn('px-2 py-2 text-center text-[12px]', d === today ? 'font-semibold text-primary' : 'text-muted-foreground')}>
            {dateLabel(d, { weekday: 'short' })} <span className="font-mono">{Number(d.slice(8))}</span>
          </p>
        ))}
      </div>
      <div ref={scroller} className="relative max-h-[640px] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(${dates.length}, minmax(0, 1fr))`, height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <p key={h} className="absolute right-2 -translate-y-1/2 font-mono text-[10.5px] text-muted-foreground" style={{ top: h * HOUR_PX }}>
                {h === 0 ? '' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`}
              </p>
            ))}
          </div>
          {columns.map((col) => (
            <div
              key={col.date}
              className="relative cursor-pointer border-l border-border-soft"
              onClick={(e) => {
                if (e.target !== e.currentTarget) return
                const y = e.nativeEvent.offsetY
                const minutes = Math.max(0, Math.min(24 * 60 - 15, Math.floor((y / HOUR_PX) * 4) * 15))
                onPick(col.date, `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`)
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className="pointer-events-none absolute inset-x-0 border-t border-border-soft" style={{ top: h * HOUR_PX }} />
              ))}
              {col.date === today && now >= col.start && now < col.end && <span className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-destructive" style={{ top: (now - col.start) * pxPerMs }} />}
              {col.placed.map(({ a, start, end, col: c, cols }) => {
                const block = a.source === 'block'
                const color = block ? '#98A2B3' : colorOf(a, cals)
                const height = Math.max(20, (end - start) * pxPerMs - 2)
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onOpen(a)}
                    title={`${a.title} · ${timeIn(a.startTime, tz)}–${timeIn(a.endTime, tz)}`}
                    className={cn('absolute overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm transition hover:brightness-110', a.status === 'cancelled' && 'opacity-50 line-through')}
                    style={{
                      top: (start - col.start) * pxPerMs + 1,
                      height,
                      left: `calc(${(c / cols) * 100}% + 2px)`,
                      width: `calc(${100 / cols}% - 4px)`,
                      background: block ? 'repeating-linear-gradient(45deg, rgba(152,162,179,.18), rgba(152,162,179,.18) 6px, rgba(152,162,179,.08) 6px, rgba(152,162,179,.08) 12px)' : `color-mix(in srgb, ${color} 22%, transparent)`,
                      borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
                    }}
                  >
                    <span className="block truncate font-semibold text-foreground">{block ? a.title : a.contact ? contactLabel(a.contact) : a.title}</span>
                    {height > 32 && (
                      <span className="block truncate text-muted-foreground">
                        {timeIn(a.startTime, tz)} · {block ? (a.assignedTo ?? a.calendar?.name ?? 'Blocked') : (a.calendar?.name ?? a.title)}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// New appointment / blocked-off time
// ---------------------------------------------------------------------------

type ContactHit = { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null }

function teamFor(cal: Cal | undefined, staff: StaffRow[]) {
  const members = asCalendarSettings(cal?.settings).teamMembers ?? []
  return members
    .filter((m) => m.selected !== false)
    .map((m) => ({ key: m.userId, name: staff.find((s) => s.id === m.userId || s.ghlId === m.userId)?.name ?? 'Team member' }))
}

function NewAppointment({
  accountId,
  data,
  tz,
  initial,
  calendarId,
  userId,
  onClose,
}: {
  accountId: string
  data: RangeData
  tz: string
  initial: { kind: 'appointment' | 'block'; date?: string; time?: string }
  calendarId: string
  userId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const usable = data.calendars.filter((c) => c.isActive).concat(data.calendars.filter((c) => !c.isActive))
  const [kind, setKind] = useState(initial.kind)
  const [calId, setCalId] = useState(calendarId || usable[0]?.id || '')
  const cal = data.calendars.find((c) => c.id === calId)
  const lengths = durationsOf(asCalendarSettings(cal?.settings))
  const [member, setMember] = useState(userId)
  const [date, setDate] = useState(initial.date ?? formatInTimeZone(new Date(), tz, 'yyyy-MM-dd'))
  const [time, setTime] = useState(initial.time ?? '09:00')
  const [endTime, setEndTime] = useState(() => {
    const [h, m] = (initial.time ?? '09:00').split(':').map(Number)
    const end = Math.min(24 * 60 - 1, h * 60 + m + 60)
    return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
  })
  const [length, setLength] = useState<number>(lengths[0] ?? 30)
  const [search, setSearch] = useState('')
  const [contact, setContact] = useState<ContactHit | null>(null)
  const [fresh, setFresh] = useState<{ firstName: string; lastName: string; phone: string; email: string } | null>(null)
  const [title, setTitle] = useState('')
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState<'confirmed' | 'new'>('confirmed')
  const [anyway, setAnyway] = useState(false)
  const team = teamFor(cal, data.staff)
  const hits = useQuery<{ contacts: ContactHit[] }>({
    queryKey: ['hl', 'contact-search', accountId, search],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/contacts?q=${encodeURIComponent(search)}`),
    enabled: kind === 'appointment' && !contact && !fresh && search.trim().length >= 2,
    staleTime: 30_000,
  })
  const iso = (d: string, t: string) => fromZonedTime(`${d}T${t}:00`, tz).toISOString()
  const save = useMutation({
    mutationFn: () =>
      hlFetch(`/api/hl/accounts/${accountId}/appointments`, {
        method: 'POST',
        json:
          kind === 'block'
            ? { kind, calendarId: calId || null, assignedUserId: member || null, start: iso(date, time), end: iso(date, endTime), title: title || 'Blocked off', notes }
            : {
                kind,
                calendarId: calId,
                contactId: contact?.id,
                contact: contact ? undefined : fresh,
                start: iso(date, time),
                duration: length,
                assignedUserId: member || null,
                title: title || undefined,
                address: address || undefined,
                notes,
                status,
                ignoreAvailability: anyway,
              },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'appointments', accountId] })
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'block' ? 'Block off time' : 'New appointment'}
      description={`Times are in ${tz.replace(/_/g, ' ')}.`}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={kind === 'appointment' ? !calId || (!contact && !fresh?.firstName) : !calId && !member} onClick={() => save.mutate()}>
            {kind === 'block' ? 'Block it off' : 'Book appointment'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Tabs
          value={kind}
          onChange={setKind}
          tabs={[
            { key: 'appointment', label: 'Appointment' },
            { key: 'block', label: 'Blocked off time' },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Calendar">
            <Select
              value={calId}
              onChange={(e) => {
                setCalId(e.target.value)
                setMember('')
                setLength(durationsOf(asCalendarSettings(data.calendars.find((c) => c.id === e.target.value)?.settings))[0] ?? 30)
              }}
            >
              {kind === 'block' && <option value="">No calendar (just the team member)</option>}
              {usable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name.trim()}
                  {c.isActive ? '' : ' (off)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team member">
            <Select value={member} onChange={(e) => setMember(e.target.value)}>
              <option value="">{kind === 'block' ? (calId ? 'The whole calendar' : 'Pick someone') : team.length ? 'Whoever is free (round robin)' : 'No one in particular'}</option>
              {(kind === 'block' ? data.staff.map((s) => ({ key: s.ghlId ?? s.id, name: s.name })) : team).map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {kind === 'appointment' && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <p className="text-[12.5px] font-medium text-muted-foreground">Contact</p>
            {contact ? (
              <div className="flex items-center justify-between gap-2 text-[13.5px]">
                <span className="text-foreground">
                  {contactLabel(contact)}
                  <span className="ml-2 font-mono text-[11.5px] text-muted-foreground">{contact.phone ?? contact.email ?? ''}</span>
                </span>
                <button type="button" className="text-[12.5px] text-primary hover:underline" onClick={() => setContact(null)}>
                  Change
                </button>
              </div>
            ) : fresh ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input placeholder="First name" value={fresh.firstName} onChange={(e) => setFresh({ ...fresh, firstName: e.target.value })} />
                <Input placeholder="Last name" value={fresh.lastName} onChange={(e) => setFresh({ ...fresh, lastName: e.target.value })} />
                <Input placeholder="Mobile phone" value={fresh.phone} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} />
                <Input placeholder="Email" value={fresh.email} onChange={(e) => setFresh({ ...fresh, email: e.target.value })} />
                <button type="button" className="w-fit text-[12.5px] text-primary hover:underline" onClick={() => setFresh(null)}>
                  Search contacts instead
                </button>
              </div>
            ) : (
              <>
                <Input placeholder="Search by name, phone or email" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
                {hits.isFetching && <Spinner />}
                {(hits.data?.contacts ?? []).slice(0, 6).map((c) => (
                  <button key={c.id} type="button" onClick={() => setContact(c)} className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted">
                    <span className="text-foreground">{contactLabel(c)}</span>
                    <span className="font-mono text-[11.5px] text-muted-foreground">{c.phone ?? c.email ?? ''}</span>
                  </button>
                ))}
                <button type="button" className="w-fit text-[12.5px] text-primary hover:underline" onClick={() => setFresh({ firstName: search.trim().split(' ')[0] ?? '', lastName: search.trim().split(' ').slice(1).join(' '), phone: '', email: '' })}>
                  + New contact
                </button>
              </>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={kind === 'block' ? 'From' : 'Starts'}>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          {kind === 'block' ? (
            <Field label="Until">
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          ) : (
            <Field label="Length">
              <Select value={length} onChange={(e) => setLength(Number(e.target.value))}>
                {[...new Set([...lengths, 15, 30, 45, 60, 90, 120])].sort((a, b) => a - b).map((m) => (
                  <option key={m} value={m}>
                    {lengthLabel(m)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Title" hint={kind === 'block' ? undefined : 'Blank: the calendar’s appointment title'}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'block' ? 'Blocked off' : ''} />
        </Field>
        {kind === 'appointment' && (
          <Field label="Location" hint="Blank: the calendar’s meeting location">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
        )}
        <Field label="Notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {kind === 'appointment' && (
          <div className="flex flex-wrap items-center gap-4 text-[13px] text-foreground/90">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={status === 'new'} onChange={(e) => setStatus(e.target.checked ? 'new' : 'confirmed')} /> Unconfirmed
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} /> Book anyway (outside its hours or over other bookings)
            </label>
          </div>
        )}
        {kind === 'appointment' && <p className="text-[12px] text-muted-foreground">Booking fires the calendar’s “Appointment booked” automations, like a booking from the page.</p>}
        <ErrorNote error={save.error || hits.error} />
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// The appointment drawer
// ---------------------------------------------------------------------------

const ACTIONS: { status: string; label: string }[] = [
  { status: 'confirmed', label: 'Confirmed' },
  { status: 'showed', label: 'Showed' },
  { status: 'noshow', label: 'No-show' },
  { status: 'cancelled', label: 'Cancel' },
]

export function AppointmentDrawer({ accountId, a, data, tz, onClose }: { accountId: string; a: Appt; data: RangeData; tz: string; onClose: () => void }) {
  const qc = useQueryClient()
  const block = a.source === 'block'
  const cal = data.calendars.find((c) => c.id === a.calendarId)
  const team = teamFor(cal, data.staff)
  const length0 = Math.round((new Date(a.endTime).getTime() - new Date(a.startTime).getTime()) / 60_000)
  const [date, setDate] = useState(formatInTimeZone(new Date(a.startTime), tz, 'yyyy-MM-dd'))
  const [time, setTime] = useState(formatInTimeZone(new Date(a.startTime), tz, 'HH:mm'))
  const [length, setLength] = useState(length0)
  const [member, setMember] = useState(a.assignedUserId ?? '')
  const [title, setTitle] = useState(a.title)
  const [address, setAddress] = useState(a.address ?? '')
  const [notes, setNotes] = useState(a.notes ?? '')
  const [anyway, setAnyway] = useState(false)
  const [status, setStatus] = useState(a.status)
  const refresh = () => qc.invalidateQueries({ queryKey: ['hl', 'appointments', accountId] })
  const start = fromZonedTime(`${date}T${time}:00`, tz).toISOString()
  const moved = new Date(start).getTime() !== new Date(a.startTime).getTime() || length !== length0
  const save = useMutation({
    mutationFn: (extra: Record<string, unknown> = {}) =>
      hlFetch(`/api/hl/accounts/${accountId}/appointments/${a.id}`, {
        method: 'PATCH',
        json: {
          title,
          notes,
          ...(block ? {} : { address }),
          ...(member !== (a.assignedUserId ?? '') ? { assignedUserId: member || null } : {}),
          ...(moved ? { start, duration: length, ignoreAvailability: anyway } : {}),
          ...extra,
        },
      }),
    onSuccess: (_d, extra) => {
      if (extra && typeof extra.status === 'string') setStatus(extra.status)
      refresh()
      if (!extra || !extra.status) onClose()
    },
  })
  const remove = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/appointments/${a.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh()
      onClose()
    },
  })
  const manage = a.token ? `${typeof window === 'undefined' ? '' : window.location.origin}/hl/a/${a.token}` : null
  return (
    <Modal
      open
      onClose={onClose}
      title={block ? 'Blocked off time' : a.contact ? contactLabel(a.contact) : a.title}
      description={`${formatInTimeZone(new Date(a.startTime), tz, 'EEE, MMM d · h:mm a')} – ${timeIn(a.endTime, tz)}${a.calendar ? ` · ${a.calendar.name.trim()}` : ''}`}
      width="max-w-xl"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {block ? (
            <Button variant="ghost" className="text-destructive" icon={<Trash2 className="h-3.5 w-3.5" />} loading={remove.isPending} onClick={() => void confirmAction('Delete this blocked-off time?', 'Delete', { danger: true }).then((ok) => ok && remove.mutate())}>
              Delete
            </Button>
          ) : (
            ACTIONS.map((x) => (
              <Button
                key={x.status}
                size="sm"
                variant={status === x.status ? 'primary' : 'ghost'}
                className={x.status === 'cancelled' && status !== 'cancelled' ? 'text-destructive' : undefined}
                disabled={status === x.status || save.isPending}
                onClick={() => void (x.status !== 'cancelled' ? Promise.resolve(true) : confirmAction('Cancel this appointment? Its “Appointment status: cancelled” automations run, and its reminders stop.', 'Cancel appointment')).then((ok) => ok && save.mutate({ status: x.status }))}
              >
                {x.label}
              </Button>
            ))
          )}
          <span className="ml-auto" />
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({})}>
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {!block && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge color={STATUS_COLOR[status] ?? 'gray'}>{STATUS_LABEL[status] ?? status}</Badge>
            {a.source === 'booking' && <span className="text-muted-foreground">Booked online</span>}
            {a.source === 'manual' && <span className="text-muted-foreground">Booked by staff</span>}
            {a.contact && (
              <Link href={`/hell-level/${accountId}/conversations?contact=${a.contact.id}`} className="ml-auto text-primary hover:underline">
                Open conversation
              </Link>
            )}
          </div>
        )}
        {a.contact && (
          <p className="font-mono text-[12px] text-muted-foreground">
            {[a.contact.phone, a.contact.email].filter(Boolean).join(' · ')}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Starts">
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Length">
            <Select value={length} onChange={(e) => setLength(Number(e.target.value))}>
              {[...new Set([length0, ...durationsOf(asCalendarSettings(cal?.settings)), 15, 30, 45, 60, 90, 120, 240])].sort((x, y) => x - y).map((m) => (
                <option key={m} value={m}>
                  {lengthLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Team member">
            <Select value={member} onChange={(e) => setMember(e.target.value)}>
              <option value="">{block ? (a.calendarId ? 'The whole calendar' : '—') : 'No one in particular'}</option>
              {(block || !team.length ? data.staff.map((s) => ({ key: s.ghlId ?? s.id, name: s.name })) : team).map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </div>
        {!block && (
          <Field label="Location">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
        )}
        <Field label="Notes">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {moved && !block && (
          <label className="flex items-center gap-2 text-[13px] text-foreground/90">
            <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} /> Move it anyway (outside the calendar’s hours or over other bookings)
          </label>
        )}
        {manage && (
          <button type="button" className="flex w-fit items-center gap-1.5 text-[12.5px] text-primary hover:underline" onClick={() => copyText(manage)}>
            <Copy className="h-3.5 w-3.5" /> Copy their reschedule / cancel link
          </button>
        )}
        {!a.calendarId && !block && (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <CalendarPlus className="h-3.5 w-3.5" /> Not on a calendar (its calendar was deleted, or it came from GoHighLevel without one).
          </p>
        )}
        <ErrorNote error={save.error || remove.error} />
      </div>
    </Modal>
  )
}

