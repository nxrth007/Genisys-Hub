'use client'

import Link from 'next/link'
import { Suspense, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays } from 'lucide-react'
import { cn } from '@/lib/utils'
import { contactLabel } from '@/components/hell-level/bits'
import { useSectionTab } from '@/components/hell-level/section'
import { Badge, Card, Empty, ErrorNote, PageHeader, Spinner, Table, fmtDateTime, hlFetch } from '@/components/hell-level/ui'
import { CalendarSettingsPanel } from '@/components/hell-level/calendar-settings'
import { AppointmentDrawer, CalendarView, STATUS_COLOR, useRange, type Appt } from '@/components/hell-level/calendar-view'

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
  if (tab === 'settings') return <CalendarSettingsPanel accountId={accountId} />
  return <CalendarView accountId={accountId} />
}

/** GHL's Appointment List View: upcoming or past, newest booking at hand; blocked-off time isn't listed. */
function AppointmentList({ accountId }: { accountId: string }) {
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming')
  const [open, setOpen] = useState<Appt | null>(null)
  const range = useMemo(() => {
    const now = new Date()
    return when === 'upcoming' ? [now, new Date(now.getTime() + 180 * 86_400_000)] : [new Date(now.getTime() - 365 * 86_400_000), now]
  }, [when])
  const q = useRange(accountId, range[0], range[1])
  const prefs = useQuery<{ me: { timezone?: string } }>({ queryKey: ['hl', 'calendar-prefs', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-preferences`) })
  const rows = (q.data?.appointments ?? []).filter((a) => a.source !== 'block')
  const list = when === 'past' ? [...rows].reverse() : rows
  const tz = prefs.data?.me.timezone || q.data?.timezone || 'America/New_York'
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
            Bookings from the calendars’ pages, and appointments made in the calendar, show up here.
          </Empty>
        ) : (
          <Table head={['When', 'Title', 'Contact', 'Calendar', 'Status', 'With']}>
            {list.map((a) => (
              <tr key={a.id} onClick={() => setOpen(a)} className="cursor-pointer border-b border-border-soft last:border-0 hover:bg-muted/40">
                <td className="whitespace-nowrap px-4 py-2.5 text-foreground/90">{fmtDateTime(a.startTime)}</td>
                <td className="px-4 py-2.5 text-foreground">{a.title}</td>
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
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
                  <Badge color={STATUS_COLOR[a.status] ?? 'gray'}>{a.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{a.assignedTo ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <ErrorNote error={q.error} />
      {open && q.data && <AppointmentDrawer accountId={accountId} a={open} data={q.data} tz={tz} onClose={() => setOpen(null)} />}
    </div>
  )
}
