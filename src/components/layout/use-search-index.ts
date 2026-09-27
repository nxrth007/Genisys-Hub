'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

/**
 * The Hub's search index — pages, registered clients and agents — shared
 * by the ⌘K palette and the Home page search so the two can never drift.
 */

export type SearchResult = {
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
const PAGES: SearchResult[] = [
  { type: 'Page', label: 'Home', href: '/home' },
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

export function useSearchIndex({
  enabled,
  query,
  limit,
}: {
  enabled: boolean
  query: string
  /** Results to return; when the query is empty, returns the first few pages. */
  limit: number
}): { results: SearchResult[]; isLoading: boolean } {
  // Fetched once enabled; cached via React Query and shared app-wide.
  const clientsQuery = useQuery<{ clients: Client[] }>({
    queryKey: ['clients'],
    queryFn: async () => {
      const res = await fetch('/api/clients')
      if (!res.ok) return { clients: [] }
      return res.json()
    },
    enabled,
    staleTime: 60_000,
  })
  // Agents list — admin-only endpoint. A non-admin gets an empty list
  // (403/404), which the search just renders as no agent results.
  const agentsQuery = useQuery<{ agents: Agent[] }>({
    queryKey: ['admin-agents-list'],
    queryFn: async () => {
      const res = await fetch('/api/admin/agents')
      if (!res.ok) return { agents: [] }
      return res.json()
    },
    enabled,
    staleTime: 60_000,
  })

  const results = useMemo<SearchResult[]>(() => {
    const all: SearchResult[] = [...PAGES]
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
    const needle = query.trim().toLowerCase()
    if (!needle) return all.slice(0, Math.min(limit, 8))
    return all
      .filter(
        (r) =>
          r.label.toLowerCase().includes(needle) ||
          r.hint?.toLowerCase().includes(needle),
      )
      .slice(0, limit)
  }, [query, limit, clientsQuery.data, agentsQuery.data])

  return {
    results,
    isLoading: clientsQuery.isLoading || agentsQuery.isLoading,
  }
}
