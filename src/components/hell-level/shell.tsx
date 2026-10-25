'use client'

import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { signOut } from 'next-auth/react'
import { ArrowLeft, Bell, Building2, ChevronsUpDown, Flame, Home, Layers, LayoutDashboard, LogOut, Phone, Pin, RefreshCcw, Rocket, Search, Settings, Sparkles, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { prettyPhone } from '@/lib/hl/merge'
import { MEMBER_SECTIONS } from '@/lib/hl/member-access'
import { Avatar, hlFetch } from './ui'
import { ArrivalGate, EnterSplashGate } from './enter-splash'
import { SECTIONS, SETTINGS_SECTION, activeTab, sectionOf, type Section } from './nav'
import { ConfirmHost } from './confirm'
import { ViewerContext, type HlViewer } from './viewer'

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
  /** The sub-account Hell-level opens on (Lead Genisys). */
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

/** The agency view's menu (GHL's agency sidebar, the parts Hell-level has). */
const AGENCY_NAV = [
  { href: '/hell-level/agency/ask-ai', label: 'Ask AI', icon: Sparkles },
  { href: '/hell-level/agency/launchpad', label: 'Launchpad', icon: Rocket },
  { href: '/hell-level/agency/dashboard', label: 'Agency Dashboard', icon: LayoutDashboard },
  { href: '/hell-level', label: 'Sub-Accounts', icon: Building2 },
  { href: '/hell-level/agency/snapshots', label: 'Account Snapshots', icon: Layers },
]
const AGENCY_SETTINGS = { href: '/hell-level/agency/settings', label: 'Settings', icon: Settings }
const agencyTitle = (pathname: string) => [...AGENCY_NAV, AGENCY_SETTINGS].find((n) => n.href === pathname)?.label ?? 'Agency view'

/**
 * Hell-level's frame: GoHighLevel's sub-account structure (the left menu in
 * GHL's order, section tabs across the top) in the Hub's own look.
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

  const base = accountId ? `/hell-level/${accountId}` : null
  const top = viewer.admin ? SECTIONS.filter((s) => s.group === 'top') : SECTIONS.filter((s) => s.key in MEMBER_SECTIONS)
  const grow = viewer.admin ? SECTIONS.filter((s) => s.group === 'grow') : []

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-background text-foreground">
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <span className="grid h-7 w-7 place-items-center rounded-md border border-border bg-surface text-foreground">
            <Flame className="h-3.5 w-3.5" />
          </span>
          <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground">Hell-level</span>
        </div>

        <AccountSwitcher accounts={accounts.data?.accounts ?? []} defaultId={accounts.data?.defaultAccountId ?? null} current={current} loading={accounts.isLoading} admin={viewer.admin} />
        {base && <QuickSearch base={base} />}

        <nav className="mt-3 flex flex-1 flex-col gap-px overflow-y-auto px-3 pb-3">
          {!base ? (
            AGENCY_NAV.map((n) => <NavLink key={n.href} href={n.href} label={n.label} icon={n.icon} active={pathname === n.href} />)
          ) : (
            <>
              {top.map((s) => (
                <NavLink key={s.key} href={`${base}/${s.key}`} label={s.label} icon={s.icon} active={sectionKey === s.key} badge={s.key === 'conversations' ? current?.unread : undefined} tag={s.badge} />
              ))}
              {grow.length > 0 && <div className="my-2 h-px bg-border-soft" />}
              {grow.map((s) => (
                <NavLink key={s.key} href={`${base}/${s.key}`} label={s.label} icon={s.icon} active={sectionKey === s.key} tag={s.badge} />
              ))}
            </>
          )}
        </nav>

        {viewer.admin ? (
          <div className="flex flex-col gap-px border-t border-border-soft px-3 py-3">
            {base ? (
              <NavLink href={`${base}/settings`} label={SETTINGS_SECTION.label} icon={SETTINGS_SECTION.icon} active={sectionKey === 'settings'} />
            ) : (
              <NavLink href={AGENCY_SETTINGS.href} label={AGENCY_SETTINGS.label} icon={AGENCY_SETTINGS.icon} active={pathname === AGENCY_SETTINGS.href} />
            )}
            <Link href="/home" className="flex h-8 items-center gap-2.5 rounded-md px-2.5 font-mono text-[12.5px] text-foreground/60 transition hover:bg-white/[0.04] hover:text-foreground">
              <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
              Back to the Hub
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 border-t border-border-soft px-4 py-3">
            <Avatar name={viewer.name || viewer.email} size={26} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-foreground">{viewer.name || viewer.email}</span>
              {viewer.name && <span className="block truncate text-[11px] text-muted-foreground">{viewer.email}</span>}
            </span>
            <button
              type="button"
              onClick={() => void signOut({ callbackUrl: '/login' })}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
              title="Sign out"
            >
              <LogOut className="h-[15px] w-[15px]" strokeWidth={1.75} />
            </button>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[54px] shrink-0 items-center gap-6 border-b border-border px-5">
          <p className="shrink-0 text-[15px] font-semibold text-foreground">{section?.label ?? (accountId ? '' : agencyTitle(pathname))}</p>
          {section?.tabs && section.tabs.length > 1 && base && (
            <Suspense fallback={null}>
              <SectionTabs section={section} href={`${base}/${section.key}`} />
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
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>
        </main>
      </div>
      {/* The entrance (Hub sidebar → /hell-level?enter=1), over the CRM loading underneath; and the white fading off after /login. */}
      <Suspense fallback={null}>
        {viewer.admin && <EnterSplashGate />}
        <ArrivalGate />
      </Suspense>
      <ConfirmHost />
    </div>
  )
}

