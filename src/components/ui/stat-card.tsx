import { cn } from '@/lib/utils'
import { TrendingUp, TrendingDown } from 'lucide-react'

/**
 * StatCard — a readout, not a decoration:
 *
 *   LABEL (mono eyebrow)
 *   LARGE VALUE                 +14%   (optional trend, mono)
 *   ▰▰▰▰▰▰▰▰▱▱  (optional 1px progress bar in tone colour)
 *   subtitle (small, muted)
 *
 * Hairline border on the card surface; no shadow. The figure is set
 * in mono with tabular digits so a grid of these lines up.
 */

export type StatTone = 'blue' | 'green' | 'amber' | 'red' | 'indigo' | 'zinc'

const TONE_BAR: Record<StatTone, string> = {
  blue: 'bg-primary',
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-destructive',
  indigo: 'bg-violet-400',
  zinc: 'bg-muted-foreground',
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
        'rounded-xl border border-border bg-card p-4',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
          <p className="eyebrow text-muted-foreground">{label}</p>
        </div>
        {trend != null && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-mono text-[11px] tabular-nums',
              trend >= 0 ? 'text-success' : 'text-destructive'
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

      <p className="mt-2.5 font-mono text-[28px] font-medium leading-none tracking-tight tabular-nums text-foreground">
        {value}
      </p>

      {subtitle && (
        <p className="mt-2 text-xs text-muted-foreground">{subtitle}</p>
      )}

      {pct != null && (
        <div className="mt-4 h-px w-full overflow-hidden bg-border">
          <div
            className={cn('h-full transition-[width]', TONE_BAR[tone])}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  )
}
