'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Globe as GlobeIcon } from 'lucide-react'
import { Globe, type GlobeHandle, type GlobeMarker } from '@/components/home/globe'
import { HomeSearch } from '@/components/home/home-search'
import { WelcomeType } from '@/components/home/welcome-type'
import { Chip } from '@/components/ui/chip'
import { LAUNCH_WINDOW_DAYS, type GlobeClientMarker, type GlobeData } from '@/lib/home-globe'

/**
 * Home — the Hub's landing canvas.
 *
 * A full-bleed black field with the client constellation on an
 * interactive globe: every onboarded client is a point where they are;
 * hover for who they are, click to bring them to the centre (clients who
 * share a spot open together). When a client's site goes live an arc
 * fires from HQ to them; recent launches pulse; a slow round-robin of
 * arcs keeps the globe breathing. A mono HUD carries the date, clock and
 * a readout of what's on the map; the search bar shares the ⌘K index.
 */

const ARC_EVERY_MS = 9_000
const LAUNCH_STAGGER_MS = 1_400
const LAUNCH_FOCUS_MS = 700
const HOUR_MS = 3_600_000
const PENDING_POLL_MS = 4_000
const IDLE_POLL_MS = 60_000
const CLUSTER_ROWS = 5

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

// Time is passed in rather than read here: these run during render,
// and render must stay pure. `nowMs` comes from the clock store.
function daysAgo(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 86400_000))
}

function isRecentLaunch(m: GlobeClientMarker, nowMs: number): boolean {
  return !!m.siteLiveAt && daysAgo(m.siteLiveAt, nowMs) <= LAUNCH_WINDOW_DAYS
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

const sameIds = (a: string[] | null, b: string[] | null) =>
  (a ? a.join('|') : '') === (b ? b.join('|') : '')

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  onboarding: 'Onboarding',
  paused: 'Paused',
  churned: 'Churned',
  pending: 'Pending',
}

