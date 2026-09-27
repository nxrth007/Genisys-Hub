import { cn } from '@/lib/utils'

/**
 * Status chip — pulls colours from the chip-* CSS utilities in
 * globals.css so a single class controls both background + foreground
 * in both palettes. Mono, uppercase, squared-off: a tag, not a pill.
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
  // tone. Useful for counts and non-status badges.
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
        'eyebrow inline-flex items-center rounded-md px-2 py-1',
        TONE_CLASS[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
