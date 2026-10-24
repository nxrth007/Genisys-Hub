'use client'

import Image from 'next/image'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AccountsResponse } from './shell'
import s from './enter-splash.module.css'

/**
 * The entrance to Hell-level: the Hub's sidebar link opens /hell-level?enter=1,
 * and this plays over the CRM (already loading underneath) until "Enter
 * Genisys CRM", which dives into the eye, whites out, swaps the URL to the
 * last sub-account and fades to reveal it. Black, white and grey only.
 */

const TITLE = 'Hell-level'
const SYSTEM_LINE = 'You have been granted access.'
const LAST_KEY = 'hl-last-account'
/** When the white-out covers the screen: the CRM route swaps in under it. */
const SWAP_MS = 860
/** When the overlay has faded away completely. */
const DONE_MS = 1650

export function EnterSplashGate() {
  const params = useSearchParams()
  const wanted = params.get('enter') === '1'
  // Stays up after the URL loses ?enter=1, until its fade-out has finished.
  const [leaving, setLeaving] = useState(false)
  const start = useCallback(() => setLeaving(true), [])
  const end = useCallback(() => setLeaving(false), [])
  if (!wanted && !leaving) return null
  return <EnterSplash onLeaveStart={start} onLeaveEnd={end} />
}

function EnterSplash({ onLeaveStart, onLeaveEnd }: { onLeaveStart: () => void; onLeaveEnd: () => void }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [leaving, setLeaving] = useState(false)
  const leavingRef = useRef(false)
  const timers = useRef<number[]>([])
  const button = useRef<HTMLButtonElement>(null)

  /** Where "Enter" goes: the home sub-account (Lead Genisys), else the one used last, else the agency view. */
  const destination = useCallback((): string => {
    const url = new URL(window.location.href)
    url.searchParams.delete('enter')
    if (url.pathname === '/hell-level') {
      const data = qc.getQueryData<AccountsResponse>(['hl', 'accounts'])
      if (data?.defaultAccountId) return `/hell-level/${data.defaultAccountId}/dashboard`
      try {
        const last = localStorage.getItem(LAST_KEY)
        if (last && (!data || data.accounts.some((a) => a.id === last))) return `/hell-level/${last}/dashboard`
      } catch {
        // no storage: the agency view
      }
    }
    return `${url.pathname}${url.search}`
  }, [qc])

  const enter = useCallback(() => {
    if (leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    onLeaveStart()
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const to = destination()
    timers.current.push(window.setTimeout(() => router.replace(to), reduce ? 0 : SWAP_MS))
    timers.current.push(window.setTimeout(onLeaveEnd, reduce ? 60 : DONE_MS))
  }, [destination, onLeaveEnd, onLeaveStart, router])

  useEffect(() => {
    // Warm the destination so the swap under the white-out is instant.
    router.prefetch(destination())
    const focus = window.setTimeout(() => button.current?.focus({ preventScroll: true }), 2300)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.target !== button.current) {
        e.preventDefault()
        enter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(focus)
      window.removeEventListener('keydown', onKey)
    }
  }, [destination, enter, router])

  // The exit's timers outlive re-renders; only unmounting cancels them.
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((t) => window.clearTimeout(t))
  }, [])

  return (
    <div className={cn(s.root, leaving && s.leaving)} role="dialog" aria-modal="true" aria-label="Enter Hell-level">
      <div className={s.art} aria-hidden>
        <div className={s.artInner}>
          <Image className={s.img} src="/hell-level/arise.webp" alt="" fill preload sizes="(max-width: 820px) 100vw, 60vw" draggable={false} />
          <Image className={s.aura} src="/hell-level/arise.webp" alt="" fill sizes="(max-width: 820px) 100vw, 60vw" draggable={false} />
          <span className={cn(s.fog, s.fogA)} />
          <span className={cn(s.fog, s.fogB)} />
          <span className={s.sweep} />
          <span className={s.eye}>
            <span className={s.eyeFlare} />
            <span className={s.eyeCore} />
          </span>
        </div>
      </div>
      <div className={s.vignette} />
      <div className={s.shade} />
      <Embers leaving={leavingRef} />

      <div className={s.hud}>
        <span className={s.hudMark}>
          <i /> Genisys // Hell-level
        </span>
        <span className={s.status}>
          <i /> System online
        </span>
      </div>

      <div className={s.copy}>
        <div className={s.sys}>
          <span className={s.sysLabel}>
            <i /> System
          </span>
          <span className={s.typed}>{SYSTEM_LINE}</span>
        </div>
        <div className={s.titleWrap}>
          <h1 className={s.title} aria-label={TITLE}>
            {[...TITLE].map((ch, i) => (
              <span key={i} className={s.char} style={{ animationDelay: `${1.15 + i * 0.055}s` }} aria-hidden>
                {ch}
              </span>
            ))}
          </h1>
          <p className={s.ghost} aria-hidden>
            {TITLE}
          </p>
        </div>
        <p className={s.sub}>Genisys CRM</p>
        <p className={s.tagline}>Every lead, every call, every text. Answered.</p>
        <div className={s.actions}>
          <span className={s.btnWrap}>
            <button ref={button} type="button" className={s.btn} onClick={enter}>
              <span className={s.btnLabel}>Enter Genisys CRM</span>
              <ArrowRight className={s.btnArrow} strokeWidth={1.75} />
            </button>
          </span>
          <span className={s.hint}>
            Press <kbd>Enter ↵</kbd>
          </span>
        </div>
      </div>

      <p className={s.credit}>
        Created by <b>@Nxrth</b>
      </p>

      <span className={s.arise} aria-hidden>
        Arise
      </span>
      <div className={s.flash} />
      <div className={s.grain} />
      <div className={s.scan} />
    </div>
  )
}

