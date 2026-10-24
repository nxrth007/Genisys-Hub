'use client'

import { useState } from 'react'
import type { MenuService, PublicMenu } from '@/lib/hl/service-menus'
import { BookingWidget } from './booking-widget'

const lengths = (ms: number[]) => ms.map((m) => (m >= 60 && m % 60 === 0 ? `${m / 60} hr` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`)).join(' / ')

/** A service menu's page: its services by group, then the picked one's booking form (and who, when allowed). */
export function ServiceMenuBooking({ menu, pageUrl }: { menu: PublicMenu; pageUrl: string | null }) {
  const [picked, setPicked] = useState<MenuService | null>(null)
  const groups = [...new Set(menu.services.map((s) => s.group))]

  if (picked) {
    const c = picked.calendar
    return (
      <div className="grid w-full gap-6 md:grid-cols-[260px_minmax(0,1fr)]" style={{ ['--hl-c' as string]: c.color }}>
        <aside className="flex flex-col gap-2 border-b border-[#EAECF0] pb-4 md:border-b-0 md:border-r md:pb-0 md:pr-6">
          <button type="button" onClick={() => setPicked(null)} className="self-start text-[13px] font-medium text-[var(--hl-c)] underline">
            ← All services
          </button>
          <p className="text-[13px] font-medium text-[#667085]">{menu.business}</p>
          <h1 className="text-[22px] font-semibold leading-tight text-[#101828]">{c.name}</h1>
          <p className="text-[14px] text-[#475467]">{lengths(c.durations)}</p>
          {c.location && <p className="text-[14px] text-[#475467]">{c.location}</p>}
          {c.description && <p className="whitespace-pre-line text-[13.5px] leading-relaxed text-[#667085]">{c.description}</p>}
        </aside>
        <section>
          <BookingWidget key={c.id} calendar={c} pageUrl={pageUrl} team={picked.team} />
          <p className="mt-5 text-center text-[11px] text-[#98A2B3]">
            <a href={c.legal.privacy} target="_blank" rel="noreferrer" className="underline">
              Privacy policy
            </a>
            {' · '}
            <a href={c.legal.terms} target="_blank" rel="noreferrer" className="underline">
              Texting terms
            </a>
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-6" style={{ ['--hl-c' as string]: menu.color }}>
      <div>
        <p className="text-[13px] font-medium text-[#667085]">{menu.business}</p>
        <h1 className="text-[24px] font-semibold leading-tight text-[#101828]">{menu.name}</h1>
        {menu.description && <p className="mt-1 whitespace-pre-line text-[14px] leading-relaxed text-[#667085]">{menu.description}</p>}
      </div>
      {!menu.services.length && <p className="text-[14px] text-[#667085]">Nothing to book here right now.</p>}
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-2">
          {groups.length > 1 && <p className="text-[13px] font-semibold uppercase tracking-wide text-[#98A2B3]">{g}</p>}
          {menu.services
            .filter((s) => s.group === g)
            .map((s) => (
              <button
                key={s.calendar.id}
                type="button"
                onClick={() => setPicked(s)}
                className="flex items-center gap-4 rounded-xl border border-[#EAECF0] px-4 py-3.5 text-left transition hover:border-[var(--hl-c)] hover:bg-[#F9FAFB]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-[#101828]">{s.calendar.name}</span>
                  <span className="block text-[13px] text-[#667085]">{lengths(s.calendar.durations)}</span>
                  {s.calendar.description && <span className="mt-0.5 line-clamp-2 block text-[13px] text-[#667085]">{s.calendar.description}</span>}
                </span>
                <span className="shrink-0 rounded-lg bg-[var(--hl-c)] px-3.5 py-2 text-[13px] font-semibold text-white">Book</span>
              </button>
            ))}
        </div>
      ))}
    </div>
  )
}
