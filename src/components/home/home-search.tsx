'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, ArrowRight, CornerDownLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSearchIndex } from '@/components/layout/use-search-index'

/**
 * The Home page's search bar. Same index as ⌘K (pages, clients,
 * agents); results open upward from the bar since it sits low on the
 * page. `/` focuses it from anywhere on Home, ↑/↓ move, Enter goes.
 */
export function HomeSearch({ className }: { className?: string }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  const { results } = useSearchIndex({ enabled: true, query: q, limit: 7 })
  const open = focused && q.trim().length > 0

  // "/" focuses the bar unless the user is already typing somewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      const typing =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function go(href: string) {
    setQ('')
    inputRef.current?.blur()
    router.push(href)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQ('')
      inputRef.current?.blur()
      return
    }
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(results[active].href)
    }
  }

  return (
    <div className={cn('relative w-full max-w-xl', className)}>
      {open && (
        <ul className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-border bg-popover py-1.5 shadow-pop">
          {results.length === 0 ? (
            <li className="px-4 py-4 text-center font-mono text-[12px] text-muted-foreground">
              No matches for &ldquo;{q}&rdquo;.
            </li>
          ) : (
            results.map((r, i) => (
              <li key={`${r.type}:${r.href}:${r.label}`}>
                <button
                  type="button"
                  // mousedown so the click lands before the input blurs
                  onMouseDown={(e) => {
                    e.preventDefault()
                    go(r.href)
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2 text-left',
                    i === active && 'bg-muted',
                  )}
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
                  {i === active ? (
                    <CornerDownLeft className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  ) : (
                    <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      <div
        className={cn(
          'flex h-12 items-center gap-3 rounded-xl border bg-surface/80 px-4 backdrop-blur transition',
          focused ? 'border-primary/50 ring-1 ring-primary/25' : 'border-border',
        )}
      >
        <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          placeholder="Search clients, pages, agents"
          spellCheck={false}
          autoComplete="off"
          className="h-full w-full bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground/70"
        />
        <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:block">
          /
        </kbd>
      </div>
    </div>
  )
}
