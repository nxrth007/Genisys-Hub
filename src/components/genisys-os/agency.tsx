'use client'

import Link from 'next/link'
import { useState } from 'react'
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
  /** The kit every client sub-account gets, read from src/lib/hl/client-kit.ts. */
  kit: {
    version: number
    pipeline: string
    stages: string[]
    forms: string[]
    folders: { name: string; workflows: { name: string; runs: boolean }[] }[]
    /** Sub-accounts that have it. */
    accounts: number
  }
}

export function useAgency() {
  return useQuery<AgencyData>({ queryKey: ['hl', 'agency'], queryFn: () => hlFetch('/api/hl/agency'), staleTime: 30_000 })
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** The agency setup guide (GHL's agency Launchpad). Its own page still opens; Agency Settings shows where it stands. */
export function AgencyLaunchpad() {
  const q = useAgency()
  const steps = q.data?.setup ?? []
  const done = steps.filter((s) => s.done).length
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Setup Guide" description="What Genisys OS needs before every client can move off GoHighLevel." />
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
                  <p className="text-[14px] font-medium text-foreground">{s.label}</p>
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

/** The setup guide, folded into Agency Settings: one line while every step is done, the steps left when one isn't. */
export function SetupSummary() {
  const q = useAgency()
  const steps = q.data?.setup ?? []
  const left = steps.filter((s) => !s.done)
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold text-foreground">Setup guide</p>
          <p className="text-[12.5px] text-muted-foreground">
            {q.isLoading ? 'Checking…' : !steps.length ? 'Couldn’t check.' : left.length ? `${steps.length - left.length} of ${steps.length} steps done` : `All ${steps.length} steps done.`}
          </p>
        </div>
        <Link href="/genisys-os/agency/launchpad" className="text-[12.5px] font-semibold text-primary hover:underline">
          Open
        </Link>
      </div>
      {left.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-border-soft pt-3">
          {left.map((s) => (
            <p key={s.key} className="flex items-start gap-2 text-[12.5px] text-foreground/85">
              <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>
                {s.label}
                <span className="text-muted-foreground"> · {s.detail}</span>
              </span>
            </p>
          ))}
        </div>
      )}
      <ErrorNote error={q.error} />
    </Card>
  )
}

type Row = AgencyData['accounts'][number]
type View = 'all' | 'leads' | 'live' | 'pending' | 'none'
const VIEWS: { id: View; label: string; hint: string; test: (a: Row) => boolean }[] = [
  { id: 'all', label: 'All', hint: 'Every sub-account', test: () => true },
  { id: 'leads', label: 'Had leads', hint: 'A new contact in the last 30 days', test: (a) => a.leads30 > 0 },
  { id: 'live', label: 'Texting live', hint: 'Their number is approved to text', test: (a) => a.texting === 'live' },
  { id: 'pending', label: 'Texting pending', hint: 'They have a number, waiting on approval', test: (a) => a.texting === 'pending' },
  { id: 'none', label: 'No number', hint: 'No phone number yet', test: (a) => a.texting === 'none' },
]

/** A count, quiet when it's zero so the real numbers stand out. */
function Num({ n, children }: { n: number; children?: React.ReactNode }) {
  return <td className={cn('px-4 py-2 tabular-nums', n ? 'text-foreground/90' : 'text-muted-foreground/45')}>{children ?? n.toLocaleString('en-US')}</td>
}

const TEXTING: Record<Row['texting'], { label: string; dot: string }> = {
  live: { label: 'Live', dot: 'bg-success' },
  pending: { label: 'Pending', dot: 'bg-warning' },
  none: { label: 'No number', dot: 'bg-muted-foreground/40' },
}

/** GHL's Agency Dashboard as one quiet table: the totals in the header line, views as pills with their counts. */
export function AgencyDashboard() {
  const q = useAgency()
  const [view, setView] = useState<View>('all')
  const t = q.data?.totals
  const all = q.data?.accounts ?? []
  const rows = all.filter(VIEWS.find((v) => v.id === view)!.test)
  const summary = t
    ? [plural(t.accounts, 'sub-account'), plural(t.contacts, 'contact'), `${plural(t.leads30, 'new lead')} in 30 days`, plural(t.upcoming, 'upcoming appointment'), `${money(t.openValue)} open`, `${money(t.wonValue30)} won in 30 days`].join(' · ')
    : 'Every sub-account at a glance.'
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
      <PageHeader title="Agency Dashboard" description={summary} />
      {q.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                title={v.hint}
                onClick={() => setView(v.id)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] transition',
                  view === v.id ? 'border-primary bg-primary-soft text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {v.label}
                <span className="font-mono text-[11px] tabular-nums opacity-70">{all.filter(v.test).length}</span>
              </button>
            ))}
          </div>
          <Card>
            <Table head={['Sub-account', 'Contacts', 'Leads 7d', 'Leads 30d', 'Texts 7d', 'Upcoming', 'Open deals', 'Won 30d', 'Texting']}>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-border-soft text-[13px] last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    <Link href={`/genisys-os/${a.id}/dashboard`} className="font-medium text-foreground hover:underline">
                      {a.name}
                    </Link>
                    {a.home && <span className="ml-2 text-[11.5px] text-muted-foreground">Home</span>}
                  </td>
                  <Num n={a.contacts} />
                  <Num n={a.leads7} />
                  <Num n={a.leads30} />
                  <Num n={a.texts7} />
                  <Num n={a.upcoming} />
                  <Num n={a.openDeals}>
                    {a.openDeals}
                    {a.openValue > 0 && <span className="text-muted-foreground"> · {money(a.openValue)}</span>}
                  </Num>
                  <Num n={a.wonValue30}>{money(a.wonValue30)}</Num>
                  <td className="whitespace-nowrap px-4 py-2 text-foreground/85">
                    <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle', TEXTING[a.texting].dot)} />
                    {TEXTING[a.texting].label}
                  </td>
                </tr>
              ))}
            </Table>
            {!rows.length && <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No sub-accounts in this view.</p>}
          </Card>
        </>
      )}
      <ErrorNote error={q.error} />
    </div>
  )
}

