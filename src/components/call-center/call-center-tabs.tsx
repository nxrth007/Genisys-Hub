'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  PhoneCall,
  ClipboardList,
  PhoneForwarded,
  Trophy,
  FileSpreadsheet,
  Users,
  MessagesSquare,
  Inbox,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Inline pill tabs — ported from Ethan's CRM mockup. Container is a
 * rounded-full bar with shadow-soft; the active tab gets bg-card +
 * text-primary + shadow-soft, inactive ones blend into the
 * surface-muted background. Same tokens flip cleanly in dark mode.
 */

const TABS = [
  // Master Tracker leads — Ethan's primary deliverable view, so it's
  // the first thing he wants to see when he opens Call Center.
  { href: '/call-center/master-tracker', label: 'Master Tracker', icon: FileSpreadsheet },
  { href: '/call-center', label: 'Appointments', icon: PhoneCall, exact: true },
  { href: '/call-center/agents', label: 'Agents', icon: Users },
  { href: '/call-center/callbacks', label: 'Callbacks', icon: PhoneForwarded },
  { href: '/call-center/eod-reports', label: 'EOD Reports', icon: ClipboardList },
  { href: '/call-center/reminders', label: 'Reminders', icon: MessagesSquare },
  { href: '/call-center/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/call-center/status-updates', label: 'Status Updates', icon: Inbox },
]

export function CallCenterTabs() {
  const pathname = usePathname()
  // Unreviewed-count poll. 60s interval matches the master-tracker
  // freshness check — slow enough to not hammer the API, fast enough
  // that a fresh client update shows up before admin would normally
  // refresh manually. Failures fall through to zero (the badge
  // disappears) so an API outage doesn't render a confusing red dot.
  const { data } = useQuery<{ unreviewed: number }>({
    queryKey: ['status-updates-summary'],
    queryFn: async () => {
      const res = await fetch('/api/call-center/status-updates/summary')
      if (!res.ok) return { unreviewed: 0 }
      return res.json()
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const unreviewed = data?.unreviewed ?? 0

  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-full border border-border bg-surface-muted p-1">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href)
        const showBadge = t.href === '/call-center/status-updates' && unreviewed > 0
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              'relative inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition',
              active
                ? 'bg-card text-primary shadow-soft'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
            {showBadge && (
              <span
                className="ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white"
                title={`${unreviewed} client status update${unreviewed === 1 ? '' : 's'} awaiting review`}
              >
                {unreviewed > 99 ? '99+' : unreviewed}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
