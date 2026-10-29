'use client'

/**
 * Hand-rolled isometric SVG office. Static furniture is memoised; bots are
 * merged in and depth-sorted each animation frame. Bots glide along
 * grid paths (src/lib/office/path.ts) with 90-degree turns.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { BotId, OfficeBot, OfficeHandoff, OfficeStatus } from '@/lib/office/mapping'
import { corners, findPath, pathLength, pointAlong, type Cell } from '@/lib/office/path'
import { COS_VISIT, DESKS, GRID, GRID_H, GRID_W, IDLE_SPOTS, ITEMS, WALL_SCREEN, visitSpot, botDepth, itemDepth, type Item } from '@/lib/office/layout'
import { PALETTES, STATUS_META, type OfficeTheme, type Palette } from './theme'

const HW = 32 // half tile width
const HH = 16 // half tile height
const WALL = 120
const SPEED = 2.4 // cells per second

const P = (gx: number, gy: number, z = 0): [number, number] => [(gx - gy) * HW, (gx + gy) * HH - z]
const pts = (...ps: [number, number][]) => ps.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')

type Layer = { key: string; depth: number; el: ReactElement }

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`
}

/** Iso box: top + the two viewer-facing sides. */
function Box({ x, y, w, d, h, z = 0, top, left, right, opacity = 1, stroke }: { x: number; y: number; w: number; d: number; h: number; z?: number; top: string; left: string; right: string; opacity?: number; stroke?: string }) {
  const t = z + h
  return (
    <g opacity={opacity}>
      <polygon points={pts(P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, t), P(x, y + d, t))} fill={left} stroke={stroke} strokeWidth={stroke ? 0.6 : 0} />
      <polygon points={pts(P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, t), P(x + w, y, t))} fill={right} stroke={stroke} strokeWidth={stroke ? 0.6 : 0} />
      <polygon points={pts(P(x, y, t), P(x + w, y, t), P(x + w, y + d, t), P(x, y + d, t))} fill={top} stroke={stroke} strokeWidth={stroke ? 0.6 : 0} />
    </g>
  )
}