type Ember = { x: number; y: number; size: number; vy: number; vx: number; alpha: number; rot: number; spin: number; square: boolean; phase: number }

/**
 * Embers and shards drifting up through the frame (the artwork's own
 * debris, set in motion). Drawn white; the canvas blends with "difference",
 * so over the bright backdrop they read dark. On "Enter" they rush upward.
 */
function Embers({ leaving }: { leaving: React.RefObject<boolean> }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let w = 0
    let h = 0
    let embers: Ember[] = []
    const rand = (a: number, b: number) => a + Math.random() * (b - a)
    const spawn = (y?: number): Ember => {
      const big = Math.random() < 0.12
      return {
        x: rand(0, w),
        y: y ?? rand(0, h),
        size: rand(0.8, 2.8) * (big ? 2.2 : 1),
        vy: -rand(0.12, 0.6),
        vx: rand(-0.12, 0.12),
        alpha: rand(0.25, 0.9),
        rot: rand(0, Math.PI),
        spin: rand(-0.02, 0.02),
        square: Math.random() < 0.62,
        phase: rand(0, Math.PI * 2),
      }
    }
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = window.innerWidth
      h = window.innerHeight
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
      el.style.width = `${w}px`
      el.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const want = reduce ? 18 : Math.min(110, Math.round((w * h) / 16000))
      embers = Array.from({ length: want }, () => spawn())
    }
    resize()
    window.addEventListener('resize', resize)

    const start = performance.now()
    let warp = 1
    let raf = 0
    const frame = (now: number) => {
      const t = (now - start) / 1000
      ctx.clearRect(0, 0, w, h)
      // Fade in over the first two seconds; rush on the way out.
      const intro = reduce ? 1 : Math.min(1, t / 2)
      warp = leaving.current ? Math.min(16, warp * 1.12 + 0.4) : 1
      for (const e of embers) {
        e.phase += 0.025
        e.x += e.vx + Math.sin(e.phase) * 0.18
        e.y += e.vy * warp * (1 + e.size * 0.12)
        e.rot += e.spin * (warp > 1 ? 3 : 1)
        if (e.y < -20) Object.assign(e, spawn(h + 10))
        const a = e.alpha * intro * (0.62 + 0.38 * Math.sin(e.phase * 1.7))
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`
        if (warp > 2) {
          // Streaks once they rush.
          ctx.fillRect(e.x, e.y, Math.max(1, e.size * 0.55), e.size * warp * 1.6)
        } else if (e.square) {
          ctx.save()
          ctx.translate(e.x, e.y)
          ctx.rotate(e.rot)
          ctx.fillRect(-e.size / 2, -e.size * 0.35, e.size, e.size * 0.7)
          ctx.restore()
        } else {
          ctx.beginPath()
          ctx.arc(e.x, e.y, e.size * 0.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      if (!reduce || leaving.current) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [leaving])

  return <canvas ref={canvas} className={s.embers} aria-hidden />
}
