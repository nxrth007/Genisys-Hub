'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Link2, Loader2, RefreshCw, Search, Send, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import type { ClientGhlOverview, GhlOverview } from '@/lib/ghl-automation-overview'

type Row = { id: string; name: string; siteUrl: string | null; hasIntake: boolean; done: number }
type Busy = Record<string, 'link' | 'send' | undefined>

/** /automation-copy — every client A–Z; each opens its copy-and-paste board for the GHL automations. */
export default function AutomationCopyPage() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<Busy>({})
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [bulk, setBulk] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['automation-copy'],
    queryFn: async (): Promise<{ clients: Row[]; total: number }> => {
      const res = await fetch('/api/automation-copy')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
  })
  const ghl = useQuery({
    queryKey: ['automation-copy-ghl-overview'],
    queryFn: async (): Promise<GhlOverview> => {
      const res = await fetch('/api/automation-copy/ghl-overview')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Couldn’t check GHL')
      return data
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const byId = useMemo(() => new Map((ghl.data?.clients ?? []).map((c) => [c.id, c])), [ghl.data])

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (q.data?.clients ?? []).filter((c) => !f || c.name.toLowerCase().includes(f))
  }, [q.data, filter])
  const total = q.data?.total ?? 0
  const ready = (ghl.data?.clients ?? []).filter((c) => c.key?.ok && c.values && c.values.matching < c.values.total)

  const note = (id: string, msg: string) => setMessages((m) => ({ ...m, [id]: msg }))

  async function link(c: ClientGhlOverview) {
    if (!c.proposal) return
    setBusy((b) => ({ ...b, [c.id]: 'link' }))
    try {
      const res = await fetch(`/api/clients/${c.id}/ghl-subaccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locationId: c.proposal.locationId }),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string }
      note(c.id, data.ok ? `Linked to ${c.proposal.name}` : data.reason || 'Couldn’t link')
      await ghl.refetch()
    } finally {
      setBusy((b) => ({ ...b, [c.id]: undefined }))
    }
  }

  async function send(id: string): Promise<boolean> {
    setBusy((b) => ({ ...b, [id]: 'send' }))
    try {
      const res = await fetch(`/api/automation-copy/${id}/ghl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string | null; results?: { name: string; action: string; detail: string }[] }
      const failed = (data.results ?? []).filter((r) => r.action === 'failed')
      const skipped = (data.results ?? []).filter((r) => r.action === 'skipped')
      note(
        id,
        data.error
          ? data.error
          : failed.length
            ? `Failed: ${failed.map((r) => `${r.name} (${r.detail})`).join('; ')}`
            : `Sent${skipped.length ? `; skipped blank: ${skipped.map((r) => r.name).join(', ')}` : ''}`,
      )
      return !!data.ok && !data.error
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }))
    }
  }

  async function sendAll() {
    const list = ready.map((c) => c.id)
    for (let i = 0; i < list.length; i++) {
      setBulk(`Sending ${i + 1} of ${list.length}…`)
      await send(list[i])
    }
    setBulk(null)
    await ghl.refetch()
    qc.invalidateQueries({ queryKey: ['automation-copy'], exact: true })
  }

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <PageHeader
        title="Automation Copy"
        subtitle="The text for each client’s GHL automations, personalized from their onboarding answers. Open a client to copy each box, or send the details to their sub-account as custom values."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Automation Copy' }]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a client"
            className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-[13px] outline-none transition focus:border-foreground/30"
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => ghl.refetch()}
            disabled={ghl.isFetching}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', ghl.isFetching && 'animate-spin')} /> Check GHL
          </button>
          <button
            type="button"
            onClick={sendAll}
            disabled={!ready.length || !!bulk}
            title="Sends the board’s details to every client whose key works and whose values are missing or out of date"
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {bulk ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {bulk ?? `Send to all ready (${ready.length})`}
          </button>
        </div>
      </div>
      {ghl.data?.agencyError && <p className="text-[12.5px] text-destructive">Couldn’t list the agency’s sub-accounts: {ghl.data.agencyError}</p>}
      {ghl.error && <p className="text-[12.5px] text-destructive">{(ghl.error as Error).message}</p>}

      {q.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((c, i) => {
            const complete = total > 0 && c.done >= total
            const g = byId.get(c.id)
            return (
              <li key={c.id} className={cn('flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-3', i > 0 && 'border-t border-border-soft')}>
                <Link href={`/automation-copy/${c.id}`} className="group flex min-w-0 flex-1 items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium group-hover:underline">{c.name}</span>
                    <span className="block truncate font-mono text-[11.5px] text-muted-foreground">
                      {c.siteUrl ? c.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'No live site yet'}
                      {!c.hasIntake && ' · no onboarding answers'}
                    </span>
                  </span>
                </Link>
                <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                  {ghl.isLoading ? (
                    <span className="font-mono text-[11px] text-muted-foreground">checking GHL…</span>
                  ) : g ? (
                    <GhlStatus g={g} busy={busy[c.id]} onLink={() => link(g)} onSend={() => send(c.id).then(() => ghl.refetch())} />
                  ) : null}
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]',
                      complete ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-border text-muted-foreground',
                    )}
                    title="Automations ticked as set up in GHL"
                  >
                    {complete && <Check className="h-3 w-3" />}
                    {c.done}/{total} set up
                  </span>
                  <Link href={`/automation-copy/${c.id}`} aria-label={`Open ${c.name}`}>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                </div>
                {messages[c.id] && <p className="w-full text-[12px] text-muted-foreground sm:order-last">{messages[c.id]}</p>}
              </li>
            )
          })}
          {rows.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-muted-foreground">No clients match.</li>}
        </ul>
      )}
    </div>
  )
}

const chip = 'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px]'
const action =
  'inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11.5px] font-medium transition hover:bg-muted disabled:opacity-50'

function GhlStatus({ g, busy, onLink, onSend }: { g: ClientGhlOverview; busy: 'link' | 'send' | undefined; onLink: () => void; onSend: () => void }) {
  if (!g.linked) {
    return g.proposal ? (
      <button type="button" onClick={onLink} disabled={!!busy} className={action} title={`Link this client to the GHL sub-account “${g.proposal.name}”`}>
        {busy === 'link' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />} Link to “{g.proposal.name}”
      </button>
    ) : (
      <span className={cn(chip, 'border-amber-500/40 text-amber-700 dark:text-amber-300')} title="Link it on the client’s GHL page">
        Not linked to GHL
      </span>
    )
  }
  if (!g.key?.ok) {
    return (
      <span className={cn(chip, 'border-amber-500/40 text-amber-700 dark:text-amber-300')} title={g.key?.detail}>
        <X className="h-3 w-3" /> {g.key?.label ? `Key “${g.key.label}” doesn’t work` : 'No Vault key'}
      </span>
    )
  }
  const v = g.values!
  const synced = v.matching === v.total
  return (
    <>
      <span className={cn(chip, synced ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'border-border text-muted-foreground')} title={`Key: ${g.key.label}`}>
        {synced && <Check className="h-3 w-3" />}
        {synced ? 'Values in GHL' : `${v.matching}/${v.total} values in GHL`}
      </span>
      {!synced && (
        <button type="button" onClick={onSend} disabled={!!busy} className={action}>
          {busy === 'send' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Send
        </button>
      )}
    </>
  )
}
