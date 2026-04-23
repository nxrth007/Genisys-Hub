'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { signOut } from 'next-auth/react'
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
  PhoneCall,
  FolderOpen,
  Target,
  LogOut,
  HelpCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from './theme-toggle'
import { Avatar } from '../ui/avatar'

type NavItem = {
  href: string
  label: string
  icon: typeof LayoutDashboard
  adminOnly?: boolean
}

// Primary navigation. Settings + Agents live in the footer section since
// they're less-frequently used than the core modules.
const mainNav: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/today', label: 'Today', icon: CheckCircle2 },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/outbox', label: 'Outbox', icon: Send },
  { href: '/crm', label: 'CRM', icon: MessageSquare },
  { href: '/calendar', label: 'Calendar', icon: Calendar },
  { href: '/notion', label: 'Notion', icon: BookOpen },
  { href: '/drive', label: 'Drive', icon: HardDrive },
  { href: '/documents', label: 'Documents', icon: FolderOpen },
  { href: '/slack', label: 'Slack', icon: Hash },
  { href: '/vault', label: 'Vault', icon: Key },
  { href: '/call-center', label: 'Call Center', icon: PhoneCall },
  { href: '/agents', label: 'Agents', icon: Headphones, adminOnly: true },
]

const footerNav: NavItem[] = [
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()

  const { data: session } = useQuery<{
    user?: { name?: string | null; email?: string | null; role?: string }
  }>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return {}
      return res.json()
    },
  })
  const role = session?.user?.role
  const visibleMain = mainNav.filter((n) => !n.adminOnly || role === 'admin')

  const displayName = session?.user?.name || session?.user?.email || 'Signed in'
  const email = session?.user?.email || ''
  const roleLabel =
    role === 'admin' ? 'Admin' : role === 'member' ? 'Member' : 'Signed in'

  return (
    <aside className="hidden flex-col border-r border-zinc-200 bg-zinc-50 md:flex md:w-64 dark:border-zinc-800 dark:bg-zinc-950">
      {/* ---- Brand + theme toggle ---- */}
      <div className="flex items-center justify-between gap-2 px-4 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600">
            <Target className="h-4 w-4 text-white" />
          </div>
          <span className="text-base font-semibold tracking-tight">Genisys Hub</span>
        </div>
        <ThemeToggle />
      </div>

      {/* ---- Main nav ---- */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <SectionLabel>Main menu</SectionLabel>
        <nav className="space-y-0.5">
          {visibleMain.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </nav>
      </div>

      {/* ---- Footer: settings + user card ---- */}
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <nav className="mb-3 space-y-0.5">
          {footerNav.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
          <a
            href="https://github.com/nxrth007/Genisys-Hub/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <HelpCircle className="h-4 w-4 flex-shrink-0" />
            Help & Support
          </a>
        </nav>

        {session?.user && (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
            <Avatar name={displayName} email={email} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{displayName}</p>
              <p className="truncate text-xs text-zinc-500">{roleLabel}</p>
            </div>
            <button
              onClick={() => signOut({ callbackUrl: '/signin' })}
              title="Sign out"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 mt-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
      {children}
    </p>
  )
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const isActive =
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  return (
    <Link
      href={item.href}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
      )}
    >
      <item.icon className="h-4 w-4 flex-shrink-0" />
      {item.label}
    </Link>
  )
}
