import Link from 'next/link'
import { cn } from '@/lib/utils'

/**
 * Page header — matches the mockup's TopBar:
 *   breadcrumbs (small, muted, "→" separators)
 *   title (28px semibold, tight tracking)
 *   subtitle (small, muted)
 *
 * Actions slot on the right. The optional `icon` prop is kept for
 * backward compatibility with pages that still pass one but is not
 * rendered — the sidebar already conveys page context, the mockup
 * leaves this row uncluttered.
 */
export type Crumb = { label: string; href?: string }

export function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
}: {
  /** Optional — accepted for compat; ignored since the mockup omits it. */
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
            className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            {breadcrumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-2">
                {c.href ? (
                  <Link href={c.href} className="hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  <span
                    className={cn(
                      i === breadcrumbs.length - 1 && 'text-foreground/70'
                    )}
                  >
                    {c.label}
                  </span>
                )}
                {i < breadcrumbs.length - 1 && (
                  <span aria-hidden className="opacity-60">
                    →
                  </span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
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
