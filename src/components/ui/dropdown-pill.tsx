'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Compact filter dropdown. Lightweight on purpose: a button + an
 * outside-click-to-close popup, no Radix dependency.
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
        className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-card px-3 text-[13px] font-medium transition hover:bg-muted"
      >
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        <span>{current}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div
          className={cn(
            'absolute z-30 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-pop',
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
                    'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-muted',
                    value === o.id && 'bg-white/[0.06] font-medium text-foreground'
                  )}
                >
                  {o.label}
                  {value === o.id && <Check className="h-3.5 w-3.5" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
