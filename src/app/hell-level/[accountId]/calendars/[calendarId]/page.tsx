'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Copy, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CALENDAR_TYPES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_PRESETS,
  WEEKDAYS,
  asCalendarSettings,
  defaultCalendarSettings,
  durationsOf,
  minutesOf,
  RRULE_DAYS,
  MAX_SERIES,
  recurringLabel,
  recurringOf,
  wantsMeet,
  type HlCalendarGroup,
  type HlCalendarSettings,
  type HlHours,
  type HlNotification,
  type HlSchedule,
  type TimeUnit,
} from '@/lib/hl/calendar-shared'
import type { StaffRow } from '@/lib/hl/staff'
import { useAccount } from '@/components/hell-level/bits'
import { ConsentBoxesEditor } from '@/components/hell-level/consent-editor'
import { bookingEmbedCode, bookingLovablePrompt } from '@/components/hell-level/embed'
import { Badge, Button, Card, ErrorNote, Field, Input, Select, Spinner, Tabs, Textarea, Toggle, copyText, hlFetch } from '@/components/hell-level/ui'

type Detail = {
  calendar: { id: string; name: string; description: string | null; isActive: boolean; kind: string | null; ghlId: string | null; settings: unknown; updatedAt: string }
  staff: StaffRow[]
  upcoming: number
  groups: HlCalendarGroup[]
  /** Team members' schedules that set their hours on this calendar. */
  schedules: HlSchedule[]
}

const lengthLabel = (m: number) => (m % 60 === 0 ? `${m / 60} hr` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`)

export default function CalendarEditorPage() {
  const { accountId, calendarId } = useParams<{ accountId: string; calendarId: string }>()
  const q = useQuery<Detail>({ queryKey: ['hl', 'calendar', calendarId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendars/${calendarId}`) })
  if (!q.data) return <div className="flex justify-center py-24">{q.error ? <ErrorNote error={q.error} /> : <Spinner />}</div>
  return <CalendarEditor key={q.data.calendar.updatedAt} accountId={accountId} data={q.data} />
}

const pad = (n: number) => String(n).padStart(2, '0')
const toTime = (h: number, m: number) => `${pad(h % 24)}:${pad(m)}`
const fromTime = (v: string): [number, number] => {
  const [h, m] = v.split(':').map(Number)
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0]
}
const NINE_TO_FIVE: HlHours = { openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }

/** Weekly hours as one list of ranges per weekday (GHL keeps them as day groups). */
function weekOf(s: HlCalendarSettings): HlHours[][] {
  return WEEKDAYS.map((_, d) => (s.openHours ?? []).filter((o) => (o.daysOfTheWeek ?? []).includes(d)).flatMap((o) => o.hours ?? []))
}

