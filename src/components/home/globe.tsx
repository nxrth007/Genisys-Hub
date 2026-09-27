'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import createGlobe, { type Globe as CobeGlobe } from 'cobe'
import { cn } from '@/lib/utils'

/**
 * Interactive dotted globe (cobe — WebGL, ~5 KB) carrying the client
 * constellation.
 *
 * Idle: slow eastward drift, which stops while a card is showing so it
 * can be read and reached. Drag: rotates with the pointer; release
 * velocity carries on and decays. Vertical drag tilts within a clamped
 * band. `focus(lat, lng)` eases a point to the centre; `hold` keeps it.
 *
 * cobe draws the sphere and the marker dots but offers no hit-testing
 * and only static arcs, so everything interactive or animated is done
 * here on top of it, using cobe's own projection (lifted from its
 * source: location → unit vector, rotate by phi/theta, orthographic
 * project). Each frame that projection places the hover card and the
 * pulse rings, finds the markers under the pointer, and draws the arcs
 * on a 2D overlay — a comet head travelling a lifted great-circle path
 * with a fading trail, and a ring flash when it lands.
 *
 * Markers within the hit radius of each other are reported together
 * (nearest first), so clients who share a city can all be reached. The
 * card is kept inside the nearest `[data-globe-bounds]` ancestor, and
 * flips below its marker when there is no room above.
 */

export type GlobeMarker = {
  id: string
  location: [number, number]
  size: number
  /** Draws a growing ring around the marker — a recent launch. */
  pulse?: boolean
}

export type GlobeHandle = {
  /** Ease the globe until this point is centred. Ignored mid-drag. */
  focus: (lat: number, lng: number) => void
  /** Send an arc from one point to another. */
  fireArc: (from: [number, number], to: [number, number]) => void
}

type Props = {
  className?: string
  markers?: GlobeMarker[]
  /** A fixed point with a steady ring — where arcs usually start. */
  origin?: [number, number] | null
  /** The marker the card is anchored to (hovered or pinned). Idle drift pauses while set. */
  activeId?: string | null
  /** Markers under the pointer, nearest first; null when none. */
  onHoverChange?: (ids: string[] | null) => void
  /** Markers clicked, nearest first — or empty globe, as null. */
  onSelect?: (ids: string[] | null) => void
  /** Rendered anchored above the active marker. */
  card?: React.ReactNode
  /** Suspend the idle drift (while a marker is pinned). */
  hold?: boolean
}

type RGB = [number, number, number]
const PALETTE: Record<'obsidian' | 'graphite', { baseColor: RGB; glowColor: RGB }> = {
  obsidian: { baseColor: [0.14, 0.15, 0.17], glowColor: [0.075, 0.08, 0.1] },
  graphite: { baseColor: [0.24, 0.25, 0.28], glowColor: [0.16, 0.17, 0.2] },
}
const currentPalette = () =>
  PALETTE[document.documentElement.classList.contains('graphite') ? 'graphite' : 'obsidian']

const DRAG_SENSITIVITY = 220
const TILT_SENSITIVITY = 320
const MAX_TILT = 0.85
const IDLE_SPEED = 0.0022
const MOMENTUM_DECAY = 0.94
const MAX_MOMENTUM = 0.09
const FOCUS_EASE = 0.085
const HIT_RADIUS_PX = 16
const CLICK_SLOP_PX = 5
/** Time to cross from a marker to its card before the hover clears. */
const HOVER_GRACE_MS = 220
/** Gap between a marker and its card, and the card's minimum margin from the bounds. */
const CARD_GAP_PX = 14
const CARD_MARGIN_PX = 8

// Arc animation, in ms.
const ARC_SAMPLES = 64
const ARC_DRAW = 1900
const ARC_TAIL_DELAY = 650
const ARC_FADE = 900
const ARC_RING = 900
const ARC_TOTAL = ARC_DRAW + Math.max(ARC_TAIL_DELAY, ARC_FADE, ARC_RING)

// ---- cobe's projection, so overlays land where the dots are ----------
const SPHERE_RADIUS = 0.8
const MARKER_ELEVATION = 0.05

type Vec3 = [number, number, number]

function toVector([lat, lng]: [number, number]): Vec3 {
  const la = (lat * Math.PI) / 180
  const lo = (lng * Math.PI) / 180 - Math.PI
  const c = Math.cos(la)
  return [-c * Math.cos(lo), Math.sin(la), c * Math.sin(lo)]
}

