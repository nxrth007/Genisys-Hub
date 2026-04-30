'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Search, ArrowRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Global ⌘K command palette — searches over pages + registered
 * clients + agents in one go. Opens via the "Search anything" pill in
 * the sidebar or the keyboard shortcut. Click any result to navigate.
 *
 * Implementation note: deliberately lightweight (no Radix dialog
 * dependency) — it's a fixed overlay + portal-less <div>, which keeps
 * the bundle small and matches our existing modal patterns elsewhere
 * (booking form's conflict warning, etc.).
 */

type Result = {
  type: 'Page' | 'Client' | 'Agent'
  label: string
  href: string
  /** Optional secondary line — shown muted under the label, e.g. an
   *  email address for an agent or a state for a client. */
  hint?: string
}

type Client = { id: string; name: string; state: string | null }
type Agent = { id: string; name: string | null; email: string }

/**
 * Static page index. "Tasks" routes to /today (the agent's primary
 * action view with embedded task board + meetings + booking stats);
 * the broader Notion DB browser stays accessible via the "Notion"
 * entry for power users.
 */
const PAGES: Result[] = [
  { type: 'Page', label: 'Tasks', href: '/today' },
  { type: 'Page', label: 'Call Center', href: '/call-center' },
  { type: 'Page', label: 'Clients', href: '/clients' },
  { type: 'Page', label: 'Master Tracker', href: '/call-center/master-tracker' },
  { type: 'Page', label: 'Notion', href: '/notion' },
  { type: 'Page', label: 'Inbox', href: '/inbox' },
  { type: 'Page', label: 'CRM', href: '/crm' },
  { type: 'Page', label: 'Calendar', href: '/calendar' },
  { type: 'Page', label: 'Drive', href: '/drive' },
  { type: 'Page', label: 'Documents', href: '/documents' },
  { type: 'Page', label: 'Slack', href: '/slack' },
  { type: 'Page', label: 'Vault', href: '/vault' },
  { type: 'Page', label: 'Agents', href: '/agents' },
  { type: 'Page', label: 'Settings', href: '/settings' },
]

export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [q, setQ] = useState('')
  const router = useRouter()

  // Reset query each time the dialog opens so the cursor lands on a
  // blank input — matches what users expect from ⌘K palettes.
  useEffect(() => {
    if (open) setQ('')
  }, [open])

  // Esc to close — captured at document level so it works regardless
  // of which element inside the dialog has focus.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  // Fetch clients + agents once the dialog is open. cached via React
  // Query, shared across the rest of the app.
  const clientsQuery = useQuery<{ clients: Client[] }>({
    queryKey: ['clients'],
    queryFn: async () => {
      const res = await fetch('/api/clients')
      if (!res.ok) return { clients: [] }
      return res.json()
    },
    enabled: open,
    staleTime: 60_000,
  })
  // Agents list — admin-only endpoint, but both Alex and Ethan are
  // admins so this reaches the search palette for them. For a future
  // non-admin staff role we'd silently get an empty list (404 on the
  // endpoint), which the search just renders as no agent results.
  const agentsQuery = useQuery<{ agents: Agent[] }>({
    queryKey: ['admin-agents-list'],
    queryFn: async () => {
      const res = await fetch('/api/admin/agents')
      if (!res.ok) return { agents: [] }
      return res.json()
    },
    enabled: open,
    staleTime: 60_000,
  })

  const results = useMemo<Result[]>(() => {
    const all: Result[] = [...PAGES]
    for (const c of clientsQuery.data?.clients ?? []) {
      all.push({
        type: 'Client',
        label: c.name,
        href: `/clients?focus=${c.id}`,
        hint: c.state || undefined,
      })
    }
    for (const a of agentsQuery.data?.agents ?? []) {
      all.push({
        type: 'Agent',
        label: a.name || a.email,
        href: `/call-center/agents/${a.id}`,
        hint: a.name ? a.email : undefined,
      })
    }
    if (!q) return all.slice(0, 8)
    const needle = q.toLowerCase()
    return all
      .filter(
        (r) =>
          r.label.toLowerCase().includes(needle) ||
          r.hint?.toLowerCase().includes(needle)
      )
      .slice(0, 12)
  }, [q, clientsQuery.data, agentsQuery.data])

  if (!open) return null

  function pick(href: string) {
    onOpenChange(false)
    router.push(href)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-soft px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages, clients, agents…"
            className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            esc
          </kbd>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <ul className="max-h-80 overflow-y-auto py-2">
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              No matches for &ldquo;{q}&rdquo;.
            </li>
          ) : (
            results.map((r) => (
              <li key={`${r.type}:${r.href}:${r.label}`}>
                <Link
                  href={r.href}
                  onClick={(e) => {
                    // Use router.push via pick() so onOpenChange fires
                    // synchronously — relying on Link's default also
                    // works but the dialog briefly sticks around.
                    e.preventDefault()
                    pick(r.href)
                  }}
                  className="flex items-center gap-3 px-4 py-2 hover:bg-muted"
                >
                  <span
                    className={cn(
                      'rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                      r.type === 'Page' && 'bg-primary-soft text-primary',
                      r.type === 'Client' && 'chip-mint',
                      r.type === 'Agent' && 'chip-violet'
                    )}
                  >
                    {r.type}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{r.label}</span>
                    {r.hint && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.hint}
                      </span>
                    )}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
