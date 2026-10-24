'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Card, ErrorNote, PageHeader, Spinner, Table, hlFetch } from './ui'

/** The agency view's pages (GHL's Launchpad, Agency Dashboard, Account Snapshots, Settings) off /api/hl/agency. */

export type AgencyData = {
  accounts: {
    id: string
    name: string
    home: boolean
    fromGhl: boolean
    contacts: number
    leads30: number
    leads7: number
    texts7: number
    upcoming: number
    openDeals: number
    openValue: number
    won30: number
    wonValue30: number
    texting: 'live' | 'pending' | 'none'
    workflows: number
    calendars: number
    domains: number
  }[]
  totals: { accounts: number; contacts: number; leads30: number; leads7: number; upcoming: number; openValue: number; wonValue30: number }
  setup: { key: string; label: string; done: boolean; detail: string; href: string | null }[]
}

export function useAgency() {
  return useQuery<AgencyData>({ queryKey: ['hl', 'agency'], queryFn: () => hlFetch('/api/hl/agency'), staleTime: 30_000 })
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export function AgencyLaunchpad() {
  const q = useAgency()
  const steps = q.data?.setup ?? []
  const done = steps.filter((s) => s.done).length
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Setup Guide" description="What Hell-level needs before every client can move off GoHighLevel." />
      {q.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{pct}%</span>
          </div>
          <Card>
            {steps.map((s) => (
              <div key={s.key} className="flex items-center gap-3 border-b border-border-soft px-5 py-4 last:border-0">
                {s.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" /> : <Circle className="h-5 w-5 shrink-0 text-muted-foreground" />}
                <div className="min-w-0 flex-1">
                  <p className={cn('text-[14px] font-medium', s.done ? 'text-foreground' : 'text-foreground')}>{s.label}</p>
                  <p className="text-[12.5px] text-muted-foreground">{s.detail}</p>
                </div>
                {s.href && !s.done && (
                  <Link href={s.href} className="text-[12.5px] font-semibold text-primary hover:underline">
                    Open
                  </Link>
                )}
                <span className={cn('font-mono text-[11px]', s.done ? 'text-success' : 'text-muted-foreground')}>{s.done ? '100%' : '0%'}</span>
              </div>
            ))}
          </Card>
        </>
      )}
      <ErrorNote error={q.error} />
    </div>
  )
}

export function AgencyDashboard() {
  const q = useAgency()
  const t = q.data?.totals
  const tiles = t
    ? [
        ['Sub-accounts', String(t.accounts)],
        ['Contacts', t.contacts.toLocaleString('en-US')],
        ['New leads (7 days)', t.leads7.toLocaleString('en-US')],
        ['New leads (30 days)', t.leads30.toLocaleString('en-US')],
        ['Upcoming appointments', String(t.upcoming)],
        ['Open pipeline', money(t.openValue)],
        ['Won (30 days)', money(t.wonValue30)],
      ]
    : []
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Agency Dashboard" description="Every sub-account at a glance." />
      {q.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            {tiles.map(([label, value]) => (
              <Card key={label} className="px-4 py-3">
                <p className="eyebrow text-muted-foreground">{label}</p>
                <p className="mt-1 text-[22px] font-semibold tabular-nums text-foreground">{value}</p>
              </Card>
            ))}
          </div>
          <Card>
            <Table head={['Sub-account', 'Contacts', 'Leads 7d', 'Leads 30d', 'Texts 7d', 'Upcoming', 'Open deals', 'Won 30d', 'Texting']}>
              {(q.data?.accounts ?? []).map((a) => (
                <tr key={a.id} className="border-b border-border-soft last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <Link href={`/hell-level/${a.id}/dashboard`} className="font-medium text-foreground hover:underline">
                      {a.name}
                    </Link>
                    {a.home && <Badge color="blue" className="ml-2">Home</Badge>}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground/85">{a.contacts.toLocaleString('en-US')}</td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground/85">{a.leads7}</td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground/85">{a.leads30}</td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground/85">{a.texts7}</td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground/85">{a.upcoming}</td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground/85">
                    {a.openDeals} <span className="text-muted-foreground">· {money(a.openValue)}</span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground/85">{money(a.wonValue30)}</td>
                  <td className="px-4 py-2.5">
                    <Badge color={a.texting === 'live' ? 'green' : a.texting === 'pending' ? 'amber' : 'gray'}>{a.texting === 'live' ? 'Live' : a.texting === 'pending' ? 'Pending' : 'No number'}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
      <ErrorNote error={q.error} />
    </div>
  )
}

/** GHL's Account Snapshots: in Hell-level, the starter kit every new sub-account gets. */
export function AgencySnapshots() {
  const parts = [
    ['Pipeline', 'Lead pipeline: New Lead → Contacted → Quote Sent → Job Scheduled → Job Complete'],
    ['Forms', 'Website quote form and chat widget, with the two consent boxes and the client’s own policy links'],
    ['Workflows', 'Missed-call text-back, quote form and chat replies (live), Google review request and appointment confirmation & reminders (drafts)'],
    ['Copy', 'A Plus Fence & Construction’s GoHighLevel snapshot copy, with every business detail a {{account.*}} merge field'],
  ]
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Account Snapshots" description="What every new sub-account starts with (GHL loads a snapshot; Hell-level builds this starter kit from the client’s onboarding answers)." />
      <Card>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <p className="text-[15px] font-semibold text-foreground">Genisys Contractor Starter</p>
            <p className="text-[12.5px] text-muted-foreground">Default snapshot · applied to every new sub-account</p>
          </div>
          <Badge color="green">Default</Badge>
        </div>
        {parts.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[140px_1fr] gap-3 border-b border-border-soft px-5 py-3 text-[13px] last:border-0">
            <span className="eyebrow pt-0.5 text-muted-foreground">{k}</span>
            <span className="text-foreground/90">{v}</span>
          </div>
        ))}
      </Card>
    </div>
  )
}