function renderItem(i: Item, pal: Palette, deskGlow: Record<string, string>): ReactElement | null {
  const { x, y, w, d } = i
  switch (i.kind) {
    case 'rug':
      return <polygon points={pts(P(x + 0.2, y + 0.2), P(x + w - 0.2, y + 0.2), P(x + w - 0.2, y + d - 0.2), P(x + 0.2, y + d - 0.2))} fill="#1f5a3a" opacity={0.85} stroke="#2f7a50" strokeWidth={1.5} />
    case 'glass': {
      const h = 78
      const [a, b] = i.axis === 'y' ? [P(x + 0.5, y), P(x + 0.5, y + 1)] : [P(x, y + 0.5), P(x + 1, y + 0.5)]
      return (
        <g>
          <polygon points={pts(a, b, [b[0], b[1] - h], [a[0], a[1] - h])} fill={pal.glass} />
          <line x1={a[0]} y1={a[1] - h} x2={b[0]} y2={b[1] - h} stroke={pal.glassEdge} strokeWidth={1.4} />
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={pal.glassEdge} strokeWidth={0.8} opacity={0.6} />
          <line x1={a[0]} y1={a[1]} x2={a[0]} y2={a[1] - h} stroke={pal.glassEdge} strokeWidth={0.5} opacity={0.5} />
        </g>
      )
    }
    case 'desk':
    case 'bigdesk': {
      const desk = DESKS.find((k) => k.id === i.id)
      const facingBack = desk ? desk.seat.y < y : false
      const glow = deskGlow[i.id] ?? '#64748b'
      const mw = i.kind === 'bigdesk' ? 1.1 : 1.2
      const monitors = i.kind === 'bigdesk' ? [x + 0.25, x + 1.6] : [x + (w - mw) / 2]
      const my = facingBack ? y + 0.12 : y + 0.12
      return (
        <g>
          <Box x={x + 0.05} y={y + 0.08} w={w - 0.1} d={d - 0.16} h={26} top={pal.woodTop} left={pal.woodLeft} right={pal.woodRight} />
          {monitors.map((mx, k) => (
            <g key={k}>
              <Box x={mx + 0.45} y={my + 0.12} w={0.25} d={0.12} h={6} z={26} top="#111" left="#0b0b0b" right="#080808" />
              <Box x={mx} y={my} w={mw} d={0.08} h={22} z={32} top="#151515" left={facingBack ? '#0c0c0c' : glow} right="#0a0a0a" />
              {!facingBack && <polygon points={pts(P(mx + 0.06, my + 0.08, 35), P(mx + mw - 0.06, my + 0.08, 35), P(mx + mw - 0.06, my + 0.08, 51), P(mx + 0.06, my + 0.08, 51))} fill="#fff" opacity={0.12} />}
            </g>
          ))}
        </g>
      )
    }
    case 'plant': {
      const [cx, cy] = P(x + 0.5, y + 0.5)
      return (
        <g>
          <Box x={x + 0.3} y={y + 0.3} w={0.4} d={0.4} h={16} top="#4b5563" left="#374151" right="#2d3440" />
          <circle cx={cx} cy={cy - 30} r={12} fill="#1f7a3e" />
          <circle cx={cx - 8} cy={cy - 38} r={9} fill="#2a9a4f" />
          <circle cx={cx + 7} cy={cy - 41} r={8} fill="#239146" />
          <circle cx={cx} cy={cy - 48} r={7} fill="#34b25c" />
        </g>
      )
    }
    case 'sofa':
      return (
        <g>
          <Box x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} h={16} top="#2f7d4f" left="#226040" right="#1c5236" />
          {w === 1 ? (
            <Box x={x + 0.05} y={y + 0.05} w={0.3} d={d - 0.1} h={20} z={16} top="#36905b" left="#25694a" right="#1f5a3f" />
          ) : (
            <Box x={x} y={y + 0.65} w={w - 0.05} d={0.3} h={20} z={16} top="#36905b" left="#25694a" right="#1f5a3f" />
          )}
        </g>
      )
    case 'coffee':
      return (
        <g>
          <Box x={x + 0.25} y={y + 0.25} w={w - 0.5} d={d - 0.5} h={12} top="rgba(180,220,240,0.25)" left="rgba(120,170,200,0.25)" right="rgba(100,150,180,0.25)" stroke="rgba(200,235,255,0.5)" />
        </g>
      )
    case 'meeting':
      return (
        <g>
          <Box x={x + 0.1} y={y + 0.15} w={w - 0.2} d={d - 0.3} h={24} top={shade(pal.woodTop, 1.25)} left={pal.woodLeft} right={pal.woodRight} />
          {[0.6, 1.6, 2.6, 3.4].map((cx, k) => (
            <Box key={k} x={x + cx - 0.18} y={y - 0.25} w={0.36} d={0.3} h={14} top="#2b2f36" left="#1e2127" right="#181b20" />
          ))}
        </g>
      )
    case 'counter':
      return <Box x={x} y={y} w={w} d={d} h={30} top="#9ca3af" left="#3f4650" right="#343a43" />
    case 'fridge':
      return <Box x={x + 0.1} y={y + 0.1} w={0.8} d={0.8} h={66} top="#d1d5db" left="#9ca3af" right="#868c96" />
    case 'bartable':
      return <Box x={x + 0.1} y={y + 0.2} w={w - 0.2} d={d - 0.4} h={28} top={shade(pal.woodTop, 1.2)} left={pal.woodLeft} right={pal.woodRight} />
  }
  return null
}

// ---------- bots ----------

type Motion = {
  pos: Cell
  path: Cell[]
  dist: number
  len: number
  target: Cell
  /** Queued legs: walk to `to`, then wait `wait` ms. */
  queue: { to: Cell; wait: number }[]
  waitUntil: number
  lastStatus: OfficeStatus
}

const center = (c: Cell): Cell => ({ x: c.x + 0.5, y: c.y + 0.5 })
const same = (a: Cell, b: Cell) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

function planPath(from: Cell, to: Cell): Cell[] {
  // `from` may be mid-segment (fractional on one axis); snap to a cell.
  const start = { x: Math.min(GRID_W - 1, Math.max(0, Math.round(from.x - 0.5))), y: Math.min(GRID_H - 1, Math.max(0, Math.round(from.y - 0.5))) }
  const raw = findPath(GRID, start, to)
  const cs = corners(raw ?? [start, to]).map(center)
  const out = same(cs[0], from) ? cs : [from, ...cs]
  return out
}

