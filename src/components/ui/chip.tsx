import { cn } from '@/lib/utils'

/**
 * Pastel status chip — pulls colors from the chip-* CSS utilities in
 * globals.css so a single Tailwind class controls both background +
 * foreground in light & dark mode. Mirrors the mockup's `<Chip>`.
 */

export type ChipTone =
  | 'pink'
  | 'amber'
  | 'mint'
  | 'blue'
  | 'violet'
  | 'muted'

const TONE_CLASS: Record<ChipTone, string> = {
  pink: 'chip-pink',
  amber: 'chip-amber',
  mint: 'chip-mint',
  blue: 'chip-blue',
  violet: 'chip-violet',
  // "muted" stays neutral — used when we want a chip shape without a
  // pastel tone. Useful for counts and non-status badges.
  muted: 'bg-muted text-muted-foreground',
}

export function Chip({
  children,
  tone = 'muted',
  className,
}: {
  children: React.ReactNode
  tone?: ChipTone
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
        TONE_CLASS[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
