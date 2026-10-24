'use client'

import Link from 'next/link'
import { Suspense, useState } from 'react'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { PhoneCall } from 'lucide-react'
import { contactLabel } from '@/components/hell-level/bits'
import { NotYet, useSectionTab } from '@/components/hell-level/section'
import { Badge, Card, Empty, ErrorNote, PageHeader, Select, Spinner, Table, fmtDateTime, hlFetch } from '@/components/hell-level/ui'

type Calls = {
  days: number
  total: number
  answered: number
  missed: number
  inbound: number
  calls: { id: string; direction: string; status: string; body: string; createdAt: string; contact: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null } }[]
}
type Appts = { days: number; total: number; byStatus: Record<string, number>; byCalendar: Record<string, number> }

const NOT_YET: Record<string, { title: string; what: string }> = {
  'custom-reports': { title: 'Custom Reports', what: 'Build-your-own reports across contacts, opportunities and conversations.' },
  'google-ads': { title: 'Google Ads', what: 'Spend, clicks and leads from a connected Google Ads account.' },
  'facebook-ads': { title: 'Facebook Ads', what: 'Spend, clicks and leads from a connected Facebook Ads account.' },
  attribution: { title: 'Attribution Report', what: 'Which source each lead came from, first touch and last touch. Contacts keep their source (form, chat, call, text) for now.' },
}

export default function ReportingPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Reporting />
    </Suspense>
  )
}

function Range({ days, setDays }: { days: number; setDays: (n: number) => void }) {
  return (
    <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
      <option value={7}>Last 7 days</option>
      <option value={30}>Last 30 days</option>
      <option value={90}>Last 90 days</option>
      <option value={365}>Last 12 months</option>
    </Select>
  )
}

function Reporting() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('reporting')
  const [days, setDays] = useState(30)
  const calls = useQuery<Calls>({ queryKey: ['hl', 'reports', accountId, 'calls', days], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/reports?kind=calls&days=${days}`), enabled: tab === 'call-reporting' })
  const appts = useQuery<Appts>({ queryKey: ['hl', 'reports', accountId, 'appointments', days], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/reports?kind=appointments&days=${days}`), enabled: tab === 'appointment-report' })
  if (NOT_YET[tab]) return <NotYet title={NOT_YET[tab].title} what={NOT_YET[tab].what} />

  if (tab === 'appointment-report') {
    const d = appts.data
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
        <PageHeader title="Appointment Report" actions={<Range days={days} setDays={setDays} />} />
        {appts.isLoading ? (
          <Spinner />
        ) : !d?.total ? (
          <Card>
            <Empty title="No appointments in this range" />
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-4">
              <p className="eyebrow mb-3 text-muted-foreground">By status · {d.total}</p>
              {Object.entries(d.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => (
                  <div key={k} className="mb-2">
                    <div className="flex justify-between text-[13px]">
                      <span className="capitalize text-foreground/90">{k}</span>
                      <span className="tabular-nums text-muted-foreground">{n}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${(n / d.total) * 100}%` }} />
                    </div>
                  </div>
                ))}
            </Card>
            <Card className="p-4">
              <p className="eyebrow mb-3 text-muted-foreground">By calendar</p>
              {Object.entries(d.byCalendar)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => (
                  <div key={k} className="flex justify-between border-b border-border-soft py-2 text-[13px] last:border-0">
                    <span className="text-foreground/90">{k}</span>
                    <span className="tabular-nums text-muted-foreground">{n}</span>
                  </div>
                ))}
            </Card>
          </div>
        )}
        <ErrorNote error={appts.error} />
      </div>
    )
  }

  const d = calls.data
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
      <PageHeader title="Call Reporting" description="Calls to the sub-account’s numbers (and calls imported from GoHighLevel)." actions={<Range days={days} setDays={setDays} />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(
          [
            ['Calls', d?.total],
            ['Answered', d?.answered],
            ['Missed', d?.missed],
            ['Answer rate', d && d.total ? `${Math.round((d.answered / d.total) * 100)}%` : '—'],
          ] as const
        ).map(([k, v]) => (
          <Card key={k} className="p-4">
            <p className="eyebrow text-muted-foreground">{k}</p>
            <p className="mt-2 text-[26px] font-semibold tabular-nums">{v ?? '—'}</p>
          </Card>
        ))}
      </div>
      <Card>
        {calls.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : !d?.calls.length ? (
          <Empty icon={<PhoneCall className="h-5 w-5" />} title="No calls in this range" />
        ) : (
          <Table head={['When', 'Contact', 'Direction', 'Result']}>
            {d.calls.map((c) => (
              <tr key={c.id} className="border-b border-border-soft last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{fmtDateTime(c.createdAt)}</td>
                <td className="px-4 py-2.5">
                  <Link href={`/hell-level/${accountId}/conversations?contact=${c.contact.id}`} className="text-primary hover:underline">
                    {contactLabel(c.contact)}
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-mono text-[12px] text-muted-foreground">{c.direction}</td>
                <td className="px-4 py-2.5">
                  <Badge color={c.status === 'answered' ? 'green' : c.status === 'missed' ? 'red' : 'gray'}>{c.body || c.status}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <ErrorNote error={calls.error} />
    </div>
  )
}