function BubbleIcon({ icon, color }: { icon: OfficeBot['icon']; color: string }) {
  switch (icon) {
    case 'dots':
      return (
        <g fill="#334155">
          <circle cx={-6} cy={0} r={1.8} />
          <circle cx={0} cy={0} r={1.8} />
          <circle cx={6} cy={0} r={1.8} />
        </g>
      )
    case 'code':
      return <path d="M-4 -5 L-9 0 L-4 5 M4 -5 L9 0 L4 5 M1.5 -6 L-1.5 6" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    case 'terminal':
      return <path d="M-8 -4 L-3 0 L-8 4 M-1 5 L7 5" stroke={color} strokeWidth={1.9} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    case 'globe':
      return (
        <g stroke={color} strokeWidth={1.4} fill="none">
          <circle r={6} />
          <ellipse rx={2.6} ry={6} />
          <line x1={-6} x2={6} />
        </g>
      )
    case 'folder':
      return <path d="M-8 -5 h5 l2 2 h9 v9 h-16 z" fill={color} opacity={0.9} />
    case 'gear':
      return (
        <g stroke={color} strokeWidth={1.6} fill="none">
          <circle r={3.2} />
          {[0, 45, 90, 135].map((a) => (
            <line key={a} x1={-7} x2={7} transform={`rotate(${a})`} strokeDasharray="2.5 9" strokeDashoffset={-0.2} />
          ))}
        </g>
      )
    case 'check':
      return <path d="M-6 0 L-2 4 L7 -5" stroke="#16a34a" strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    case 'alert':
      return (
        <g fill="#ca8a04">
          <rect x={-1.2} y={-6} width={2.4} height={8} rx={1} />
          <circle cy={5} r={1.5} />
        </g>
      )
    case 'error':
      return <path d="M-5 -5 L5 5 M5 -5 L-5 5" stroke="#dc2626" strokeWidth={2.2} strokeLinecap="round" />
    default:
      return null
  }
}

type BotProps = { bot: OfficeBot; pos: Cell; moving: boolean; reduced: boolean; glow: number; t: number }

const bobOf = (bot: OfficeBot, reduced: boolean, t: number) => (reduced ? 0 : Math.sin(t / 420 + bot.name.length) * 2.5)

/** Ground part (shadow + colour ring): depth-sorted with the furniture. */
function BotGround({ bot, pos, reduced, glow, t }: BotProps) {
  const [sx, sy] = P(pos.x, pos.y)
  const bob = bobOf(bot, reduced, t)
  return (
    <g>
      <ellipse cx={sx} cy={sy} rx={15} ry={7.5} fill="#000" opacity={0.4 - bob * 0.02} />
      <ellipse cx={sx} cy={sy} rx={17} ry={8.5} fill="none" stroke={bot.color} strokeWidth={2.4} opacity={0.9} filter={glow > 0.5 ? 'url(#office-glow)' : undefined} />
      <ellipse cx={sx} cy={sy} rx={17} ry={8.5} fill={bot.color} opacity={0.12 * glow} />
    </g>
  )
}

