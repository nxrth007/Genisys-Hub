'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { Bell, Menu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOBILE_TABS, sectionOf } from './nav'

/**
 * Genisys OS on a phone (under 768px; shell.tsx keeps the desktop sidebar from there up), laid out
 * like GoHighLevel's LeadConnector app: a top bar with the menu button and where you are, the five
 * everyday screens along the bottom, and the full menu sliding in from the left.
 */

const badgeText = (n: number) => (n > 99 ? '99+' : String(n))

export function MobileTopBar({ title, subtitle, unread, unreadHref, onMenu }: { title: string; subtitle: string | null; unread: number; unreadHref: string | null; onMenu: () => void }) {
  return (
    <header className="shrink-0 border-b border-border bg-sidebar pt-[env(safe-area-inset-top)] md:hidden">
      <div className="flex h-[52px] items-center gap-0.5 px-1">
        <button type="button" onClick={onMenu} aria-label="Menu" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-foreground/80 transition active:bg-foreground/[0.08]">
          <Menu className="h-[21px] w-[21px]" strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-[16px] font-semibold leading-tight text-foreground">{title}</p>
          {subtitle && <p className="truncate text-[11.5px] leading-tight text-muted-foreground">{subtitle}</p>}
        </div>
        {unreadHref && (
          <Link href={unreadHref} aria-label="Unread conversations" className="relative grid h-11 w-11 shrink-0 place-items-center rounded-lg text-foreground/80 transition active:bg-foreground/[0.08]">
            <Bell className="h-[20px] w-[20px]" strokeWidth={1.75} />
            {unread > 0 && (
              <span className="absolute right-1.5 top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-destructive px-1 font-mono text-[10px] font-bold text-destructive-foreground">{badgeText(unread)}</span>
            )}
          </Link>
        )}
      </div>
    </header>
  )
}

/**
 * The bottom tab bar. It steps aside inside a conversation (the message box takes the bottom, as in
 * any texting app) and while the keyboard is up (html.gos-typing, phone-app.tsx).
 */
export function MobileTabBar({ base, active, unread }: { base: string; active: string | undefined; unread: number }) {
  const sp = useSearchParams()
  if (active === 'conversations' && sp.get('contact')) return null
  return (
    <nav aria-label="Genisys OS" className="gos-tabbar shrink-0 select-none border-t border-border bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="flex h-14 items-stretch">
        {MOBILE_TABS.map((t) => {
          const Icon = sectionOf(t.key)?.icon
          const on = active === t.key
          return (
            <Link
              key={t.key}
              href={`${base}/${t.key}`}
              aria-current={on ? 'page' : undefined}
              className={cn('relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition active:bg-foreground/[0.05]', on ? 'text-primary' : 'text-muted-foreground')}
            >
              {on && <span className="absolute inset-x-5 top-0 h-[2px] rounded-full bg-primary" />}
              <span className="relative">
                {Icon && <Icon className="h-[22px] w-[22px]" strokeWidth={on ? 2 : 1.6} />}
                {t.key === 'conversations' && unread > 0 && (
                  <span className="absolute -right-2.5 -top-1.5 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-destructive px-1 font-mono text-[9.5px] font-bold text-destructive-foreground">{badgeText(unread)}</span>
                )}
              </span>
              <span className="max-w-full truncate px-0.5">{t.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

/** The full menu (the desktop sidebar's contents), sliding in from the left. Tapping anything in it that goes somewhere closes it. */
export function MobileDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <div className={cn('fixed inset-0 z-[60] md:hidden', !open && 'pointer-events-none')} inert={!open}>
      <div onClick={onClose} className={cn('absolute inset-0 bg-black/60 transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest('a')) onClose()
        }}
        onSubmitCapture={onClose}
        className={cn(
          'absolute inset-y-0 left-0 flex w-[86vw] max-w-[320px] flex-col border-r border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] shadow-pop transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {children}
      </div>
    </div>
  )
}
