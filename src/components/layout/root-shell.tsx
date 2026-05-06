'use client'

import { usePathname } from 'next/navigation'
import { AppShell } from './app-shell'
import { AgentShell } from './agent-shell'

/**
 * Picks the right shell based on the current pathname.
 *
 * - /agent/*  → AgentShell (minimal, no Hub sidebar)
 * - /client/* → no chrome; the client portal renders its own header
 * - /signin/* → no chrome; the signin pages render their own centered card
 * - everything else → AppShell (full Hub with sidebar + header)
 */
export function RootShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname === '/signin' || pathname.startsWith('/signin/')) {
    // Signin flow renders full-bleed with its own layout; no wrapper chrome.
    return <>{children}</>
  }

  if (pathname === '/client' || pathname.startsWith('/client/')) {
    // Client portal renders its own minimal header; no Hub sidebar /
    // admin nav should leak through.
    return <>{children}</>
  }

  if (pathname === '/agent' || pathname.startsWith('/agent/')) {
    return <AgentShell>{children}</AgentShell>
  }

  return <AppShell>{children}</AppShell>
}
