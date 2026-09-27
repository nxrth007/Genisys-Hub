'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Sidebar } from './sidebar'
import { MobileSidebar } from './mobile-sidebar'

/**
 * Desktop: fixed sidebar on the left, content on the right. No top header
 * — each page renders its own title + actions row.
 *
 * Mobile: thin top bar with a hamburger that opens the sidebar in a drawer.
 *
 * Home is the one full-bleed page: the globe owns the whole canvas, so
 * the content padding every other page relies on is dropped there.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()
  const fullBleed = pathname === '/home'

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile-only top bar. Desktop chrome lives in the sidebar. */}
        <header className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-border-soft bg-sidebar px-4 md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="-ml-2 grid h-9 w-9 place-items-center rounded-md hover:bg-muted"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em]">
            Genisys
          </span>
        </header>
        <main
          className={cn(
            'flex-1 overflow-y-auto',
            fullBleed ? 'p-0' : 'px-6 py-6 lg:px-10 lg:py-8',
          )}
        >
          {children}
        </main>
      </div>
      {mobileOpen && <MobileSidebar onClose={() => setMobileOpen(false)} />}
    </div>
  )
}
