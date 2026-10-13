'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Copy, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClientSummary, DuplicatePair } from '@/lib/client-dedupe'
import type { MergeResult } from '@/lib/client-merge'

/**
 * Clients that look like the same business, side by side, with a merge:
 * pick the record to keep and the name to keep, and everything on the
 * other one (submissions, logins, appointments, invoices, SEO site, A2P
 * board) moves onto it. Hidden when there are no pairs.
 */

type View = { pairs: DuplicatePair[]; canMerge: boolean }

const KEY = ['client-duplicates']

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

async function post(body: Record<string, unknown>): Promise<View & { result?: MergeResult }> {
  const res = await fetch('/api/clients/duplicates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
  return data
}

export function DuplicateClients() {
  const qc = useQueryClient()
  const [done, setDone] = useState<MergeResult | null>(null)
  const q = useQuery<View | null>({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch('/api/clients/duplicates')
      if (res.status === 403) return null
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      return res.json()
    },
    staleTime: 60_000,
  })
  const act = useMutation({
    mutationFn: post,
    onSuccess: (data) => {
      qc.setQueryData(KEY, { pairs: data.pairs, canMerge: data.canMerge })
      if (data.result) {
        setDone(data.result)
        qc.invalidateQueries({ queryKey: ['clients-roster'] })
        qc.invalidateQueries({ queryKey: ['clients'] })
      }
    },
  })

  const v = q.data
  if (!v || (!v.pairs.length && !done)) return null

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-warning">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
          <Copy className="h-3.5 w-3.5" /> Possible duplicates
        </span>
        <span>
          {v.pairs.length
            ? `${v.pairs.length} pair${v.pairs.length === 1 ? '' : 's'} of clients look like the same business.`
            : 'No more duplicates.'}
          {!v.canMerge && v.pairs.length > 0 && ' Only Alex can merge them.'}
        </span>
      </div>

      {done && (
        <div className="flex flex-col gap-1 rounded-lg border border-border-soft bg-card px-3 py-2 text-foreground">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" /> Merged into {done.name}
            {Object.keys(done.moved).length > 0 && (
              <span className="font-normal text-muted-foreground">
                {' '}
                — moved {Object.entries(done.moved).map(([k, n]) => `${n} ${k}`).join(', ')}
              </span>
            )}
          </span>
          {done.notes.map((n) => (
            <span key={n} className="text-warning">
              {n}
            </span>
          ))}
          <button type="button" onClick={() => setDone(null)} className="self-start text-[11.5px] text-muted-foreground hover:text-foreground hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {v.pairs.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-soft rounded-lg border border-border-soft bg-card text-[12.5px] text-foreground">
          {v.pairs.map((p) => (
            <PairRow
              key={`${p.a.id}|${p.b.id}`}
              pair={p}
              canMerge={v.canMerge}
              busy={act.isPending}
              onDismiss={() => act.mutate({ action: 'dismiss', a: p.a.id, b: p.b.id })}
              onMerge={(keepId, dropId, useOtherName) => {
                setDone(null)
                act.mutate({ action: 'merge', keepId, dropId, useOtherName })
              }}
            />
          ))}
        </ul>
      )}
      {act.isError && <p className="text-[12px] text-destructive">{(act.error as Error).message}</p>}
    </div>
  )
}

/** The record with more on it is the better one to keep. */
function weight(c: ClientSummary): number {
  return (c.archived ? 0 : 1000) + (c.repoFullName ? 100 : 0) + (c.ghlLocationId ? 50 : 0) + c.appointments * 2 + c.users * 5 + c.intakes
}

function PairRow({
  pair,
  canMerge,
  busy,
  onDismiss,
  onMerge,
}: {
  pair: DuplicatePair
  canMerge: boolean
  busy: boolean
  onDismiss: () => void
  onMerge: (keepId: string, dropId: string, useOtherName: boolean) => void
}) {
  const [keepId, setKeepId] = useState(weight(pair.b) > weight(pair.a) ? pair.b.id : pair.a.id)
  const [nameFrom, setNameFrom] = useState(keepId)
  const [confirming, setConfirming] = useState(false)
  const keep = keepId === pair.a.id ? pair.a : pair.b
  const drop = keepId === pair.a.id ? pair.b : pair.a
  const finalName = nameFrom === keep.id ? keep.name : drop.name

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
        <span className="font-medium text-foreground">{pair.a.name}</span>
        <span>and</span>
        <span className="font-medium text-foreground">{pair.b.name}</span>
        <span>· {pair.why.join(' · ')}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {[pair.a, pair.b].map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={!canMerge}
            onClick={() => {
              setKeepId(c.id)
              setNameFrom(c.id)
              setConfirming(false)
            }}
            className={cn(
              'flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition disabled:cursor-default',
              canMerge && keepId === c.id ? 'border-primary bg-primary/5' : 'border-border-soft hover:bg-muted/50',
            )}
          >
            <span className="flex items-center gap-2">
              <span className="font-medium">{c.name}</span>
              {canMerge && keepId === c.id && <span className="rounded bg-primary/15 px-1.5 text-[10.5px] font-medium text-primary">Keep</span>}
              {c.archived && <span className="rounded bg-muted px-1.5 text-[10.5px] text-muted-foreground">Archived</span>}
            </span>
            <span className="text-[11.5px] text-muted-foreground">
              Added {day(c.createdAt)} · {c.lifecycle}
              {c.contactName ? ` · ${c.contactName}` : ''}
            </span>
            <span className="text-[11.5px] text-muted-foreground">
              {[c.contactEmail, c.contactPhone].filter(Boolean).join(' · ') || 'No contact details'}
            </span>
            <span className="text-[11.5px] text-muted-foreground">
              {c.intakes} submission{c.intakes === 1 ? '' : 's'} · {c.users} login{c.users === 1 ? '' : 's'} · {c.appointments} appointment{c.appointments === 1 ? '' : 's'}
              {c.repoFullName ? ` · ${c.repoFullName}` : ''}
              {c.ghlLocationId ? ' · GHL sub-account' : ''}
            </span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {canMerge && (
          <>
            <label className="inline-flex items-center gap-1.5 text-muted-foreground">
              Name
              <select
                value={nameFrom}
                onChange={(e) => {
                  setNameFrom(e.target.value)
                  setConfirming(false)
                }}
                className="h-7 rounded-md border border-border bg-surface px-2 text-[12px] text-foreground outline-none"
              >
                <option value={pair.a.id}>{pair.a.name}</option>
                <option value={pair.b.id}>{pair.b.name}</option>
              </select>
            </label>
            {confirming ? (
              <>
                <span className="text-foreground">
                  Move everything from <b>{drop.name}</b> onto <b>{keep.name}</b>, name it <b>{finalName}</b>, and delete the extra record?
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onMerge(keep.id, drop.id, nameFrom !== keep.id)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />} Merge
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="text-[11.5px] text-muted-foreground hover:text-foreground hover:underline">
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                className="rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium hover:bg-muted disabled:opacity-50"
              >
                Merge into {keep.name}
              </button>
            )}
          </>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="ml-auto text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title="They're different businesses — stop flagging this pair"
        >
          Not duplicates
        </button>
      </div>
    </li>
  )
}
