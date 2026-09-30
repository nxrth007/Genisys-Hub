'use client'

import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Webhook } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * One strip under the Clients header: is the onboarding form still
 * landing in the Hub? Two paths feed it — the form's webhook (instant)
 * and the Hub's own read of the form's Google Sheet (every few minutes,
 * and on demand here). A submission that misses the first is caught by
 * the second, and this says which is doing the work.
 */

type SheetStatus = {
  ok: boolean
  checkedAt: string
  sheetRows: number
  imported: { businessName: string | null; at: string | null }[]
  recoveredTotal: number
  error: string | null
  account: string | null
}

type Health = {
  webhookUrl: string
  secretConfigured: boolean
  lastIntake: { id: string; at: string; businessName: string | null; clientId: string | null } | null
  intakes30d: number
  unlinked: number
  total: number
  sheet: SheetStatus | null
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const d = Math.floor(ms / 86_400_000)
  if (d >= 1) return d === 1 ? 'yesterday' : `${d} days ago`
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return `${h}h ago`
  const m = Math.max(1, Math.floor(ms / 60_000))
  return `${m}m ago`
}

export function OnboardingHealth() {
  const qc = useQueryClient()
  const q = useQuery<Health>({
    queryKey: ['clients-onboarding-health'],
    queryFn: async () => {
      const res = await fetch('/api/clients/onboarding-health')
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      return res.json()
    },
    staleTime: 60_000,
  })
  const sync = useMutation({
    mutationFn: async (): Promise<Health> => {
      const res = await fetch('/api/clients/onboarding-health', { method: 'POST' })
      if (!res.ok) throw new Error(`Sync failed (${res.status})`)
      return res.json()
    },
    onSuccess: (data) => {
      qc.setQueryData(['clients-onboarding-health'], data)
      // New clients may have just arrived.
      qc.invalidateQueries({ queryKey: ['clients-roster'] })
    },
  })

  if (!q.data) return null
  const h = q.data
  const s = h.sheet
  const justImported = sync.isSuccess ? (sync.data?.sheet?.imported.length ?? 0) : 0

  const problem = !h.secretConfigured
    ? 'The webhook secret is missing from the Vault — the form can’t deliver by webhook.'
    : s?.error
      ? s.error
      : h.unlinked > 0
        ? `${h.unlinked} submission${h.unlinked === 1 ? '' : 's'} never became a client (no business name?).`
        : null

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border px-4 py-2.5 text-[12.5px]',
        problem ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border-soft bg-surface text-muted-foreground',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
          <Webhook className="h-3.5 w-3.5" /> Onboarding form
        </span>
        <span className="inline-flex items-center gap-1.5">
          {problem ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />}
          {problem ?? 'Connected'}
        </span>
        <span>
          Last submission:{' '}
          {h.lastIntake ? (
            <>
              <span className="text-foreground/85">{h.lastIntake.businessName ?? 'unnamed'}</span>, {ago(h.lastIntake.at)}
            </>
          ) : (
            'none yet'
          )}
        </span>
        <span>{h.intakes30d} in the last 30 days</span>
        <span className="ml-auto inline-flex items-center gap-3">
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground/85 transition hover:bg-muted disabled:opacity-50"
          >
            {sync.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Check the sheet now
          </button>
          <Link href="/clients/onboarding" className="underline underline-offset-2 hover:text-foreground">
            Onboarding answers
          </Link>
        </span>
      </div>
      <p className={cn('text-[12px]', problem ? 'text-warning/90' : 'text-muted-foreground')}>
        {s
          ? s.ok
            ? `Google Sheet: ${s.sheetRows} submission${s.sheetRows === 1 ? '' : 's'}, ${h.total} in the Hub, checked ${ago(s.checkedAt)}.${
                s.recoveredTotal > 0
                  ? ` ${s.recoveredTotal} ${s.recoveredTotal === 1 ? 'was' : 'were'} recovered from the sheet because the form’s webhook didn’t deliver ${s.recoveredTotal === 1 ? 'it' : 'them'} — set INTAKE_WEBHOOK_URL in the form’s Lovable settings.`
                  : ''
              }`
            : `Google Sheet: couldn’t be read (${ago(s.checkedAt)}).`
          : 'Google Sheet: not checked yet — the Hub reads it every 10 minutes.'}
        {sync.isSuccess && (justImported > 0 ? ` Just added ${justImported} from the sheet.` : ' Nothing new in the sheet.')}
        {sync.isError && ' The check failed — try again.'}
      </p>
    </div>
  )
}
