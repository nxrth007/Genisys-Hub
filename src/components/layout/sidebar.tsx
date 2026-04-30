'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { signOut } from 'next-auth/react'
import {
  Settings,
  HelpCircle,
  CheckSquare,
  Phone,
  Building2,
  LayoutGrid,
  LayoutDashboard,
  Inbox,
  Send,
  MessageSquare,
  Calendar,
  HardDrive,
  FolderOpen,
  Hash,
  Key,
  Headphones,
  CheckCircle2,
  Search,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  Moon,
  Sun,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '../ui/avatar'
import { SearchDialog } from './search-dialog'

/**
 * Sidebar — ported from Ethan's CRM mockup. 260px column with:
 *  - Brand + theme toggle + (decorative) collapse button
 *  - Search command pill (opens ⌘K dialog)
 *  - Main menu (role-based: alex sees the full Hub, everyone else
 *    including Ethan sees Tasks / Call Center / Clients)
 *  - Footer: Settings, Help, profile card
 *
 * Visuals come from the OKLch token system in globals.css — active
 * nav items use `bg-primary-soft text-primary` and the whole column
 * sits on `bg-sidebar`, so dark/light mode flips cleanly via the
 * single `.dark` class on <html>.
 */

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}

/** Email of the agency owner — sees the full Hub. Anyone else (Ethan
 *  + future staff additions) gets the simplified curated view. Easier
 *  to expand to a list later than to add a per-user feature flag. */
const FULL_VIEW_EMAILS = new Set(['alex@leadgenisys.com'])

// Simplified set Ethan asked for. Tasks routes to /notion (the task
// board) since that's where our Notion-backed kanban + focus list
// already live; renaming the route would invalidate bookmarks.
const SIMPLIFIED_NAV: NavItem[] = [
  { href: '/notion', label: 'Tasks', icon: CheckSquare },
  { href: '/call-center', label: 'Call Center', icon: Phone },
  { href: '/clients', label: 'Clients', icon: Building2 },
]

// Full nav Alex sees. Same module list as before, plus the new
// Clients page slotted in between Call Center and Notion.
const FULL_NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/today', label: 'Today', icon: CheckCircle2 },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/outbox', label: 'Outbox', icon: Send },
  { href: '/crm', label: 'CRM', icon: MessageSquare },
  { href: '/calendar', label: 'Calendar', icon: Calendar },
  { href: '/call-center', label: 'Call Center', icon: Phone },
  { href: '/clients', label: 'Clients', icon: Building2 },
  { href: '/notion', label: 'Tasks', icon: CheckSquare },
  { href: '/drive', label: 'Drive', icon: HardDrive },
  { href: '/documents', label: 'Documents', icon: FolderOpen },
  { href: '/slack', label: 'Slack', icon: Hash },
  { href: '/vault', label: 'Vault', icon: Key },
  { href: '/agents', label: 'Agents', icon: Headphones },
]

export function Sidebar() {
  const pathname = usePathname()
  const [searchOpen, setSearchOpen] = useState(false)

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

  const email = (session?.user?.email || '').toLowerCase()
  const role = session?.user?.role
  const fullView = FULL_VIEW_EMAILS.has(email)
  const nav = fullView ? FULL_NAV : SIMPLIFIED_NAV

  // ⌘K (or Ctrl+K) toggles the global search anywhere in the Hub.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((s) => !s)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const displayName = session?.user?.name || session?.user?.email || 'Signed in'
  const roleLabel =
    role === 'admin' ? 'Admin' : role === 'member' ? 'Member' : 'Signed in'
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

  return (
    <>
      <aside className="hidden w-[260px] shrink-0 flex-col gap-2 border-r border-border-soft bg-sidebar px-4 py-5 md:flex">
        {/* ---- Brand + theme toggle ---- */}
        <div className="mb-2 flex items-center justify-between px-2">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <LayoutGrid className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <span className="text-[17px] font-semibold tracking-tight text-sidebar-foreground">
              Genisys
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            <CompactThemeToggle />
            {/* Collapse is decorative for now — keeps the visual
                rhythm of the mockup but doesn't trigger any state. */}
            <button
              disabled
              aria-label="Collapse sidebar (coming soon)"
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground/60"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ---- Search command pill ---- */}
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="relative mt-1 flex h-9 w-full items-center gap-2 rounded-xl border border-border bg-surface-muted px-3 text-left text-sm text-muted-foreground transition hover:bg-muted"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1">Search anything</span>
          <kbd className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>

        <p className="mt-4 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Main menu
        </p>

        {/* ---- Main nav ---- */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {nav.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </nav>

        {/* ---- Footer: settings, help, profile ---- */}
        <div className="mt-auto flex flex-col gap-1">
          <NavLink
            item={{ href: '/settings', label: 'Settings', icon: Settings }}
            pathname={pathname}
          />
          <a
            href="https://github.com/nxrth007/Genisys-Hub/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground/75 hover:bg-muted hover:text-foreground"
          >
            <HelpCircle className="h-4 w-4" />
            Help &amp; Support
          </a>

          {session?.user && (
            <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 shadow-soft">
              <Avatar name={displayName} email={email} size="sm" />
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-semibold">{displayName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {roleLabel}
                </p>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: '/signin' })}
                title="Sign out"
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </aside>

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  )
}

/**
 * Compact theme toggle styled to fit the brand row (h-7 w-7 to match
 * the collapse button next to it). Reads/writes localStorage['theme']
 * and mirrors the inline init script in layout.tsx so first paint
 * already has the right theme applied.
 */
function CompactThemeToggle() {
  const [isDark, setIsDark] = useState<boolean | null>(null)
  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'))
  }, [])
  if (isDark === null) {
    return <div className="h-7 w-7" aria-hidden />
  }
  function toggle() {
    const next = !isDark
    setIsDark(next)
    if (next) {
      document.documentElement.classList.add('dark')
      localStorage.setItem('theme', 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('theme', 'light')
    }
  }
  return (
    <button
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active =
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      className={cn(
        'group flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium transition',
        active
          ? 'bg-primary-soft text-primary'
          : 'text-foreground/75 hover:bg-muted hover:text-foreground'
      )}
    >
      <span className="flex items-center gap-3">
        <Icon className="h-4 w-4" strokeWidth={2} />
        {item.label}
      </span>
      {active && <ChevronRight className="h-4 w-4 opacity-60" />}
    </Link>
  )
}
