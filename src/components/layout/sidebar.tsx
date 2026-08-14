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
  Inbox,
  Send,
  MessageSquare,
  Calendar,
  HardDrive,
  FolderOpen,
  Hash,
  Key,
  Headphones,
  Wallet,
  CheckCircle2,
  Search,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Sun,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { canAccessPayments } from '@/lib/payments-access'
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
  /** Optional prefix used for the active-state highlight. Defaults to
   *  `href`. Lets a nav item link to a deep route (e.g. Call Center →
   *  /call-center/master-tracker) while still highlighting whenever
   *  the user is anywhere under the parent (/call-center/...). */
  match?: string
}

/** Email of the agency owner — sees the full Hub. Anyone else (Ethan
 *  + future staff additions) gets the simplified curated view. Easier
 *  to expand to a list later than to add a per-user feature flag. */
const FULL_VIEW_EMAILS = new Set(['alex@leadgenisys.com'])

// Simplified set Ethan asked for. Tasks routes to /today — that's
// where the embedded TaskBoard + meetings + booking stats live, i.e.
// the agent's "what do I do right now" view. /notion exists too for
// Alex's full nav as the broader task-DB browser.
//
// CRM lives here too: with the reminder system creating GHL contacts
// automatically, conversation threads pile up fast and Ethan needs to
// see them himself rather than asking Alex every time. The CRM page's
// own filter chips (Sales / Reminder line) keep the noise managed.
const SIMPLIFIED_NAV: NavItem[] = [
  { href: '/today', label: 'Tasks', icon: CheckSquare },
  // Call Center → land on Master Tracker (the deliverable view) by
  // default; `match: '/call-center'` keeps the nav item highlighted
  // for any sub-tab (Appointments / Callbacks / Agents / etc.).
  {
    href: '/call-center/master-tracker',
    match: '/call-center',
    label: 'Call Center',
    icon: Phone,
  },
  { href: '/crm', label: 'CRM', icon: MessageSquare },
  { href: '/clients', label: 'Clients', icon: Building2 },
  // Documents — Ethan needs the pinned financials + Mary client
  // sheets at the top of the page just like Alex does. There's
  // no path-level admin gate on /documents, so just exposing the
  // nav link makes it reachable.
  { href: '/documents', label: 'Documents', icon: FolderOpen },
]

// Full nav Alex sees. /today is the canonical landing page (the
// root `/` redirects there); /notion stays separate as the broader
// Notion DB browser for power users.
//
// The Dashboard entry was removed 2026-05-11 (Alex + Ethan): the
// old welcome / module-grid page was redundant with this sidebar,
// so /app/page.tsx is now a redirect to /today and the nav entry
// pointed at the same place. Removing it deduplicates the nav.
const FULL_NAV: NavItem[] = [
  { href: '/today', label: 'Today', icon: CheckCircle2 },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/outbox', label: 'Outbox', icon: Send },
  { href: '/crm', label: 'CRM', icon: MessageSquare },
  { href: '/calendar', label: 'Calendar', icon: Calendar },
  // Same Master-Tracker-by-default behavior in the full nav.
  {
    href: '/call-center/master-tracker',
    match: '/call-center',
    label: 'Call Center',
    icon: Phone,
  },
  { href: '/clients', label: 'Clients', icon: Building2 },
  { href: '/notion', label: 'Notion', icon: CheckSquare },
  { href: '/drive', label: 'Drive', icon: HardDrive },
  { href: '/documents', label: 'Documents', icon: FolderOpen },
  { href: '/slack', label: 'Slack', icon: Hash },
  { href: '/vault', label: 'Vault', icon: Key },
  { href: '/agents', label: 'Agents', icon: Headphones },
]