/** Fraction-of-canvas position of a world point, and whether it faces the viewer. */
function projectVec([x, y, z]: Vec3, phi: number, theta: number) {
  const ct = Math.cos(theta), st = Math.sin(theta)
  const cp = Math.cos(phi), sp = Math.sin(phi)
  const c = cp * x + sp * z
  const s = sp * st * x + ct * y - cp * st * z
  const depth = -sp * ct * x + st * y + cp * ct * z
  return {
    x: (c + 1) / 2,
    y: (1 - s) / 2,
    visible: depth >= 0 || c * c + s * s >= SPHERE_RADIUS * SPHERE_RADIUS,
  }
}

function projectLocation(loc: [number, number], phi: number, theta: number) {
  const r = SPHERE_RADIUS + MARKER_ELEVATION
  const v = toVector(loc)
  return projectVec([v[0] * r, v[1] * r, v[2] * r], phi, theta)
}

const clampTilt = (t: number) => Math.max(-MAX_TILT, Math.min(MAX_TILT, t))

/** The phi/theta that put a location dead centre (cobe's own recipe), tilt clamped. */
function anglesFor(lat: number, lng: number) {
  return {
    phi: Math.PI - ((lng * Math.PI) / 180 - Math.PI / 2),
    theta: clampTilt((lat * Math.PI) / 180),
  }
}

const TAU = Math.PI * 2
function shortestDelta(from: number, to: number) {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Compare hover/pin sets by membership: the same markers in a new distance order are the same set. */
const setKey = (ids: string[] | null) => (ids ? [...ids].sort().join('|') : '')

/**
 * World-space points along the great circle from `from` to `to`, lifted
 * off the surface in the middle — higher for longer hops. Computed once
 * per arc; only the projection changes as the globe turns.
 */
function arcPoints(from: [number, number], to: [number, number]): Vec3[] | null {
  const a = toVector(from)
  const b = toVector(to)
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  const w = Math.acos(dot)
  // Too close to draw, or antipodal (no unique great circle).
  if (w < 0.01 || Math.PI - w < 0.01) return null
  const sw = Math.sin(w)
  const base = SPHERE_RADIUS + MARKER_ELEVATION
  const lift = 0.06 + 0.3 * (w / Math.PI)
  const out: Vec3[] = []
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const t = i / ARC_SAMPLES
    const k1 = Math.sin((1 - t) * w) / sw
    const k2 = Math.sin(t * w) / sw
    const r = base + lift * Math.sin(Math.PI * t)
    out.push([(a[0] * k1 + b[0] * k2) * r, (a[1] * k1 + b[1] * k2) * r, (a[2] * k1 + b[2] * k2) * r])
  }
  return out
}

type ScreenPos = { id: string; x: number; y: number; visible: boolean }
type LiveArc = { points: Vec3[]; start: number }

