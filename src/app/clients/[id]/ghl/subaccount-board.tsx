'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, Copy, ExternalLink, Link2, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { GhlSubAccountPicker } from '@/components/clients/ghl-subaccount-picker'
import type { GhlBoardField, GhlSubAccountBoard, LinkResult } from '@/lib/ghl-subaccount-provisioning'

/**
 * GHL doesn't let sub-accounts be created by API on the agency's current
 * plan, so a person creates it in GHL from this board — the same name,
 * fields and snapshot the automation would have used — and the Hub links
 * it afterwards.
 */

type BoardData = { board: GhlSubAccountBoard; checks: string[] }

const STEPS: { id: string; text: string }[] = [
  { id: 'created', text: 'In GHL (Agency view → Sub-Accounts → Create Sub-Account), add the business with the name and details below — the name exactly as shown.' },
  { id: 'snapshot', text: 'Pick the snapshot shown below when it asks which to load.' },
  { id: 'checked', text: 'Open the new sub-account once and check the snapshot finished loading (workflows, calendars, pipeline present).' },
]

const AGENCY_URL = 'https://app.gohighlevel.com/agency_dashboard/'

export function SubAccountBoard({ clientId }: { clientId: string }) {
  const q = useQuery({
    queryKey: ['client-ghl-board', clientId],
    queryFn: async (): Promise<BoardData> => {
      const res = await fetch(`/api/clients/${clientId}/ghl-subaccount`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
    refetchOnWindowFocus: false,
  })

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={q.data ? `GHL sub-account — ${q.data.board.client.name}` : 'GHL sub-account'}
        subtitle="Create the sub-account in GHL by hand from these details, then link it here. Same name, fields and snapshot the automation would have used."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Clients', href: '/clients' }, { label: 'Sub-account' }]}
        actions={
          <Link
            href={`/clients?focus=${clientId}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" /> Back to client
          </Link>
        }
      />
      {q.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : q.data ? (
        <Board clientId={clientId} data={q.data} />
      ) : null}
    </div>
  )
}

function Board({ clientId, data }: { clientId: string; data: BoardData }) {
  const qc = useQueryClient()
  const { board } = data
  const [checks, setChecks] = useState<string[]>(data.checks)
  const [pasted, setPasted] = useState('')
  const linked = !!board.status.locationId

  const saveChecks = useMutation({
    mutationFn: (next: string[]) =>
      fetch(`/api/clients/${clientId}/ghl-subaccount`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checks: next }),
      }),
  })
  function toggle(id: string) {
    const next = checks.includes(id) ? checks.filter((c) => c !== id) : [...checks, id]
    setChecks(next)
    saveChecks.mutate(next)
  }

  const link = useMutation({
    mutationFn: async (locationId: string | null): Promise<LinkResult> => {
      const res = await fetch(`/api/clients/${clientId}/ghl-subaccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(locationId ? { locationId } : {}),
      })
      return (await res.json().catch(() => ({ ok: false, status: 'failed', reason: 'No answer from the Hub.' }))) as LinkResult
    },
    onSuccess: (r) => {
      if (r.ok) {
        qc.invalidateQueries({ queryKey: ['client-ghl-board', clientId] })
        qc.invalidateQueries({ queryKey: ['clients-roster'] })
      }
    },
  })
  const result = link.data
  const blanks = [...board.fields, ...board.owner].filter((f) => !f.value.trim()).length

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
        <section className="rounded-xl border border-border-soft bg-surface p-4">
          <p className="eyebrow mb-3 text-muted-foreground">Status</p>
          {linked ? (
            <div className="flex flex-col gap-2 text-[13px]">
              <p className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" /> Linked to this client
              </p>
              <GhlSubAccountPicker clientId={clientId} locationId={board.status.locationId} />
              {board.status.url && (
                <a href={board.status.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  Open in GHL <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {board.status.snapshotStatus && <p className="text-[12px] text-muted-foreground">Snapshot: {board.status.snapshotStatus}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-[13px]">
              <p className="text-muted-foreground">
                Not linked yet. Already in GHL? Pick it from the list. Just created it? The Hub can also find it by
                the name on this board.
              </p>
              <GhlSubAccountPicker clientId={clientId} locationId={null} />
              <button
                type="button"
                disabled={link.isPending}
                onClick={() => link.mutate(null)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium transition hover:bg-muted disabled:opacity-50"
              >
                {link.isPending && link.variables === null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Find it by name and link
              </button>
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow text-muted-foreground/80">Or paste its GHL link</span>
                <input
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder="https://app.gohighlevel.com/v2/location/…"
                  spellCheck={false}
                  className="h-9 w-full rounded-md border border-border bg-card px-2.5 font-mono text-[12px] outline-none transition focus:border-foreground/30"
                />
                <button
                  type="button"
                  disabled={link.isPending || !pasted.trim()}
                  onClick={() => link.mutate(pasted.trim())}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium transition hover:bg-muted disabled:opacity-50"
                >
                  {link.isPending && link.variables ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  Link this one
                </button>
              </div>
              {result && !result.ok && (
                <p className={cn('text-[12px]', result.status === 'not_found' ? 'text-amber-600 dark:text-amber-300' : 'text-destructive')}>{result.reason}</p>
              )}
              {result?.ok && <p className="text-[12px] text-emerald-600 dark:text-emerald-400">Linked {result.name}.</p>}
              {board.status.provisionStatus === 'failed' && board.status.provisionError && (
                <p className="rounded-lg border border-border bg-card px-3 py-2 text-[11.5px] leading-snug text-muted-foreground">
                  Last automatic attempt: {board.status.provisionError}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border-soft bg-surface p-4">
          <p className="eyebrow mb-2 text-muted-foreground">Snapshot to load</p>
          <p className="text-[13px] font-medium">{board.snapshot.name ?? 'Onboarding snapshot'}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{board.snapshot.id}</p>
          {board.snapshot.listed === false && (
            <p className="mt-1 text-[11.5px] text-amber-600 dark:text-amber-300">This id isn&rsquo;t in the agency&rsquo;s snapshot list — check Settings → GHL sub-accounts.</p>
          )}
        </section>
      </aside>

      <div className="flex min-w-0 flex-col gap-6">
        {!linked && (
          <section className="rounded-xl border border-border-soft bg-surface p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
              <p className="eyebrow text-muted-foreground">Steps</p>
              <a href={AGENCY_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-[11.5px] text-muted-foreground hover:text-foreground">
                Open GHL agency view <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <ul className="flex flex-col gap-2">
              {STEPS.map((s) => {
                const on = checks.includes(s.id)
                return (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug">
                      <input type="checkbox" checked={on} onChange={() => toggle(s.id)} className="mt-0.5 h-4 w-4 shrink-0 accent-foreground" />
                      <span className={cn(on && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{s.text}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
            <p className="mt-3 text-[12px] text-muted-foreground">
              Then come back and press <span className="font-medium text-foreground/80">Find it by name and link</span>.
            </p>
          </section>
        )}

        {blanks > 0 && (
          <p className="text-[12.5px] text-muted-foreground">
            {blanks} detail{blanks === 1 ? ' is' : 's are'} not on file — leave {blanks === 1 ? 'it' : 'them'} blank in GHL or fill in from what you know.
            {!board.client.hasIntake && ' This client has no onboarding answers, so most come from the client record.'}
          </p>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="eyebrow text-muted-foreground">Business details — GHL&rsquo;s create form, in order</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {board.fields.map((f) => (
              <CopyCard key={f.key} field={f} wide={f.key === 'name'} />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="eyebrow text-muted-foreground">Account owner</h2>
            <p className="font-mono text-[11px] text-muted-foreground/70">the client&rsquo;s login — GHL emails them an invite</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {board.owner.map((f) => (
              <CopyCard key={f.key} field={f} />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function CopyCard({ field, wide }: { field: GhlBoardField; wide?: boolean }) {
  const [copied, setCopied] = useState(false)
  const empty = !field.value.trim()

  async function copy() {
    try {
      await navigator.clipboard.writeText(field.value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4', empty ? 'border-amber-500/40' : 'border-border', wide && 'sm:col-span-2')}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-semibold">{field.label}</p>
        <button
          type="button"
          onClick={copy}
          disabled={empty}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40',
            copied ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-border bg-surface hover:bg-muted',
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className={cn('rounded-lg border border-border-soft bg-surface px-3 py-2.5 font-mono text-[12.5px] leading-relaxed', wide && 'text-[15px]')}>
        {empty ? <span className="text-amber-600 dark:text-amber-300">not on file</span> : field.value}
      </div>
      {field.note && <p className="text-[11.5px] leading-snug text-muted-foreground">{field.note}</p>}
    </div>
  )
}
