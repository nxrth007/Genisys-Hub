import { type LucideIcon } from 'lucide-react'

/**
 * Used on every module page that isn't implemented yet.
 * Lists the concrete features we're going to build in that module so the user
 * can see the plan at a glance.
 */
export function ModulePlaceholder({
  icon: Icon,
  title,
  summary,
  features,
}: {
  icon: LucideIcon
  title: string
  summary: string
  features: string[]
}) {
  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-4">
        <div className="rounded-lg bg-primary-soft p-2.5 bg-primary-soft">
          <Icon className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
      </div>
      <p className="text-muted-foreground mb-6">{summary}</p>

      <div className="rounded-xl border border-border bg-card p-6 border-border bg-card">
        <h3 className="font-semibold mb-3 text-sm text-muted-foreground uppercase tracking-wide">
          Coming in this module
        </h3>
        <ul className="space-y-2">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-sm">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-foreground" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-6 text-xs text-muted-foreground/70">
        Scaffold only — module implementation lands in a follow-up commit.
      </p>
    </div>
  )
}
