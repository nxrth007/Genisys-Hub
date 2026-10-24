'use client'

import Link from 'next/link'
import { Suspense, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, Copy, ExternalLink, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { contactLabel } from '@/components/hell-level/bits'
import { useSectionTab } from '@/components/hell-level/section'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Table, copyText, fmtDateTime, hlFetch } from '@/components/hell-level/ui'
import { confirmAction } from '@/components/hell-level/confirm'

type Appointment = {
  id: string
  title: string
  startTime: string
  endTime: string
  status: string
  assignedTo: string | null
  address: string | null
  notes: string | null
  source?: string | null
  token?: string | null
  contact: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null } | null
  calendar: { id: string; name: string } | null
}
type CalendarRow = { id: string; name: string; description: string | null; kind: string | null; isActive: boolean; settings: Record<string, unknown> }
type Data = { calendars: CalendarRow[]; appointments: Appointment[] }

const STATUS: Record<string, 'green' | 'blue' | 'red' | 'gray' | 'amber'> = { confirmed: 'blue', showed: 'green', noshow: 'red', cancelled: 'gray', new: 'amber', invalid: 'gray' }

export default function CalendarsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <CalendarsSection />
    </Suspense>
  )
}

function CalendarsSection() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('calendars')
  if (tab === 'appointments') return <AppointmentList accountId={accountId} />
  if (tab === 'settings') return <CalendarSettings accountId={accountId} />
  return <MonthView accountId={accountId} />
}

