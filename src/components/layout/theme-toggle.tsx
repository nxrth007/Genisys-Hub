'use client'

import { useSyncExternalStore } from 'react'
import { Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Palette toggle: Obsidian (near-black) ↔ Graphite (dark grey).
 *
 * Both palettes are dark, so `.dark` stays on <html> permanently and the
 * toggle only adds or removes `.graphite`. Persists to the same
 * localStorage key the init script in layout.tsx reads — 'dark' means
 * Obsidian, 'light' means Graphite, kept for compatibility with saved
 * preferences from before the rename.
 *
 * The <html> class list is the source of truth, read through an
 * external-store subscription so every toggle on the page agrees and
 * nothing renders the wrong icon during hydration.
 */

function subscribeToRootClass(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  return () => observer.disconnect()
}
const readGraphite = () => document.documentElement.classList.contains('graphite')
const serverGraphite = () => null

export function useGraphite() {
  const graphite = useSyncExternalStore(subscribeToRootClass, readGraphite, serverGraphite)

  function toggle() {
    const next = !readGraphite()
    document.documentElement.classList.toggle('graphite', next)
    try {
      localStorage.setItem('theme', next ? 'light' : 'dark')
    } catch {
      // localStorage may be disabled in strict-privacy modes — non-fatal.
    }
  }

  return { graphite, toggle }
}

export function ThemeToggle({ className }: { className?: string }) {
  const { graphite, toggle } = useGraphite()

  if (graphite === null) {
    return <div className={cn('h-8 w-8', className)} aria-hidden />
  }

  return (
    <button
      onClick={toggle}
      aria-label={graphite ? 'Switch to Obsidian' : 'Switch to Graphite'}
      title={graphite ? 'Obsidian' : 'Graphite'}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {graphite ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  )
}
