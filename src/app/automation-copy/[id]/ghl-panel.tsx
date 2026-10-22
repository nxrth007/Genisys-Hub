'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, Loader2, RefreshCw, Send, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AutomationInputs } from '@/lib/automation-copy'
import type { GhlAutomationStatus, PushResult } from '@/lib/ghl-automation-values'

/** The three base automations the copy is for, as they're likely named in a sub-account. */
const EXPECTED_WORKFLOWS: { label: string; match: RegExp }[] = [
  { label: 'Auto Missed Call Text-Back', match: /missed\s*call/i },
  { label: 'Website Chat Widget Form Submitted', match: /chat/i },
  { label: 'Website Quote Form Submitted', match: /quote/i },
]

/**
 * The client's GHL sub-account: whether the Hub can reach it, the board's
 * details as custom values there, and a button to write them.
 */
export function GhlPanel({ clientId, values }: { clientId: string; values: AutomationInputs }) {
  const qc = useQueryClient()
  const key = ['automation-copy-ghl', clientId]
  const q = useQuery({
    queryKey: key,
    queryFn: async (): Promise<GhlAutomationStatus> => {
      const res = await fetch(`/api/automation-copy/${clientId}/ghl`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Couldn’t check GHL')
      return data
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const [pushing, setPushing] = useState(false)
  const [push, setPush] = useState<PushResult | null>(null)
  const [pushError, setPushError] = useState<string | null>(null)

  async function send() {
    setPushing(true)
    setPushError(null)
    try {
      const res = await fetch(`/api/automation-copy/${clientId}/ghl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values }),
      })
      const data = (await res.json().catch(() => ({}))) as PushResult & { error?: string }
      if (!res.ok) throw new Error(data.error || 'Couldn’t send to GHL')
      setPush(data)
      qc.setQueryData(key, data.status)
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err))
    } finally {
      setPushing(false)
    }
  }

  const s = q.data
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border-soft bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow text-muted-foreground">GHL sub-account</p>
          <p className="text-[12px] text-muted-foreground">
            The details on the left as custom values, for workflows that use them instead of typed names.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} /> Check again
          </button>
          {s?.linked && (
            <button
              type="button"
              onClick={send}
              disabled={pushing || !s.using}
              title={s.using ? `Writes with the ${s.using.source} (${s.using.label})` : 'No key the Hub has can reach this sub-account'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send to GHL
            </button>
          )}
        </div>
      </div>

      {q.isLoading ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking the sub-account…
        </p>
      ) : q.error ? (
        <p className="text-[13px] text-destructive">{(q.error as Error).message}</p>
      ) : !s ? null : !s.linked ? (
        <p className="text-[13px]">
          {s.reason}{' '}
          <Link href={`/clients/${clientId}/ghl`} className="underline underline-offset-2">
            Link it on the client’s GHL page
          </Link>
          , then check again.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11.5px] text-muted-foreground">
            <span>{s.profile?.name || 'Sub-account'}</span>
            <span>{s.locationId}</span>
            {s.subaccountUrl && (
              <a href={s.subaccountUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                Open in GHL <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            {s.access.map((a) => (
              <div key={a.label} className="flex flex-wrap items-start gap-x-4 gap-y-1 rounded-lg border border-border-soft bg-card px-3 py-2 text-[12.5px]">
                <span className="min-w-[12rem] font-medium">
                  {a.source === 'agency key' ? 'Agency key' : 'Sub-account key'}
                  <span className="block font-mono text-[11px] font-normal text-muted-foreground">{a.label}</span>
                </span>
                <Result ok={a.customValues.ok} label="Custom values" detail={a.customValues.detail} />
                <Result ok={a.workflows.ok} label="Workflows" detail={a.workflows.detail} />
              </div>
            ))}
            {s.notes.map((n) => (
              <p key={n} className="text-[12px] text-muted-foreground">
                {n}
              </p>
            ))}
            {!s.using && (
              <p className="text-[12.5px] text-amber-700 dark:text-amber-300">
                No key the Hub has can read this sub-account’s custom values. Add a key for it to the Vault (tag it ghl and client, named after the
                business), then check again.
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Custom value</th>
                  <th className="py-1.5 pr-3 font-medium">Token for workflows</th>
                  <th className="py-1.5 pr-3 font-medium">In GHL now</th>
                  <th className="py-1.5 font-medium">Board</th>
                </tr>
              </thead>
              <tbody>
                {s.values.map((v) => {
                  const hub = values[v.input].trim()
                  const same = v.ghl && v.ghl.value === hub
                  return (
                    <tr key={v.key} className="border-t border-border-soft align-top">
                      <td className="py-2 pr-3 font-medium">{v.name}</td>
                      <td className="py-2 pr-3 font-mono text-[11.5px] text-sky-700 dark:text-sky-300">
                        {v.ghl?.fieldKey || `{{ custom_values.${v.key} }}`}
                      </td>
                      <td className={cn('py-2 pr-3', !v.ghl ? 'text-muted-foreground' : same ? '' : 'text-amber-700 dark:text-amber-300')}>
                        {v.ghl ? v.ghl.value || '(empty)' : 'Not there yet'}
                      </td>
                      <td className="py-2">
                        <span className="inline-flex items-center gap-1">
                          {same && <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
                          {hub || <span className="text-muted-foreground">blank</span>}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {pushError && <p className="text-[12.5px] text-destructive">{pushError}</p>}
          {push && (
            <div className="rounded-lg border border-border-soft bg-card px-3 py-2 text-[12.5px]">
              <p className="mb-1 font-medium">{push.error ? push.error : push.ok ? 'Sent to GHL.' : 'Some values didn’t go through.'}</p>
              <ul className="flex flex-col gap-0.5">
                {push.results.map((r) => (
                  <li key={r.name} className={cn(r.action === 'failed' && 'text-destructive')}>
                    {r.name}: {r.action}
                    {r.action === 'failed' || r.action === 'skipped' ? ` (${r.detail})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="group">
            <summary className="cursor-pointer list-none text-[12.5px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              Workflows in this sub-account{s.workflows ? ` (${s.workflows.length})` : ''}
            </summary>
            {s.workflows ? (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {EXPECTED_WORKFLOWS.map((e) => {
                    const found = s.workflows!.some((w) => e.match.test(w.name))
                    return (
                      <span
                        key={e.label}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px]',
                          found ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/40 text-amber-700 dark:text-amber-300',
                        )}
                      >
                        {found ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />} {e.label}
                      </span>
                    )
                  })}
                </div>
                <ul className="columns-1 gap-6 text-[12.5px] sm:columns-2">
                  {s.workflows.map((w) => (
                    <li key={w.name} className="break-inside-avoid py-0.5">
                      {w.name} <span className="font-mono text-[11px] text-muted-foreground">{w.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-2 text-[12.5px] text-muted-foreground">No key the Hub has can list this sub-account’s workflows.</p>
            )}
          </details>
        </>
      )}
    </section>
  )
}

function Result({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <span className={cn('inline-flex min-w-0 flex-1 items-start gap-1', ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive')}>
      {ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 break-words">
        {label}: {detail}
      </span>
    </span>
  )
}
