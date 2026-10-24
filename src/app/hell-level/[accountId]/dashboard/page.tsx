'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, MessageCircle, PhoneMissed, Send, UserPlus } from 'lucide-react'
import { contactLabel, SOURCE_LABEL } from '@/components/hell-level/bits'
import { Avatar, Card, ErrorNote, PageHeader, Select, Spinner, hlFetch, timeAgo } from '@/components/hell-level/ui'

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
  won: number
  open: number
  recent: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null; source: string | null; createdAt: string }[]
}

export default function DashboardPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const [days, setDays] = useState(30)
  const q = useQuery<Stats>({ queryKey: ['hl', 'dashboard', accountId, days], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/dashboard?days=${days}`) })
  const s = q.data
  const max = Math.max(1, ...(s?.daily ?? [0]))
  const money = (n: number) => `$${n.toLocaleString('en-US')}`

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-7">
      <PageHeader
        title="Dashboard"
        description="Leads, calls and texts for this sub-account."
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
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat icon={<UserPlus className="h-5 w-5" />} tint="#EFF4FF" color="#155EEF" label="New contacts" value={s.contacts} />
            <Stat icon={<FileText className="h-5 w-5" />} tint="#F4F3FF" color="#6938EF" label="Form & chat submissions" value={s.forms} />
            <Stat icon={<PhoneMissed className="h-5 w-5" />} tint="#FEF3F2" color="#D92D20" label="Missed calls" value={s.missed} sub={`${s.answered} answered`} />
            <Stat icon={<Send className="h-5 w-5" />} tint="#ECFDF3" color="#079455" label="Texts sent" value={s.sent} sub={`${s.received} received${s.failed ? ` · ${s.failed} failed` : ''}`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <p className="text-[15px] font-semibold text-[#101828]">New leads per day</p>
              <div className="mt-5 flex h-40 items-end gap-[3px]">
                {s.daily.map((n, i) => (
                  <div key={i} className="group relative flex-1">
                    <div className="w-full rounded-t bg-[#155EEF]/85 transition group-hover:bg-[#155EEF]" style={{ height: `${Math.max(n ? 6 : 2, (n / max) * 160)}px`, opacity: n ? 1 : 0.25 }} />
                    <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-[#101828] px-1.5 py-0.5 text-[11px] text-white group-hover:block">
                      {n} · {new Date(new Date(s.since).getTime() + i * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[12px] text-[#98A2B3]">
                <span>{s.days} days ago</span>
                <span>Today</span>
              </div>
            </Card>
            <Card className="p-5">
              <div className="flex items-baseline justify-between">
                <p className="text-[15px] font-semibold text-[#101828]">{s.pipeline?.name ?? 'Pipeline'}</p>
                <Link href={`/hell-level/${accountId}/opportunities`} className="text-[13px] font-semibold text-[#155EEF] hover:underline">
                  Open
                </Link>
              </div>
              <p className="mt-1 text-[13px] text-[#667085]">
                {s.open} open · {money(s.won)} won
              </p>
              <div className="mt-4 flex flex-col gap-3">
                {(s.pipeline?.stages ?? []).map((st) => {
                  const total = Math.max(1, ...(s.pipeline?.stages ?? []).map((x) => x.count))
                  return (
                    <div key={st.id}>
                      <div className="flex justify-between text-[13px]">
                        <span className="text-[#344054]">{st.name}</span>
                        <span className="tabular-nums text-[#667085]">
                          {st.count}
                          {st.value ? ` · ${money(st.value)}` : ''}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#F2F4F7]">
                        <div className="h-full rounded-full bg-[#2E90FA]" style={{ width: `${(st.count / total) * 100}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>
          </div>

          <Card>
            <div className="flex items-center justify-between border-b border-[#EAECF0] px-5 py-4">
              <p className="text-[15px] font-semibold text-[#101828]">Latest contacts</p>
              <Link href={`/hell-level/${accountId}/contacts`} className="text-[13px] font-semibold text-[#155EEF] hover:underline">
                All contacts
              </Link>
            </div>
            {s.recent.length ? (
              <ul>
                {s.recent.map((c) => (
                  <li key={c.id} className="border-b border-[#EAECF0] last:border-0">
                    <Link href={`/hell-level/${accountId}/conversations?contact=${c.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-[#F9FAFB]">
                      <Avatar name={contactLabel(c)} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-[#101828]">{contactLabel(c)}</span>
                        <span className="block truncate text-[12px] text-[#667085]">{SOURCE_LABEL[c.source ?? ''] ?? c.source ?? '—'}</span>
                      </span>
                      <span className="text-[12px] text-[#98A2B3]">{timeAgo(c.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-5 py-6 text-[14px] text-[#667085]">
                <MessageCircle className="h-4 w-4" /> No contacts yet. They show up here as soon as the website form, chat widget or phone number gets used.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

function Stat({ icon, tint, color, label, value, sub }: { icon: React.ReactNode; tint: string; color: string; label: string; value: number; sub?: string }) {
  return (
    <Card className="p-5">
      <span className="grid h-10 w-10 place-items-center rounded-lg" style={{ background: tint, color }}>
        {icon}
      </span>
      <p className="mt-4 text-[13px] font-medium text-[#475467]">{label}</p>
      <p className="mt-1 text-[28px] font-semibold tabular-nums tracking-tight text-[#101828]">{value.toLocaleString('en-US')}</p>
      {sub && <p className="text-[12px] text-[#667085]">{sub}</p>}
    </Card>
  )
}
