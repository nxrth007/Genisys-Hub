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
        <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
          <Icon className="h-6 w-6 text-purple-600" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
      </div>
      <p className="text-zinc-600 dark:text-zinc-400 mb-6">{summary}</p>

      <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="font-semibold mb-3 text-sm text-zinc-500 uppercase tracking-wide">
          Coming in this module
        </h3>
        <ul className="space-y-2">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-sm">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-purple-600" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-6 text-xs text-zinc-400">
        Scaffold only — module implementation lands in a follow-up commit.
      </p>
    </div>
  )
}