function Ranges({ value, onChange }: { value: HlHours[]; onChange: (v: HlHours[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((h, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input type="time" className="w-32" value={toTime(h.openHour, h.openMinute)} onChange={(e) => {
            const [openHour, openMinute] = fromTime(e.target.value)
            onChange(value.map((x, j) => (j === i ? { ...x, openHour, openMinute } : x)))
          }} />
          <span className="text-muted-foreground">–</span>
          <Input type="time" className="w-32" value={toTime(h.closeHour, h.closeMinute)} onChange={(e) => {
            const [closeHour, closeMinute] = fromTime(e.target.value)
            onChange(value.map((x, j) => (j === i ? { ...x, closeHour, closeMinute } : x)))
          }} />
          <button type="button" className="text-muted-foreground hover:text-destructive" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" className="flex w-fit items-center gap-1 text-[12.5px] text-primary hover:underline" onClick={() => onChange([...value, value.length ? { ...NINE_TO_FIVE, openHour: 13, closeHour: 17 } : NINE_TO_FIVE])}>
        <Plus className="h-3 w-3" /> Add hours
      </button>
    </div>
  )
}

function Amount({ label, hint, value, unit, units, onChange }: { label: string; hint?: string; value: number | string | undefined; unit: TimeUnit | undefined; units: TimeUnit[]; onChange: (v: number | string, u: TimeUnit) => void }) {
  const names: Record<TimeUnit, string> = { mins: 'minutes', hours: 'hours', days: 'days', weeks: 'weeks', months: 'months' }
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input type="number" min={0} className="w-24" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value), unit ?? units[0])} />
        <Select className="w-32" value={unit ?? units[0]} onChange={(e) => onChange(value ?? 0, e.target.value as TimeUnit)}>
          {units.map((u) => (
            <option key={u} value={u}>
              {names[u]}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  )
}

function CalendarEditor({ accountId, data }: { accountId: string; data: Detail }) {
  const qc = useQueryClient()
  const account = useAccount(accountId)
  const business = account.data?.account.profile.businessName || account.data?.account.name || 'the business'
  const [name, setName] = useState(data.calendar.name)
  const [description, setDescription] = useState(data.calendar.description ?? '')
  const [isActive, setActive] = useState(data.calendar.isActive)
  const [s, setS] = useState<HlCalendarSettings>(() => ({ ...defaultCalendarSettings(), ...asCalendarSettings(data.calendar.settings) }))
  const [kind, setKind] = useState(data.calendar.kind ?? 'round_robin')
  // Other lengths the booker can pick, besides the meeting length.
  const [extra, setExtra] = useState<number[]>(() => {
    const own = asCalendarSettings(data.calendar.settings)
    const main = minutesOf(own.slotDuration, own.slotDurationUnit, 30)
    return durationsOf(own).filter((m) => m !== main)
  })
  const [newLength, setNewLength] = useState('')
  const mainLength = minutesOf(s.slotDuration, s.slotDurationUnit, 30)
  const lengths = [...new Set([mainLength, ...extra])]
  const [tab, setTab] = useState<'details' | 'availability' | 'form' | 'confirm' | 'notify' | 'share'>('details')
  const [newDate, setNewDate] = useState('')
  const save = useMutation({
    mutationFn: () =>
      hlFetch(`/api/hl/accounts/${accountId}/calendars/${data.calendar.id}`, {
        method: 'PATCH',
        json: {
          name,
          description,
          isActive,
          kind,
          settings: { ...s, durationOptions: lengths.length > 1 ? lengths.map((m, i) => ({ duration: m, durationUnit: 'mins', isDefault: i === 0 })) : [] },
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'calendar', data.calendar.id] })
      qc.invalidateQueries({ queryKey: ['hl', 'calendars', accountId] })
    },
  })
  const set = (patch: Partial<HlCalendarSettings>) => setS((x) => ({ ...x, ...patch }))
  const week = weekOf(s)
  const setDay = (d: number, hours: HlHours[]) => {
    const next = week.map((h, i) => (i === d ? hours : h))
    set({ openHours: next.flatMap((h, i) => (h.length ? [{ daysOfTheWeek: [i], hours: h }] : [])) })
  }
  const overrides = (s.availabilities ?? []).filter((a) => !a.deleted).map((a) => ({ ...a, date: String(a.date).slice(0, 10) }))
  const team = s.teamMembers ?? []
  const staffKey = (st: StaffRow) => st.ghlId ?? st.id
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const link = `${origin}/hl/b/${data.calendar.id}`

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-7">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/hell-level/${accountId}/calendars?tab=settings`} className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm text-[16px] font-semibold" />
        {data.calendar.ghlId && <Badge color="gray">From GoHighLevel</Badge>}
        <label className="ml-auto flex items-center gap-2 text-[13px] text-foreground/85">
          <Toggle checked={isActive} onChange={setActive} label="Taking bookings" /> {isActive ? 'Taking bookings' : 'Off'}
        </label>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
      <ErrorNote error={save.error} />
      {save.isSuccess && !save.isPending && <p className="text-[12.5px] text-success">Saved.</p>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'details', label: 'Calendar Details' },
          { key: 'availability', label: 'Availability' },
          { key: 'form', label: 'Booking Form' },
          { key: 'confirm', label: 'Confirmations' },
          { key: 'notify', label: 'Notifications' },
          { key: 'share', label: 'Share & Embed' },
        ]}
      />

      {tab === 'details' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="flex flex-col gap-4 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Calendar type">
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {CALENDAR_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Group">
                <Select value={s.groupId && data.groups.some((g) => g.key === s.groupId) ? s.groupId : ''} onChange={(e) => set({ groupId: e.target.value })}>
                  <option value="">Not grouped</option>
                  {data.groups.map((g) => (
                    <option key={g.id} value={g.key}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="-mt-2 text-[12.5px] text-muted-foreground">{CALENDAR_TYPES.find((t) => t.key === kind)?.what}</p>
            {(kind === 'class_booking' || kind === 'event') && (
              <Field label="Seats per slot" hint={kind === 'event' ? 'How many people can book the same time' : 'How many people can join the same session'}>
                <Input type="number" min={1} className="w-32" value={s.appointmentPerSlot ?? 1} onChange={(e) => set({ appointmentPerSlot: e.target.value === '' ? 1 : Number(e.target.value) })} />
              </Field>
            )}
            <Field label="Description" hint="Shown on the booking page">
              <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A free 30-minute call to talk through your project." />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
              <Field label="Meeting type">
                <Select value={s.meetingType ?? ((s.teamMembers ?? []).some((m) => wantsMeet(s, m.userId)) ? 'google_meet' : 'location')} onChange={(e) => set({ meetingType: e.target.value === 'google_meet' ? 'google_meet' : 'location' })}>
                  <option value="location">At the meeting location</option>
                  <option value="google_meet">Google Meet</option>
                </Select>
              </Field>
              <Field label="Meeting location" hint={s.meetingType === 'google_meet' ? 'Leave empty: each booking’s Meet link becomes its location' : 'An address, a phone number or a meeting link. A team member’s own location wins.'}>
                <Input value={s.meetingLocation ?? ''} onChange={(e) => set({ meetingLocation: e.target.value })} placeholder={s.meetingType === 'google_meet' ? 'Google Meet' : 'We’ll call you at the number you give'} />
              </Field>
            </div>
            {(s.meetingType === 'google_meet' || (!s.meetingType && (s.teamMembers ?? []).some((m) => wantsMeet(s, m.userId)))) && (
              <p className="-mt-2 text-[12.5px] text-muted-foreground">
                A Google Meet link is made for each booking on the team member’s Google Calendar, so they need it connected under{' '}
                <Link className="underline" href={`/hell-level/${accountId}/settings?tab=calendars&section=connections`}>
                  Settings → Calendars → Connections
                </Link>
                .
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
              <Field label="Appointment title" hint="{{contact.name}} becomes the person’s name">
                <Input value={s.eventTitle ?? ''} onChange={(e) => set({ eventTitle: e.target.value })} />
              </Field>
              <Field label="Colour">
                <div className="flex items-center gap-2">
                  <input type="color" value={s.eventColor ?? '#155EEF'} onChange={(e) => set({ eventColor: e.target.value })} className="h-9 w-11 cursor-pointer rounded-md border border-border" />
                  <Input value={s.eventColor ?? ''} onChange={(e) => set({ eventColor: e.target.value })} className="font-mono text-[12.5px]" />
                </div>
              </Field>
            </div>
          </Card>
          <Card className="flex flex-col gap-4 p-5">
            <div>
              <p className="text-[15px] font-semibold text-foreground">{kind === 'collective' ? 'Hosts' : kind === 'personal' ? 'Team member' : 'Team members'}</p>
              <p className="text-[12.5px] text-muted-foreground">
                {kind === 'collective'
                  ? 'A time is open only when every host is free, and the booking is with all of them.'
                  : kind === 'personal'
                    ? 'One person takes every booking.'
                    : kind === 'event'
                      ? 'An event calendar has no host: people book seats at a time.'
                      : kind === 'class_booking'
                        ? 'Who runs the sessions. Each session holds the seats above.'
                        : 'Bookings go round robin to whoever is free. No one picked: the calendar takes one booking per slot.'}
              </p>
            </div>
            {kind === 'event' ? null : !data.staff.length ? (
              <p className="text-[13px] text-muted-foreground">
                No staff yet.{' '}
                <Link href={`/hell-level/${accountId}/settings?tab=my-staff`} className="text-primary hover:underline">
                  Add them under Settings → My Staff
                </Link>
                .
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {data.staff.map((st) => {
                  const k = staffKey(st)
                  const m = team.find((x) => x.userId === k || x.userId === st.id)
                  return (
                    <div key={st.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                      <input
                        type="checkbox"
                        checked={!!m}
                        onChange={(e) => set({ teamMembers: e.target.checked ? [...(kind === 'personal' ? [] : team), { userId: k, priority: 0.5, selected: true }] : team.filter((x) => x !== m) })}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-foreground">{st.name}</span>
                        {st.email && <span className="block truncate text-[12px] text-muted-foreground">{st.email}</span>}
                      </span>
                      {m && kind === 'round_robin' && (
                        <Select className="w-28" value={String(m.priority ?? 0.5)} onChange={(e) => set({ teamMembers: team.map((x) => (x === m ? { ...x, priority: Number(e.target.value) } : x)) })}>
                          <option value="1">High</option>
                          <option value="0.5">Medium</option>
                          <option value="0">Low</option>
                        </Select>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {team.length > 1 && kind === 'round_robin' && (
              <Field label="Distribution">
                <Select value={s.eventType ?? 'RoundRobin_OptimizeForAvailability'} onChange={(e) => set({ eventType: e.target.value as HlCalendarSettings['eventType'] })}>
                  <option value="RoundRobin_OptimizeForAvailability">Optimize for availability (priority first)</option>
                  <option value="RoundRobin_OptimizeForEqualDistribution">Optimize for equal distribution</option>
                </Select>
              </Field>
            )}
          </Card>
        </div>
      )}

      {tab === 'availability' && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex flex-col gap-5">
            <Card className="flex flex-col gap-3 p-5">
              <p className="text-[15px] font-semibold text-foreground">Weekly hours</p>
              <p className="-mt-2 text-[12.5px] text-muted-foreground">In the sub-account’s timezone ({account.data?.account.timezone ?? '…'}). Visitors see times in their own.</p>
              {data.schedules.length > 0 && (
                <p className="rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] text-foreground/85">
                  {data.schedules.map((sc) => `${data.staff.find((st) => staffKey(st) === sc.userId || st.id === sc.userId)?.name ?? 'A team member'} (${sc.name})`).join(', ')}{' '}
                  {data.schedules.length === 1 ? 'uses their own schedule' : 'use their own schedules'} here; these hours are for everyone else.{' '}
                  <Link href={`/hell-level/${accountId}/settings?tab=calendars&section=availability`} className="text-primary hover:underline">
                    Schedules
                  </Link>
                </p>
              )}
              {WEEKDAYS.map((d, i) => (
                <div key={d} className="grid grid-cols-[130px_minmax(0,1fr)] items-start gap-3 border-b border-border-soft pb-3 last:border-0">
                  <label className="flex items-center gap-2 pt-2 text-[13.5px] text-foreground">
                    <input type="checkbox" checked={week[i].length > 0} onChange={(e) => setDay(i, e.target.checked ? [NINE_TO_FIVE] : [])} /> {d}
                  </label>
                  {week[i].length ? <Ranges value={week[i]} onChange={(h) => setDay(i, h)} /> : <p className="pt-2 text-[13px] text-muted-foreground">Unavailable</p>}
                </div>
              ))}
            </Card>
            <Card className="flex flex-col gap-3 p-5">
              <p className="text-[15px] font-semibold text-foreground">Date-specific hours</p>
              <p className="-mt-2 text-[12.5px] text-muted-foreground">Holidays and one-off changes: a date’s own hours replace its weekday’s.</p>
              {overrides.map((o) => (
                <div key={o.date} className="grid grid-cols-[130px_minmax(0,1fr)] items-start gap-3 border-b border-border-soft pb-3">
                  <div className="pt-2 text-[13.5px] text-foreground">
                    {new Date(`${o.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                    <button type="button" className="ml-2 text-muted-foreground hover:text-destructive" title="Remove" onClick={() => set({ availabilities: overrides.filter((x) => x.date !== o.date) })}>
                      <Trash2 className="inline h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-[13px] text-foreground/85">
                      <input type="checkbox" checked={!o.hours.length} onChange={(e) => set({ availabilities: overrides.map((x) => (x.date === o.date ? { ...x, hours: e.target.checked ? [] : [NINE_TO_FIVE] } : x)) })} /> Closed all day
                    </label>
                    {o.hours.length > 0 && <Ranges value={o.hours} onChange={(h) => set({ availabilities: overrides.map((x) => (x.date === o.date ? { ...x, hours: h } : x)) })} />}
                  </div>
                </div>
              ))}
              <div className="flex gap-2">
                <Input type="date" className="w-44" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
                <Button
                  disabled={!newDate || overrides.some((o) => o.date === newDate)}
                  onClick={() => {
                    set({ availabilities: [...overrides, { date: newDate, hours: [] }].sort((a, b) => a.date.localeCompare(b.date)) })
                    setNewDate('')
                  }}
                >
                  Add date
                </Button>
              </div>
            </Card>
            <RecurringCard s={s} set={set} />
          </div>
          <Card className="flex h-fit flex-col gap-4 p-5">
            <p className="text-[15px] font-semibold text-foreground">Slots</p>
            <Amount label="Meeting length" value={s.slotDuration} unit={s.slotDurationUnit} units={['mins', 'hours']} onChange={(v, u) => set({ slotDuration: Number(v) || 0, slotDurationUnit: u })} />
            <div className="-mt-2 flex flex-col gap-1.5">
              <p className="text-[12.5px] text-muted-foreground">Let people pick another length</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {extra
                  .filter((m) => m !== mainLength)
                  .map((m) => (
                    <span key={m} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[12.5px] text-foreground/90">
                      {lengthLabel(m)}
                      <button type="button" title="Remove" className="text-muted-foreground hover:text-destructive" onClick={() => setExtra(extra.filter((x) => x !== m))}>
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                <Input type="number" min={5} max={720} className="h-8 w-20" placeholder="min" value={newLength} onChange={(e) => setNewLength(e.target.value)} />
                <Button
                  size="sm"
                  disabled={!(Number(newLength) >= 5 && Number(newLength) <= 720) || lengths.includes(Number(newLength))}
                  onClick={() => {
                    setExtra([...extra, Number(newLength)].sort((a, b) => a - b))
                    setNewLength('')
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
            <Amount label="Start a slot every" hint="Usually the meeting length" value={s.slotInterval} unit={s.slotIntervalUnit} units={['mins', 'hours']} onChange={(v, u) => set({ slotInterval: Number(v) || 0, slotIntervalUnit: u })} />
            <div className="grid grid-cols-2 gap-3">
              <Amount label="Buffer before" value={s.preBuffer} unit={s.preBufferUnit} units={['mins', 'hours']} onChange={(v, u) => set({ preBuffer: Number(v) || 0, preBufferUnit: u })} />
              <Amount label="Buffer after" value={s.slotBuffer} unit={s.slotBufferUnit} units={['mins', 'hours']} onChange={(v, u) => set({ slotBuffer: Number(v) || 0, slotBufferUnit: u })} />
            </div>
            <Amount label="Minimum notice" hint="How soon someone can book" value={s.allowBookingAfter} unit={s.allowBookingAfterUnit} units={['mins', 'hours', 'days']} onChange={(v, u) => set({ allowBookingAfter: Number(v) || 0, allowBookingAfterUnit: u })} />
            <Amount label="Booking window" hint="How far ahead (0 = no limit)" value={s.allowBookingFor} unit={s.allowBookingForUnit} units={['days', 'weeks', 'months']} onChange={(v, u) => set({ allowBookingFor: Number(v) || 0, allowBookingForUnit: u })} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Per slot" hint="Per team member">
                <Input type="number" min={1} value={s.appointmentPerSlot ?? 1} onChange={(e) => set({ appointmentPerSlot: e.target.value === '' ? 1 : Number(e.target.value) })} />
              </Field>
              <Field label="Per day" hint="Blank = no limit">
                <Input type="number" min={0} value={s.appointmentPerDay ?? ''} onChange={(e) => set({ appointmentPerDay: e.target.value === '' ? '' : Number(e.target.value) })} />
              </Field>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-[13.5px] text-foreground/90">
              <span>
                Look busy
                <span className="block text-[12px] text-muted-foreground">Hides a share of open slots</span>
              </span>
              <span className="flex items-center gap-2">
                {s.lookBusyConfig?.enabled && (
                  <Input type="number" min={0} max={90} className="w-20" value={s.lookBusyConfig.lookBusyPercentage ?? 0} onChange={(e) => set({ lookBusyConfig: { enabled: true, lookBusyPercentage: Number(e.target.value) || 0 } })} />
                )}
                <Toggle checked={!!s.lookBusyConfig?.enabled} onChange={(v) => set({ lookBusyConfig: { enabled: v, lookBusyPercentage: s.lookBusyConfig?.lookBusyPercentage || 10 } })} label="Look busy" />
              </span>
            </label>
          </Card>
        </div>
      )}

      {tab === 'form' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="flex flex-col gap-4 p-5">
            <p className="text-[15px] font-semibold text-foreground">What the booking form asks</p>
            <p className="-mt-2 text-[12.5px] text-muted-foreground">First name and a mobile number are always asked (texts are how bookings are confirmed).</p>
            {(
              [
                ['askEmail', 'Email'],
                ['askNotes', '“Anything we should know?”'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-[13.5px] text-foreground/90">
                {label}
                <Toggle checked={s[k] !== false} onChange={(v) => set({ [k]: v })} label={label} />
              </label>
            ))}
            {s.askEmail !== false && (
              <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-[13.5px] text-foreground/90">
                Email required
                <Toggle checked={!!s.requireEmail} onChange={(v) => set({ requireEmail: v })} label="Email required" />
              </label>
            )}
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-[13.5px] text-foreground/90">
              <span>
                Sticky contact
                <span className="block text-[12px] text-muted-foreground">Someone who booked before finds their details filled in (kept on their own device)</span>
              </span>
              <Toggle checked={!!s.stickyContact} onChange={(v) => set({ stickyContact: v })} label="Sticky contact" />
            </label>
            <Field label="Booking page colour">
              <div className="flex items-center gap-2">
                <input type="color" value={s.widgetColor ?? '#155EEF'} onChange={(e) => set({ widgetColor: e.target.value })} className="h-9 w-11 cursor-pointer rounded-md border border-border" />
                <Input value={s.widgetColor ?? ''} onChange={(e) => set({ widgetColor: e.target.value })} className="font-mono text-[12.5px]" />
              </div>
            </Field>
          </Card>
          <Card className="flex flex-col gap-4 p-5">
            <p className="text-[15px] font-semibold text-foreground">Consent checkboxes</p>
            <ConsentBoxesEditor value={s.consents ?? []} onChange={(consents) => set({ consents })} business={business} />
          </Card>
        </div>
      )}

      {tab === 'confirm' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="flex flex-col gap-3 p-5">
            {(
              [
                ['autoConfirm', 'Confirm bookings straight away', 'Off: they come in as unconfirmed for someone to confirm'],
                ['allowReschedule', 'Let people reschedule', 'From the link in their texts'],
                ['allowCancellation', 'Let people cancel', 'From the link in their texts'],
              ] as const
            ).map(([k, label, hint]) => (
              <label key={k} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-[13.5px] text-foreground/90">
                <span>
                  {label}
                  <span className="block text-[12px] text-muted-foreground">{hint}</span>
                </span>
                <Toggle checked={s[k] !== false} onChange={(v) => set({ [k]: v })} label={label} />
              </label>
            ))}
          </Card>
          <Card className="flex flex-col gap-4 p-5">
            <Field label="After booking">
              <Select value={s.formSubmitType ?? 'ThankYouMessage'} onChange={(e) => set({ formSubmitType: e.target.value as HlCalendarSettings['formSubmitType'] })}>
                <option value="ThankYouMessage">Show a thank-you message</option>
                <option value="RedirectURL">Send them to a page</option>
              </Select>
            </Field>
            {s.formSubmitType === 'RedirectURL' ? (
              <Field label="Page address">
                <Input value={s.formSubmitRedirectUrl ?? ''} onChange={(e) => set({ formSubmitRedirectUrl: e.target.value })} placeholder="https://acmeroofing.com/thank-you" />
              </Field>
            ) : (
              <Field label="Thank-you message">
                <Textarea rows={2} value={s.formSubmitThanksMessage ?? ''} onChange={(e) => set({ formSubmitThanksMessage: e.target.value })} />
              </Field>
            )}
            <Field label="Calendar invite notes" hint="Goes in the invite on the team’s Google Calendar once it’s connected. {{reschedule_link}} and {{cancellation_link}} work.">
              <Textarea rows={3} value={s.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} placeholder={'Phone: {{contact.phone}}\nReschedule: {{reschedule_link}}'} />
            </Field>
            <Field label="Facebook pixel ID" hint="Fires PageView on the booking page and Schedule when someone books">
              <Input value={s.pixelId ?? ''} onChange={(e) => set({ pixelId: e.target.value.replace(/\D/g, '') })} placeholder="1301548744583715" className="w-56 font-mono text-[12.5px]" />
            </Field>
            <p className="text-[12.5px] text-muted-foreground">
              Confirmation and reminder texts: set them up under Notifications, or with automations:{' '}
              <Link href={`/hell-level/${accountId}/automation`} className="text-primary hover:underline">
                Automation → Create workflow → Appointment Confirmation & Reminders
              </Link>
              .
            </p>
          </Card>
        </div>
      )}

      {tab === 'notify' && <NotificationsTab value={s.hlNotifications ?? []} onChange={(hlNotifications) => set({ hlNotifications })} />}

      {tab === 'share' && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
          <Card className="flex flex-col gap-4 p-5">
            <Field label="Booking link">
              <div className="flex gap-2">
                <Input readOnly value={link} className="font-mono text-[12px]" />
                <Button icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyText(link)}>
                  Copy
                </Button>
                <a href={link} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-[13px] text-foreground hover:bg-muted">
                  <ExternalLink className="h-3.5 w-3.5" /> Open
                </a>
              </div>
            </Field>
            <Field label="Embed on the website">
              <Textarea readOnly rows={5} value={bookingEmbedCode(origin, { id: data.calendar.id, name })} className="font-mono text-[11.5px]" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyText(bookingEmbedCode(origin, { id: data.calendar.id, name }))}>
                Copy embed code
              </Button>
              <Button icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyText(bookingLovablePrompt(origin, { id: data.calendar.id, name }))}>
                Copy Lovable prompt
              </Button>
            </div>
            <p className="text-[12.5px] text-muted-foreground">{data.upcoming} upcoming booking{data.upcoming === 1 ? '' : 's'} on this calendar.</p>
          </Card>
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium text-foreground/90">Preview (after you save)</p>
            <div className={cn('overflow-hidden rounded-xl border border-border bg-card', !isActive && 'opacity-60')}>
              <iframe key={data.calendar.updatedAt} src={`/hl/b/${data.calendar.id}`} title="Booking page" className="h-[720px] w-full border-0" />
            </div>
            {!isActive && <p className="text-[12px] text-warning">Turned off: the booking page says it isn’t taking bookings.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

const MERGE_HINT = '{{contact.first_name}} {{contact.name}} {{appointment.start_time}} {{appointment.time}} {{appointment.calendar_name}} {{appointment.location}} {{appointment.reschedule_link}} {{appointment.cancellation_link}} {{appointment.booking_link}} {{account.business_name}}'

/** Minutes as a number and a unit for the reminder and follow-up times. */
function splitMinutes(m: number): { n: number; unit: 'minutes' | 'hours' | 'days' } {
  if (m > 0 && m % 1440 === 0) return { n: m / 1440, unit: 'days' }
  if (m > 0 && m % 60 === 0) return { n: m / 60, unit: 'hours' }
  return { n: m, unit: 'minutes' }
}
const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const

/** The calendar's notifications: texts to the contact, texts or emails to the team member, on booking, changes, before and after. */
function NotificationsTab({ value, onChange }: { value: HlNotification[]; onChange: (v: HlNotification[]) => void }) {
  const [preset, setPreset] = useState('')
  const set = (i: number, patch: Partial<HlNotification>) => onChange(value.map((n, j) => (j === i ? { ...n, ...patch } : n)))
  const add = (key: string) => {
    const p = NOTIFICATION_PRESETS.find((x) => x.label === key)
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `n${Date.now()}`
    onChange([...value, p ? { id, enabled: true, on: p.on, to: p.to, channel: p.channel, minutes: p.minutes, subject: p.subject, body: p.body } : { id, enabled: true, on: 'booked', to: 'contact', channel: 'sms', body: '' }])
    setPreset('')
  }
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2 p-5">
        <p className="text-[15px] font-semibold text-foreground">Notifications</p>
        <p className="text-[12.5px] text-muted-foreground">
          Sent when an appointment on this calendar is booked, rescheduled or cancelled, before it starts and after it ends. Texts to the contact need their texting consent (the booking form’s box) and stop if they text STOP; reminders wait for the morning. Team member alerts go to the appointment’s team member (their phone and email under My Staff), else the business’s notification phone and email.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Select className="w-80" value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="">Add a notification…</option>
            {NOTIFICATION_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
            <option value="__blank">A blank one</option>
          </Select>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={!preset} onClick={() => add(preset)}>
            Add
          </Button>
        </div>
      </Card>
      {!value.length && <p className="px-1 text-[13px] text-muted-foreground">None yet: this calendar sends nothing on its own (automations still can).</p>}
      {value.map((n, i) => {
        const timed = n.on === 'reminder' || n.on === 'followup'
        const t = splitMinutes(Number(n.minutes) || 0)
        return (
          <Card key={n.id} className={cn('flex flex-col gap-3 p-4', !n.enabled && 'opacity-60')}>
            <div className="flex flex-wrap items-center gap-2">
              <Toggle checked={n.enabled} onChange={(v) => set(i, { enabled: v })} label="On" />
              <Select className="h-8 w-36 text-[12.5px]" value={n.on} onChange={(e) => set(i, { on: e.target.value as HlNotification['on'], ...(e.target.value === 'reminder' || e.target.value === 'followup' ? { minutes: n.minutes ?? 60 } : {}) })}>
                {NOTIFICATION_EVENTS.map((ev) => (
                  <option key={ev.key} value={ev.key}>
                    {ev.label}
                  </option>
                ))}
              </Select>
              {timed && (
                <>
                  <Input type="number" min={0} className="h-8 w-20 text-[12.5px]" value={t.n} onChange={(e) => set(i, { minutes: Math.max(0, Number(e.target.value) || 0) * UNIT_MINUTES[t.unit] })} />
                  <Select className="h-8 w-28 text-[12.5px]" value={t.unit} onChange={(e) => set(i, { minutes: t.n * UNIT_MINUTES[e.target.value as keyof typeof UNIT_MINUTES] })}>
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </Select>
                  <span className="text-[12.5px] text-muted-foreground">{n.on === 'reminder' ? 'before it starts' : 'after it ends'}</span>
                </>
              )}
              <span className="text-[12.5px] text-muted-foreground">to</span>
              <Select className="h-8 w-36 text-[12.5px]" value={n.to} onChange={(e) => set(i, { to: e.target.value === 'member' ? 'member' : 'contact', ...(e.target.value === 'contact' ? { channel: 'sms' } : {}) })}>
                <option value="contact">the contact</option>
                <option value="member">the team member</option>
              </Select>
              <Select className="h-8 w-24 text-[12.5px]" value={n.channel} onChange={(e) => set(i, { channel: e.target.value === 'email' ? 'email' : 'sms' })}>
                <option value="sms">Text</option>
                <option value="email" disabled={n.to === 'contact'}>
                  Email{n.to === 'contact' ? ' (not yet)' : ''}
                </option>
              </Select>
              <button type="button" title="Remove" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {n.channel === 'email' && <Input placeholder="Subject" value={n.subject ?? ''} onChange={(e) => set(i, { subject: e.target.value })} />}
            <Textarea rows={3} value={n.body} onChange={(e) => set(i, { body: e.target.value })} placeholder="The message" />
          </Card>
        )
      })}
      <p className="px-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{MERGE_HINT}</p>
    </div>
  )
}

/** GHL's Recurring: every booking on the calendar is a series. */
function RecurringCard({ s, set }: { s: HlCalendarSettings; set: (patch: Partial<HlCalendarSettings>) => void }) {
  const r = { freq: 'WEEKLY' as const, count: 4, interval: 1, weekDays: [], monthDays: [], bookingOption: 'skip' as const, bookingOverlapDefaultStatus: 'confirmed' as const, ...(s.recurring ?? {}) }
  const put = (patch: Partial<typeof r>) => set({ recurring: { ...r, ...patch } })
  const rule = recurringOf({ ...s, enableRecurring: true, recurring: r })
  const unit = r.freq === 'DAILY' ? 'days' : r.freq === 'MONTHLY' ? 'months' : 'weeks'
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-foreground">Recurring</p>
          <p className="text-[12.5px] text-muted-foreground">Each booking is a series: the first time picked, then the rest on a schedule, with the same team member when they’re free.</p>
        </div>
        <Toggle checked={s.enableRecurring === true} onChange={(v) => set({ enableRecurring: v, recurring: { ...r, count: Math.max(2, Number(r.count) || 2) } })} label="Recurring" />
      </div>
      {s.enableRecurring === true && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Repeats">
              <Select value={r.freq ?? 'WEEKLY'} onChange={(e) => put({ freq: e.target.value as 'DAILY' | 'WEEKLY' | 'MONTHLY', weekDays: [], monthDays: [] })}>
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </Select>
            </Field>
            <Field label={`Every (${unit})`}>
              <Input type="number" min={1} max={12} value={r.interval ?? 1} onChange={(e) => put({ interval: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} />
            </Field>
            <Field label="Times in all" hint={`2 to ${MAX_SERIES}`}>
              <Input type="number" min={2} max={MAX_SERIES} value={r.count ?? 2} onChange={(e) => put({ count: Math.max(2, Math.min(MAX_SERIES, Number(e.target.value) || 2)) })} />
            </Field>
          </div>
          {r.freq === 'WEEKLY' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[12.5px] text-muted-foreground">On</span>
              {RRULE_DAYS.map((code, i) => {
                const on = (r.weekDays ?? []).includes(code)
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => put({ weekDays: on ? (r.weekDays ?? []).filter((x) => x !== code) : [...(r.weekDays ?? []), code] })}
                    className={cn('rounded-full border px-2.5 py-0.5 text-[12.5px]', on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}
                  >
                    {WEEKDAYS[i].slice(0, 3)}
                  </button>
                )
              })}
              <span className="text-[12px] text-muted-foreground">(none: the day of the first booking)</span>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="When a time in the series isn’t free">
              <Select value={r.bookingOption ?? 'skip'} onChange={(e) => put({ bookingOption: e.target.value as 'skip' | 'book_next' | 'continue' })}>
                <option value="skip">Skip it</option>
                <option value="book_next">Book the next free time that day</option>
                <option value="continue">Book it anyway</option>
              </Select>
            </Field>
            {r.bookingOption === 'continue' && (
              <Field label="Booked anyway as">
                <Select value={r.bookingOverlapDefaultStatus === 'new' ? 'new' : 'confirmed'} onChange={(e) => put({ bookingOverlapDefaultStatus: e.target.value === 'new' ? 'new' : 'confirmed' })}>
                  <option value="confirmed">Confirmed</option>
                  <option value="new">Unconfirmed</option>
                </Select>
              </Field>
            )}
          </div>
          {rule && <p className="text-[12.5px] text-muted-foreground">{recurringLabel(rule)}. The booking page says so, and each one gets its own reminders and reschedule link.</p>}
        </>
      )}
    </Card>
  )
}
