'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  PhoneCall,
  ClipboardList,
  PhoneForwarded,
  Trophy,
  FileSpreadsheet,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Inline pill tabs — ported from Ethan's CRM mockup. Container is a
 * rounded-full bar with shadow-soft; the active tab gets bg-card +
 * text-primary + shadow-soft, inactive ones blend into the
 * surface-muted background. Same tokens flip cleanly in dark mode.
 */

const TABS = [
  { href: '/call-center', label: 'Appointments', icon: PhoneCall, exact: true },
  { href: '/call-center/agents', label: 'Agents', icon: Users },
  { href: '/call-center/callbacks', label: 'Callbacks', icon: PhoneForwarded },
  { href: '/call-center/eod-reports', label: 'EOD Reports', icon: ClipboardList },
  { href: '/call-center/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/call-center/master-tracker', label: 'Master Tracker', icon: FileSpreadsheet },
]

export function CallCenterTabs() {
  const pathname = usePathname()
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-full border border-border bg-surface-muted p-1">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href)
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition',
              active
                ? 'bg-card text-primary shadow-soft'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
