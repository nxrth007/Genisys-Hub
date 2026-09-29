'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { signOut } from 'next-auth/react'
import {
  Settings,
  HelpCircle,
  CheckSquare,
  Building2,
  Globe,
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
  TrendingUp,
  CheckCircle2,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Sun,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { canAccessPayments } from '@/lib/payments-access'
import { canAccessSeo } from '@/lib/seo/access'
import { Avatar } from '../ui/avatar'
import { SearchDialog } from './search-dialog'
import { useGraphite } from './theme-toggle'

/**
 * Sidebar — a 216px instrument column (56px collapsed):
 *  - Brand mark + palette toggle + collapse
 *  - Search pill (opens ⌘K)
 *  - Main menu (role-based: alex sees the full Hub, everyone else
 *    including Ethan sees the curated set)
 *  - Footer: Settings, Help, profile
 *
 * Nav labels are mono; the active item gets a 2px accent bar on its
 * left edge and a faint fill rather than a coloured pill, so the column
 * reads as a rail of controls instead of a list of buttons.
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
  { href: '/home', label: 'Home', icon: Globe },
  { href: '/today', label: 'Tasks', icon: CheckSquare },
  // Call Center and Call Center 2 were retired 2026-09-26: appointment
  // booking is no longer what the agency does. The routes still exist
  // for history; they just aren't in the nav.
  { href: '/crm', label: 'CRM', icon: MessageSquare },
  { href: '/clients', label: 'Clients', icon: Building2 },
  // Documents — Ethan needs the pinned financials + Mary client
  // sheets at the top of the page just like Alex does. There's
  // no path-level admin gate on /documents, so just exposing the
  // nav link makes it reachable.
  { href: '/documents', label: 'Documents', icon: FolderOpen },
]

// Full nav Alex sees. /home is the landing page (the root `/`
// redirects there); /notion stays separate as the broader Notion DB
// browser for power users.
const FULL_NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: Globe },
  { href: '/today', label: 'Today', icon: CheckCircle2 },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/outbox', label: 'Outbox', icon: Send },
  { href: '/crm', label: 'CRM', icon: MessageSquare },
  { href: '/calendar', label: 'Calendar', icon: Calendar },
  // Call Center and Call Center 2 retired 2026-09-26 (see SIMPLIFIED_NAV).
  { href: '/clients', label: 'Clients', icon: Building2 },
  { href: '/notion', label: 'Notion', icon: CheckSquare },
  { href: '/drive', label: 'Drive', icon: HardDrive },
  { href: '/documents', label: 'Documents', icon: FolderOpen },
  { href: '/slack', label: 'Slack', icon: Hash },
  { href: '/vault', label: 'Vault', icon: Key },
  { href: '/agents', label: 'Agents', icon: Headphones },
]

// Collapsed mode — narrows the column to icons only. Persisted in
// localStorage and read as an external store, so the first client
// render already knows the answer (the server renders expanded) and
// the mobile drawer's copy of the sidebar stays in step with desktop.
const COLLAPSED_KEY = 'sidebar-collapsed'
const COLLAPSED_EVENT = 'sidebar-collapsed-change'

function subscribeCollapsed(onChange: () => void) {
  window.addEventListener(COLLAPSED_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(COLLAPSED_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}
function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}
const serverCollapsed = () => false

export function Sidebar() {
  const pathname = usePathname()
  const [searchOpen, setSearchOpen] = useState(false)
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, serverCollapsed)
  function toggleCollapsed() {
    try {
      localStorage.setItem(COLLAPSED_KEY, String(!readCollapsed()))
    } catch {
      // localStorage may be disabled in strict-privacy modes — non-fatal.
    }
    window.dispatchEvent(new Event(COLLAPSED_EVENT))
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
  // SEO and Payments — tight email allowlists (owner + Ethan), NOT
  // role=admin, so Mary/Hannah (admins) don't get them. Appended to
  // whichever base nav the viewer sees, SEO just before Payments.
  const nav: NavItem[] = [
    ...baseNav,
    ...(canAccessSeo(email) ? [{ href: '/seo', label: 'SEO', icon: TrendingUp }] : []),
    ...(canAccessPayments(email) ? [{ href: '/payments', label: 'Payments', icon: Wallet }] : []),
  ]

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
          'hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-4 transition-[width] duration-200 md:flex',
          collapsed ? 'w-[56px] px-1.5' : 'w-[216px] px-3',
        )}
      >
        {/* ---- Brand + palette toggle + collapse ---- */}
        <div
          className={cn(
            'mb-3 flex items-center',
            collapsed ? 'flex-col gap-1.5' : 'justify-between px-1',
          )}
        >
          <Link href="/home" className="flex items-center gap-2.5" title="Home">
            <span className="grid h-7 w-7 place-items-center rounded-md border border-border bg-surface font-mono text-[12px] font-semibold text-foreground">
              G
            </span>
            {!collapsed && (
              <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground">
                Genisys
              </span>
            )}
          </Link>
          <div className={cn('flex items-center', collapsed && 'flex-col')}>
            <CompactThemeToggle />
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-3.5 w-3.5" />
              ) : (
                <PanelLeftClose className="h-3.5 w-3.5" />
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
            className="grid h-8 w-full place-items-center rounded-md border border-border bg-surface text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-left font-mono text-[12px] text-muted-foreground transition hover:border-border hover:bg-muted hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="flex-1">Search</span>
            <kbd className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
              {isMac ? '⌘K' : 'Ctrl K'}
            </kbd>
          </button>
        )}

        {!collapsed && <p className="eyebrow mb-1 mt-5 px-2 text-muted-foreground/70">Menu</p>}
        {collapsed && <div className="mb-1 mt-4 h-px w-full bg-border-soft" />}

        {/* ---- Main nav ---- */}
        <nav className="flex flex-1 flex-col gap-px overflow-y-auto">
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
        <div className="mt-auto flex flex-col gap-px pt-3">
          <div className="mb-2 h-px w-full bg-border-soft" />
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
              'flex h-8 items-center gap-2.5 rounded-md font-mono text-[12.5px] text-foreground/70 transition hover:bg-muted hover:text-foreground',
              collapsed ? 'justify-center px-0' : 'px-2.5',
            )}
          >
            <HelpCircle className="h-[15px] w-[15px] flex-shrink-0" strokeWidth={1.75} />
            {!collapsed && 'Help'}
          </a>

          {session?.user &&
            (collapsed ? (
              // Collapsed profile — avatar-only with sign-out tooltip.
              // Single click signs out (a floating menu is heavy in a
              // 56px column; we'd rather click than juggle popovers).
              <button
                onClick={() => signOut({ callbackUrl: '/signin' })}
                title={`${displayName} · Click to sign out`}
                className="mt-2 grid h-9 w-full place-items-center rounded-md border border-border bg-surface hover:bg-muted"
              >
                <Avatar name={displayName} email={email} size="sm" />
              </button>
            ) : (
              <div className="mt-2 flex items-center gap-2.5 rounded-md border border-border bg-surface px-2.5 py-2">
                <Avatar name={displayName} email={email} size="sm" />
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-[13px] font-medium leading-tight">
                    {displayName}
                  </p>
                  <p className="eyebrow mt-0.5 truncate text-muted-foreground">
                    {roleLabel}
                  </p>
                </div>
                <button
                  onClick={() => signOut({ callbackUrl: '/signin' })}
                  title="Sign out"
                  className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
 * Compact palette toggle sized to sit next to the collapse button.
 * Obsidian shows a sun (go lighter), Graphite shows a moon (go darker).
 */
function CompactThemeToggle() {
  const { graphite, toggle } = useGraphite()
  if (graphite === null) {
    return <div className="h-7 w-7" aria-hidden />
  }
  return (
    <button
      onClick={toggle}
      aria-label={graphite ? 'Switch to Obsidian' : 'Switch to Graphite'}
      title={graphite ? 'Obsidian' : 'Graphite'}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      {graphite ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
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

  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        'relative flex h-8 items-center gap-2.5 rounded-md font-mono text-[12.5px] transition',
        collapsed ? 'justify-center px-0' : 'px-2.5',
        active
          ? 'bg-white/[0.06] text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[2px] before:rounded-full before:bg-primary'
          : 'text-foreground/70 hover:bg-white/[0.04] hover:text-foreground',
      )}
    >
      <Icon
        className={cn('h-[15px] w-[15px] flex-shrink-0', active && 'text-primary')}
        strokeWidth={1.75}
      />
      {!collapsed && item.label}
    </Link>
  )
}
