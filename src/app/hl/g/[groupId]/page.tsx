import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { publicCalendar, type PublicCalendar } from '@/lib/hl/booking'
import { listGroups } from '@/lib/hl/calendar-records'
import { readProfile } from '@/lib/hl/accounts'
import { asCalendarSettings } from '@/lib/hl/calendar-shared'
import { BookingFrame, lengthText } from '@/components/hell-level/booking-frame'
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
  const account = await prisma.hlAccount.findUnique({ where: { id: row.accountId }, select: { name: true, profile: true } })
  const profile = readProfile(account?.profile)
  const brand = {
    business: profile.businessName || account?.name || '',
    color: calendars[0]?.color ?? (profile.brandColor && /^#[0-9a-f]{6}$/i.test(profile.brandColor) ? profile.brandColor : '#155EEF'),
    logo: /^https?:\/\//i.test(profile.logoUrl ?? '') ? profile.logoUrl! : null,
  }
  return { group, calendars, brand }
}

export async function generateMetadata({ params }: Props) {
  const data = await load((await params).groupId)
  return { title: data ? `${data.group.name}${data.calendars[0] ? ` | ${data.calendars[0].business}` : ''}` : 'Book a time', robots: { index: false } }
}

/** A calendar group's page (GHL's group widget): its active calendars, each opening its own booking page. */
export default async function GroupPage({ params }: Props) {
  const data = await load((await params).groupId)
  if (!data) notFound()
  const { group, calendars, brand } = data
  return (
    <>
      <BookingFrame color={brand.color} business={brand.business} logo={brand.logo} title={group.name} description={group.description} legal={calendars[0]?.legal ?? null}>
        {calendars.length ? (
          <div className="flex flex-col gap-3">
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[#98A2B3]">Pick what you’d like to book</p>
            {calendars.map((c) => (
              <a
                key={c.id}
                href={`/hl/b/${c.id}`}
                className="group flex items-center gap-4 rounded-2xl border border-[#EAECF0] bg-white px-5 py-4 transition hover:border-[var(--hl-c)] hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,.18)]"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--hl-c)_10%,white)] text-[var(--hl-c)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="4" width="18" height="17" rx="3" />
                    <path d="M16 2v4M8 2v4M3 10h18" />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15.5px] font-semibold text-[#101828]">{c.name}</span>
                  <span className="block text-[13px] text-[#667085]">{[c.durations.map(lengthText).join(' / '), c.location].filter(Boolean).join(' · ')}</span>
                  {c.description && <span className="mt-1 line-clamp-2 block text-[13.5px] text-[#475467]">{c.description}</span>}
                </span>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--hl-c)] transition group-hover:translate-x-0.5 group-hover:bg-[color-mix(in_srgb,var(--hl-c)_10%,white)]">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="py-6 text-center text-[14px] text-[#667085]">Nothing to book here right now.</p>
        )}
      </BookingFrame>
      <FrameHeight formId={group.id} />
    </>
  )
}
