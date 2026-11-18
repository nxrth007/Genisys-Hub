'use client'

import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'

/**
 * Palette switch: Obsidian (near-black) · Graphite (dark grey) · Chalk (light).
 *
 * The <html> class list is the source of truth. Obsidian is `dark`,
 * Graphite is `dark graphite`, and Chalk is `light` — with no `dark`, so
 * every `dark:` utility in the codebase switches off and the `.light`
 * tokens in globals.css take over. The inline script in layout.tsx sets
 * the same classes before first paint.
 *
 * The choice persists under localStorage `palette`. The older `theme` key
 * ('dark' = Obsidian, 'light' = Graphite, from before Chalk existed) is
 * still read when `palette` is missing, so nobody's saved choice is lost.
 *
 * Read through an external-store subscription so every switch on the page
 * agrees and nothing renders the wrong state during hydration.
 */

export type Palette = 'obsidian' | 'graphite' | 'light'

export const PALETTES: { id: Palette; label: string; hint: string }[] = [
  { id: 'obsidian', label: 'Obsidian', hint: 'near-black' },
  { id: 'graphite', label: 'Graphite', hint: 'dark grey' },
  { id: 'light', label: 'Chalk', hint: 'light' },
]

function subscribeToRootClass(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  return () => observer.disconnect()
}

export function readPalette(): Palette {
  const c = document.documentElement.classList
  return c.contains('light') ? 'light' : c.contains('graphite') ? 'graphite' : 'obsidian'
}
const serverPalette = () => null

export function applyPalette(palette: Palette) {
  const c = document.documentElement.classList
  c.toggle('light', palette === 'light')
  c.toggle('dark', palette !== 'light')
  c.toggle('graphite', palette === 'graphite')
  try {
    localStorage.setItem('palette', palette)
  } catch {
    // localStorage may be disabled in strict-privacy modes — non-fatal.
  }
}

export function usePalette() {
  const palette = useSyncExternalStore(subscribeToRootClass, readPalette, serverPalette)
  return { palette, setPalette: applyPalette }
}

/* One swatch per palette in that palette's own canvas colour, hairlined so
   the white one shows on Chalk and the black one on Obsidian. */
const SWATCH: Record<Palette, string> = {
  obsidian: 'bg-[oklch(0.095_0.005_260)]',
  graphite: 'bg-[oklch(0.235_0.008_260)]',
  light: 'bg-[oklch(0.975_0.003_250)]',
}

/**
 * Three swatches in a pill — black, grey, white — the active one ringed
 * in the accent. `vertical` stacks them for the collapsed sidebar.
 */
export function PaletteSwitch({
  className,
  vertical = false,
}: {
  className?: string
  vertical?: boolean
}) {
  const { palette, setPalette } = usePalette()

  if (palette === null) {
    // Server render and the first client frame: hold the space, draw nothing.
    return (
      <div
        className={cn(vertical ? 'h-[66px] w-[26px]' : 'h-[26px] w-[66px]', className)}
        aria-hidden
      />
    )
  }

  return (
    <div
      role="radiogroup"
      aria-label="Palette"
      className={cn(
        'inline-flex rounded-full border border-border bg-surface p-0.5',
        vertical ? 'flex-col' : 'items-center',
        className,
      )}
    >
      {PALETTES.map((p) => {
        const on = p.id === palette
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${p.label} (${p.hint})`}
            title={`${p.label} · ${p.hint}`}
            onClick={() => setPalette(p.id)}
            className="grid h-5 w-5 place-items-center rounded-full transition hover:bg-muted"
          >
            <span
              aria-hidden
              className={cn(
                'block h-2.5 w-2.5 rounded-full ring-1 ring-inset ring-foreground/15 transition',
                SWATCH[p.id],
                on && 'outline outline-[1.5px] outline-offset-[1.5px] outline-primary',
              )}
            />
          </button>
        )
      })}
    </div>
  )
}

/** The agent portal's header switch — the same pill, under its old name. */
export function ThemeToggle({ className }: { className?: string }) {
  return <PaletteSwitch className={className} />
}
