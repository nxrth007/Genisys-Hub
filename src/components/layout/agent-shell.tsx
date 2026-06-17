'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { useQuery } from '@tanstack/react-query'
import {
  Headphones,
  LogOut,
  CalendarCheck,
  ClipboardList,
  PhoneCall,
  Building2,
  Table,
  Bell,
  BellRing,
  MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from './theme-toggle'

/**
 * Minimal chrome for the /agent portal — no sidebar, no CRM/Vault/etc
 * navigation. Agents see only their own dashboard and sign-out.
 *
 * Session read via /api/auth/session (avoids needing a SessionProvider
 * at the root — no other part of the app uses useSession either).
 */
const NAV = [
  { href: '/agent', label: 'Appointments', icon: CalendarCheck, exact: true },
  { href: '/agent/alerts', label: 'Alerts', icon: BellRing },
  { href: '/agent/master-tracker', label: 'Master Tracker', icon: Table },
  { href: '/agent/callbacks', label: 'Callbacks', icon: PhoneCall },
  { href: '/agent/reminders', label: 'Reminders', icon: Bell },
  { href: '/agent/messages', label: 'Messages', icon: MessageSquare },
  { href: '/agent/clients', label: 'Clients', icon: Building2 },
  { href: '/agent/eod', label: 'EOD Reports', icon: ClipboardList },
]

export function AgentShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { data: session } = useQuery<{
    user?: { name?: string | null; email?: string | null }
  }>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return {}
      return res.json()
    },
  })
  const agentName = session?.user?.name || session?.user?.email || ''

  // Unread agent-alert count → red badge on the Alerts nav item so
  // Mary notices a customer decline / no-show without opening the
  // tab. Polls every 60s; cheap count query.
  const { data: alertData } = useQuery<{ unreadCount: number }>({
    queryKey: ['agent-alerts-unread'],
    queryFn: async () => {
      const res = await fetch('/api/agent/alerts?status=unread')
      if (!res.ok) return { unreadCount: 0 }
      const d = await res.json()
      return { unreadCount: d.unreadCount ?? 0 }
    },
    refetchInterval: 60_000,
  })
  const unreadAlerts = alertData?.unreadCount ?? 0

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-6">
          <Link href="/agent" className="flex items-center gap-2">
            <Headphones className="h-5 w-5 text-blue-600" />
            <span className="font-semibold tracking-tight">Genisys Agent</span>
          </Link>
          <nav className="hidden items-center gap-1 sm:flex">
            {NAV.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname.startsWith(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    active
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                      : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                  )}
                >
                  <item.icon className="h-3.5 w-3.5" />
                  {item.label}
                  {item.href === '/agent/alerts' && unreadAlerts > 0 && (
                    <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
                      {unreadAlerts}
                    </span>
                  )}
                </Link>
              )
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {agentName && (
            <span className="hidden text-xs text-zinc-500 sm:inline">{agentName}</span>
          )}
          {/* Per-user theme preference — agents told us light mode was
              hard to read in some lighting; toggle persists in
              localStorage and the inline init script in the root
              layout applies it before paint to avoid a flash. */}
          <ThemeToggle />
          <button
            onClick={() => signOut({ callbackUrl: '/signin/agent' })}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}
