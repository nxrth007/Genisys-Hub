'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  LayoutDashboard,
  Inbox,
  MessageSquare,
  Settings,
  Calendar,
  BookOpen,
  Send,
  CheckCircle2,
  Key,
  Hash,
  HardDrive,
  Headphones,
  Target,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type NavItem = {
  href: string
  label: string
  icon: typeof LayoutDashboard
  adminOnly?: boolean
}

const navItems: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/today', label: 'Today', icon: CheckCircle2 },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/outbox', label: 'Outbox', icon: Send },
  { href: '/crm', label: 'CRM', icon: MessageSquare },
  { href: '/calendar', label: 'Calendar', icon: Calendar },
  { href: '/notion', label: 'Notion', icon: BookOpen },
  { href: '/drive', label: 'Drive', icon: HardDrive },
  { href: '/slack', label: 'Slack', icon: Hash },
  { href: '/vault', label: 'Vault', icon: Key },
  { href: '/agents', label: 'Agents', icon: Headphones, adminOnly: true },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()

  // Pull session so we can hide admin-only nav items from non-admins. If the
  // query is still loading we optimistically show all items — middleware
  // blocks non-admin access at the route level anyway, so this is just UX.
  const { data: session } = useQuery<{ user?: { role?: string } }>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return {}
      return res.json()
    },
  })
  const role = session?.user?.role
  const visibleNav = navItems.filter((n) => !n.adminOnly || role === 'admin')

  return (
    <aside className="hidden md:flex md:w-64 md:flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex h-16 items-center gap-2 border-b border-zinc-200 px-6 dark:border-zinc-800">
        <Target className="h-6 w-6 text-purple-600" />
        <span className="text-lg font-bold tracking-tight">Genisys Hub</span>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {visibleNav.map((item) => {
          const isActive =
            item.href === '/'
              ? pathname === '/'
              : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-zinc-500">GENISYS</p>
            <p className="text-xs text-zinc-400">Hub v0.1</p>
          </div>
          <Target className="h-4 w-4 text-purple-600/50" />
        </div>
      </div>
    </aside>
  )
}
