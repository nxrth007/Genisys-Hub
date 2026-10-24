'use client'

import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  BarChart3,
  Bell,
  CalendarDays,
  ChevronsUpDown,
  Contact,
  CreditCard,
  Filter,
  Flame,
  Globe,
  LayoutDashboard,
  Megaphone,
  MessagesSquare,
  Phone,
  Rocket,
  Search,
  Settings,
  Star,
  Workflow,
  Building2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { prettyPhone } from '@/lib/hl/merge'
import { Avatar, hlFetch } from './ui'

export type AccountRow = {
  id: string
  name: string
  clientId: string | null
  clientName: string | null
  owner: string | null
  website: string | null
  number: { number: string; kind: string; verification: string } | null
  contacts: number
  unread: number
  lastLeadAt: string | null
  createdAt: string
}

export type AccountsResponse = { accounts: AccountRow[]; clientsWithout: { id: string; name: string; contactName: string | null; lifecycle: string }[] }

export function useAccounts() {
  return useQuery<AccountsResponse>({
    queryKey: ['hl', 'accounts'],
    queryFn: () => hlFetch<AccountsResponse>('/api/hl/accounts'),
    refetchInterval: 30_000,
  })
}

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; soon?: boolean; badge?: number }

const LAST_KEY = 'hl-last-account'

