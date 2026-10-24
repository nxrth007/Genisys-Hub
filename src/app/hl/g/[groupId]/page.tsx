import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { publicCalendar, type PublicCalendar } from '@/lib/hl/booking'
import { listGroups } from '@/lib/hl/calendar-records'
import { asCalendarSettings } from '@/lib/hl/calendar-shared'
import { FrameHeight } from '@/components/hell-level/frame-height'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ groupId: string }> }

async function load(groupId: string) {
  const row = await prisma.hlRecord.findFirst({ where: { id: groupId, kind: 'calendar_group' }, select: { accountId: true } })
  if (!row) return null
  const group = (await listGroups(row.accountId)).find((g) => g.id === groupId)
  if (!group?.isActive) return null
  const rows = await prisma.hlCalendar.findMany({ where: { accountId: row.accountId, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, settings: true } })
  const calendars = (await Promise.all(rows.filter((c) => asCalendarSettings(c.settings).groupId === group.key).map((c) => publicCalendar(c.id)))).filter((c): c is PublicCalendar => !!c)
  return { group, calendars }
}

export async function generateMetadata({ params }: Props) {
  const data = await load((await params).groupId)
  return { title: data ? `${data.group.name}${data.calendars[0] ? ` | ${data.calendars[0].business}` : ''}` : 'Book a time', robots: { index: false } }
}

const length = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`)

/** A calendar group's page (GHL's group widget): its active calendars, each opening its own booking page. */
export default async function GroupPage({ params }: Props) {
  const data = await load((await params).groupId)
  if (!data) notFound()
  const { group, calendars } = data
  return (
    <div className="min-h-screen bg-white text-[#101828]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-8">
        <div>
          {calendars[0] && <p className="text-[13px] font-medium text-[#667085]">{calendars[0].business}</p>}
          <h1 className="text-[24px] font-semibold leading-tight">{group.name}</h1>
          {group.description && <p className="mt-1 whitespace-pre-line text-[14px] text-[#475467]">{group.description}</p>}
        </div>
        {calendars.length ? (
          <div className="flex flex-col gap-3">
            {calendars.map((c) => (
              <a key={c.id} href={`/hl/b/${c.id}`} className="group flex items-start gap-4 rounded-xl border border-[#EAECF0] px-5 py-4 transition hover:border-[var(--c)] hover:shadow-sm" style={{ ['--c' as string]: c.color }}>
                <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ background: c.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-semibold text-[#101828]">{c.name}</span>
                  <span className="block text-[13px] text-[#667085]">{c.durations.map(length).join(' / ')}</span>
                  {c.description && <span className="mt-1 line-clamp-2 block text-[13.5px] text-[#475467]">{c.description}</span>}
                </span>
                <span className="self-center text-[14px] font-semibold text-[var(--c)]">Book →</span>
              </a>
            ))}
          </div>
        ) : (
          <p className="text-[14px] text-[#667085]">Nothing to book here right now.</p>
        )}
      </main>
      <FrameHeight formId={group.id} />
    </div>
  )
}