/** Head, name tag and bubbles: drawn above all furniture so desks/glass never hide them. */
function BotTop({ bot, pos, moving, reduced, glow, t }: BotProps) {
  const [sx, sy] = P(pos.x, pos.y)
  const status = STATUS_META[bot.status]
  const bob = bobOf(bot, reduced, t)
  const hy = sy - 40 + bob
  const tagW = Math.max(40, bot.name.length * 6.6 + 14)
  return (
    <g>
      {/* head */}
      <g transform={`translate(${sx},${hy})`}>
        <line x1={0} y1={-13} x2={0} y2={-19} stroke="#94a3b8" strokeWidth={1.4} />
        <circle cx={0} cy={-20} r={2.2} fill={status.color} filter={glow > 0.5 ? 'url(#office-glow)' : undefined} />
        <rect x={-15} y={-13} width={30} height={24} rx={9} fill="#1c212b" stroke="#3a4252" strokeWidth={1} />
        <rect x={-11} y={-5} width={22} height={8} rx={4} fill={bot.color} opacity={0.95} filter={glow > 0.5 ? 'url(#office-glow)' : undefined} />
        <circle cx={-4.5} cy={-1} r={1.6} fill="#fff" opacity={0.9} />
        <circle cx={4.5} cy={-1} r={1.6} fill="#fff" opacity={0.9} />
        <rect x={-15} y={-13} width={30} height={7} rx={6} fill="#fff" opacity={0.06} />
      </g>
      {/* name tag */}
      <g transform={`translate(${sx},${sy + 18})`}>
        <rect x={-tagW / 2} y={-8} width={tagW} height={16} rx={8} fill="#0b0f16" opacity={0.72} stroke={bot.color} strokeOpacity={0.5} strokeWidth={0.8} />
        <text textAnchor="middle" y={3.5} fontSize={10} fontWeight={600} fill="#e5e7eb" fontFamily="var(--font-geist-sans), system-ui, sans-serif">
          {bot.name}
        </text>
      </g>
      {/* speech bubble */}
      {bot.icon && !moving && (
        <g transform={`translate(${sx + 16},${hy - 30})`}>
          <path d="M-15 -11 h30 a5 5 0 0 1 5 5 v12 a5 5 0 0 1 -5 5 h-20 l-6 6 l1 -6 h-5 a5 5 0 0 1 -5 -5 v-12 a5 5 0 0 1 5 -5 z" fill="#fff" opacity={0.96} />
          <g transform="translate(0,0)">
            <BubbleIcon icon={bot.icon} color={status.color} />
          </g>
        </g>
      )}
      {moving && !reduced && (
        <g transform={`translate(${sx + 16},${hy - 30})`}>
          <path d="M-15 -11 h30 a5 5 0 0 1 5 5 v12 a5 5 0 0 1 -5 5 h-20 l-6 6 l1 -6 h-5 a5 5 0 0 1 -5 -5 v-12 a5 5 0 0 1 5 -5 z" fill="#fff" opacity={0.96} />
          <BubbleIcon icon="folder" color={bot.color} />
        </g>
      )}
    </g>
  )
}

export type SceneProps = {
  bots: OfficeBot[]
  handoffs: OfficeHandoff[]
  theme: OfficeTheme
  paused: boolean
  wallStat: string
}

