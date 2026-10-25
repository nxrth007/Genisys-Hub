'use client'

import { useState } from 'react'
import type { MenuService, PublicMenu } from '@/lib/hl/service-menus'
import { lengthText } from './booking-frame'
import { BookingWidget } from './booking-widget'

const lengths = (ms: number[]) => ms.map(lengthText).join(' / ')

/** A service menu's page inside BookingFrame: its services by group, then the picked one's booking (and who, when allowed). */
export function ServiceMenuBooking({ menu, pageUrl }: { menu: PublicMenu; pageUrl: string | null }) {
  const [picked, setPicked] = useState<MenuService | null>(null)
  const groups = [...new Set(menu.services.map((s) => s.group))]

  if (picked) {
    const c = picked.calendar
    return (
      <div className="hl-in flex flex-col gap-5" style={{ ['--hl-c' as string]: c.color }}>
        <div className="flex items-start gap-3 border-b border-[#F2F4F7] pb-5">
          <button type="button" onClick={() => setPicked(null)} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[#475467] transition hover:bg-[#F2F4F7]" aria-label="All services">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[18px] font-semibold tracking-[-0.01em] text-[#101828]">{c.name}</p>
            <p className="text-[13.5px] text-[#667085]">{[lengths(c.durations), c.location].filter(Boolean).join(' · ')}</p>
            {c.description && <p className="mt-1 whitespace-pre-line text-[13.5px] leading-relaxed text-[#475467]">{c.description}</p>}
          </div>
        </div>
        <BookingWidget key={c.id} calendar={c} pageUrl={pageUrl} team={picked.team} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {!menu.services.length && <p className="py-6 text-center text-[14px] text-[#667085]">Nothing to book here right now.</p>}
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-3">
          <p className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[#98A2B3]">{groups.length > 1 ? g : 'Pick a service'}</p>
          {menu.services
            .filter((s) => s.group === g)
            .map((s) => (
              <button
                key={s.calendar.id}
                type="button"
                onClick={() => setPicked(s)}
                className="group flex items-center gap-4 rounded-2xl border border-[#EAECF0] bg-white px-5 py-4 text-left transition hover:border-[var(--hl-c)] hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,.18)]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[15.5px] font-semibold text-[#101828]">{s.calendar.name}</span>
                  <span className="block text-[13px] text-[#667085]">{lengths(s.calendar.durations)}</span>
                  {s.calendar.description && <span className="mt-1 line-clamp-2 block text-[13.5px] text-[#475467]">{s.calendar.description}</span>}
                </span>
                <span className="shrink-0 rounded-xl bg-[color-mix(in_srgb,var(--hl-c)_10%,white)] px-3.5 py-2 text-[13px] font-semibold text-[color-mix(in_srgb,var(--hl-c)_58%,black)] transition group-hover:bg-[var(--hl-c)] group-hover:text-[var(--hl-ink)]">Book</span>
              </button>
            ))}
        </div>
      ))}
    </div>
  )
}
