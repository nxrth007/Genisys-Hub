'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search, ArrowRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSearchIndex } from './use-search-index'

/**
 * Global ⌘K command palette — searches over pages + registered
 * clients + agents in one go. Opens via the "Search" pill in the
 * sidebar or the keyboard shortcut. Click any result to navigate.
 *
 * Implementation note: deliberately lightweight (no Radix dialog
 * dependency) — it's a fixed overlay + portal-less <div>, which keeps
 * the bundle small and matches our existing modal patterns elsewhere.
 */
export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [q, setQ] = useState('')
  const router = useRouter()

  // The query is cleared on every close, so the next open always lands
  // the cursor on a blank input — what users expect from ⌘K palettes.
  const close = useCallback(() => {
    setQ('')
    onOpenChange(false)
  }, [onOpenChange])

  // Esc to close — captured at document level so it works regardless
  // of which element inside the dialog has focus.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const { results } = useSearchIndex({ enabled: open, query: q, limit: 12 })

  if (!open) return null

  function pick(href: string) {
    close()
    router.push(href)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border-soft px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages, clients, agents…"
            className="h-7 w-full bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            esc
          </kbd>
          <button
            type="button"
            onClick={close}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center font-mono text-[12px] text-muted-foreground">
              No matches for &ldquo;{q}&rdquo;.
            </li>
          ) : (
            results.map((r) => (
              <li key={`${r.type}:${r.href}:${r.label}`}>
                <Link
                  href={r.href}
                  onClick={(e) => {
                    // Use router.push via pick() so onOpenChange fires
                    // synchronously — relying on Link's default also
                    // works but the dialog briefly sticks around.
                    e.preventDefault()
                    pick(r.href)
                  }}
                  className="flex items-center gap-3 px-4 py-2 hover:bg-muted"
                >
                  <span
                    className={cn(
                      'eyebrow rounded px-1.5 py-0.5',
                      r.type === 'Page' && 'bg-primary-soft text-primary',
                      r.type === 'Client' && 'chip-mint',
                      r.type === 'Agent' && 'chip-violet',
                    )}
                  >
                    {r.type}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{r.label}</span>
                    {r.hint && (
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {r.hint}
                      </span>
                    )}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
