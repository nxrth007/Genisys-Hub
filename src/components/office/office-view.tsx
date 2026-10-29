'use client'

import dynamic from 'next/dynamic'
import { useSyncExternalStore, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Pause, Play, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { DESKS } from '@/lib/office/layout'
import type { OfficeState, OfficeStatus } from '@/lib/office/mapping'
import { OFFICE_THEMES, STATUS_META, type OfficeTheme } from './theme'

// The SVG scene + animation loop only runs in the browser and stays out of
// every other page's bundle.
const OfficeScene = dynamic(() => import('./office-scene'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-xs text-zinc-500">Loading office…</div>,
})

const POLL_MS = 7_000
const THEME_KEY = 'office-theme'
const THEME_EVENT = 'office-theme-change'

function subscribeTheme(cb: () => void) {
  window.addEventListener(THEME_EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(THEME_EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}
function readTheme(): OfficeTheme {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'day' || v === 'evening' || v === 'night' ? v : 'night'
  } catch {
    return 'night'
  }
}
function setTheme(t: OfficeTheme) {
  try {
    localStorage.setItem(THEME_KEY, t)
  } catch {
    // non-fatal
  }
  window.dispatchEvent(new Event(THEME_EVENT))
}

const LEGEND: OfficeStatus[] = ['coding', 'browsing', 'terminal', 'thinking', 'needs_you', 'error']

function StatusPill({ status }: { status: OfficeStatus }) {
  const m = STATUS_META[status]
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${m.color}22`, color: m.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  )
}

export function OfficeView({ demo, user }: { demo: boolean; user: { name: string | null; email: string | null; image: string | null; role: string | null } }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'night' as OfficeTheme)
  const [paused, setPaused] = useState(false)

  const { data, error, isLoading } = useQuery<OfficeState>({
    queryKey: ['office-state', demo],
    queryFn: async () => {
      const res = await fetch(`/api/office/state${demo ? '?demo=1' : ''}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    refetchInterval: paused ? false : POLL_MS,
    refetchIntervalInBackground: false,
  })

  const bots = data?.bots ?? []
  const occupied = bots.filter((b) => b.id === 'alfred' || b.status !== 'idle').length
  const free = Math.max(0, DESKS.length - occupied)
  const working = data?.counts.working ?? 0
  const idle = data?.counts.idle ?? 0
  const needs = (data?.counts.needsYou ?? 0) + (data?.counts.error ?? 0)

  return (
    <div className="flex h-full min-h-[640px] flex-col bg-[#07090d] text-zinc-100 lg:flex-row">
      <section className="relative flex min-h-[520px] flex-1 flex-col overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-5 py-3">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Genisys Staff Virtual Office</h1>
            <p className="mt-0.5 font-mono text-[11px] text-zinc-400">
              {working} working • {idle} idle • {free} free desk{free === 1 ? '' : 's'}
              {needs > 0 && <span className="text-yellow-400"> • {needs} need{needs === 1 ? 's' : ''} you</span>}
            </p>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
            {demo ? (
              <span className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-300">Sample data · demo mode</span>
            ) : (
              <span className={cn('inline-flex items-center gap-1.5 rounded px-2 py-1', paused ? 'text-zinc-500' : 'text-emerald-400')}>
                <Radio className="h-3 w-3" /> {paused ? 'Paused' : 'Live'}
              </span>
            )}
          </div>
        </header>

        <div className="relative flex-1">
          {error ? (
            <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded bg-red-500/15 px-3 py-1.5 text-xs text-red-300">Couldn&apos;t load office state ({(error as Error).message}). Retrying…</div>
          ) : null}
          {isLoading ? (
            <div className="grid h-full place-items-center text-xs text-zinc-500">Loading office…</div>
          ) : (
            <div className="absolute inset-0 p-2">
              <OfficeScene bots={bots} handoffs={data?.handoffs ?? []} theme={theme} paused={paused} wallStat={`${working} working · ${needs} need you`} />
            </div>
          )}

          {/* Legend */}
          <div className="absolute bottom-3 left-3 rounded-lg border border-white/10 bg-black/55 px-3 py-2 backdrop-blur">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-zinc-500">Status</div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
              {LEGEND.map((s) => (
                <li key={s} className="flex items-center gap-1.5 text-[11px] text-zinc-300">
                  <span className="h-2 w-2 rounded-full" style={{ background: STATUS_META[s].color, boxShadow: `0 0 6px ${STATUS_META[s].color}` }} />
                  {STATUS_META[s].label}
                </li>
              ))}
            </ul>
          </div>

          {/* Theme toggle */}
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 rounded-full border border-white/10 bg-black/55 p-1 backdrop-blur" role="radiogroup" aria-label="Office lighting">
            {OFFICE_THEMES.map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={theme === t}
                onClick={() => setTheme(t)}
                className={cn('rounded-full px-3 py-1 text-[11px] font-medium capitalize transition-colors', theme === t ? 'bg-white/15 text-white' : 'text-zinc-400 hover:text-zinc-200')}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Pause */}
          <button
            onClick={() => setPaused((p) => !p)}
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-3 py-2 text-[11px] font-medium text-zinc-200 backdrop-blur hover:bg-black/70"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume live view' : 'Pause live view'}
          </button>
        </div>
      </section>

      <aside className="flex w-full shrink-0 flex-col border-l border-white/5 bg-[#0b0e13] lg:w-[340px]">
        <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
          <Avatar name={user.name} email={user.email} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{user.name || user.email}</div>
            <div className="text-[11px] capitalize text-zinc-500">{user.role ?? 'staff'}</div>
          </div>
        </div>

        <div className="border-b border-white/5 px-4 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Team · {bots.length}</div>
          <ul className="space-y-2.5">
            {bots.map((b) => (
              <li key={b.id} className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold text-black" style={{ background: b.color, boxShadow: `0 0 8px ${b.color}66` }}>
                  {b.name[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-medium">
                      {b.name} <span className="font-normal text-zinc-500">· {b.role}</span>
                    </span>
                    <StatusPill status={b.status} />
                  </div>
                  <div className="truncate text-[11px] text-zinc-400" title={b.task}>
                    {b.task}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">Activity{demo ? ' · sample' : ''}</div>
          <div className="min-h-[160px] flex-1 overflow-y-auto pr-1">
            {data && data.activity.length === 0 ? (
              <p className="text-[12px] text-zinc-500">No pipeline events in the last 3 days. Bots stay idle until the Hub records real work.</p>
            ) : (
              <ul className="space-y-2">
                {(data?.activity ?? []).map((a) => {
                  const bot = bots.find((b) => b.id === a.botId)
                  const color = a.tone === 'done' ? '#22c55e' : STATUS_META[a.tone].color
                  return (
                    <li key={a.id} className="flex gap-2 text-[11.5px] leading-snug">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
                      <span className="text-zinc-300">
                        <span className="font-mono text-zinc-500">{format(new Date(a.at), 'h:mm a')}</span> — <span className="font-medium" style={{ color: bot?.color }}>{bot?.name ?? a.botId}</span>: {a.text}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}