function useRange(accountId: string, from: Date, to: Date) {
  return useQuery<Data>({
    queryKey: ['hl', 'appointments', accountId, from.toISOString(), to.toISOString()],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/appointments?from=${from.toISOString()}&to=${to.toISOString()}`),
  })
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

function MonthView({ accountId }: { accountId: string }) {
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [open, setOpen] = useState<Appointment | null>(null)
  const gridStart = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay())
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42)
  const q = useRange(accountId, gridStart, gridEnd)
  const byDay = useMemo(() => {
    const m = new Map<string, Appointment[]>()
    for (const a of q.data?.appointments ?? []) {
      const k = dayKey(new Date(a.startTime))
      m.set(k, [...(m.get(k) ?? []), a])
    }
    return m
  }, [q.data])
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i))
  const today = dayKey(new Date())
  return (
    <div className="flex flex-col gap-4 px-6 py-6">
      <PageHeader
        title={month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        description={q.data ? `${q.data.appointments.length} appointments in view` : ' '}
        actions={
          <>
            <Button size="sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
              Today
            </Button>
            <Button size="sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </>
        }
      />
      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <p key={d} className="eyebrow px-2 py-2 text-muted-foreground">
              {d}
            </p>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d) => {
            const list = byDay.get(dayKey(d)) ?? []
            const inMonth = d.getMonth() === month.getMonth()
            return (
              <div key={d.toISOString()} className={cn('min-h-[108px] border-b border-r border-border-soft p-1.5 [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-surface-muted/40')}>
                <p className={cn('mb-1 w-fit rounded px-1.5 font-mono text-[11px]', dayKey(d) === today ? 'bg-primary text-primary-foreground' : inMonth ? 'text-foreground/80' : 'text-muted-foreground/50')}>{d.getDate()}</p>
                <div className="flex flex-col gap-0.5">
                  {list.slice(0, 3).map((a) => (
                    <button key={a.id} type="button" onClick={() => setOpen(a)} className={cn('truncate rounded px-1.5 py-0.5 text-left text-[11px] transition hover:brightness-125', a.status === 'cancelled' ? 'bg-muted text-muted-foreground line-through' : 'chip-blue')}>
                      {new Date(a.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} {a.contact ? contactLabel(a.contact) : a.title}
                    </button>
                  ))}
                  {list.length > 3 && <p className="px-1.5 font-mono text-[10.5px] text-muted-foreground">+{list.length - 3} more</p>}
                </div>
              </div>
            )
          })}
        </div>
      </Card>
      {q.isLoading && <Spinner />}
      <ErrorNote error={q.error} />
      {open && <AppointmentModal accountId={accountId} a={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

const STATUS_ACTIONS: { status: string; label: string }[] = [
  { status: 'confirmed', label: 'Confirm' },
  { status: 'showed', label: 'Showed' },
  { status: 'noshow', label: 'No-show' },
  { status: 'cancelled', label: 'Cancel' },
]

function AppointmentModal({ accountId, a, onClose }: { accountId: string; a: Appointment; onClose: () => void }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState(a.status)
  const change = useMutation({
    mutationFn: (s: string) => hlFetch(`/api/hl/accounts/${accountId}/appointments/${a.id}`, { method: 'PATCH', json: { status: s } }),
    onSuccess: (_d, s) => {
      setStatus(s)
      qc.invalidateQueries({ queryKey: ['hl', 'appointments', accountId] })
    },
  })
  const manage = a.token ? `${typeof window === 'undefined' ? '' : window.location.origin}/hl/a/${a.token}` : null
  return (
    <Modal
      open
      onClose={onClose}
      title={a.title}
      description={`${fmtDateTime(a.startTime)} – ${new Date(a.endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="mr-auto text-[12px] text-muted-foreground">Mark as</span>
          {STATUS_ACTIONS.map((x) => (
            <Button
              key={x.status}
              size="sm"
              variant={status === x.status ? 'primary' : x.status === 'cancelled' ? 'ghost' : 'secondary'}
              className={x.status === 'cancelled' && status !== 'cancelled' ? 'text-destructive' : undefined}
              disabled={status === x.status}
              loading={change.isPending && change.variables === x.status}
              onClick={() => void (x.status !== 'cancelled' ? Promise.resolve(true) : confirmAction('Cancel this appointment? Any “Appointment status: cancelled” automations run.', 'Cancel appointment')).then((ok) => ok && change.mutate(x.status))}
            >
              {x.label}
            </Button>
          ))}
        </div>
      }
    >
      <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[13px]">
        <dt className="eyebrow text-muted-foreground">Status</dt>
        <dd>
          <Badge color={STATUS[status] ?? 'gray'}>{status}</Badge>
          {a.source === 'booking' && <span className="ml-2 text-[12px] text-muted-foreground">Booked online</span>}
        </dd>
        <dt className="eyebrow text-muted-foreground">Contact</dt>
        <dd>
          {a.contact ? (
            <Link href={`/hell-level/${accountId}/conversations?contact=${a.contact.id}`} className="text-primary hover:underline">
              {contactLabel(a.contact)}
            </Link>
          ) : (
            '—'
          )}
        </dd>
        <dt className="eyebrow text-muted-foreground">Calendar</dt>
        <dd className="text-foreground/90">{a.calendar?.name ?? '—'}</dd>
        <dt className="eyebrow text-muted-foreground">With</dt>
        <dd className="text-foreground/90">{a.assignedTo ?? '—'}</dd>
        {a.address && (
          <>
            <dt className="eyebrow text-muted-foreground">Where</dt>
            <dd className="text-foreground/90">{a.address}</dd>
          </>
        )}
        {a.notes && (
          <>
            <dt className="eyebrow text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-wrap text-foreground/90">{a.notes}</dd>
          </>
        )}
        {manage && (
          <>
            <dt className="eyebrow text-muted-foreground">Their link</dt>
            <dd>
              <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => copyText(manage)}>
                <Copy className="h-3 w-3" /> Copy the reschedule / cancel link
              </button>
            </dd>
          </>
        )}
      </dl>
      <ErrorNote error={change.error} />
    </Modal>
  )
}

function AppointmentList({ accountId }: { accountId: string }) {
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming')
  const range = useMemo(() => {
    const now = new Date()
    return when === 'upcoming' ? [now, new Date(now.getTime() + 180 * 86_400_000)] : [new Date(now.getTime() - 365 * 86_400_000), now]
  }, [when])
  const q = useRange(accountId, range[0], range[1])
  const list = when === 'past' ? [...(q.data?.appointments ?? [])].reverse() : (q.data?.appointments ?? [])
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
      <PageHeader
        title="Appointments"
        actions={
          <div className="flex rounded-md border border-border p-0.5">
            {(['upcoming', 'past'] as const).map((w) => (
              <button key={w} type="button" onClick={() => setWhen(w)} className={cn('rounded px-3 py-1 font-mono text-[12px] capitalize', when === w ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
                {w}
              </button>
            ))}
          </div>
        }
      />
      <Card>
        {q.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : !list.length ? (
          <Empty icon={<CalendarDays className="h-5 w-5" />} title={when === 'upcoming' ? 'Nothing booked ahead' : 'No past appointments'}>
            Appointments imported from GoHighLevel show up here.
          </Empty>
        ) : (
          <Table head={['When', 'Title', 'Contact', 'Calendar', 'Status', 'With']}>
            {list.map((a) => (
              <tr key={a.id} className="border-b border-border-soft last:border-0 hover:bg-muted/40">
                <td className="whitespace-nowrap px-4 py-2.5 text-foreground/90">{fmtDateTime(a.startTime)}</td>
                <td className="px-4 py-2.5 text-foreground">{a.title}</td>
                <td className="px-4 py-2.5">
                  {a.contact ? (
                    <Link href={`/hell-level/${accountId}/conversations?contact=${a.contact.id}`} className="text-primary hover:underline">
                      {contactLabel(a.contact)}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{a.calendar?.name ?? '—'}</td>
                <td className="px-4 py-2.5">
                  <Badge color={STATUS[a.status] ?? 'gray'}>{a.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{a.assignedTo ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <ErrorNote error={q.error} />
    </div>
  )
}

type CalendarListRow = CalendarRow & { upcoming: number }

function CalendarSettings({ accountId }: { accountId: string }) {
  const router = useRouter()
  const qc = useQueryClient()
  const q = useQuery<{ calendars: CalendarListRow[] }>({ queryKey: ['hl', 'calendars', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendars`) })
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => hlFetch<{ calendar: { id: string } }>(`/api/hl/accounts/${accountId}/calendars`, { method: 'POST', json: { name } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'calendars', accountId] })
      router.push(`/hell-level/${accountId}/calendars/${r.calendar.id}`)
    },
  })
  const toggle = useMutation({
    mutationFn: (c: CalendarListRow) => hlFetch(`/api/hl/accounts/${accountId}/calendars/${c.id}`, { method: 'PATCH', json: { isActive: !c.isActive } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'calendars', accountId] }),
  })
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const minutes = (c: CalendarRow) => {
    const d = Number(c.settings.slotDuration)
    if (!Number.isFinite(d) || d <= 0) return '—'
    return c.settings.slotDurationUnit === 'hours' ? `${d} hr` : `${d} min`
  }
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
      <PageHeader
        title="Calendars"
        description="Booking calendars: each has a booking page to share or embed on the website. Bookings land here and on the contact, and can start automations."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Create calendar
          </Button>
        }
      />
      <Card>
        {q.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : !q.data?.calendars.length ? (
          <Empty icon={<CalendarDays className="h-5 w-5" />} title="No calendars yet" action={<Button variant="primary" onClick={() => setCreating(true)}>Create calendar</Button>}>
            Make one for estimates or calls, set its hours, and put its booking page on the client’s site.
          </Empty>
        ) : (
          <Table head={['Calendar', 'Length', 'Upcoming', 'Status', '']}>
            {q.data.calendars.map((c) => (
              <tr key={c.id} className="border-b border-border-soft last:border-0 hover:bg-muted/40">
                <td className="px-4 py-2.5">
                  <Link href={`/hell-level/${accountId}/calendars/${c.id}`} className="font-medium text-foreground hover:underline">
                    {c.name}
                  </Link>
                  <p className="font-mono text-[11.5px] text-muted-foreground">{(c.kind ?? 'calendar').replace(/_/g, ' ')}</p>
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{minutes(c)}</td>
                <td className="px-4 py-2.5 tabular-nums text-foreground/85">{c.upcoming}</td>
                <td className="px-4 py-2.5">
                  <button type="button" onClick={() => toggle.mutate(c)} title={c.isActive ? 'Stop taking bookings' : 'Start taking bookings'}>
                    <Badge color={c.isActive ? 'green' : 'gray'}>{c.isActive ? 'Active' : 'Off'}</Badge>
                  </button>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <button type="button" className="mr-3 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground" onClick={() => copyText(`${origin}/hl/b/${c.id}`)} title="Copy the booking link">
                    <Copy className="h-3.5 w-3.5" /> Link
                  </button>
                  <a href={`/hl/b/${c.id}`} target="_blank" rel="noreferrer" className="mr-3 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
                    <ExternalLink className="h-3.5 w-3.5" /> Open
                  </a>
                  <Link href={`/hell-level/${accountId}/calendars/${c.id}`} className="text-[12.5px] font-semibold text-primary hover:underline">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <ErrorNote error={q.error || toggle.error} />
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create calendar"
        description="Starts Monday to Friday, 9 to 5, 30-minute slots. Change it all after."
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
              Create
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Free Estimate" autoFocus />
        </Field>
        <ErrorNote error={create.error} />
      </Modal>
    </div>
  )
}
