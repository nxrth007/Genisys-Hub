'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PhoneCall, ClipboardList, PhoneForwarded, Trophy } from 'lucide-react'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/call-center', label: 'Appointments', icon: PhoneCall, exact: true },
  { href: '/call-center/callbacks', label: 'Callbacks', icon: PhoneForwarded },
  { href: '/call-center/eod-reports', label: 'EOD Reports', icon: ClipboardList },
  { href: '/call-center/leaderboard', label: 'Leaderboard', icon: Trophy },
]

export function CallCenterTabs() {
  const pathname = usePathname()
  return (
    <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href)
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              'inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-purple-600 text-purple-700 dark:text-purple-300'
                : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:hover:text-zinc-200'
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
