'use client'

import { useSyncExternalStore } from 'react'
import { Globe } from '@/components/home/globe'
import { HomeSearch } from '@/components/home/home-search'

/**
 * Home — the Hub's landing canvas.
 *
 * A full-bleed black field: an interactive globe in the centre, a
 * search bar low on the page, and a mono HUD in the corners with the
 * date and the clock in local time and UTC. Deliberately sparse — this
 * screen is going to grow live functionality, and the layout leaves
 * that room rather than filling it now.
 */

function pad(n: number) {
  return String(n).padStart(2, '0')
}

// A once-a-second tick as an external store: the snapshot is the
// current second, so React re-renders exactly when the clock changes
// and never during hydration (the server snapshot is null).
function subscribeToSeconds(onChange: () => void) {
  const id = setInterval(onChange, 1000)
  return () => clearInterval(id)
}
const currentSecond = () => Math.floor(Date.now() / 1000)
const serverSecond = () => null

function useClock(): Date | null {
  const second = useSyncExternalStore(subscribeToSeconds, currentSecond, serverSecond)
  return second === null ? null : new Date(second * 1000)
}

export default function HomePage() {
  const now = useClock()

  const local = now
    ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    : '--:--:--'
  const utc = now
    ? `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
    : '--:--:--'
  const date = now
    ? now
        .toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: '2-digit',
          year: 'numeric',
        })
        .toUpperCase()
    : ''
  const tz = now
    ? Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ')
    : ''

  return (
    <div className="relative flex h-full min-h-[600px] flex-col overflow-hidden bg-background">
      {/* Faint grid so the black field reads as a surface, not a void. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(to right, oklch(1 0 0 / 3%) 1px, transparent 1px), linear-gradient(to bottom, oklch(1 0 0 / 3%) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage:
            'radial-gradient(ellipse 70% 70% at 50% 45%, black 20%, transparent 75%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 70% 70% at 50% 45%, black 20%, transparent 75%)',
        }}
      />

      {/* HUD */}
      <div className="eyebrow pointer-events-none relative z-10 flex items-start justify-between px-6 pt-6 text-muted-foreground lg:px-8">
        <div className="flex flex-col gap-1">
          <span className="text-foreground/85">
            Genisys <span className="text-muted-foreground/60">{'//'}</span> Hub
          </span>
          <span className="tabular-nums">{date}</span>
        </div>
        <div className="flex flex-col items-end gap-1 tabular-nums">
          <span>
            <span className="text-foreground/85">{local}</span>
            <span className="ml-2 text-muted-foreground/60">{tz}</span>
          </span>
          <span>
            {utc}
            <span className="ml-2 text-muted-foreground/60">UTC</span>
          </span>
        </div>
      </div>

      {/* Globe */}
      <div className="relative z-10 flex flex-1 items-center justify-center px-6">
        <Globe className="w-[min(66vh,620px)] max-w-full" />
      </div>

      {/* Search */}
      <div className="relative z-10 flex justify-center px-6 pb-[8vh]">
        <HomeSearch />
      </div>
    </div>
  )
}
