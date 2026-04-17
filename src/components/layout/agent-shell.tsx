'use client'

import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { useQuery } from '@tanstack/react-query'
import { Headphones, LogOut } from 'lucide-react'

/**
 * Minimal chrome for the /agent portal — no sidebar, no CRM/Vault/etc
 * navigation. Agents see only their own dashboard and sign-out.
 *
 * Session read via /api/auth/session (avoids needing a SessionProvider
 * at the root — no other part of the app uses useSession either).
 */
export function AgentShell({ children }: { children: React.ReactNode }) {
  const { data: session } = useQuery<{
    user?: { name?: string | null; email?: string | null }
  }>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return {}
      return res.json()
    },
  })
  const agentName = session?.user?.name || session?.user?.email || ''

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6 dark:border-zinc-800 dark:bg-zinc-900">
        <Link href="/agent" className="flex items-center gap-2">
          <Headphones className="h-5 w-5 text-purple-600" />
          <span className="font-semibold tracking-tight">Genisys Agent</span>
        </Link>
        <div className="flex items-center gap-3">
          {agentName && (
            <span className="hidden text-xs text-zinc-500 sm:inline">{agentName}</span>
          )}
          <button
            onClick={() => signOut({ callbackUrl: '/signin/agent' })}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}
