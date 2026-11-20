'use client'

/**
 * Shared pieces of the Tracker pages: the circle marks, the next-action text
 * and the "signed up" times. Hub tokens only, so they read the same in
 * Obsidian, Graphite and Chalk.
 *
 *   done         a filled green circle with a check
 *   blocked      a filled red circle with a cross
 *   in_progress  a blue ring, half filled
 *   pending      an empty grey ring
 *   not_needed   a faint ring with a dash (Stripe, for a client from before Stripe)
 *   none         a faint dashed ring: the Hub has no record either way
 */
import { Check, Minus, PenLine, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { shortDate } from '@/lib/stripe-billing-plan'
import { STATE_WORD, type NextAction, type StepState, type StepView, type TrackerRow } from '@/lib/tracker/derive'

const SIZE = { sm: 'h-3.5 w-3.5', md: 'h-5 w-5', lg: 'h-10 w-10' } as const
const ICON = { sm: 'h-2 w-2', md: 'h-3 w-3', lg: 'h-5 w-5' } as const
const RING = { sm: 'border-[1.5px]', md: 'border-2', lg: 'border-2' } as const
const PEN = { sm: 'hidden', md: '-right-1 -top-1 h-2.5 w-2.5', lg: '-right-0.5 -top-0.5 h-4 w-4' } as const

/** One step's state as a circle. `byHand` adds a small pen: a person marked it, the Hub has no evidence of its own. */
export function Mark({ state, size = 'md', byHand = false, className }: { state: StepState; size?: keyof typeof SIZE; byHand?: boolean; className?: string }) {
  const base = cn('relative inline-flex shrink-0 items-center justify-center rounded-full', SIZE[size], className)
  const pen = byHand ? <PenLine className={cn('absolute rounded-full bg-card p-px text-muted-foreground', PEN[size])} aria-label="by hand" /> : null
  switch (state) {
    case 'done':
      return (
        <span className={cn(base, 'bg-success text-success-foreground')}>
          <Check className={ICON[size]} strokeWidth={3} aria-hidden />
          {pen}
        </span>
      )
    case 'blocked':
      return (
        <span className={cn(base, 'bg-destructive text-destructive-foreground')}>
          <X className={ICON[size]} strokeWidth={3} aria-hidden />
        </span>
      )
    case 'in_progress':
      return (
        <span className={cn(base, RING[size], 'border-primary text-primary')}>
          <svg viewBox="0 0 20 20" className="h-full w-full" aria-hidden>
            <path d="M10 3.5a6.5 6.5 0 0 1 0 13Z" fill="currentColor" />
          </svg>
        </span>
      )
    case 'not_needed':
      return (
        <span className={cn(base, RING[size], 'border-muted-foreground/25 text-muted-foreground/60')}>
          <Minus className={ICON[size]} strokeWidth={2.5} aria-hidden />
        </span>
      )
    case 'none':
      return <span className={cn(base, RING[size], 'border-dashed border-muted-foreground/30')} />
    default:
      return <span className={cn(base, RING[size], 'border-muted-foreground/40')} />
  }
}

/** The tooltip for a mark: state, evidence, date. */
export function markTitle(v: StepView): string {
  return `${STATE_WORD[v.state]}${v.byHand ? ' (by hand)' : ''}${v.note ? ` — ${v.note}` : ''}${v.at ? ` · ${shortDate(v.at)}` : ''}`
}

/** "Text Torrence for onboarding" in red, a waiting note in grey, or a green Done. */
export function NextActionText({ next, stuckDays, stuck, prefix, className }: { next: NextAction; stuckDays?: number | null; stuck?: boolean; prefix?: string; className?: string }) {
  if (next.kind === 'done') return <span className={cn('chip-mint inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium', className)}>Done</span>
  return (
    <span className={cn('inline-flex items-center gap-2', next.kind === 'act' ? 'font-medium text-destructive' : 'text-muted-foreground', className)}>
      <span>
        {prefix}
        {next.text}
      </span>
      {stuck && stuckDays != null && (
        <span className="font-mono text-[11px] font-normal tabular-nums text-warning" title={`Nothing has happened for ${stuckDays} days`}>
          {stuckDays}d
        </span>
      )}
    </span>
  )
}

/** The person first, the way Stripe lists sign-ups; the business when there's no person. */
export function rowTitle(r: Pick<TrackerRow, 'person' | 'clientName'>): string {
  return r.person ?? r.clientName
}

const ET = 'America/New_York'

/** "Nov 19, 12:47 AM" (Eastern). */
export function signedUpShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ET })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ET })}`
}

/** "Nov 19, 2026 at 12:47 AM" (Eastern). */
export function signedUpLong(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: ET })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ET })}`
}
