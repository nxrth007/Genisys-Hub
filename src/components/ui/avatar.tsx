import { cn } from '@/lib/utils'

/**
 * Initials-in-a-colored-circle avatar. Color is deterministic from the
 * email/name so the same user always gets the same hue across the app.
 *
 * Follows Ethan's demo aesthetic — small rounded color dots next to names
 * everywhere (agent cards, sidebar user footer, appointment rows, etc.).
 */

const COLORS = [
  'bg-blue-500',
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-cyan-500',
  'bg-pink-500',
  'bg-teal-500',
  'bg-orange-500',
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

function initialsFrom(name: string | null | undefined, email: string | null | undefined): string {
  const source = name?.trim() || email?.split('@')[0] || '?'
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

export function Avatar({
  name,
  email,
  size = 'md',
  className,
}: {
  name?: string | null
  email?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}) {
  const seed = (email || name || '').toLowerCase()
  const color = COLORS[hashString(seed) % COLORS.length]
  const initials = initialsFrom(name, email)

  const sizeCls =
    size === 'xs'
      ? 'h-5 w-5 text-[9px]'
      : size === 'sm'
        ? 'h-8 w-8 text-xs'
        : size === 'lg'
          ? 'h-12 w-12 text-base'
          : 'h-9 w-9 text-sm'

  return (
    <div
      className={cn(
        'inline-flex flex-shrink-0 items-center justify-center rounded-full font-semibold text-white',
        color,
        sizeCls,
        className
      )}
      aria-hidden
    >
      {initials}
    </div>
  )
}
