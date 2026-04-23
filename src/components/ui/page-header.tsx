import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Standardized page header: optional breadcrumb, icon + title + subtitle
 * on the left, actions slot on the right. Used at the top of every
 * full-page view so the layouts feel cohesive.
 */
export type Crumb = { label: string; href?: string }

export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  breadcrumbs,
  actions,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  subtitle?: string
  breadcrumbs?: Crumb[]
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="mb-2 flex flex-wrap items-center gap-1 text-xs text-zinc-500"
          >
            {breadcrumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-zinc-300" />}
                {c.href ? (
                  <Link
                    href={c.href}
                    className="hover:text-zinc-900 dark:hover:text-zinc-200"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span className={cn(i === breadcrumbs.length - 1 && 'text-zinc-700 dark:text-zinc-300')}>
                    {c.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        )}
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
              <Icon className="h-6 w-6 text-blue-600" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle && (
              <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
            )}
          </div>
        </div>
      </div>
      {actions && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  )
}