/** GoHighLevel's sub-account chrome: navy sidebar with the account switcher, white top bar, light canvas. */
export function HellShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ accountId?: string }>()
  const pathname = usePathname()
  const router = useRouter()
  const accountId = params?.accountId ?? null
  const accounts = useAccounts()
  const current = accounts.data?.accounts.find((a) => a.id === accountId) ?? null

  useEffect(() => {
    if (!accountId) return
    try {
      localStorage.setItem(LAST_KEY, accountId)
    } catch {
      // private mode: the switcher still works, it just won't remember
    }
  }, [accountId])

  const base = accountId ? `/hell-level/${accountId}` : null
  const main: NavItem[] = base
    ? [
        { href: `${base}/launchpad`, label: 'Launchpad', icon: Rocket },
        { href: `${base}/dashboard`, label: 'Dashboard', icon: LayoutDashboard },
        { href: `${base}/conversations`, label: 'Conversations', icon: MessagesSquare, badge: current?.unread },
        { href: `${base}/calendars`, label: 'Calendars', icon: CalendarDays, soon: true },
        { href: `${base}/contacts`, label: 'Contacts', icon: Contact },
        { href: `${base}/opportunities`, label: 'Opportunities', icon: Filter },
        { href: `${base}/payments`, label: 'Payments', icon: CreditCard, soon: true },
      ]
    : []
  const grow: NavItem[] = base
    ? [
        { href: `${base}/marketing`, label: 'Marketing', icon: Megaphone, soon: true },
        { href: `${base}/automation`, label: 'Automation', icon: Workflow },
        { href: `${base}/sites`, label: 'Sites', icon: Globe },
        { href: `${base}/reputation`, label: 'Reputation', icon: Star, soon: true },
        { href: `${base}/reporting`, label: 'Reporting', icon: BarChart3, soon: true },
      ]
    : []

  return (
    <div className="hl-root fixed inset-0 flex overflow-hidden font-sans">
      <aside className="hl-sidebar flex w-[248px] shrink-0 flex-col bg-[#0E1A33] text-[#C3CAD9]">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[#FF7A1A] to-[#E0301E] text-white shadow-[0_2px_8px_rgba(224,48,30,0.45)]">
            <Flame className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </span>
          <div className="leading-tight">
            <p className="text-[15px] font-bold tracking-tight text-white">Hell-level</p>
            <p className="text-[11px] text-[#8A94A8]">by Genisys</p>
          </div>
        </div>

        <AccountSwitcher accounts={accounts.data?.accounts ?? []} current={current} loading={accounts.isLoading} />

        {base && <QuickSearch base={base} />}

        <nav className="mt-2 flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
          {!base && (
            <NavLink item={{ href: '/hell-level', label: 'Sub-Accounts', icon: Building2 }} active={pathname === '/hell-level'} />
          )}
          {main.map((item) => (
            <NavLink key={item.href} item={item} active={pathname.startsWith(item.href)} />
          ))}
          {grow.length > 0 && <div className="my-2 h-px bg-white/10" />}
          {grow.map((item) => (
            <NavLink key={item.href} item={item} active={pathname.startsWith(item.href)} />
          ))}
        </nav>

        <div className="flex flex-col gap-0.5 border-t border-white/10 px-3 py-3">
          {base && <NavLink item={{ href: `${base}/settings`, label: 'Settings', icon: Settings }} active={pathname.startsWith(`${base}/settings`)} />}
          <Link href="/home" className="flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] text-[#8A94A8] transition hover:bg-white/5 hover:text-white">
            <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.8} />
            Back to the Hub
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[60px] shrink-0 items-center justify-between gap-4 border-b border-[#EAECF0] bg-white px-6">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-[#101828]">{current?.name ?? (accountId ? 'Loading…' : 'Agency view')}</p>
            {current && <p className="truncate text-[12px] text-[#667085]">{[current.owner, current.website?.replace(/^https?:\/\//, '').replace(/\/$/, '')].filter(Boolean).join(' · ') || 'Sub-account'}</p>}
          </div>
          <div className="flex items-center gap-2">
            {current?.number && (
              <span className="hidden items-center gap-1.5 rounded-full bg-[#F2F4F7] px-3 py-1.5 text-[13px] font-medium text-[#344054] md:inline-flex" title="This sub-account's number">
                <Phone className="h-3.5 w-3.5 text-[#667085]" />
                {prettyPhone(current.number.number)}
              </span>
            )}
            {base && (
              <button
                type="button"
                onClick={() => router.push(`${base}/conversations?filter=unread`)}
                className="relative grid h-9 w-9 place-items-center rounded-full text-[#475467] transition hover:bg-[#F2F4F7]"
                title="Unread conversations"
              >
                <Bell className="h-[18px] w-[18px]" />
                {!!current?.unread && (
                  <span className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[#F04438] px-1 text-[10px] font-bold text-white">{current.unread > 99 ? '99+' : current.unread}</span>
                )}
              </button>
            )}
            <Avatar name="Genisys" size={34} />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      className={cn(
        'group flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition',
        active ? 'bg-[#22314F] text-white' : 'text-[#C3CAD9] hover:bg-white/5 hover:text-white',
        item.soon && !active && 'text-[#8A94A8]',
      )}
    >
      <Icon className={cn('h-[18px] w-[18px] shrink-0', active ? 'text-white' : 'text-[#98A2B3] group-hover:text-white')} strokeWidth={1.8} />
      <span className="flex-1 truncate">{item.label}</span>
      {item.soon && <span className="rounded bg-white/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[#8A94A8]">Soon</span>}
      {!!item.badge && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#F04438] px-1.5 text-[11px] font-bold text-white">{item.badge}</span>}
    </Link>
  )
}

function AccountSwitcher({ accounts, current, loading }: { accounts: AccountRow[]; current: AccountRow | null; loading: boolean }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const params = useParams<{ accountId?: string }>()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? accounts.filter((a) => `${a.name} ${a.owner ?? ''} ${a.clientName ?? ''}`.toLowerCase().includes(s)) : accounts
  }, [accounts, q])

  // Switching keeps you on the same page of the other sub-account (GHL does the same).
  const section = params?.accountId ? pathname.split('/')[3] || 'launchpad' : 'launchpad'
  const keep = ['launchpad', 'dashboard', 'conversations', 'contacts', 'opportunities', 'automation', 'sites', 'settings'].includes(section) ? section : 'launchpad'

  return (
    <div ref={box} className="relative px-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-lg bg-[#1A2742] px-3 py-2.5 text-left transition hover:bg-[#22314F]"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[#2B3B5C] text-[13px] font-bold text-white">
          {(current?.name ?? 'S').charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-white">{current?.name ?? (loading ? 'Loading…' : 'Choose a sub-account')}</span>
          <span className="block truncate text-[11.5px] text-[#8A94A8]">{current ? current.owner || 'Sub-account' : `${accounts.length} sub-account${accounts.length === 1 ? '' : 's'}`}</span>
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-[#8A94A8]" />
      </button>
      {open && (
        <div className="absolute left-3 right-3 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-[#EAECF0] bg-white text-[#101828] shadow-[0_12px_16px_-4px_rgba(16,24,40,0.12)]">
          <div className="border-b border-[#EAECF0] p-2">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search sub-accounts"
              className="h-9 w-full rounded-lg border border-[#D0D5DD] px-3 text-[13px] outline-none focus:border-[#84ADFF]"
            />
          </div>
          <div className="max-h-[50vh] overflow-y-auto py-1">
            {list.map((a) => (
              <Link
                key={a.id}
                href={`/hell-level/${a.id}/${keep}`}
                onClick={() => setOpen(false)}
                className={cn('flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-[#F9FAFB]', a.id === current?.id && 'bg-[#EFF4FF]')}
              >
                <Avatar name={a.name} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{a.name}</span>
                  <span className="block truncate text-[11.5px] text-[#667085]">{a.owner || a.clientName || 'Sub-account'}</span>
                </span>
                {!!a.unread && <span className="rounded-full bg-[#F04438] px-1.5 text-[10px] font-bold text-white">{a.unread}</span>}
              </Link>
            ))}
            {!list.length && <p className="px-3 py-4 text-center text-[13px] text-[#667085]">No sub-accounts match.</p>}
          </div>
          <Link href="/hell-level" onClick={() => setOpen(false)} className="flex items-center gap-2 border-t border-[#EAECF0] px-3 py-2.5 text-[13px] font-semibold text-[#155EEF] hover:bg-[#F9FAFB]">
            <Building2 className="h-4 w-4" /> All sub-accounts
          </Link>
        </div>
      )}
    </div>
  )
}

function QuickSearch({ base }: { base: string }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  return (
    <form
      className="mt-3 px-3"
      onSubmit={(e) => {
        e.preventDefault()
        router.push(`${base}/contacts?q=${encodeURIComponent(q.trim())}`)
      }}
    >
      <label className="flex h-9 items-center gap-2 rounded-lg bg-[#1A2742] px-3 text-[13px] text-[#8A94A8] focus-within:ring-2 focus-within:ring-[#155EEF]/60">
        <Search className="h-4 w-4 shrink-0" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts" className="w-full bg-transparent text-white outline-none placeholder:text-[#8A94A8]" />
      </label>
    </form>
  )
}
