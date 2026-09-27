import Link from 'next/link'
import { cn } from '@/lib/utils'

/**
 * Page header:
 *   breadcrumbs (mono eyebrow, "/" separators)
 *   title (26px semibold, tight tracking)
 *   subtitle (13px, muted)
 *
 * Actions slot on the right. The optional `icon` prop is kept for
 * backward compatibility with pages that still pass one but is not
 * rendered — the sidebar already conveys page context.
 */
export type Crumb = { label: string; href?: string }

export function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
}: {
  /** Optional — accepted for compat; not rendered. */
  icon?: React.ComponentType<{ className?: string }>
  title: string
  subtitle?: string
  breadcrumbs?: Crumb[]
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="eyebrow mb-2.5 flex flex-wrap items-center gap-2 text-muted-foreground"
          >
            {breadcrumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-2">
                {c.href ? (
                  <Link href={c.href} className="transition hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  <span
                    className={cn(
                      i === breadcrumbs.length - 1 && 'text-foreground/80'
                    )}
                  >
                    {c.label}
                  </span>
                )}
                {i < breadcrumbs.length - 1 && (
                  <span aria-hidden className="text-muted-foreground/50">
                    /
                  </span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 text-[13px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-3">
          {actions}
        </div>
      )}
    </div>
  )
}
