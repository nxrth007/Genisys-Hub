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
    <div className="flex h-screen overflow-hidden bg-white dark:bg-zinc-950">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile-only top bar. Desktop chrome lives in the sidebar. */}
        <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 md:hidden dark:border-zinc-800 dark:bg-zinc-950">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-2 -ml-2 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold tracking-tight">Genisys Hub</span>
        </header>
        <main className="flex-1 overflow-y-auto bg-white p-6 dark:bg-zinc-950">
          {children}
        </main>
      </div>
      {mobileOpen && <MobileSidebar onClose={() => setMobileOpen(false)} />}
    </div>
  )
}
