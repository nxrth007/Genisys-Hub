'use client'

import { useEffect, useRef } from 'react'
import createGlobe, { type Globe as CobeGlobe, type Marker } from 'cobe'
import { cn } from '@/lib/utils'

/**
 * Interactive dotted globe (cobe — WebGL, ~5 KB).
 *
 * Idle: slow eastward drift. Drag: rotates with the pointer, and the
 * release velocity carries on and decays, so a flick spins it rather
 * than stopping dead. Vertical drag tilts within a clamped band so the
 * poles can't be flipped past. Touch works through the same pointer
 * events.
 *
 * Rotation lives in refs and is pushed to cobe from a frame loop, so
 * dragging never re-renders React. `markers` is wired through so client
 * sites / offices can be plotted later without changing the component.
 */

export type GlobeMarker = Marker

const DRAG_SENSITIVITY = 220
const TILT_SENSITIVITY = 320
const MAX_TILT = 0.85
const IDLE_SPEED = 0.0022
const MOMENTUM_DECAY = 0.94
const MAX_MOMENTUM = 0.09

export function Globe({
  className,
  markers = [],
}: {
  className?: string
  markers?: GlobeMarker[]
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const globeRef = useRef<CobeGlobe | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const phi = useRef(0.3)
  const theta = useRef(0.22)
  const momentum = useRef(0)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    let size = wrap.clientWidth
    const graphite = document.documentElement.classList.contains('graphite')

    const globe = createGlobe(canvas, {
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      width: size * 2,
      height: size * 2,
      phi: phi.current,
      theta: theta.current,
      dark: 1,
      diffuse: 1.15,
      mapSamples: 28000,
      mapBrightness: 7.5,
      // Land is drawn in the map colour; the sphere itself stays close
      // to the canvas so only the dots read — that's the wireframe feel.
      baseColor: graphite ? [0.24, 0.25, 0.28] : [0.14, 0.15, 0.17],
      markerColor: [0.8, 0.9, 1],
      glowColor: graphite ? [0.16, 0.17, 0.2] : [0.075, 0.08, 0.1],
      markers: [],
    })
    globeRef.current = globe

    let raf = 0
    const frame = () => {
      if (!pointer.current) {
        // Free-running: idle drift plus whatever the last drag left.
        momentum.current *= MOMENTUM_DECAY
        phi.current += IDLE_SPEED + momentum.current
      }
      globe.update({
        phi: phi.current,
        theta: theta.current,
        width: size * 2,
        height: size * 2,
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    const ro = new ResizeObserver(() => {
      size = wrap.clientWidth
    })
    ro.observe(wrap)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      globe.destroy()
      globeRef.current = null
    }
  }, [])

  useEffect(() => {
    globeRef.current?.update({ markers })
  }, [markers])

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    pointer.current = { x: e.clientX, y: e.clientY }
    momentum.current = 0
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.style.cursor = 'grabbing'
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!pointer.current) return
    const dx = e.clientX - pointer.current.x
    const dy = e.clientY - pointer.current.y
    pointer.current = { x: e.clientX, y: e.clientY }

    const dphi = dx / DRAG_SENSITIVITY
    phi.current += dphi
    theta.current = Math.max(
      -MAX_TILT,
      Math.min(MAX_TILT, theta.current - dy / TILT_SENSITIVITY),
    )
    momentum.current = Math.max(-MAX_MOMENTUM, Math.min(MAX_MOMENTUM, dphi))
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    pointer.current = null
    e.currentTarget.style.cursor = 'grab'
  }

  return (
    <div ref={wrapRef} className={cn('relative aspect-square', className)}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="h-full w-full cursor-grab touch-none select-none"
        style={{ contain: 'layout paint size' }}
        aria-label="Interactive globe"
      />
    </div>
  )
}