export function Sidebar() {
  const pathname = usePathname()
  const [searchOpen, setSearchOpen] = useState(false)
  // Collapsed mode — narrows the column to icons only. Persisted in
  // localStorage so the choice sticks across reloads. We hydrate from
  // storage in an effect (rather than the inline init script in
  // layout.tsx) to avoid a layout-shift cost; the first paint shows
  // the expanded view, and if the user has it collapsed it snaps to
  // narrow on mount.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    if (saved === 'true') setCollapsed(true)
  }, [])
  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem('sidebar-collapsed', String(next))
      } catch {
        // localStorage may be disabled in strict-privacy modes — non-fatal.
      }
      return next
    })
  }

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
  const baseNav = fullView ? FULL_NAV : SIMPLIFIED_NAV
  // Payments — tight email allowlist (owner + Ethan), NOT role=admin, so
  // Mary/Hannah (admins) don't get it. Appended to whichever base nav the
  // viewer sees.
  const nav = canAccessPayments(email)
    ? [...baseNav, { href: '/payments', label: 'Payments', icon: Wallet }]
    : baseNav

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
      <aside
        className={cn(
          'hidden shrink-0 flex-col gap-2 border-r border-border-soft bg-sidebar py-5 transition-[width] duration-200 md:flex',
          collapsed ? 'w-[68px] px-2' : 'w-[260px] px-4'
        )}
      >
        {/* ---- Brand + theme toggle + collapse ---- */}
        <div
          className={cn(
            'mb-2 flex items-center px-2',
            collapsed ? 'flex-col gap-1' : 'justify-between'
          )}
        >
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <LayoutGrid className="h-4 w-4" strokeWidth={2.25} />
            </div>
            {!collapsed && (
              <span className="text-[17px] font-semibold tracking-tight text-sidebar-foreground">
                Genisys
              </span>
            )}
          </div>
          <div
            className={cn(
              'flex items-center gap-0.5',
              collapsed && 'flex-col'
            )}
          >
            <CompactThemeToggle />
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* ---- Search ---- */}
        {collapsed ? (
          // Collapsed: icon-only square that opens the same palette.
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            title={`Search · ${isMac ? '⌘K' : 'Ctrl+K'}`}
            className="mt-1 grid h-9 w-full place-items-center rounded-xl border border-border bg-surface-muted text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <Search className="h-4 w-4" />
          </button>
        ) : (
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
        )}

        {!collapsed && (
          <p className="mt-4 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Main menu
          </p>
        )}

        {/* ---- Main nav ---- */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {nav.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              collapsed={collapsed}
            />
          ))}
        </nav>

        {/* ---- Footer: settings, help, profile ---- */}
        <div className="mt-auto flex flex-col gap-1">
          <NavLink
            item={{ href: '/settings', label: 'Settings', icon: Settings }}
            pathname={pathname}
            collapsed={collapsed}
          />
          <a
            href="https://github.com/nxrth007/Genisys-Hub/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            title="Help & Support"
            className={cn(
              'flex items-center gap-3 rounded-xl text-sm font-medium text-foreground/75 transition hover:bg-muted hover:text-foreground',
              collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
            )}
          >
            <HelpCircle className="h-4 w-4 flex-shrink-0" />
            {!collapsed && 'Help & Support'}
          </a>

          {session?.user &&
            (collapsed ? (
              // Collapsed profile — avatar-only with sign-out tooltip.
              // Single click signs out (the floating menu is heavy in
              // a 68px column; we'd rather click than juggle popovers).
              <button
                onClick={() => signOut({ callbackUrl: '/signin' })}
                title={`${displayName} · Click to sign out`}
                className="mt-2 grid h-9 w-full place-items-center rounded-xl border border-border bg-surface shadow-soft hover:bg-muted"
              >
                <Avatar name={displayName} email={email} size="sm" />
              </button>
            ) : (
              <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 shadow-soft">
                <Avatar name={displayName} email={email} size="sm" />
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-semibold">
                    {displayName}
                  </p>
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
            ))}
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

function NavLink({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem
  pathname: string
  collapsed?: boolean
}) {
  // Use item.match (when present) for the active-state prefix — lets
  // an item link to a deep route while still highlighting for any
  // page under the parent path. Falls back to href for items that
  // don't need that decoupling.
  const matchPrefix = item.match ?? item.href
  const active =
    matchPrefix === '/' ? pathname === '/' : pathname.startsWith(matchPrefix)
  const Icon = item.icon

  // Collapsed: icon-only, centered in a square, with the label on a
  // native title tooltip. Active state still uses bg-primary-soft so
  // the visual continuity holds when the user toggles modes.
  if (collapsed) {
    return (
      <Link
        href={item.href}
        title={item.label}
        aria-label={item.label}
        className={cn(
          'grid h-10 w-full place-items-center rounded-xl text-sm font-medium transition',
          active
            ? 'bg-primary-soft text-primary'
            : 'text-foreground/75 hover:bg-muted hover:text-foreground'
        )}
      >
        <Icon className="h-4 w-4" strokeWidth={2} />
      </Link>
    )
  }

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