export default function OfficeScene({ bots, handoffs, theme, paused, wallStat }: SceneProps) {
  const pal = PALETTES[theme]
  const [reduced, setReduced] = useState(false)
  const [, setFrame] = useState(0)
  const motion = useRef(new Map<BotId, Motion>())
  const played = useRef<Set<string> | null>(null)
  const clock = useRef(0)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // Home spot for each bot: desk when busy (Alfred always), lounge/breakroom when idle.
  const homes = useMemo(() => {
    const out = new Map<BotId, Cell>()
    let idleIdx = 0
    bots.forEach((b, i) => {
      const desk = DESKS[i]
      if (b.id === 'alfred' || b.status !== 'idle') out.set(b.id, desk ? desk.seat : IDLE_SPOTS[0])
      else out.set(b.id, IDLE_SPOTS[idleIdx++ % IDLE_SPOTS.length])
    })
    return out
  }, [bots])

  // Retarget bots when data changes.
  useEffect(() => {
    const now = performance.now()
    const deskOf = (id: BotId) => DESKS[bots.findIndex((b) => b.id === id)]?.seat
    for (const b of bots) {
      const home = homes.get(b.id)!
      let m = motion.current.get(b.id)
      if (!m) {
        const c = center(home)
        m = { pos: c, path: [c], dist: 0, len: 0, target: home, queue: [], waitUntil: 0, lastStatus: b.status }
        motion.current.set(b.id, m)
        continue
      }
      const escalated = (b.status === 'needs_you' || b.status === 'error') && m.lastStatus !== b.status && b.id !== 'alfred'
      m.lastStatus = b.status
      if (escalated) m.queue.push({ to: COS_VISIT, wait: 2500 })
      if (!same(m.target, home) || escalated) {
        m.target = home
        m.queue.push({ to: home, wait: 0 })
      }
      void now
    }
    // Handoffs: the first stage's bot walks to the next stage's bot, then home.
    if (played.current === null) {
      // First load: only replay handoffs from the last two minutes.
      played.current = new Set(handoffs.filter((h) => Date.now() - Date.parse(h.at) > 120_000).map((h) => h.id))
    }
    for (const h of [...handoffs].reverse()) {
      if (played.current.has(h.id)) continue
      played.current.add(h.id)
      const m = motion.current.get(h.from)
      const seat = deskOf(h.to)
      if (!m || !seat) continue
      m.queue.push({ to: visitSpot(seat), wait: 2500 }, { to: homes.get(h.from)!, wait: 0 })
      // Alfred stops by too, to sign off on the handoff.
      const alfred = motion.current.get('alfred')
      if (alfred && h === handoffs[0]) alfred.queue.push({ to: visitSpot(visitSpot(seat)), wait: 2000 }, { to: homes.get('alfred')!, wait: 0 })
    }
  }, [bots, homes, handoffs])

  // Animation loop.
  useEffect(() => {
    if (paused) return
    let raf = 0
    let last = performance.now()
    const step = (ts: number) => {
      const dt = Math.min(0.1, (ts - last) / 1000)
      last = ts
      clock.current = ts
      for (const m of motion.current.values()) {
        if (m.dist < m.len) {
          m.dist = reduced ? m.len : Math.min(m.len, m.dist + SPEED * dt)
          m.pos = pointAlong(m.path, m.dist)
          continue
        }
        if (ts < m.waitUntil) continue
        const next = m.queue.shift()
        if (!next) continue
        const path = planPath(m.pos, next.to)
        m.path = path
        m.len = pathLength(path)
        m.dist = 0
        m.waitUntil = 0
        if (next.wait) {
          // Wait starts after arrival: approximate with travel time.
          m.waitUntil = ts + (reduced ? 0 : (m.len / SPEED) * 1000) + next.wait
        }
      }
      setFrame((f) => (f + 1) % 1_000_000)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [paused, reduced])

  const deskGlow = useMemo(() => {
    const g: Record<string, string> = {}
    bots.forEach((b, i) => {
      const d = DESKS[i]
      if (d) g[d.id] = b.status === 'idle' && b.id !== 'alfred' ? '#1e293b' : STATUS_META[b.status].color
    })
    return g
  }, [bots])

  const furniture: Layer[] = useMemo(
    () =>
      ITEMS.filter((i) => i.kind !== 'rug').map((i) => ({ key: i.id, depth: itemDepth(i), el: renderItem(i, pal, deskGlow) ?? <g /> })),
    [pal, deskGlow],
  )
  const rugs = useMemo(() => ITEMS.filter((i) => i.kind === 'rug').map((i) => <g key={i.id}>{renderItem(i, pal, deskGlow)}</g>), [pal, deskGlow])

  const floor = useMemo(() => {
    const strips: ReactElement[] = []
    for (let j = 0; j < GRID_H * 2; j++) {
      const y0 = j / 2
      const y1 = y0 + 0.5
      strips.push(<polygon key={`f${j}`} points={pts(P(0, y0), P(GRID_W, y0), P(GRID_W, y1), P(0, y1))} fill={j % 2 ? pal.floorA : pal.floorB} />)
      // Plank seams, staggered.
      for (let k = (j % 3) * 1.3; k < GRID_W; k += 3.9) {
        const [a, b] = [P(k, y0), P(k, y1)]
        strips.push(<line key={`s${j}-${k}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={pal.floorLine} strokeWidth={0.8} />)
      }
    }
    return strips
  }, [pal])

  const walls = useMemo(() => {
    const winR = [2, 7.5, 10.5].map((x) => (
      <polygon key={`wr${x}`} points={pts(P(x, 0, 38), P(x + 2, 0, 38), P(x + 2, 0, 98), P(x, 0, 98))} fill={pal.window} opacity={0.8} stroke={pal.wallTop} strokeWidth={2} />
    ))
    const winL = [8, 11.5].map((y) => (
      <polygon key={`wl${y}`} points={pts(P(0, y, 38), P(0, y + 2, 38), P(0, y + 2, 98), P(0, y, 98))} fill={pal.window} opacity={0.8} stroke={pal.wallTop} strokeWidth={2} />
    ))
    return (
      <g>
        <polygon points={pts(P(0, 0), P(0, GRID_H), P(0, GRID_H, WALL), P(0, 0, WALL))} fill={pal.wallLeft} />
        <polygon points={pts(P(0, 0), P(GRID_W, 0), P(GRID_W, 0, WALL), P(0, 0, WALL))} fill={pal.wallRight} />
        <polygon points={pts(P(-0.25, -0.25, WALL), P(GRID_W, -0.25, WALL), P(GRID_W, 0, WALL), P(0, 0, WALL), P(0, GRID_H, WALL), P(-0.25, GRID_H, WALL))} fill={pal.wallTop} />
        {winR}
        {winL}
      </g>
    )
  }, [pal])

  const t = clock.current
  const botParts = bots.map((b) => {
    const m = motion.current.get(b.id)
    const pos = m?.pos ?? center(homes.get(b.id) ?? IDLE_SPOTS[0])
    const moving = !!m && m.dist < m.len
    const props: BotProps = { bot: b, pos, moving, reduced, glow: pal.glow, t }
    const depth = botDepth(pos)
    return {
      ground: { key: `bot-${b.id}`, depth, el: <BotGround {...props} /> } as Layer,
      top: { key: `bot-top-${b.id}`, depth, el: <BotTop {...props} /> } as Layer,
    }
  })
  const layers = [...furniture, ...botParts.map((p) => p.ground)].sort((a, b) => a.depth - b.depth)
  const tops = botParts.map((p) => p.top).sort((a, b) => a.depth - b.depth)

  // Wall screen (meeting room) in the y=0 wall plane.
  const [wx, wy] = P(WALL_SCREEN.x, 0, 100)
  const ux = HW / Math.hypot(HW, HH)
  const uy = HH / Math.hypot(HW, HH)
  const screenLen = WALL_SCREEN.len * Math.hypot(HW, HH)

  // Desk light pools at night.
  const pools = bots.map((b, i) => {
    const d = DESKS[i]
    if (!d || (b.status === 'idle' && b.id !== 'alfred')) return null
    const [cx, cy] = P(d.item.x + d.item.w / 2, d.item.y + 0.5)
    return <ellipse key={`pool-${b.id}`} cx={cx} cy={cy} rx={78} ry={40} fill={`url(#pool-${b.status})`} opacity={pal.glow} />
  })

  const [minX, minY] = [P(0, GRID_H)[0] - 40, P(0, 0, WALL)[1] - 40]
  const [maxX, maxY] = [P(GRID_W, 0)[0] + 40, P(GRID_W, GRID_H)[1] + 40]

  return (
    <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className="h-full w-full" role="img" aria-label="Isometric virtual office with the Hub's pipeline bots">
      <defs>
        <filter id="office-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {Object.entries(STATUS_META).map(([k, v]) => (
          <radialGradient key={k} id={`pool-${k}`}>
            <stop offset="0%" stopColor={v.color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={v.color} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} fill={pal.bg} />
      {walls}
      <g transform={`matrix(${ux},${uy},0,1,${wx},${wy})`}>
        <rect x={0} y={0} width={screenLen} height={46} rx={3} fill="#05070a" stroke="#2a2f38" strokeWidth={2} />
        <rect x={4} y={4} width={screenLen - 8} height={38} rx={2} fill="#0b2a4a" opacity={0.6 + 0.4 * pal.glow} />
        <text x={screenLen / 2} y={20} textAnchor="middle" fontSize={9} fill="#7dd3fc" fontFamily="var(--font-geist-mono), monospace" letterSpacing={1}>
          LIVE
        </text>
        <text x={screenLen / 2} y={34} textAnchor="middle" fontSize={11} fontWeight={700} fill="#e0f2fe" fontFamily="var(--font-geist-mono), monospace">
          {wallStat}
        </text>
      </g>
      {floor}
      {rugs}
      {pools}
      {layers.map((l) => (
        <g key={l.key}>{l.el}</g>
      ))}
      <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} fill={pal.ambient} opacity={pal.ambientOpacity} pointerEvents="none" style={{ mixBlendMode: 'multiply' }} />
      {/* Bot heads/name tags above everything (after ambient so they stay legible at night). */}
      {tops.map((l) => (
        <g key={l.key}>{l.el}</g>
      ))}
    </svg>
  )
}
