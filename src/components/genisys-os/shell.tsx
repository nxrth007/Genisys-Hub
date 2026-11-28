'use client'

import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { signOut } from 'next-auth/react'
import { ArrowLeft, Bell, Building2, ChevronDown, ChevronsUpDown, EyeOff, Flame, Home, Layers, LayoutDashboard, LogOut, Phone, Pin, RefreshCcw, Search, Settings, Sparkles, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { prettyPhone } from '@/lib/hl/merge'
import { MEMBER_SECTIONS } from '@/lib/hl/member-access'
import { Avatar, hlFetch } from './ui'
import { ArrivalGate, EnterSplashGate } from './enter-splash'
import { SECTIONS, SETTINGS_SECTION, activeTab, defaultTab, laterTabs, sectionOf, shownTabs, type Section, type SectionTab } from './nav'
import { ConfirmHost } from './confirm'
import { ViewerContext, type HlViewer } from './viewer'
import { MobileDrawer, MobileTabBar, MobileTopBar } from './mobile-nav'
import { InstallHint, PhoneAppEffects, PhoneAppWorker } from './phone-app'
import { NotifyCard, NotifySwitch, forgetThisDevice, useAppBadge } from './notifications'

/** A section as a sub-account login sees it: only their tabs (null when it isn't theirs). */
function memberSection(s: Section): Section | null {
  const tabs = MEMBER_SECTIONS[s.key]
  if (!tabs) return null
  return s.tabs ? { ...s, tabs: s.tabs.filter((t) => tabs.includes(t.key)) } : s
}

export type AccountRow = {
  id: string
  name: string
  clientId: string | null
  clientName: string | null
  owner: string | null
  website: string | null
  ghlLocationId: string | null
  number: { number: string; kind: string; verification: string } | null
  contacts: number
  unread: number
  lastLeadAt: string | null
  createdAt: string
}

export type AccountsResponse = {
  accounts: AccountRow[]
  clientsWithout: { id: string; name: string; contactName: string | null; lifecycle: string }[]
  /** The sub-account Genisys OS opens on (Lead Genisys). */
  defaultAccountId: string | null
}

export function useAccounts() {
  return useQuery<AccountsResponse>({
    queryKey: ['hl', 'accounts'],
    queryFn: () => hlFetch<AccountsResponse>('/api/hl/accounts'),
    refetchInterval: 30_000,
  })
}

const LAST_KEY = 'hl-last-account'

/**
 * The agency view's menu (GHL's agency sidebar, the parts Genisys OS has).
 * The Launchpad (its setup guide, all done) moved into Settings; its page
 * still opens.
 */
const AGENCY_NAV = [
  { href: '/genisys-os/agency/ask-ai', label: 'Ask AI', icon: Sparkles },
  { href: '/genisys-os/agency/dashboard', label: 'Agency Dashboard', icon: LayoutDashboard },
  { href: '/genisys-os', label: 'Sub-Accounts', icon: Building2 },
  { href: '/genisys-os/agency/snapshots', label: 'Account Snapshots', icon: Layers },
]
const AGENCY_SETTINGS = { href: '/genisys-os/agency/settings', label: 'Settings', icon: Settings }
const AGENCY_TITLES = [...AGENCY_NAV, AGENCY_SETTINGS, { href: '/genisys-os/agency/launchpad', label: 'Setup Guide' }]
const agencyTitle = (pathname: string) => AGENCY_TITLES.find((n) => n.href === pathname)?.label ?? 'Agency view'

/**
 * Genisys OS's frame: GoHighLevel's sub-account structure (the left menu in
 * GHL's order, section tabs across the top) in the Hub's own look.
 *
 * On a phone (under 768px) it's laid out as an app instead (mobile-nav.tsx):
 * a top bar, the five everyday screens along the bottom and this same menu
 * sliding in from the left. Contractors add it to their home screen
 * (app-meta.ts, phone-app.tsx) and it opens full screen.
 */
export function HellShell({ children, viewer }: { children: React.ReactNode; viewer: HlViewer }) {
  const params = useParams<{ accountId?: string }>()
  const pathname = usePathname()
  const accountId = params?.accountId ?? null
  const accounts = useAccounts()
  const current = accounts.data?.accounts.find((a) => a.id === accountId) ?? null
  const sectionKey = accountId ? pathname.split('/')[3] : undefined
  const found = sectionOf(sectionKey)
  const section = found && !viewer.admin ? memberSection(found) : found
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    if (!accountId) return
    try {
      localStorage.setItem(LAST_KEY, accountId)
      // The switcher's "Recent": newest first.
      writeList(RECENT_KEY, [accountId, ...readList(RECENT_KEY).filter((x) => x !== accountId)].slice(0, 6))
    } catch {
      // private mode: the switcher still works, it just won't remember
    }
  }, [accountId])

  const base = accountId ? `/genisys-os/${accountId}` : null
  // GoHighLevel-import lists only show where an import filled them (Lead Genisys).
  const imported = !!current?.ghlLocationId
  const title = section?.label ?? (accountId ? '' : agencyTitle(pathname))
  // The number on a contractor's home-screen icon: their conversations waiting (staff see every client, so none).
  useAppBadge(viewer.admin || !accounts.data ? null : accounts.data.accounts.reduce((n, a) => n + a.unread, 0))

  return (
    <div className="gos-app fixed inset-0 flex overflow-hidden bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-foreground">
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <SidebarBody viewer={viewer} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar
          title={title || current?.name || 'Genisys OS'}
          subtitle={title && current ? current.name : null}
          unread={current?.unread ?? 0}
          unreadHref={base ? `${base}/conversations?filter=unread` : null}
          onMenu={() => setMenu(true)}
        />
        <header className="hidden h-[54px] shrink-0 items-center gap-6 border-b border-border px-5 md:flex">
          <p className="shrink-0 text-[15px] font-semibold text-foreground">{title}</p>
          {section?.tabs && base && (
            <Suspense fallback={null}>
              <SectionTabs section={section} href={`${base}/${section.key}`} imported={imported} admin={viewer.admin} />
            </Suspense>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {current?.number && (
              <span className="hidden items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[12px] text-muted-foreground lg:inline-flex" title="This sub-account’s number">
                <Phone className="h-3 w-3" />
                {prettyPhone(current.number.number)}
              </span>
            )}
            {base && (
              <Link href={`${base}/conversations?filter=unread`} className="relative grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" title="Unread conversations">
                <Bell className="h-4 w-4" />
                {!!current?.unread && (
                  <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 font-mono text-[9px] font-bold text-destructive-foreground">{current.unread > 99 ? '99+' : current.unread}</span>
                )}
              </Link>
            )}
          </div>
        </header>
        {/* On a phone the section's tabs get their own row under the top bar. */}
        {section?.tabs && base && (
          <Suspense fallback={null}>
            <SectionTabs section={section} href={`${base}/${section.key}`} imported={imported} admin={viewer.admin} strip />
          </Suspense>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          {/* Where a contractor lands after signing in: how to put the app on their home screen, then to turn on notifications (phones only, until done or hidden). */}
          {base && sectionKey === 'dashboard' && (
            <>
              <InstallHint />
              <NotifyCard accountId={accountId!} staff={viewer.admin} />
            </>
          )}
          <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>
        </main>
        {base && (
          <Suspense fallback={null}>
            <MobileTabBar base={base} active={sectionKey} unread={current?.unread ?? 0} />
          </Suspense>
        )}
      </div>
      <MobileDrawer open={menu} onClose={() => setMenu(false)}>
        <SidebarBody viewer={viewer} roomy />
      </MobileDrawer>
      {/* The entrance (Hub sidebar → /genisys-os?enter=1), over the CRM loading underneath; and the white fading off after /login. */}
      <Suspense fallback={null}>
        {viewer.admin && <EnterSplashGate />}
        <ArrivalGate />
      </Suspense>
      <ConfirmHost />
      <PhoneAppEffects />
      <PhoneAppWorker />
    </div>
  )
}

/**
 * The menu: the logo, the account switcher, search, the sections and the
 * foot (Settings and the way back to the Hub for Genisys; who's signed in and
 * Sign out for a sub-account's own login). The desktop sidebar, and the
 * phone's slide-in menu (`roomy`: rows big enough for a thumb).
 */
function SidebarBody({ viewer, roomy }: { viewer: HlViewer; roomy?: boolean }) {
  const params = useParams<{ accountId?: string }>()
  const pathname = usePathname()
  const accountId = params?.accountId ?? null
  const accounts = useAccounts()
  const current = accounts.data?.accounts.find((a) => a.id === accountId) ?? null
  const sectionKey = accountId ? pathname.split('/')[3] : undefined
  const base = accountId ? `/genisys-os/${accountId}` : null
  // Sections with nothing built fold away under "Not built yet" (Genisys staff only; logins never see them).
  const top = viewer.admin ? SECTIONS.filter((s) => s.group === 'top' && !s.later) : SECTIONS.filter((s) => s.key in MEMBER_SECTIONS)
  const grow = viewer.admin ? SECTIONS.filter((s) => s.group === 'grow' && !s.later) : []
  const folded = viewer.admin ? SECTIONS.filter((s) => s.later) : []

  return (
    <>
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <span className="grid h-7 w-7 place-items-center rounded-md border border-border bg-surface text-foreground">
          <Flame className="h-3.5 w-3.5" />
        </span>
        <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground">Genisys OS</span>
      </div>

      <AccountSwitcher accounts={accounts.data?.accounts ?? []} defaultId={accounts.data?.defaultAccountId ?? null} current={current} loading={accounts.isLoading} admin={viewer.admin} />
      {base && <QuickSearch base={base} roomy={roomy} />}

      <nav className="mt-3 flex flex-1 flex-col gap-px overflow-y-auto px-3 pb-3">
        {!base ? (
          AGENCY_NAV.map((n) => <NavLink key={n.href} href={n.href} label={n.label} icon={n.icon} active={pathname === n.href} roomy={roomy} />)
        ) : (
          <>
            {top.map((s) => (
              <NavLink key={s.key} href={`${base}/${s.key}`} label={s.label} icon={s.icon} active={sectionKey === s.key} badge={s.key === 'conversations' ? current?.unread : undefined} tag={s.badge} roomy={roomy} />
            ))}
            {grow.length > 0 && <div className="my-2 h-px bg-border-soft" />}
            {grow.map((s) => (
              <NavLink key={s.key} href={`${base}/${s.key}`} label={s.label} icon={s.icon} active={sectionKey === s.key} tag={s.badge} roomy={roomy} />
            ))}
            {folded.length > 0 && <NotBuiltGroup base={base} sections={folded} active={sectionKey} roomy={roomy} />}
          </>
        )}
      </nav>

      {viewer.admin ? (
        <div className="flex flex-col gap-px border-t border-border-soft px-3 py-3">
          {/* Staff choose, client by client, whose leads buzz this device. */}
          {base && accountId && <NotifySwitch accountId={accountId} accountName={current?.name ?? null} staff roomy={roomy} />}
          {base ? (
            <NavLink href={`${base}/settings`} label={SETTINGS_SECTION.label} icon={SETTINGS_SECTION.icon} active={sectionKey === 'settings'} roomy={roomy} />
          ) : (
            <NavLink href={AGENCY_SETTINGS.href} label={AGENCY_SETTINGS.label} icon={AGENCY_SETTINGS.icon} active={pathname === AGENCY_SETTINGS.href} roomy={roomy} />
          )}
          <Link
            href="/home"
            className={cn('flex items-center gap-2.5 rounded-md px-2.5 font-mono text-foreground/60 transition hover:bg-foreground/[0.04] hover:text-foreground', roomy ? 'h-11 text-[14px]' : 'h-8 text-[12.5px]')}
          >
            <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
            Back to the Hub
          </Link>
        </div>
      ) : (
        <div className="border-t border-border-soft">
        {accountId && (
          <div className="px-1.5 pt-2">
            <NotifySwitch accountId={accountId} accountName={current?.name ?? null} staff={false} roomy={roomy} />
          </div>
        )}
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Avatar name={viewer.name || viewer.email} size={roomy ? 32 : 26} />
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate font-medium text-foreground', roomy ? 'text-[14px]' : 'text-[12.5px]')}>{viewer.name || viewer.email}</span>
            {viewer.name && <span className={cn('block truncate text-muted-foreground', roomy ? 'text-[12px]' : 'text-[11px]')}>{viewer.email}</span>}
          </span>
          <button
            type="button"
            // The phone stops getting this login's notifications first: the next person to sign in on it shouldn't see these leads.
            onClick={() => void forgetThisDevice().finally(() => signOut({ callbackUrl: '/login' }))}
            className={cn('grid shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground', roomy ? 'h-11 w-11' : 'h-8 w-8')}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="h-[15px] w-[15px]" strokeWidth={1.75} />
          </button>
        </div>
        </div>
      )}
    </>
  )
}

/**
 * A section's tabs across the top: the built ones (and the GHL-import lists
 * on an imported sub-account), then, for Genisys staff, a "not built" menu
 * holding the section's "Not in Genisys OS yet" tabs. `strip`: the phone's
 * row of them under the top bar, swiped sideways when they don't fit.
 */
function SectionTabs({ section, href, imported, admin, strip }: { section: Section; href: string; imported: boolean; admin: boolean; strip?: boolean }) {
  const sp = useSearchParams()
  const pathname = usePathname()
  // On a page under the section (a workflow, a form), the default tab stays lit.
  const current = activeTab(section, pathname === href ? sp.get('tab') : null)
  const all = section.tabs ?? []
  const later = admin ? laterTabs(all, { folded: section.later }) : []
  const shown = shownTabs(all, { imported, folded: section.later })
  // A tab that's off the bar (opened from an old link) shows while it's open.
  const extra = all.find((t) => t.key === current && !shown.includes(t) && !later.includes(t))
  const tabs = extra ? [...shown, extra] : shown
  const home = defaultTab(section)
  if (tabs.length < 2 && !later.length) return null
  const bar = (
    <div className="flex min-w-0 items-stretch gap-1 self-stretch">
      <nav className={cn('-mb-px flex min-w-0 items-stretch gap-1 overflow-x-auto', strip && 'no-scrollbar')}>
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.key === home ? href : `${href}?tab=${t.key}`}
            className={cn(
              'flex shrink-0 items-center border-b-2 px-2.5 text-[13px] transition',
              strip && 'px-3 text-[13.5px]',
              current === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {later.length > 0 && <LaterTabsMenu tabs={later} href={href} current={current} />}
    </div>
  )
  if (!strip) return bar
  return <div className="flex h-11 shrink-0 items-stretch border-b border-border bg-sidebar px-1 md:hidden">{bar}</div>
}

/** The section's unbuilt tabs, one click away (it reads as the tab while one is open). */
function LaterTabsMenu({ tabs, href, current }: { tabs: SectionTab[]; href: string; current: string | null }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const on = tabs.find((t) => t.key === current)
  return (
    <div ref={box} className="relative -mb-px flex shrink-0 items-stretch">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Not built yet: GoHighLevel has these, Genisys OS doesn't yet"
        className={cn(
          'flex items-center gap-1 border-b-2 px-2.5 text-[13px] transition',
          on ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground/60 hover:text-foreground',
        )}
      >
        {on ? on.label : `${tabs.length} not built`}
        <ChevronDown className={cn('h-3 w-3 transition', open && 'rotate-180')} />
      </button>
      {open && (
        // On a phone the menu sits at the row's right end, so it opens leftwards.
        <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-1 shadow-pop md:left-0 md:right-auto">
          <p className="eyebrow px-2.5 pb-1 pt-1.5 text-muted-foreground">Not built yet</p>
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={`${href}?tab=${t.key}`}
              onClick={() => setOpen(false)}
              className={cn('block rounded-md px-2.5 py-1.5 text-[13px] transition hover:bg-muted', t.key === current ? 'text-foreground' : 'text-muted-foreground')}
            >
              {t.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

/** The sections with nothing built (Payments, AI Agents, Marketing), folded at the foot of the menu; open while you're in one. */
function NotBuiltGroup({ base, sections, active, roomy }: { base: string; sections: Section[]; active: string | undefined; roomy?: boolean }) {
  const [open, setOpen] = useState(false)
  // Always open while you're in one of them.
  const shown = open || sections.some((s) => s.key === active)
  return (
    <>
      <div className="my-2 h-px bg-border-soft" />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={shown}
        title="GoHighLevel has these; Genisys OS doesn't yet. Folded away, nothing switched off."
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2.5 font-mono text-foreground/45 transition hover:bg-foreground/[0.04] hover:text-foreground/80',
          roomy ? 'h-11 text-[14px]' : 'h-8 text-[12.5px]',
        )}
      >
        <EyeOff className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />
        <span className="flex-1 text-left">Not built yet</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition', shown && 'rotate-180')} />
      </button>
      {shown && sections.map((s) => <NavLink key={s.key} href={`${base}/${s.key}`} label={s.label} icon={s.icon} active={active === s.key} muted roomy={roomy} />)}
    </>
  )
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  badge,
  tag,
  muted,
  roomy,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  active: boolean
  badge?: number
  tag?: string
  /** A folded section's link: quieter than the rest of the menu. */
  muted?: boolean
  /** The phone's menu: a row a thumb can hit. */
  roomy?: boolean
}) {
  return (
    <Link
      href={href}
      className={cn(
        'relative flex items-center gap-2.5 rounded-md px-2.5 font-mono transition',
        roomy ? 'h-11 text-[14px]' : 'h-8 text-[12.5px]',
        active
          ? 'bg-foreground/[0.06] text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[2px] before:rounded-full before:bg-primary'
          : muted
            ? 'text-foreground/45 hover:bg-foreground/[0.04] hover:text-foreground'
            : 'text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground',
      )}
    >
      <Icon className={cn('h-[15px] w-[15px] shrink-0', active && 'text-primary')} strokeWidth={1.75} />
      <span className="flex-1 truncate">{label}</span>
      {tag && <span className="eyebrow rounded bg-warning/15 px-1.5 py-px text-[9px] text-warning">{tag}</span>}
      {!!badge && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 font-mono text-[9px] font-bold text-destructive-foreground">{badge}</span>}
    </Link>
  )
}

const RECENT_KEY = 'hl-recent-accounts'
const PIN_KEY = 'hl-pinned-accounts'

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // private mode: not remembered
  }
}

/** GHL's account switcher: search, "Switch to Agency View", recent sub-accounts, then all of them with home and pin. */
function AccountSwitcher({ accounts, defaultId, current, loading, admin }: { accounts: AccountRow[]; defaultId: string | null; current: AccountRow | null; loading: boolean; admin: boolean }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const params = useParams<{ accountId?: string }>()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Switching keeps you on the same section of the other sub-account (GHL does the same).
  const section = params?.accountId ? pathname.split('/')[3] || 'dashboard' : 'dashboard'
  // A sub-account login on just the one has nothing to switch to.
  const fixed = !admin && accounts.length <= 1

  return (
    <div ref={box} className="relative px-3">
      <button
        type="button"
        onClick={() => !fixed && setOpen((o) => !o)}
        className={cn('flex w-full items-center gap-2.5 rounded-md border border-border bg-surface px-2.5 py-2 text-left transition', fixed ? 'cursor-default' : 'hover:bg-muted')}
      >
        {current ? (
          <Avatar name={current.name} size={26} />
        ) : (
          <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-primary-soft text-primary">
            <RefreshCcw className="h-3.5 w-3.5" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{current?.name ?? (loading ? 'Loading…' : 'Click here to switch')}</span>
          <span className="eyebrow block truncate text-muted-foreground">{current ? (admin && current.id === defaultId ? 'Home sub-account' : current.owner || 'Sub-account') : 'Agency view'}</span>
        </span>
        {!fixed && <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {open && <SwitcherPanel accounts={accounts} defaultId={defaultId} current={current} section={section} admin={admin} onClose={() => setOpen(false)} />}
    </div>
  )
}

function SwitcherPanel({ accounts, defaultId, current, section, admin, onClose }: { accounts: AccountRow[]; defaultId: string | null; current: AccountRow | null; section: string; admin: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  // Read when the panel opens (it's only ever on screen in the browser).
  const [pinned, setPinned] = useState<string[]>(() => readList(PIN_KEY))
  const [recentIds] = useState<string[]>(() => readList(RECENT_KEY))
  const togglePin = (id: string) => {
    const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [id, ...pinned]
    setPinned(next)
    writeList(PIN_KEY, next)
  }
  const s = q.trim().toLowerCase()
  const matches = (a: AccountRow) => !s || `${a.name} ${a.owner ?? ''} ${a.clientName ?? ''}`.toLowerCase().includes(s)
  const recent = recentIds
    .map((id) => accounts.find((a) => a.id === id))
    .filter((a): a is AccountRow => !!a && a.id !== current?.id)
    .slice(0, 3)
  const rank = (a: AccountRow) => (pinned.includes(a.id) ? 0 : a.id === defaultId ? 1 : 2)
  const all = accounts.filter(matches).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  const card = (a: AccountRow, tools: boolean) => (
    <div key={`${tools ? 'all' : 'recent'}-${a.id}`} className={cn('mx-3 mb-1.5 flex items-center gap-2 rounded-md border px-2.5 py-2 transition', a.id === current?.id ? 'border-primary/50 bg-primary-soft' : 'border-border hover:bg-muted')}>
      <Link href={`/genisys-os/${a.id}/${section}`} onClick={onClose} className="flex min-w-0 flex-1 items-center gap-2.5">
        <Avatar name={a.name} size={26} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{a.name}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">{a.owner || a.clientName || (a.ghlLocationId ? 'Imported from GoHighLevel' : 'Sub-account')}</span>
        </span>
        {!!a.unread && <span className="rounded-full bg-destructive px-1.5 font-mono text-[10px] font-bold text-destructive-foreground">{a.unread}</span>}
      </Link>
      {tools && admin && (
        <>
          {/* The home sub-account (where Genisys OS opens; Lead Genisys) is marked, not changed from here: it also
              decides where the GHL import and the setup guide look. */}
          {a.id === defaultId && (
            <span className="grid h-7 w-7 place-items-center text-primary" title="Home sub-account: Genisys OS opens here">
              <Home className="h-3.5 w-3.5 fill-primary/20" />
            </span>
          )}
          <button
            type="button"
            onClick={() => togglePin(a.id)}
            className={cn('grid h-7 w-7 place-items-center rounded-md transition', pinned.includes(a.id) ? 'text-primary' : 'text-muted-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground')}
            title={pinned.includes(a.id) ? 'Unpin' : 'Pin to the top'}
          >
            <Pin className={cn('h-3.5 w-3.5', pinned.includes(a.id) && 'fill-primary')} />
          </button>
        </>
      )}
    </div>
  )

  return (
    <div className="absolute left-3 top-full z-50 mt-1.5 flex w-[min(330px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-pop">
      <div className="p-3 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-md border border-primary/50 bg-surface px-2.5 text-[13px] text-muted-foreground">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for a sub-account" className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
      {current && admin && (
        <Link href="/genisys-os/agency/dashboard" onClick={onClose} className="mx-3 mb-2 flex w-fit items-center gap-2 text-[12.5px] font-medium text-primary hover:underline">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
            <Undo2 className="h-3 w-3" />
          </span>
          Switch to Agency View
        </Link>
      )}
      <div className="max-h-[60vh] overflow-y-auto border-t border-border pb-2">
        {!s && recent.length > 0 && (
          <>
            <p className="eyebrow px-3 pb-1.5 pt-3 text-muted-foreground">Recent</p>
            {recent.map((a) => card(a, false))}
          </>
        )}
        <p className="eyebrow px-3 pb-1.5 pt-3 text-muted-foreground">All accounts</p>
        {all.map((a) => card(a, true))}
        {!all.length && <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">No sub-accounts match.</p>}
      </div>
    </div>
  )
}

function QuickSearch({ base, roomy }: { base: string; roomy?: boolean }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  return (
    <form
      className="mt-2.5 px-3"
      onSubmit={(e) => {
        e.preventDefault()
        router.push(`${base}/contacts?q=${encodeURIComponent(q.trim())}`)
      }}
    >
      <label
        className={cn(
          'flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 font-mono text-[12px] text-muted-foreground focus-within:border-primary/50',
          roomy ? 'h-10' : 'h-8',
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <input
          type="search"
          enterKeyHint="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
    </form>
  )
}
