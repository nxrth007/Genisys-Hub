'use client'

import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Sidebar } from './sidebar'
import { MobileSidebar } from './mobile-sidebar'

/**
 * Desktop: fixed sidebar on the left, content on the right. No top header
 * — each page renders its own title + actions row, matching the reference
 * design (Ethan's Lovable demo).
 *
 * Mobile: thin top bar with a hamburger that opens the sidebar in a drawer.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile-only top bar. Desktop chrome lives in the sidebar. */}
        <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-border-soft bg-sidebar px-4 md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="-ml-2 grid h-9 w-9 place-items-center rounded-md hover:bg-muted"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold tracking-tight">Genisys</span>
        </header>
        {/* Match the mockup's content padding — px-6/py-6 on mobile,
            px-10/py-8 on lg+. Pages can still set their own max-width
            inside via their own wrappers. */}
        <main className="flex-1 overflow-y-auto px-6 py-6 lg:px-10 lg:py-8">
          {children}
        </main>
      </div>
      {mobileOpen && <MobileSidebar onClose={() => setMobileOpen(false)} />}
    </div>
  )
}
