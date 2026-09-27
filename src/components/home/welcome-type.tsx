'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * "Welcome to / Genisys" typed onto the Home canvas.
 *
 * Line one types like a terminal. Line two decodes: each letter cycles
 * through a few random glyphs before it settles, left to right, so the
 * name resolves rather than appears. A block cursor blinks through the
 * whole sequence and stays; a hairline draws in under the name when it
 * is done. It rests for thirty seconds, then clears and plays again.
 * With reduced motion the finished text renders once and stays.
 */

const LINE_ONE = 'WELCOME TO'
const LINE_TWO = 'Genisys'
const GLYPHS = '01<>/[]{}=+*#%&@$-_:;abcdefXYZ'

const START_DELAY = 400
const TYPE_MS = 55
const PAUSE_MS = 260
const DECODE_FRAMES = 4
const DECODE_MS = 38
/** How long the finished text rests before the sequence plays again. */
const REPLAY_MS = 30_000

type Phase = 'idle' | 'one' | 'two' | 'done'

function randomGlyph() {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
}

export function WelcomeType({ className }: { className?: string }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [one, setOne] = useState('')
  const [two, setTwo] = useState('')

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const t = setTimeout(() => {
        setOne(LINE_ONE)
        setTwo(LINE_TWO)
        setPhase('done')
      }, 0)
      return () => clearTimeout(t)
    }

    const timers: number[] = []
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))

    // One full sequence, then a reset and another after REPLAY_MS —
    // for as long as the page is open.
    const run = () => {
      let t = START_DELAY
      at(t, () => setPhase('one'))
      for (let i = 1; i <= LINE_ONE.length; i++) {
        t += TYPE_MS
        const n = i
        at(t, () => setOne(LINE_ONE.slice(0, n)))
      }

      t += PAUSE_MS
      at(t, () => setPhase('two'))
      for (let i = 0; i < LINE_TWO.length; i++) {
        const settled = LINE_TWO.slice(0, i)
        for (let f = 0; f < DECODE_FRAMES; f++) {
          t += DECODE_MS
          // The letter being decoded flickers; everything after it is not
          // there yet, so the word grows as it resolves.
          at(t, () => setTwo(settled + randomGlyph()))
        }
        t += DECODE_MS
        at(t, () => setTwo(LINE_TWO.slice(0, i + 1)))
      }
      t += 200
      at(t, () => setPhase('done'))

      at(t + REPLAY_MS, () => {
        setOne('')
        setTwo('')
        setPhase('idle')
        run()
      })
    }
    run()

    return () => timers.forEach((id) => clearTimeout(id))
  }, [])

  const cursorOn = (line: 'one' | 'two') =>
    (phase === 'one' && line === 'one') ||
    ((phase === 'two' || phase === 'done') && line === 'two')

  return (
    <div className={cn('select-none', className)} aria-label="Welcome to Genisys">
      <p className="eyebrow mb-4 text-muted-foreground/60">
        <span className="text-primary/80">{'//'}</span> sys.init
      </p>

      <p className="flex h-7 items-center font-mono text-[15px] uppercase tracking-[0.32em] text-muted-foreground">
        <span>{one}</span>
        {cursorOn('one') && <Cursor className="ml-1 h-[1em] w-[0.6em]" />}
      </p>

      <p className="mt-2 flex h-[1.1em] items-center text-[clamp(44px,6vw,76px)] font-semibold leading-none tracking-[-0.035em] text-foreground">
        <span
          className="font-mono"
          style={{ textShadow: '0 0 28px oklch(1 0 0 / 22%), 0 0 2px oklch(1 0 0 / 40%)' }}
        >
          {two}
        </span>
        {cursorOn('two') && <Cursor className="ml-2 h-[0.9em] w-[0.5em]" />}
      </p>

      {/* Hairline that draws in once the name has resolved. */}
      <div
        className={cn(
          'mt-5 h-px bg-gradient-to-r from-foreground/60 via-foreground/25 to-transparent transition-[width] duration-700 ease-out',
          phase === 'done' ? 'w-56' : 'w-0',
        )}
      />
    </div>
  )
}

function Cursor({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block animate-[hud-blink_1s_steps(1)_infinite] bg-foreground', className)}
    />
  )
}