function SectionTabs({ section, href }: { section: Section; href: string }) {
  const sp = useSearchParams()
  const pathname = usePathname()
  // On a page under the section (a workflow, a form), the first tab stays lit.
  const current = activeTab(section, pathname === href ? sp.get('tab') : null)
  return (
    <nav className="-mb-px flex min-w-0 items-stretch gap-1 self-stretch overflow-x-auto">
      {section.tabs!.map((t) => (
        <Link
          key={t.key}
          href={t.key === section.tabs![0].key ? href : `${href}?tab=${t.key}`}
          className={cn(
            'flex shrink-0 items-center border-b-2 px-2.5 text-[13px] transition',
            current === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  badge,
  tag,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  active: boolean
  badge?: number
  tag?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        'relative flex h-8 items-center gap-2.5 rounded-md px-2.5 font-mono text-[12.5px] transition',
        active
          ? 'bg-white/[0.06] text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[2px] before:rounded-full before:bg-primary'
          : 'text-foreground/70 hover:bg-white/[0.04] hover:text-foreground',
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
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  // Read when the panel opens (it's only ever on screen in the browser).
  const [pinned, setPinned] = useState<string[]>(() => readList(PIN_KEY))
  const [recentIds] = useState<string[]>(() => readList(RECENT_KEY))
  const makeHome = useMutation({
    mutationFn: (id: string) => hlFetch(`/api/hl/accounts/${id}`, { method: 'PATCH', json: { makeDefault: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'accounts'] }),
  })
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
      <Link href={`/hell-level/${a.id}/${section}`} onClick={onClose} className="flex min-w-0 flex-1 items-center gap-2.5">
        <Avatar name={a.name} size={26} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{a.name}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">{a.owner || a.clientName || (a.ghlLocationId ? 'Imported from GoHighLevel' : 'Sub-account')}</span>
        </span>
        {!!a.unread && <span className="rounded-full bg-destructive px-1.5 font-mono text-[10px] font-bold text-destructive-foreground">{a.unread}</span>}
      </Link>
      {tools && admin && (
        <>
          <button
            type="button"
            onClick={() => a.id !== defaultId && makeHome.mutate(a.id)}
            className={cn('grid h-7 w-7 place-items-center rounded-md transition', a.id === defaultId ? 'text-primary' : 'text-muted-foreground/60 hover:bg-white/[0.06] hover:text-foreground')}
            title={a.id === defaultId ? 'Home sub-account: Hell-level opens here' : 'Make this the home sub-account'}
          >
            <Home className={cn('h-3.5 w-3.5', a.id === defaultId && 'fill-primary/20')} />
          </button>
          <button
            type="button"
            onClick={() => togglePin(a.id)}
            className={cn('grid h-7 w-7 place-items-center rounded-md transition', pinned.includes(a.id) ? 'text-primary' : 'text-muted-foreground/60 hover:bg-white/[0.06] hover:text-foreground')}
            title={pinned.includes(a.id) ? 'Unpin' : 'Pin to the top'}
          >
            <Pin className={cn('h-3.5 w-3.5', pinned.includes(a.id) && 'fill-primary')} />
          </button>
        </>
      )}
    </div>
  )

  return (
    <div className="absolute left-3 top-full z-50 mt-1.5 flex w-[330px] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-pop">
      <div className="p-3 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-md border border-primary/50 bg-surface px-2.5 text-[13px] text-muted-foreground">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for a sub-account" className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
      {current && admin && (
        <Link href="/hell-level/agency/launchpad" onClick={onClose} className="mx-3 mb-2 flex w-fit items-center gap-2 text-[12.5px] font-medium text-primary hover:underline">
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

function QuickSearch({ base }: { base: string }) {
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
      <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 font-mono text-[12px] text-muted-foreground focus-within:border-primary/50">
        <Search className="h-3.5 w-3.5 shrink-0" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground" />
      </label>
    </form>
  )
}
