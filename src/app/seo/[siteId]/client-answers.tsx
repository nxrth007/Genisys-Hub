'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ClipboardList, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FactSource } from '@/lib/seo/types'
import type { SeoSiteDetail, SeoSiteDetailResponse } from '@/lib/seo/api-types'
import { btnSmall, Card, CopyButton, enc, Notice, type NoticeState, seoFetch, seoKeys, timeAgo } from '../ui'

/**
 * From the client — the onboarding form's answers next to the business
 * facts: what's still missing (with a message to send them), where the form
 * and the facts disagree, and what changed lately. The engine reads the same
 * answers every week (lib/seo/client-facts.ts).
 */

const FIELD_LABEL: Record<string, string> = {
  established: 'Year founded',
  license: 'License',
  insurance: 'Insurance',
  owner: 'Owner',
}

export function SourceChip({ source }: { source?: { source: FactSource; at: string; by: string | null } }) {
  if (!source) return null
  const client = source.source === 'client'
  return (
    <span
      title={client ? `From the client’s onboarding form (${source.at.slice(0, 10)})` : `Set in the Hub${source.by ? ` by ${source.by}` : ''} (${source.at.slice(0, 10)})`}
      className={cn(
        'rounded px-1.5 py-px font-mono text-[10px] uppercase tracking-wide',
        client ? 'bg-emerald-500/15 text-emerald-300' : 'bg-sky-500/15 text-sky-300',
      )}
    >
      {client ? 'client' : 'team'}
    </span>
  )
}

export function ClientAnswersCard({ site, now }: { site: SeoSiteDetail; now: number }) {
  const qc = useQueryClient()
  const [notice, setNotice] = useState<NoticeState>(null)
  const [showMessage, setShowMessage] = useState(false)
  const c = site.client

  const act = useMutation({
    mutationFn: (body: Record<string, string>) =>
      seoFetch<{ site: SeoSiteDetail }>(`/api/seo/sites/${enc(site.id)}/facts`, { method: 'POST', body }),
    onMutate: () => setNotice(null),
    onSuccess: ({ site: next }, body) => {
      if (next) qc.setQueryData<SeoSiteDetailResponse>(seoKeys.site(site.id), (old) => (old ? { ...old, site: next } : old))
      setNotice({
        tone: 'ok',
        text: body.action === 'sync_intake' ? 'Folded the client’s latest answers into the facts.' : 'Settled. The form won’t raise it again.',
      })
    },
    onError: (e: Error) => setNotice({ tone: 'err', text: e.message }),
  })

  return (
    <Card
      title="From the client"
      hint={c.intake ? `onboarding form · ${timeAgo(c.intake.submittedAt, now)}` : 'no onboarding answers on file'}
      actions={
        c.intake && site.facts ? (
          <button
            type="button"
            className={btnSmall}
            disabled={act.isPending}
            onClick={() => act.mutate({ action: 'sync_intake' })}
            title="Fold the client’s newest answers into the facts again (team edits are kept)"
          >
            {act.isPending && act.variables?.action === 'sync_intake' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Re-apply answers
          </button>
        ) : null
      }
    >
      <div className="flex flex-col gap-5">
        <Notice notice={notice} onClose={() => setNotice(null)} />

        {!c.intake && (
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            This client has no onboarding submission linked. If they filled the form under a different business name, link it
            on the Clients page; otherwise the checklist below is what to ask them for.
          </p>
        )}
        {c.intake && !c.synced && (
          <p className="text-[12.5px] text-muted-foreground">A newer submission arrived — the engine folds it into the facts within a minute.</p>
        )}

        {c.conflicts.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold">Needs a decision</h3>
            {c.conflicts.map((x) => (
              <div key={`${x.field}-${x.client}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1 basis-[16rem]">
                  <span className="font-medium">{FIELD_LABEL[x.field] ?? x.field}:</span> the form says <b>{x.client}</b>, the facts say{' '}
                  <b>{x.current}</b>.
                </span>
                <button type="button" className={btnSmall} disabled={act.isPending} onClick={() => act.mutate({ action: 'resolve', field: x.field, choice: 'client' })}>
                  Use {x.client}
                </button>
                <button type="button" className={btnSmall} disabled={act.isPending} onClick={() => act.mutate({ action: 'resolve', field: x.field, choice: 'current' })}>
                  Keep {x.current}
                </button>
              </div>
            ))}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" />
              {c.gaps.length ? `Still needed from the client (${c.gaps.length})` : 'Nothing missing — the engine has what it needs'}
            </h3>
            {c.gaps.length > 0 && (
              <span className="flex items-center gap-2">
                <button type="button" className={btnSmall} onClick={() => setShowMessage((v) => !v)}>
                  <ChevronDown className={cn('h-3 w-3 transition', showMessage && 'rotate-180')} /> {showMessage ? 'Hide' : 'Show'} message
                </button>
                <CopyButton value={c.request} label="Copy message" />
              </span>
            )}
          </div>
          {c.gaps.length > 0 && (
            <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {c.gaps.map((g) => (
                <li key={g.key} className="text-[12.5px] leading-snug">
                  <span className="font-medium text-foreground/90">{g.label}</span>
                  <span className="block text-[12px] text-muted-foreground">{g.why}</span>
                </li>
              ))}
            </ul>
          )}
          {showMessage && c.request && (
            <pre className="whitespace-pre-wrap rounded-lg border border-border-soft bg-surface px-3 py-2 font-sans text-[12.5px] leading-relaxed text-foreground/85">
              {c.request}
            </pre>
          )}
          {c.gaps.length > 0 && (
            <p className="text-[11.5px] text-muted-foreground/80">
              When they answer, add it to the facts below (or have them resubmit the onboarding form — it’s picked up automatically).
            </p>
          )}
        </section>

        {c.changes.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[13px] font-semibold">Recent changes to the facts</h3>
            <ul className="flex flex-col gap-1">
              {c.changes.slice(0, 8).map((x, i) => (
                <li key={`${x.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                  <SourceChip source={{ source: x.source, at: x.at, by: x.by }} />
                  <span className="min-w-0 flex-1">{x.summary}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {timeAgo(x.at, now)}
                    {x.by ? ` · ${x.by.split('@')[0]}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {c.intake && (
          <details className="group rounded-lg border border-border-soft">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[12.5px] font-medium">
              Their answers, word for word
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition group-open:rotate-180" />
            </summary>
            <dl className="grid gap-3 border-t border-border-soft px-3 py-3">
              {c.intake.answers.map((a) => (
                <div key={a.label} className="flex flex-col gap-0.5">
                  <dt className="eyebrow text-muted-foreground">{a.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground/85">{a.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </Card>
  )
}
