'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleDashed, DownloadCloud, Loader2, MinusCircle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImportState } from '@/lib/hl/ghl-import'
import { Badge, Button, Card, ErrorNote, Spinner, fmtDateTime, hlFetch } from './ui'

type ImportResponse = { state: ImportState | null; phases: readonly (readonly [string, string])[]; defaultVault: string }

/**
 * Settings → GoHighLevel Import: copy a GHL sub-account (contacts,
 * conversations, pipelines, calendars, forms…) into this one. Read-only on
 * GHL's side; running it again updates instead of duplicating.
 */
export function ImportPanel({ accountId, compact = false }: { accountId?: string; compact?: boolean }) {
  const qc = useQueryClient()
  const q = useQuery<ImportResponse>({
    queryKey: ['hl', 'import', accountId ?? 'default'],
    queryFn: () => hlFetch(`/api/hl/import${accountId ? `?accountId=${accountId}` : ''}`),
    refetchInterval: (query) => (query.state.data?.state?.status === 'running' ? 3000 : false),
  })
  const start = useMutation({
    mutationFn: () => hlFetch<ImportResponse>('/api/hl/import', { method: 'POST', json: accountId ? { accountId } : {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'import'] })
      qc.invalidateQueries({ queryKey: ['hl', 'accounts'] })
    },
  })
  const s = q.data?.state ?? null
  const running = s?.status === 'running'
  const total = q.data ? q.data.phases.length : 0
  const finished = s ? Object.values(s.phases).filter((p) => p.status !== 'pending' && p.status !== 'running').length : 0

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-4 border-b border-border px-5 py-4">
        <span className="grid h-10 w-10 place-items-center rounded-md border border-border bg-surface text-primary">
          <DownloadCloud className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-foreground">Import from GoHighLevel</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Copies the GHL sub-account behind the Vault key <span className="font-mono text-foreground/85">{s?.vaultName ?? q.data?.defaultVault ?? 'GHL Genisys Token'}</span>: contacts, conversations, pipelines, opportunities, notes, tasks, calendars, appointments,
            forms, staff, tags, custom fields and the lists GHL keeps. Nothing changes in GHL. Run it again any time to pick up what’s new.
          </p>
          {s && (
            <p className="mt-2 font-mono text-[11.5px] text-muted-foreground">
              {running ? `Running · ${finished}/${total} sections · started ${fmtDateTime(s.startedAt)}` : s.status === 'done' ? `Finished ${fmtDateTime(s.finishedAt)}` : `Stopped: ${s.error ?? 'failed'}`}
            </p>
          )}
        </div>
        <Button variant="primary" loading={start.isPending} disabled={running} icon={running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined} onClick={() => start.mutate()}>
          {running ? 'Importing…' : s ? 'Run again' : 'Start import'}
        </Button>
      </div>
      {q.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : s && !compact ? (
        <ul className="divide-y divide-border-soft">
          {(q.data?.phases ?? []).map(([key, label]) => {
            const p = s.phases[key as keyof typeof s.phases]
            if (!p) return null
            const Icon = p.status === 'done' ? CheckCircle2 : p.status === 'running' ? Loader2 : p.status === 'skipped' ? MinusCircle : p.status === 'failed' ? XCircle : CircleDashed
            return (
              <li key={key} className="flex items-start gap-3 px-5 py-2.5">
                <Icon
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0',
                    p.status === 'done' && 'text-success',
                    p.status === 'running' && 'animate-spin text-primary',
                    p.status === 'skipped' && 'text-warning',
                    p.status === 'failed' && 'text-destructive',
                    p.status === 'pending' && 'text-muted-foreground/50',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-foreground">{label}</p>
                  {p.detail && <p className="text-[12px] text-muted-foreground">{p.detail}</p>}
                </div>
                {p.count > 0 && <Badge color={p.status === 'done' ? 'green' : 'gray'}>{p.count.toLocaleString('en-US')}</Badge>}
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className="px-5 pb-4">
        <ErrorNote error={q.error || start.error} />
      </div>
    </Card>
  )
}
