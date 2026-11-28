'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { contactLabel, SOURCE_LABEL } from '@/components/genisys-os/bits'
import { Avatar, Card, ErrorNote, PageHeader, Select, Spinner, Table, fmtDateTime, hlFetch, timeAgo } from '@/components/genisys-os/ui'
import { cn } from '@/lib/utils'

type Slim = { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null }
type Money = { count: number; value: number }
type Counts = { leads: number; forms: number; booked: number; reviewRequests: number }
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
  results: Counts & {
    previous: Counts
    textedBack: number
    texting: 'live' | 'pending' | 'none'
    search: { clicks: number; impressions: number; checkedAt: string } | null
  }
  pipeline: { id: string; name: string; stages: { id: string; name: string; count: number; value: number }[] } | null
  opportunities: { open: Money; won: Money; lost: Money; abandoned: Money }
  conversion: number | null
  sources: { source: string; leads: number; won: number; value: number }[]
  tasks: { id: string; title: string; dueDate: string | null; contact: Slim | null }[]
  appointments: { id: string; title: string; startTime: string; contact: Slim | null }[]
  recent: (Slim & { source: string | null; createdAt: string })[]
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`
const num = (n: number) => n.toLocaleString('en-US')

/** This period against the one before: "+3", "−2", or "same". */
function Change({ now, before }: { now: number; before: number }) {
  const d = now - before
  return <span className={cn('tabular-nums', d > 0 ? 'text-success' : 'text-muted-foreground')}>{d > 0 ? `+${num(d)}` : d < 0 ? `−${num(-d)}` : 'same'}</span>
}

/** One result: what it is, the number, and a quiet line under it. */
function Result({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-r border-border-soft px-3.5 py-3 sm:px-5 sm:py-4">
      <p className="eyebrow text-muted-foreground">{label}</p>
      <p className="text-[22px] font-semibold leading-none tabular-nums text-foreground sm:text-[24px]">{value}</p>
      <p className="min-h-[18px] text-[12px] text-muted-foreground">{note}</p>
    </div>
  )
}

/**
 * The sub-account's home: what Genisys OS did for the business (the results
 * the $297 pays for: leads caught, missed calls texted back, appointments,
 * review requests, Google search), then what needs a look today, then where
 * leads came from. Contractors land here when they sign in.
 */
export default function DashboardPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const [days, setDays] = useState(30)
  const q = useQuery<Stats>({ queryKey: ['hl', 'dashboard', accountId, days], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/dashboard?days=${days}`) })
  const s = q.data
  const base = `/genisys-os/${accountId}`
  const r = s?.results
  const vs = `vs the ${days} days before`

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <PageHeader
        title="Dashboard"
        description="What Genisys OS did for the business."
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
      ) : !s || !r ? (
        <ErrorNote error={q.error} />
      ) : (
        <>
          <Card className="overflow-hidden">
            {/* The grid's right and bottom hairlines are the cells'; the card's own edge hides the outer ones. */}
            <div className="-mb-px -mr-px grid grid-cols-2 lg:grid-cols-4">
              <Result label="New leads" value={num(r.leads)} note={<><Change now={r.leads} before={r.previous.leads} /> {vs}</>} />
              <Result label="Website form & chat" value={num(r.forms)} note={<><Change now={r.forms} before={r.previous.forms} /> {vs}</>} />
              <Result label="Calls answered" value={num(s.answered)} note={s.missed ? `${num(s.missed)} missed` : 'None missed'} />
              <Result
                label="Missed calls texted back"
                value={s.missed ? `${num(r.textedBack)} of ${num(s.missed)}` : '—'}
                note={
                  r.texting !== 'live' ? (
                    <span className="text-warning">{r.texting === 'pending' ? 'Texting isn’t approved yet' : 'No phone number yet'}</span>
                  ) : s.missed && r.textedBack >= s.missed ? (
                    'Every one got a text'
                  ) : s.missed ? (
                    'Some got no text'
                  ) : (
                    'No missed calls'
                  )
                }
              />
              <Result label="Texts sent" value={num(s.sent)} note={`${num(s.received)} ${s.received === 1 ? 'reply' : 'replies'} from leads${s.failed ? ` · ${num(s.failed)} failed` : ''}`} />
              <Result label="Appointments booked" value={num(r.booked)} note={<><Change now={r.booked} before={r.previous.booked} /> {vs}</>} />
              <Result label="Review requests sent" value={num(r.reviewRequests)} note={<><Change now={r.reviewRequests} before={r.previous.reviewRequests} /> {vs}</>} />
              <Result
                label="Seen on Google"
                value={r.search ? num(r.search.impressions) : '—'}
                note={
                  r.search
                    ? `${num(r.search.clicks)} ${r.search.clicks === 1 ? 'click' : 'clicks'} · last 28 days, as of ${new Date(r.search.checkedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                    : 'The website isn’t on Search Console yet'
                }
              />
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
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
                <p className="eyebrow text-muted-foreground">Latest leads</p>
                <Link href={`${base}/contacts`} className="font-mono text-[12px] text-primary hover:underline">
                  All
                </Link>
              </div>
              {s.recent.length ? (
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
              ) : (
                <p className="px-5 py-6 text-[13px] text-muted-foreground">No leads yet.</p>
              )}
            </Card>
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
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <p className="eyebrow border-b border-border px-5 py-3 text-muted-foreground">Where leads came from</p>
              {s.sources.length ? (
                <Table head={['Source', 'Leads', 'Won', 'Won value']}>
                  {s.sources.map((row) => (
                    <tr key={row.source} className="border-b border-border-soft last:border-0">
                      <td className="px-4 py-2.5 text-foreground">{SOURCE_LABEL[row.source] ?? row.source}</td>
                      <td className="px-4 py-2.5 tabular-nums">{row.leads}</td>
                      <td className="px-4 py-2.5 tabular-nums">{row.won}</td>
                      <td className="px-4 py-2.5 tabular-nums">{row.value ? money(row.value) : '—'}</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <p className="px-5 py-6 text-[13px] text-muted-foreground">No new leads in this range.</p>
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

          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="eyebrow text-muted-foreground">Pipeline · {s.pipeline?.name ?? 'Pipeline'}</p>
              <p className="text-[12.5px] text-muted-foreground">
                {num(s.opportunities.open.count)} open · {num(s.opportunities.won.count)} won · {num(s.opportunities.lost.count)} lost
                {s.opportunities.won.value > 0 && <> · {money(s.opportunities.won.value)} won</>}
                <Link href={`${base}/opportunities`} className="ml-3 font-mono text-[12px] text-primary hover:underline">
                  Open
                </Link>
              </p>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {(s.pipeline?.stages ?? []).map((st) => {
                const top = Math.max(1, ...(s.pipeline?.stages ?? []).map((x) => x.count))
                return (
                  <div key={st.id} className="grid grid-cols-[96px_1fr_auto] items-center gap-2 text-[13px] sm:grid-cols-[150px_1fr_110px] sm:gap-3">
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
        </>
      )}
    </div>
  )
}
