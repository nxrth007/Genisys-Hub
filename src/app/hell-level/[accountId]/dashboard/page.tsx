'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { contactLabel, SOURCE_LABEL } from '@/components/hell-level/bits'
import { Avatar, Card, ErrorNote, PageHeader, Select, Spinner, Table, fmtDateTime, hlFetch, timeAgo } from '@/components/hell-level/ui'

type Slim = { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null }
type Money = { count: number; value: number }
type Stats = {
  days: number
  since: string
  contacts: number
  forms: number
  missed: number
  answered: number
  sent: number
  received: number
  failed: number
  daily: number[]
  pipeline: { id: string; name: string; stages: { id: string; name: string; count: number; value: number }[] } | null
  opportunities: { open: Money; won: Money; lost: Money; abandoned: Money }
  conversion: number | null
  sources: { source: string; leads: number; won: number; value: number }[]
  tasks: { id: string; title: string; dueDate: string | null; contact: Slim | null }[]
  appointments: { id: string; title: string; startTime: string; contact: Slim | null }[]
  recent: (Slim & { source: string | null; createdAt: string })[]
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`

/** GHL's sub-account Dashboard widgets, over the chosen range. */
export default function DashboardPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const [days, setDays] = useState(30)
  const q = useQuery<Stats>({ queryKey: ['hl', 'dashboard', accountId, days], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/dashboard?days=${days}`) })
  const s = q.data
  const base = `/hell-level/${accountId}`

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
      <PageHeader
        title="Dashboard"
        actions={
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
        }
      />
      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : !s ? (
        <ErrorNote error={q.error} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <p className="eyebrow text-muted-foreground">Opportunity Status</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {(
                  [
                    ['Open', s.opportunities.open.count, 'bg-primary'],
                    ['Won', s.opportunities.won.count, 'bg-success'],
                    ['Lost', s.opportunities.lost.count, 'bg-destructive'],
                    ['Abandoned', s.opportunities.abandoned.count, 'bg-muted-foreground'],
                  ] as const
                ).map(([k, n, dot]) => (
                  <div key={k}>
                    <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} /> {k}
                    </p>
                    <p className="text-[24px] font-semibold tabular-nums text-foreground">{n}</p>
                  </div>
                ))}
              </div>
            </Card>
            <Card className="p-5">
              <p className="eyebrow text-muted-foreground">Opportunity Value</p>
              <p className="mt-4 text-[30px] font-semibold tabular-nums text-foreground">{money(s.opportunities.open.value + s.opportunities.won.value)}</p>
              <div className="mt-3 flex gap-6 text-[12.5px] text-muted-foreground">
                <span>
                  Open <span className="tabular-nums text-foreground">{money(s.opportunities.open.value)}</span>
                </span>
                <span>
                  Won <span className="tabular-nums text-success">{money(s.opportunities.won.value)}</span>
                </span>
              </div>
            </Card>
            <Card className="p-5">
              <p className="eyebrow text-muted-foreground">Conversion Rate</p>
              <p className="mt-4 text-[30px] font-semibold tabular-nums text-foreground">{s.conversion === null ? '—' : `${s.conversion}%`}</p>
              <p className="mt-3 text-[12.5px] text-muted-foreground">Won out of won + lost, opportunities created in range.</p>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <div className="flex items-baseline justify-between">
                <p className="eyebrow text-muted-foreground">Funnel · {s.pipeline?.name ?? 'Pipeline'}</p>
                <Link href={`${base}/opportunities`} className="font-mono text-[12px] text-primary hover:underline">
                  Open
                </Link>
              </div>
              <div className="mt-4 flex flex-col gap-2">
                {(s.pipeline?.stages ?? []).map((st) => {
                  const top = Math.max(1, ...(s.pipeline?.stages ?? []).map((x) => x.count))
                  return (
                    <div key={st.id} className="grid grid-cols-[150px_1fr_110px] items-center gap-3 text-[13px]">
                      <span className="truncate text-foreground/90">{st.name}</span>
                      <div className="h-6 rounded bg-muted">
                        <div className="flex h-full items-center rounded bg-primary/70 px-2 font-mono text-[11px] text-primary-foreground" style={{ width: `${Math.max(st.count ? 6 : 0, (st.count / top) * 100)}%` }}>
                          {st.count || ''}
                        </div>
                      </div>
                      <span className="text-right tabular-nums text-muted-foreground">{st.value ? money(st.value) : ''}</span>
                    </div>
                  )
                })}
                {!s.pipeline?.stages.length && <p className="text-[13px] text-muted-foreground">No pipeline yet.</p>}
              </div>
            </Card>
            <Card className="p-5">
              <p className="eyebrow text-muted-foreground">Activity</p>
              <dl className="mt-4 grid grid-cols-2 gap-y-3 text-[13px]">
                {(
                  [
                    ['New contacts', s.contacts],
                    ['Form & chat leads', s.forms],
                    ['Calls answered', s.answered],
                    ['Calls missed', s.missed],
                    ['Texts sent', s.sent],
                    ['Texts received', s.received],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-[20px] font-semibold tabular-nums text-foreground">{v.toLocaleString('en-US')}</dd>
                  </div>
                ))}
              </dl>
              {s.failed > 0 && <p className="mt-3 text-[12px] text-destructive">{s.failed} text(s) failed to deliver</p>}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <p className="eyebrow border-b border-border px-5 py-3 text-muted-foreground">Lead Source Report</p>
              {s.sources.length ? (
                <Table head={['Source', 'Leads', 'Won', 'Won value']}>
                  {s.sources.map((r) => (
                    <tr key={r.source} className="border-b border-border-soft last:border-0">
                      <td className="px-4 py-2.5 text-foreground">{SOURCE_LABEL[r.source] ?? r.source}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.leads}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.won}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.value ? money(r.value) : '—'}</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <p className="px-5 py-6 text-[13px] text-muted-foreground">No new contacts in this range.</p>
              )}
            </Card>
            <Card className="p-5">
              <p className="eyebrow text-muted-foreground">New leads per day</p>
              <div className="mt-4 flex h-28 items-end gap-[2px]">
                {s.daily.map((n, i) => {
                  const max = Math.max(1, ...s.daily)
                  return (
                    <div key={i} className="group relative flex-1">
                      <div className="w-full rounded-t bg-primary/80 group-hover:bg-primary" style={{ height: `${Math.max(n ? 5 : 2, (n / max) * 112)}px`, opacity: n ? 1 : 0.3 }} />
                      <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-1.5 py-0.5 text-[11px] text-foreground group-hover:block">
                        {n} · {new Date(new Date(s.since).getTime() + i * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  )
                })}
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
                <p className="eyebrow text-muted-foreground">Tasks</p>
                <Link href={`${base}/contacts?tab=tasks`} className="font-mono text-[12px] text-primary hover:underline">
                  All
                </Link>
              </div>
              {s.tasks.length ? (
                <ul>
                  {s.tasks.map((t) => (
                    <li key={t.id} className="border-b border-border-soft px-5 py-2.5 text-[13px] last:border-0">
                      <p className="text-foreground">{t.title}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {t.contact ? contactLabel(t.contact) : 'No contact'} {t.dueDate ? `· due ${fmtDateTime(t.dueDate)}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-6 text-[13px] text-muted-foreground">No pending tasks.</p>
              )}
            </Card>
            <Card>
              <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
                <p className="eyebrow text-muted-foreground">Upcoming appointments</p>
                <Link href={`${base}/calendars?tab=appointments`} className="font-mono text-[12px] text-primary hover:underline">
                  All
                </Link>
              </div>
              {s.appointments.length ? (
                <ul>
                  {s.appointments.map((a) => (
                    <li key={a.id} className="border-b border-border-soft px-5 py-2.5 text-[13px] last:border-0">
                      <p className="text-foreground">{a.contact ? contactLabel(a.contact) : a.title}</p>
                      <p className="text-[12px] text-muted-foreground">{fmtDateTime(a.startTime)}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-6 text-[13px] text-muted-foreground">Nothing booked.</p>
              )}
            </Card>
            <Card>
              <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
                <p className="eyebrow text-muted-foreground">Latest contacts</p>
                <Link href={`${base}/contacts`} className="font-mono text-[12px] text-primary hover:underline">
                  All
                </Link>
              </div>
              <ul>
                {s.recent.map((c) => (
                  <li key={c.id} className="border-b border-border-soft last:border-0">
                    <Link href={`${base}/conversations?contact=${c.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-muted/40">
                      <Avatar name={contactLabel(c)} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-foreground">{contactLabel(c)}</span>
                        <span className="block truncate text-[11.5px] text-muted-foreground">{SOURCE_LABEL[c.source ?? ''] ?? c.source ?? '—'}</span>
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(c.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
