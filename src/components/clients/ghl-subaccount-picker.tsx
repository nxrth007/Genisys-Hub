'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Check, ChevronDown, Loader2, Search, Unlink } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LinkResult, SubAccountOption } from '@/lib/ghl-subaccount-provisioning'

type Options = { locations: SubAccountOption[]; truncated: boolean }

export function useGhlSubAccounts(enabled = true) {
  return useQuery<Options>({
    queryKey: ['ghl-locations'],
    queryFn: async () => {
      const res = await fetch('/api/clients/ghl-locations')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
      return data as Options
    },
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
}

/**
 * Pick which of the agency's GHL sub-accounts belongs to a client. Lists
 * every sub-account with the client it's already linked to, so it's clear
 * who is who; one already taken can't be picked twice.
 */
export function GhlSubAccountPicker({ clientId, locationId }: { clientId: string; locationId: string | null }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const options = useGhlSubAccounts(open || !!locationId)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ghl-locations'] })
    qc.invalidateQueries({ queryKey: ['clients-roster'] })
    qc.invalidateQueries({ queryKey: ['client-ghl-board', clientId] })
  }

  const link = useMutation({
    mutationFn: async (id: string): Promise<LinkResult> => {
      const res = await fetch(`/api/clients/${clientId}/ghl-subaccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locationId: id, replace: true }),
      })
      return (await res.json().catch(() => ({ ok: false, status: 'failed', reason: 'No answer from the Hub.' }))) as LinkResult
    },
    onSuccess: (r) => {
      if (r.ok) {
        setOpen(false)
        setQ('')
      }
      refresh()
    },
  })

  const unlink = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/ghl-subaccount`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Couldn’t unlink.')
    },
    onSuccess: () => {
      setOpen(false)
      refresh()
    },
  })

  const current = options.data?.locations.find((l) => l.id === locationId) ?? null
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const all = options.data?.locations ?? []
    return needle
      ? all.filter((l) => l.name.toLowerCase().includes(needle) || l.client?.name.toLowerCase().includes(needle) || l.id.toLowerCase() === needle)
      : all
  }, [options.data, q])
  const error = link.data && !link.data.ok ? link.data.reason : unlink.error ? (unlink.error as Error).message : null

  return (
    <div ref={box} className="relative inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex max-w-xs items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] transition hover:bg-muted',
          locationId ? 'border-border font-medium' : 'border-dashed border-border font-semibold',
        )}
      >
        <Building2 className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {locationId ? (current?.name || (options.isLoading ? 'Loading…' : locationId)) : 'Link sub-account…'}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {error && <span className="max-w-xs break-words text-[11px] text-destructive">{error}</span>}

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search sub-accounts or clients"
              className="w-full bg-transparent text-[13px] outline-none"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {options.isLoading ? (
              <p className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading sub-accounts from GHL…
              </p>
            ) : options.error ? (
              <p className="px-3 py-2 text-[12px] text-destructive">{(options.error as Error).message}</p>
            ) : shown.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-muted-foreground">No sub-account matches.</p>
            ) : (
              shown.map((l) => {
                const mine = l.id === locationId
                const taken = !!l.client && !mine
                return (
                  <button
                    key={l.id}
                    type="button"
                    disabled={taken || mine || link.isPending}
                    onClick={() => link.mutate(l.id)}
                    title={taken ? `Linked to ${l.client!.name}` : l.id}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px]',
                      taken ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted',
                    )}
                  >
                    <span className="min-w-0 truncate">{l.name || l.id}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {link.isPending && link.variables === l.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : mine ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <Check className="h-3 w-3" /> this client
                        </span>
                      ) : l.client ? (
                        l.client.name
                      ) : (
                        ''
                      )}
                    </span>
                  </button>
                )
              })
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11.5px]">
            <Link href={`/clients/${clientId}/ghl`} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Not in GHL yet? Create one by hand
            </Link>
            {locationId && (
              <button
                type="button"
                disabled={unlink.isPending}
                onClick={() => {
                  if (window.confirm('Unlink this sub-account from the client? Nothing changes in GHL.')) unlink.mutate()
                }}
                className="inline-flex items-center gap-1 text-destructive hover:underline disabled:opacity-50"
              >
                <Unlink className="h-3 w-3" /> Unlink
              </button>
            )}
          </div>
          {options.data?.truncated && (
            <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">Showing the first 2,000 sub-accounts.</p>
          )}
        </div>
      )}
    </div>
  )
}
