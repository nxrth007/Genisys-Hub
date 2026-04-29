'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  PhoneCall,
  ClipboardList,
  PhoneForwarded,
  Trophy,
  FileSpreadsheet,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Pill-style tab nav for the Call Center subsections. Matches Ethan's
 * reference design — rounded pills with icons that stay visible against
 * the page background rather than the old underline-on-border style.
 */

const TABS = [
  { href: '/call-center', label: 'Appointments', icon: PhoneCall, exact: true },
  { href: '/call-center/callbacks', label: 'Callbacks', icon: PhoneForwarded },
  { href: '/call-center/eod-reports', label: 'EOD Reports', icon: ClipboardList },
  { href: '/call-center/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/call-center/master-tracker', label: 'Master Tracker', icon: FileSpreadsheet },
]

export function CallCenterTabs() {
  const pathname = usePathname()
  return (
    <div className="flex flex-wrap items-center gap-1">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href)
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/80'
            )}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