export const Globe = forwardRef<GlobeHandle, Props>(function Globe(
  {
    className,
    markers = [],
    origin = null,
    activeId = null,
    onHoverChange,
    onSelect,
    card,
    hold = false,
  },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const arcCanvasRef = useRef<HTMLCanvasElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const ringRefs = useRef(new Map<string, HTMLDivElement>())
  const globeRef = useRef<CobeGlobe | null>(null)

  const pointer = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null)
  const phi = useRef(0.3)
  const theta = useRef(0.22)
  const momentum = useRef(0)
  const focusTarget = useRef<{ phi: number; theta: number } | null>(null)
  const positions = useRef<ScreenPos[]>([])
  const arcs = useRef<LiveArc[]>([])
  const overCard = useRef(false)
  /** Set-key of what was last reported through onHoverChange. */
  const reportedKey = useRef('')
  const clearTimer = useRef<number | null>(null)

  // Latest props for the frame loop and pointer handlers, synced after
  // each render so the globe is never re-created for a prop change.
  const live = useRef({ markers, origin, activeId, hold, hasCard: Boolean(card), onHoverChange })
  useEffect(() => {
    live.current = { markers, origin, activeId, hold, hasCard: Boolean(card), onHoverChange }
  })

  useImperativeHandle(ref, () => ({
    focus(lat, lng) {
      // A focus that arrives mid-drag would fight the user's hand.
      if (pointer.current) return
      focusTarget.current = anglesFor(lat, lng)
      momentum.current = 0
    },
    fireArc(from, to) {
      const points = arcPoints(from, to)
      if (points) arcs.current.push({ points, start: performance.now() })
    },
  }))

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const arcCanvas = arcCanvasRef.current
    if (!wrap || !canvas || !arcCanvas) return
    const ctx = arcCanvas.getContext('2d')
    if (!ctx) return
    const boundsEl = wrap.closest<HTMLElement>('[data-globe-bounds]')

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let size = wrap.clientWidth
    const sizeArcCanvas = () => {
      arcCanvas.width = Math.round(size * dpr)
      arcCanvas.height = Math.round(size * dpr)
    }
    sizeArcCanvas()

    const globe = createGlobe(canvas, {
      devicePixelRatio: dpr,
      width: size * 2,
      height: size * 2,
      phi: phi.current,
      theta: theta.current,
      dark: 1,
      diffuse: 1.15,
      mapSamples: 28000,
      mapBrightness: 7.5,
      ...currentPalette(),
      markerColor: [0.86, 0.93, 1],
      markers: [],
      markerElevation: MARKER_ELEVATION,
    })
    globeRef.current = globe

    // Follow the Obsidian / Graphite toggle while the page is open.
    const paletteWatch = new MutationObserver(() => globe.update(currentPalette()))
    paletteWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    const drawArcs = (now: number) => {
      const S = arcCanvas.width
      ctx.clearRect(0, 0, S, S)
      const p = phi.current, t = theta.current

      // Home base: a steady ring at the origin.
      const o = live.current.origin
      if (o) {
        const op = projectLocation(o, p, t)
        if (op.visible) {
          ctx.globalAlpha = 0.55
          ctx.strokeStyle = 'rgb(214, 234, 255)'
          ctx.lineWidth = 1 * dpr
          ctx.beginPath()
          ctx.arc(op.x * S, op.y * S, 5 * dpr, 0, TAU)
          ctx.stroke()
        }
      }

      arcs.current = arcs.current.filter((a) => now - a.start < ARC_TOTAL)
      for (const arc of arcs.current) {
        const el = now - arc.start
        const head = reduceMotion ? 1 : easeInOut(clamp01(el / ARC_DRAW))
        const tail = reduceMotion ? 0 : easeInOut(clamp01((el - ARC_TAIL_DELAY) / ARC_DRAW))
        const fade = el > ARC_DRAW ? 1 - clamp01((el - ARC_DRAW) / ARC_FADE) : 1
        const pts = arc.points.map((v) => projectVec(v, p, t))

        // Trail: brighter toward the head, only where it faces us.
        ctx.strokeStyle = 'rgb(214, 234, 255)'
        ctx.lineWidth = 1.4 * dpr
        ctx.lineCap = 'round'
        const span = Math.max(head - tail, 1e-3)
        for (let i = 0; i < ARC_SAMPLES; i++) {
          const s0 = i / ARC_SAMPLES
          const s1 = (i + 1) / ARC_SAMPLES
          if (s1 < tail || s0 > head) continue
          const a = pts[i], b = pts[i + 1]
          if (!a.visible || !b.visible) continue
          ctx.globalAlpha = fade * (0.12 + 0.88 * clamp01((s1 - tail) / span))
          ctx.beginPath()
          ctx.moveTo(a.x * S, a.y * S)
          ctx.lineTo(b.x * S, b.y * S)
          ctx.stroke()
        }

        // Comet head, while it is still travelling.
        if (!reduceMotion && head < 1) {
          const f = head * ARC_SAMPLES
          const i0 = Math.min(Math.floor(f), ARC_SAMPLES - 1)
          const k = f - i0
          const v0 = arc.points[i0], v1 = arc.points[i0 + 1]
          const hp = projectVec(
            [v0[0] + (v1[0] - v0[0]) * k, v0[1] + (v1[1] - v0[1]) * k, v0[2] + (v1[2] - v0[2]) * k],
            p,
            t,
          )
          if (hp.visible) {
            ctx.globalAlpha = 1
            ctx.shadowColor = 'rgba(200, 225, 255, 0.95)'
            ctx.shadowBlur = 12 * dpr
            ctx.fillStyle = '#ffffff'
            ctx.beginPath()
            ctx.arc(hp.x * S, hp.y * S, 2.2 * dpr, 0, TAU)
            ctx.fill()
            ctx.shadowBlur = 0
          }
        }

        // Landing flash: a ring at the destination — opening, or with
        // reduced motion a fixed ring that only fades.
        const ringAge = el - ARC_DRAW
        if (ringAge >= 0 && ringAge < ARC_RING) {
          const d = pts[ARC_SAMPLES]
          if (d.visible) {
            const r = clamp01(ringAge / ARC_RING)
            ctx.globalAlpha = 1 - r
            ctx.lineWidth = 1.2 * dpr
            ctx.beginPath()
            ctx.arc(d.x * S, d.y * S, (reduceMotion ? 9 : 3 + 15 * easeInOut(r)) * dpr, 0, TAU)
            ctx.stroke()
          }
        }
      }
      ctx.globalAlpha = 1
    }

    let raf = 0
    const frame = (now: number) => {
      // Layout reads first, while it is still clean from the last paint:
      // only needed when a card is anchored.
      const cardEl = cardRef.current
      const anchoring = Boolean(cardEl && live.current.activeId)
      const wrapRect = anchoring ? wrap.getBoundingClientRect() : null
      const bounds = anchoring
        ? boundsEl?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        : null
      const cardW = anchoring && cardEl ? cardEl.offsetWidth : 0
      const cardH = anchoring && cardEl ? cardEl.offsetHeight : 0

      const target = focusTarget.current
      if (target) {
        const dp = shortestDelta(phi.current, target.phi)
        const dt = target.theta - theta.current
        phi.current += dp * FOCUS_EASE
        theta.current += dt * FOCUS_EASE
        if (Math.abs(dp) < 0.003 && Math.abs(dt) < 0.003) focusTarget.current = null
      } else if (!pointer.current) {
        // Momentum from a fling always decays; the idle drift itself
        // stops while a card is up (hovered or pinned) so it can be read.
        momentum.current *= MOMENTUM_DECAY
        const idle =
          reduceMotion || live.current.hold || live.current.activeId ? 0 : IDLE_SPEED
        phi.current += idle + momentum.current
      }

      globe.update({ phi: phi.current, theta: theta.current, width: size * 2, height: size * 2 })

      // Where every marker sits right now — for hit-testing and to move
      // the rings + card by hand, with no React render per frame.
      const next: ScreenPos[] = live.current.markers.map((m) => ({
        id: m.id,
        ...projectLocation(m.location, phi.current, theta.current),
      }))
      positions.current = next
      for (const q of next) {
        const ring = ringRefs.current.get(q.id)
        if (ring) {
          ring.style.left = `${q.x * 100}%`
          ring.style.top = `${q.y * 100}%`
          ring.style.visibility = q.visible ? 'visible' : 'hidden'
        }
      }

      if (cardEl) {
        const active = live.current.activeId
        const q = active ? next.find((m) => m.id === active) : null
        const show = Boolean(q && q.visible && live.current.hasCard)
        // Placed above the marker, kept inside the bounds, flipped below
        // when there is no room above. While hidden it keeps its last
        // position, so it fades out in place.
        if (q && q.visible && wrapRect && bounds) {
          const mx = q.x * wrapRect.width
          const my = q.y * wrapRect.height
          const minLeft = bounds.left - wrapRect.left + CARD_MARGIN_PX
          const maxLeft = bounds.right - wrapRect.left - cardW - CARD_MARGIN_PX
          const left = Math.min(Math.max(mx - cardW / 2, minLeft), Math.max(minLeft, maxLeft))
          let top = my - cardH - CARD_GAP_PX
          if (wrapRect.top + top < bounds.top + CARD_MARGIN_PX) top = my + CARD_GAP_PX
          cardEl.style.left = `${left}px`
          cardEl.style.top = `${top}px`
        }
        cardEl.style.opacity = show ? '1' : '0'
        cardEl.style.pointerEvents = show ? 'auto' : 'none'
        // Hidden means out of the tab order and the accessibility tree
        // too, not just see-through. Written only when it changes.
        if (cardEl.inert === show) cardEl.inert = !show
      }

      drawArcs(now)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    const ro = new ResizeObserver(() => {
      size = wrap.clientWidth
      sizeArcCanvas()
    })
    ro.observe(wrap)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      paletteWatch.disconnect()
      globe.destroy()
      globeRef.current = null
    }
  }, [])

  // No hover timer may outlive the component.
  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current)
    },
    [],
  )

  // Marker changes go straight to cobe. The active marker is drawn
  // larger so the sphere agrees with the card. The origin only gets its
  // ring from the overlay — a dot there should be passed as a marker so
  // it can be hovered and explained like everything else. No ids: cobe
  // would add an anchor element per marker, and the overlay already
  // knows where everything is.
  useEffect(() => {
    globeRef.current?.update({
      markers: markers.map((m) => ({
        location: m.location,
        size: m.id === activeId ? m.size * 1.7 : m.size,
      })),
    })
  }, [markers, activeId])

  // ---- hover -----------------------------------------------------------
  function report(ids: string[] | null) {
    const key = setKey(ids)
    if (key === reportedKey.current) return
    reportedKey.current = key
    live.current.onHoverChange?.(ids)
  }

  function cancelClear() {
    if (clearTimer.current) {
      clearTimeout(clearTimer.current)
      clearTimer.current = null
    }
  }

  /** Clear the hover after a short grace, unless the pointer reaches the card or a marker. */
  function scheduleClear() {
    if (clearTimer.current || !reportedKey.current) return
    clearTimer.current = window.setTimeout(() => {
      clearTimer.current = null
      if (!overCard.current && !pointer.current) report(null)
    }, HOVER_GRACE_MS)
  }

  /** Every visible marker within the hit radius, nearest first. */
  function markersUnder(clientX: number, clientY: number): string[] | null {
    const wrap = wrapRef.current
    if (!wrap) return null
    const rect = wrap.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const hits: Array<{ id: string; d: number }> = []
    for (const q of positions.current) {
      if (!q.visible) continue
      const d = Math.hypot(q.x * rect.width - px, q.y * rect.height - py)
      if (d <= HIT_RADIUS_PX) hits.push({ id: q.id, d })
    }
    if (hits.length === 0) return null
    hits.sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
    return hits.map((h) => h.id)
  }

  /** Update hover and cursor for a pointer position that isn't dragging. */
  function hoverAt(el: HTMLElement, clientX: number, clientY: number) {
    const ids = markersUnder(clientX, clientY)
    el.style.cursor = ids ? 'pointer' : 'grab'
    if (ids) {
      cancelClear()
      report(ids)
    } else if (!overCard.current) {
      scheduleClear()
    }
  }

  // ---- pointer ---------------------------------------------------------
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    // Primary button only — and not a macOS ctrl-click, which is a right-click.
    if (e.button !== 0 || e.ctrlKey) return
    pointer.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false }
    momentum.current = 0
    focusTarget.current = null
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = pointer.current
    if (!p) {
      hoverAt(e.currentTarget, e.clientX, e.clientY)
      return
    }
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > CLICK_SLOP_PX) p.moved = true
    if (!p.moved) return
    e.currentTarget.style.cursor = 'grabbing'
    const dphi = dx / DRAG_SENSITIVITY
    phi.current += dphi
    // Positive theta rotates the surface down the screen, so dragging
    // down adds to it — the globe follows the pointer on both axes.
    theta.current = clampTilt(theta.current + dy / TILT_SENSITIVITY)
    momentum.current = Math.max(-MAX_MOMENTUM, Math.min(MAX_MOMENTUM, dphi))
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = pointer.current
    pointer.current = null
    if (p && !p.moved) {
      e.currentTarget.style.cursor = 'grab'
      onSelect?.(markersUnder(e.clientX, e.clientY))
      return
    }
    // After a drag, whatever is now under the pointer is the hover —
    // including clearing one whose grace ran out mid-drag. Touch has no
    // hover: a lifted finger over a dot must not pop a card.
    if (e.pointerType === 'touch') {
      e.currentTarget.style.cursor = 'grab'
      return
    }
    hoverAt(e.currentTarget, e.clientX, e.clientY)
  }

  /** A cancelled gesture (scroll takeover, lost capture) is never a click. */
  function onPointerCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    pointer.current = null
    e.currentTarget.style.cursor = 'grab'
  }

  const pulsing = markers.filter((m) => m.pulse)

  return (
    <div ref={wrapRef} className={cn('relative aspect-square', className)}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={scheduleClear}
        className="h-full w-full cursor-grab touch-none select-none"
        style={{ contain: 'layout paint size' }}
        aria-label="Interactive globe of clients"
      />

      {/* Overlay — arcs, rings and the card ride on the projected positions. */}
      <div className="pointer-events-none absolute inset-0">
        <canvas ref={arcCanvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
        {pulsing.map((m) => (
          // The wrapper is positioned and shown/hidden each frame; the
          // animated ring inside can't override its visibility.
          <div
            key={m.id}
            ref={(el) => {
              if (el) ringRefs.current.set(m.id, el)
              else ringRefs.current.delete(m.id)
            }}
            className="absolute"
            style={{ left: '50%', top: '50%', visibility: 'hidden' }}
            aria-hidden
          >
            <div className="hud-pulse-ring absolute left-0 top-0 h-7 w-7 rounded-full border border-foreground/70" />
          </div>
        ))}
        <div
          ref={cardRef}
          inert
          onPointerEnter={() => {
            overCard.current = true
            cancelClear()
          }}
          onPointerLeave={() => {
            overCard.current = false
            scheduleClear()
          }}
          className="absolute z-10 opacity-0 transition-opacity duration-150"
          style={{ left: 0, top: 0, pointerEvents: 'none' }}
        >
          {card}
        </div>
      </div>
    </div>
  )
})
