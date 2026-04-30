import { cn } from '@/lib/utils'
import { TrendingUp, TrendingDown } from 'lucide-react'

/**
 * StatCard — ported from Ethan's CRM mockup.
 *
 *   LABEL (small, muted)
 *   LARGE VALUE                 +14%   (optional trend badge)
 *   ▰▰▰▰▰▰▰▰▱▱  (optional progress bar in tone color)
 *   subtitle (small, muted)
 *
 * Surface uses the new design tokens (bg-surface, border-border,
 * shadow-soft) so light/dark mode stays consistent across the app.
 * Tone controls the bar color; the icon + label stay neutral so the
 * card reads as data-first, not decoration-first.
 */

export type StatTone = 'blue' | 'green' | 'amber' | 'red' | 'indigo' | 'zinc'

const TONE_BAR: Record<StatTone, string> = {
  blue: 'bg-sky-400',
  green: 'bg-emerald-500',
  amber: 'bg-amber-400',
  red: 'bg-rose-500',
  indigo: 'bg-violet-500',
  zinc: 'bg-zinc-400',
}

export function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
  trend,
  progress,
  tone = 'blue',
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  subtitle?: string
  /** Percentage delta; positive or negative. Renders a +X% / -X% badge. */
  trend?: number | null
  /** 0–100. Renders a thin colored bar. Omit to hide it. */
  progress?: number | null
  tone?: StatTone
  className?: string
}) {
  const pct = progress == null ? null : Math.max(0, Math.min(100, progress))

  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-card p-4 shadow-soft',
        className
      )}
    >
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        <p className="text-[13px] text-muted-foreground">{label}</p>
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <p className="text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
          {value}
        </p>
        {trend != null && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium',
              trend >= 0 ? 'text-emerald-600' : 'text-rose-600'
            )}
          >
            {trend >= 0 ? (
              <TrendingUp className="h-3.5 w-3.5" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5" />
            )}
            {trend >= 0 ? '+' : ''}
            {trend}%
          </span>
        )}
      </div>

      {pct != null && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-[width]', TONE_BAR[tone])}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {subtitle && (
        <p className="mt-1.5 text-xs text-muted-foreground">{subtitle}</p>
      )}
    </div>
  )
}