/**
 * GHL's Account Snapshots: in Genisys OS, the kit every client sub-account
 * gets. Read from the kit itself (src/lib/hl/client-kit.ts), so it says what
 * new sub-accounts really get.
 */
export function AgencySnapshots() {
  const q = useAgency()
  const k = q.data?.kit
  const line = (label: string, body: React.ReactNode) => (
    <div key={label} className="grid grid-cols-[180px_1fr] gap-3 border-b border-border-soft px-5 py-3 text-[13px] last:border-0">
      <span className="eyebrow pt-0.5 text-muted-foreground">{label}</span>
      <div className="text-foreground/90">{body}</div>
    </div>
  )
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Account Snapshots" description="What every client sub-account starts with. GHL loads a snapshot; Genisys OS adds this kit and fills it from the client’s onboarding answers." />
      {!k ? (
        <div className="flex justify-center py-16">{q.error ? <ErrorNote error={q.error} /> : <Spinner />}</div>
      ) : (
        <Card>
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <p className="text-[15px] font-semibold text-foreground">Genisys Contractor Kit</p>
              <p className="text-[12.5px] text-muted-foreground">
                Version {k.version} · on {plural(k.accounts, 'sub-account')} · added to every new client sub-account
              </p>
            </div>
            <Badge color="green">Default</Badge>
          </div>
          {line(
            'Pipeline',
            <>
              {k.pipeline}: {k.stages.join(' → ')}
            </>,
          )}
          {line('Forms', k.forms.join(' · '))}
          {k.folders.map((f) =>
            line(
              f.name,
              <div className="flex flex-col gap-0.5">
                {f.workflows.map((w) => (
                  <span key={w.name} className={w.runs ? undefined : 'text-muted-foreground'}>
                    {w.name}
                    {!w.runs && <span className="text-[12px]"> · trigger off</span>}
                  </span>
                ))}
              </div>,
            ),
          )}
          {line('Where it came from', 'GoHighLevel’s client workflows (D&D Rustics’ sub-account, 2026-10-24), step for step. Every business detail is a merge field, filled from the sub-account’s Business Profile.')}
        </Card>
      )}
    </div>
  )
}
