'use client'

import { useEffect, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'

/**
 * The workflow builder's canvas, GHL style: drag the background to move
 * around, scroll to pan, Ctrl/⌘ + scroll (or the buttons) to zoom around the
 * pointer. Content hangs from the top centre; clicks on cards, buttons and
 * fields go through untouched.
 */

type View = { x: number; y: number; z: number }

const MIN = 0.3
const MAX = 2
const START: View = { x: 0, y: 48, z: 1 }
const INTERACTIVE = '[data-node], button, a, input, textarea, select, label, [role="button"]'

/** Zoom to `z`, keeping the point at (cx, cy) (container coordinates, container `width` wide) where it is. */
function zoomAt(v: View, z: number, cx: number, cy: number, width: number): View {
  const nz = Math.min(MAX, Math.max(MIN, z))
  const ox = width / 2 + v.x
  const k = nz / v.z
  return { z: nz, x: cx - k * (cx - ox) - width / 2, y: cy - k * (cy - v.y) }
}

export function PanZoomCanvas({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>(START)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; sx: number; sy: number; x: number; y: number } | null>(null)

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const box = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0022)
        setView((v) => zoomAt(v, v.z * factor, e.clientX - box.left, e.clientY - box.top, el.clientWidth))
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /** Zoom by a factor around the middle of the canvas (the buttons). */
  const zoomBy = (factor: number | null) => {
    const el = ref.current
    if (!el) return
    setView((v) => zoomAt(v, factor === null ? 1 : v.z * factor, el.clientWidth / 2, el.clientHeight / 2, el.clientWidth))
  }

  return (
    <div
      ref={ref}
      className={`relative h-full w-full touch-none select-none overflow-hidden bg-muted ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{
        backgroundImage: 'radial-gradient(rgb(255 255 255 / 0.07) 1px, transparent 1px)',
        backgroundSize: `${22 * view.z}px ${22 * view.z}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest(INTERACTIVE)) return
        drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: view.x, y: view.y }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        setView((v) => ({ ...v, x: d.x + (e.clientX - d.sx), y: d.y + (e.clientY - d.sy) }))
      }}
      onPointerUp={(e) => {
        if (drag.current?.id === e.pointerId) {
          drag.current = null
          setDragging(false)
        }
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
    >
      <div className="absolute left-1/2 top-0 cursor-default" style={{ transform: `translate(calc(-50% + ${view.x}px), ${view.y}px) scale(${view.z})`, transformOrigin: 'top center' }}>
        {children}
      </div>
      <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm">
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Zoom out"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="w-12 rounded-md py-1 text-center font-mono text-[11.5px] tabular-nums text-foreground/85 hover:bg-muted" title="Reset to 100%" onClick={() => zoomBy(null)}>
          {Math.round(view.z * 100)}%
        </button>
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Zoom in"
          onClick={() => zoomBy(1.2)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title="Back to the start" onClick={() => setView(START)}>
          <Maximize className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