export default function HomePage() {
  const now = useClock()
  const globeRef = useRef<GlobeHandle>(null)
  // A hover or pin is the set of markers under the pointer, nearest first.
  const [hovered, setHovered] = useState<string[] | null>(null)
  const [pinned, setPinned] = useState<string[] | null>(null)
  // What the card last showed, so it can fade out with its content.
  const [lastShown, setLastShown] = useState<string[] | null>(null)

  const data = useQuery<GlobeData>({
    queryKey: ['home-globe'],
    queryFn: async () => {
      const res = await fetch('/api/home/globe')
      if (!res.ok) throw new Error('Failed to load the globe')
      return res.json()
    },
    staleTime: 30_000,
    // Poll briskly while clients are still being placed, then settle.
    refetchInterval: (q) =>
      q.state.data?.unplaced.some((u) => u.reason === 'pending') ? PENDING_POLL_MS : IDLE_POLL_MS,
  })
  const clients = useMemo(() => data.data?.markers ?? [], [data.data])
  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  const hq = data.data?.hq ?? null
  const origin = useMemo<[number, number] | null>(() => (hq ? [hq.lat, hq.lng] : null), [hq])

  // Launch recency changes by the day, so the clock is read at hour
  // resolution here — the markers don't rebuild every second.
  const hourKey = now ? Math.floor(now.getTime() / HOUR_MS) : null
  const refMs = hourKey === null ? null : hourKey * HOUR_MS
  const markers = useMemo<GlobeMarker[]>(
    () =>
      clients.map((c) => ({
        id: c.id,
        location: [c.lat, c.lng],
        size: c.siteUrl ? 0.05 : 0.038,
        pulse: refMs !== null && isRecentLaunch(c, refMs),
      })),
    [clients, refMs],
  )

  // The timers below read these rather than closing over them, so a
  // data refresh never restarts the heartbeat or cancels a launch arc.
  const clientsRef = useRef(clients)
  const busyRef = useRef(false)
  useEffect(() => {
    clientsRef.current = clients
    busyRef.current = hovered !== null || pinned !== null
  })

  // Launch arcs. The first load replays the last two weeks of launches,
  // oldest first. After that only a site that has *just* gone live (or a
  // recent launch that has just been placed on the map) fires — and the
  // globe turns to it first, unless someone is reading a card.
  const seenLaunch = useRef<Map<string, string | null> | null>(null)
  const launchTimers = useRef<number[]>([])
  useEffect(() => {
    if (!origin || clients.length === 0) return
    const timers = launchTimers.current
    const fire = (c: GlobeClientMarker) => globeRef.current?.fireArc(origin, [c.lat, c.lng])
    const nowMs = Date.now()
    const seen = seenLaunch.current

    if (!seen) {
      let t = 1200
      clients
        .filter((c) => isRecentLaunch(c, nowMs))
        .sort((a, b) => (a.siteLiveAt ?? '').localeCompare(b.siteLiveAt ?? ''))
        .forEach((c) => {
          timers.push(window.setTimeout(() => fire(c), t))
          t += LAUNCH_STAGGER_MS
        })
      seenLaunch.current = new Map(clients.map((c) => [c.id, c.siteLiveAt]))
      return
    }

    const fresh = clients.filter(
      (c) => c.siteLiveAt && seen.get(c.id) !== c.siteLiveAt && isRecentLaunch(c, nowMs),
    )
    for (const c of clients) seen.set(c.id, c.siteLiveAt)
    fresh.forEach((c, i) => {
      timers.push(
        window.setTimeout(() => {
          if (!busyRef.current) globeRef.current?.focus(c.lat, c.lng)
          timers.push(window.setTimeout(() => fire(c), LAUNCH_FOCUS_MS))
        }, i * (LAUNCH_STAGGER_MS + LAUNCH_FOCUS_MS)),
      )
    })
  }, [origin, clients])

  // Launch timers are cancelled only when the page goes away.
  useEffect(() => {
    const timers = launchTimers.current
    return () => timers.forEach((id) => clearTimeout(id))
  }, [])

  // Heartbeat: a slow round-robin of arcs from HQ. Skipped entirely for
  // reduced motion — launches still show, ambience doesn't.
  useEffect(() => {
    if (!origin) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let i = 0
    const id = window.setInterval(() => {
      const list = clientsRef.current
      if (list.length === 0) return
      const c = list[i % list.length]
      i += 1
      globeRef.current?.fireArc(origin, [c.lat, c.lng])
    }, ARC_EVERY_MS)
    return () => clearInterval(id)
  }, [origin])

  // Esc clears a pinned card.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPinned(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shown = pinned ?? hovered
  const activeId = shown?.[0] ?? null
  const cardIds = shown ?? lastShown
  const cardMembers = useMemo(
    () => (cardIds ?? []).map((id) => byId.get(id)).filter((c): c is GlobeClientMarker => Boolean(c)),
    [cardIds, byId],
  )

  const local = now
    ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    : '--:--:--'
  const utc = now
    ? `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
    : '--:--:--'
  const date = now
    ? now
        .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' })
        .toUpperCase()
    : ''
  const tz = now ? Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ') : ''

  const launches = refMs === null ? 0 : clients.filter((c) => isRecentLaunch(c, refMs)).length
  const unplaced = data.data?.unplaced ?? []
  const placing = unplaced.filter((u) => u.reason === 'pending').length
  const notPlaced = unplaced.length - placing

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
          maskImage: 'radial-gradient(ellipse 70% 70% at 50% 45%, black 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 70% at 50% 45%, black 20%, transparent 75%)',
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

      {/* Welcome — pinned left of the globe on wide screens, above it otherwise */}
      <div className="pointer-events-none relative z-10 px-6 pt-8 lg:absolute lg:left-10 lg:top-1/2 lg:-translate-y-1/2 lg:px-0 lg:pt-0 xl:left-16">
        <WelcomeType />
      </div>

      {/* Constellation readout — under the clock on small screens, bottom right on wide ones */}
      <div className="eyebrow pointer-events-none absolute right-6 top-20 z-10 flex flex-col items-end gap-1 text-muted-foreground lg:bottom-6 lg:right-8 lg:top-auto">
        {data.isLoading ? (
          <span>loading constellation…</span>
        ) : data.isError ? (
          <span className="text-destructive/80">globe data unavailable</span>
        ) : (
          <>
            <span>
              <span className="tabular-nums text-foreground/85">{clients.length}</span> client
              {clients.length === 1 ? '' : 's'} on map
            </span>
            <span>
              <span className="tabular-nums text-foreground/85">{launches}</span> launch
              {launches === 1 ? '' : 'es'} · {LAUNCH_WINDOW_DAYS}d
            </span>
            {placing > 0 && <span className="text-foreground/70">placing {placing}…</span>}
            {notPlaced > 0 && (
              <Link
                href="/clients"
                className="pointer-events-auto text-muted-foreground/60 transition hover:text-foreground"
                title="These clients have no address or city the map can find — add one on the Clients page."
              >
                {notPlaced} not placed
              </Link>
            )}
          </>
        )}
      </div>

      {/* Globe */}
      <div className="relative z-10 flex flex-1 items-center justify-center px-6">
        <Globe
          ref={globeRef}
          className="w-[min(66vh,620px)] max-w-full"
          markers={markers}
          origin={origin}
          activeId={activeId}
          hold={pinned !== null}
          onHoverChange={(ids) => {
            setHovered(ids)
            if (ids) setLastShown(ids)
          }}
          onSelect={(ids) => {
            // Empty globe clears the pin; a marker toggles it and eases
            // that spot to the centre.
            const first = ids ? byId.get(ids[0]) : null
            if (!ids || !first) {
              setPinned(null)
              return
            }
            setPinned((cur) => (sameIds(cur, ids) ? null : ids))
            setLastShown(ids)
            globeRef.current?.focus(first.lat, first.lng)
          }}
          card={
            cardMembers.length > 0 && refMs !== null ? (
              <PlaceCard members={cardMembers} pinned={pinned !== null} nowMs={refMs} />
            ) : null
          }
        />
      </div>

      {/* Search */}
      <div className="relative z-10 flex justify-center px-6 pb-[8vh]">
        <HomeSearch />
      </div>
    </div>
  )
}

function PlaceCard({
  members,
  pinned,
  nowMs,
}: {
  members: GlobeClientMarker[]
  pinned: boolean
  nowMs: number
}) {
  const frame =
    'w-64 rounded-xl border bg-popover/95 p-3.5 text-popover-foreground shadow-pop backdrop-blur ' +
    (pinned ? 'border-foreground/30' : 'border-border')
  if (members.length === 1) {
    return (
      <div className={frame}>
        <ClientCard client={members[0]} nowMs={nowMs} />
      </div>
    )
  }

  // Several clients share this spot — list them all.
  const rows = [...members].sort((a, b) => a.name.localeCompare(b.name))
  const extra = rows.length - CLUSTER_ROWS
  return (
    <div className={frame}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold">{members.length} clients</p>
        {members[0].place && <p className="eyebrow text-muted-foreground">{members[0].place}</p>}
      </div>
      <ul className="mt-2.5 flex flex-col divide-y divide-border-soft">
        {rows.slice(0, CLUSTER_ROWS).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
            <div className="min-w-0">
              <Link
                href={`/clients?focus=${c.id}`}
                className="block truncate text-[12.5px] font-medium hover:underline"
              >
                {c.name}
              </Link>
              {c.siteUrl ? (
                <a
                  href={c.siteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate font-mono text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {hostOf(c.siteUrl)}
                </a>
              ) : (
                <span className="block font-mono text-[11px] text-muted-foreground/70">site in progress</span>
              )}
            </div>
            <Chip>{STATUS_LABEL[c.status] ?? c.status}</Chip>
          </li>
        ))}
      </ul>
      {extra > 0 && (
        <Link href="/clients" className="eyebrow mt-2 inline-block text-muted-foreground hover:text-foreground">
          +{extra} more →
        </Link>
      )}
    </div>
  )
}

function ClientCard({ client, nowMs }: { client: GlobeClientMarker; nowMs: number }) {
  const recent = isRecentLaunch(client, nowMs)
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{client.name}</p>
          {client.place && <p className="eyebrow mt-0.5 text-muted-foreground">{client.place}</p>}
        </div>
        <Chip>{STATUS_LABEL[client.status] ?? client.status}</Chip>
      </div>

      <div className="mt-3 flex flex-col gap-1.5 font-mono text-[11.5px]">
        {client.siteUrl ? (
          <a
            href={client.siteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-foreground hover:underline"
          >
            <GlobeIcon className="h-3 w-3 text-muted-foreground" />
            {hostOf(client.siteUrl)}
            <ExternalLink className="h-2.5 w-2.5 text-muted-foreground/70" />
          </a>
        ) : (
          <span className="text-muted-foreground">site in progress</span>
        )}
        <span className="text-muted-foreground">
          onboarded {daysAgo(client.onboardedAt, nowMs)}d ago
          {recent && client.siteLiveAt && (
            <span className="text-foreground/85"> · live {daysAgo(client.siteLiveAt, nowMs)}d ago</span>
          )}
        </span>
      </div>

      <Link
        href={`/clients?focus=${client.id}`}
        className="eyebrow mt-3 inline-flex items-center gap-1 text-muted-foreground transition hover:text-foreground"
      >
        Open client →
      </Link>
    </>
  )
}
