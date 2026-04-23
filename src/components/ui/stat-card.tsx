import { cn } from '@/lib/utils'
import { TrendingUp, TrendingDown } from 'lucide-react'

/**
 * StatCard v2 — matches Ethan's Lovable design:
 *
 *   [icon] LABEL
 *   LARGE VALUE          +14%    ↗
 *   ━━━━━━━━━━━━  ← colored progress bar
 *   optional subtitle
 *
 * Used for the 4-across stat rows at the top of Call Center, Dashboard,
 * etc. Tone controls the progress bar + accent color. Progress is an
 * optional 0–100 number; omit to hide the bar.
 */

export type StatTone = 'blue' | 'green' | 'amber' | 'red' | 'indigo' | 'zinc'

const TONES: Record<
  StatTone,
  { bar: string; icon: string; iconBg: string; valueText: string }
> = {
  blue: {
    bar: 'bg-blue-500',
    icon: 'text-blue-600',
    iconBg: 'bg-blue-50 dark:bg-blue-950/50',
    valueText: 'text-zinc-900 dark:text-zinc-100',
  },
  green: {
    bar: 'bg-emerald-500',
    icon: 'text-emerald-600',
    iconBg: 'bg-emerald-50 dark:bg-emerald-950/50',
    valueText: 'text-zinc-900 dark:text-zinc-100',
  },
  amber: {
    bar: 'bg-amber-500',
    icon: 'text-amber-600',
    iconBg: 'bg-amber-50 dark:bg-amber-950/50',
    valueText: 'text-zinc-900 dark:text-zinc-100',
  },
  red: {
    bar: 'bg-rose-500',
    icon: 'text-rose-600',
    iconBg: 'bg-rose-50 dark:bg-rose-950/50',
    valueText: 'text-zinc-900 dark:text-zinc-100',
  },
  indigo: {
    bar: 'bg-indigo-500',
    icon: 'text-indigo-600',
    iconBg: 'bg-indigo-50 dark:bg-indigo-950/50',
    valueText: 'text-zinc-900 dark:text-zinc-100',
  },
  zinc: {
    bar: 'bg-zinc-400',
    icon: 'text-zinc-500',
    iconBg: 'bg-zinc-100 dark:bg-zinc-800/60',
    valueText: 'text-zinc-900 dark:text-zinc-100',
  },
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
  /** Percentage delta; positive or negative. Renders a small +X% / -X% badge. */
  trend?: number | null
  /** 0–100. Renders a filled progress bar at the bottom. */
  progress?: number | null
  tone?: StatTone
  className?: string
}) {
  const t = TONES[tone]
  const pct = progress == null ? null : Math.max(0, Math.min(100, progress))

  return (
    <div
      className={cn(
        'rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900',
        className
      )}
    >
      <div className="flex items-center gap-2">
        {Icon && (
          <div className={cn('rounded-md p-1.5', t.iconBg)}>
            <Icon className={cn('h-3.5 w-3.5', t.icon)} />
          </div>
        )}
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </p>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2">
        <p className={cn('text-3xl font-bold tabular-nums', t.valueText)}>
          {value}
        </p>
        {trend != null && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
              trend >= 0
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
            )}
          >
            {trend >= 0 ? (
              <TrendingUp className="h-2.5 w-2.5" />
            ) : (
              <TrendingDown className="h-2.5 w-2.5" />
            )}
            {trend >= 0 ? '+' : ''}
            {trend}%
          </span>
        )}
      </div>

      {pct != null && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className={cn('h-full rounded-full transition-[width]', t.bar)}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {subtitle && (
        <p className="mt-2 text-[11px] text-zinc-500">{subtitle}</p>
      )}
    </div>
  )
}
