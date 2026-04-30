'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Pill-shaped dropdown — ported from Ethan's CRM mockup. Same shape +
 * behavior as their Radix-backed version, but lightweight: no Radix
 * Popover dependency, just a button + outside-click-to-close popup.
 *
 * Usage:
 *   <DropdownPill
 *     value={pkg}
 *     options={[{ id: 'all', label: 'All packages' }, …]}
 *     onChange={setPkg}
 *     icon={Calendar}
 *   />
 */

type Option<T extends string> = { id: T; label: string }

export function DropdownPill<T extends string>({
  value,
  options,
  onChange,
  icon: Icon,
  align = 'start',
  className,
}: {
  value: T
  options: ReadonlyArray<Option<T>>
  onChange: (next: T) => void
  icon?: LucideIcon
  align?: 'start' | 'end'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Close when clicking outside the wrapper.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const current = options.find((o) => o.id === value)?.label ?? String(value)

  return (
    <div ref={wrapRef} className={cn('relative inline-block', className)}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2 text-sm font-medium shadow-soft transition hover:bg-muted"
      >
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        <span>{current}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div
          className={cn(
            'absolute z-30 mt-1 w-48 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-pop',
            align === 'end' ? 'right-0' : 'left-0'
          )}
        >
          <ul className="flex flex-col">
            {options.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted',
                    value === o.id && 'bg-primary-soft font-medium text-primary'
                  )}
                >
                  {o.label}
                  {value === o.id && <Check className="h-4 w-4" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
