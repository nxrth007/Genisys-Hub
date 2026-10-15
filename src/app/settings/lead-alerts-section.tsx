'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, CheckCircle2, Copy, Loader2, MessageSquareText, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LeadAlertRow, NoEinClientRow } from '@/lib/lead-alert'

type Overview = {
  enabled: boolean
  senderPhone: string | null
  vaultEntryName: string
  recent: LeadAlertRow[]
  noEinClients: NoEinClientRow[]
  reportingSubAccounts30d: number
  secretConfigured: boolean
  webhookUrl: string | null
  isAdmin: boolean
}

const STATUS_STYLES: Record<string, string> = {
  delivered: 'bg-success/15 text-success',
  sending: 'bg-warning/15 text-warning',
  failed: 'bg-destructive/10 text-destructive',
  unrouted: 'bg-warning/15 text-warning',
  skipped: 'bg-muted text-muted-foreground',
}

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as T
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
}

/**
 * Settings → Lead texts: No EIN clients get their website leads texted
 * from the Lead Genisys sub-account. See lib/lead-alert.ts.
 */
export function LeadAlertsSection() {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const query = useQuery<Overview>({
    queryKey: ['lead-alerts'],
    queryFn: async () => readJson<Overview>(await fetch('/api/admin/lead-alerts')),
    refetchInterval: 30_000,
  })
  const data = query.data
  const refresh = () => qc.invalidateQueries({ queryKey: ['lead-alerts'] })

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) =>
      readJson(
        await fetch('/api/admin/lead-alerts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }),
      ),
    onSuccess: refresh,
    onError: (err) => window.alert(`Couldn't save: ${(err as Error).message}`),
  })

  const createSecret = useMutation({
    mutationFn: async () =>
      readJson(
        await fetch('/api/admin/lead-alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create-secret' }),
        }),
      ),
    onSuccess: refresh,
    onError: (err) => window.alert(`Couldn't create the webhook URL: ${(err as Error).message}`),
  })

  const retry = useMutation({
    mutationFn: async (id: string) =>
      readJson<{ status: string; reason?: string }>(await fetch(`/api/admin/lead-alerts/${id}`, { method: 'POST' })),
    onSuccess: (r) => {
      setNotice(
        r.status === 'delivered'
          ? { ok: true, text: 'Texted.' }
          : { ok: false, text: r.reason || `Not sent (${r.status}).` },
      )
      refresh()
    },
    onError: (err) => setNotice({ ok: false, text: (err as Error).message }),
  })

  async function copyUrl() {
    if (!data?.webhookUrl) return
    await navigator.clipboard.writeText(data.webhookUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const enabled = !!data?.enabled

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-muted p-2">
          <MessageSquareText className="h-5 w-5 text-foreground/80" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold">Lead texts for No EIN clients</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A client without an EIN can&apos;t text from their own sub-account. Each client sub-account posts its
            form and chat-widget leads to the webhook below; when the client is set to{' '}
            <span className="font-medium text-foreground/90">No EIN</span> on their card, the Hub texts their
            contact phone from <code>{data?.vaultEntryName ?? 'GHL Genisys Token'}</code>
            {data?.senderPhone ? ` (${data.senderPhone})` : ''}. Everyone else is skipped. Changing a
            client&apos;s EIN status is all it takes to start or stop it.
          </p>
        </div>
      </div>

      {query.isError && <Notice ok={false}>Couldn&apos;t load: {(query.error as Error).message}</Notice>}

      <div className="mt-5 flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
        <div>
          <p className="text-sm font-medium">Send lead texts</p>
          <p className="text-xs text-muted-foreground">
            {enabled ? 'On — No EIN clients are texted for every new lead.' : 'Off — leads are logged below but nobody is texted.'}
          </p>
        </div>
        <button
          type="button"
          disabled={query.isLoading || toggle.isPending}
          onClick={() => toggle.mutate(!enabled)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50',
            enabled ? 'bg-success/15 text-success' : 'bg-muted text-foreground/85',
          )}
        >
          {toggle.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : enabled ? (
            <>
              <CheckCircle2 className="h-3 w-3" />
              Enabled
            </>
          ) : (
            'Disabled'
          )}
        </button>
      </div>

      <div className="mt-3 rounded-lg border border-border bg-background px-4 py-3">
        <p className="text-sm font-medium">Webhook URL</p>
        {!data ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : !data.secretConfigured ? (
          data.isAdmin ? (
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={() => createSecret.mutate()}
                disabled={createSecret.isPending}
                className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
              >
                {createSecret.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Create webhook URL'}
              </button>
              <span className="text-xs text-muted-foreground">Stores a new secret in the Vault.</span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Not set up yet — an admin creates it here.</p>
          )
        ) : data.webhookUrl ? (
          <>
            <p className="text-xs text-muted-foreground">
              Contains the secret — paste it only into GHL. Heard from {data.reportingSubAccounts30d} sub-account
              {data.reportingSubAccounts30d === 1 ? '' : 's'} in the last 30 days.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={data.webhookUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs"
              />
              <button
                type="button"
                onClick={copyUrl}
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Set up. Only admins can see the URL, since it contains the secret.</p>
        )}

        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium">Installing it in a sub-account</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              If the sub-account already has a workflow posting to the Lead Genisys inbound webhooks, open it, put
              this URL in its Webhook action, and save. That&apos;s the whole install.
            </li>
            <li>
              Otherwise: Automation → Workflows → new workflow named <em>Lead alert → Hub</em>. Triggers: Form
              Submitted (no filter) plus the chat-widget trigger. Action: Webhook, method POST, this URL. Publish.
            </li>
            <li>
              Optional Custom Data on the action: <code>source</code> (e.g. &quot;Website form&quot;) and{' '}
              <code>message</code> override what the Hub guesses; any other key is added to the text as-is.
            </li>
            <li>
              Put the same workflow in the onboarding snapshot, so every new sub-account has it from day one.
            </li>
            <li>
              On the client card: the GHL sub-account must be linked, and EIN set to No EIN.
            </li>
          </ol>
        </details>
      </div>

      {data && (
        <div className="mt-5">
          <p className="text-sm font-medium">No EIN clients</p>
          {data.noEinClients.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No active client is set to No EIN.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {data.noEinClients.map((c) => {
                const problem = !c.linked
                  ? 'No GHL sub-account linked — leads can’t be matched.'
                  : !c.contactPhone
                    ? 'No contact phone — nothing to text.'
                    : !c.lastLeadAt
                      ? 'No lead heard yet — check the workflow is installed.'
                      : null
                return (
                  <li key={c.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.name}</p>
                      <p className={cn('mt-0.5 text-xs', problem && (!c.linked || !c.contactPhone) ? 'text-destructive' : 'text-muted-foreground')}>
                        {problem ?? `Texts ${c.contactPhone}`}
                      </p>
                    </div>
                    <p className="shrink-0 text-right text-xs text-muted-foreground">
                      {c.lastLeadAt ? `Last lead ${when(c.lastLeadAt)}` : ''}
                      {c.lastStatus && c.lastStatus !== 'delivered' ? ` · ${c.lastStatus}` : ''}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {data && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Recent leads</p>
            <button
              type="button"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              {query.isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Refresh
            </button>
          </div>
          {notice && <Notice ok={notice.ok}>{notice.text}</Notice>}
          {data.recent.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">Nothing yet. Each lead any sub-account posts shows up here.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {data.recent.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', STATUS_STYLES[r.status] ?? 'bg-muted')}>
                        {r.status}
                      </span>
                      <span className="truncate font-medium">{r.clientName ?? r.locationName ?? r.locationId}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {[r.leadName, r.leadPhone, r.source].filter(Boolean).join(' · ') || 'No lead details'}
                      {r.status === 'delivered' && r.recipientPhone ? ` → ${r.recipientPhone}` : ''}
                    </p>
                    {(r.errorMessage || (r.reason && r.status !== 'skipped')) && (
                      <p className="mt-0.5 break-words text-xs text-destructive">{r.errorMessage ?? r.reason}</p>
                    )}
                    {r.status === 'skipped' && r.reason && <p className="mt-0.5 text-xs text-muted-foreground">{r.reason}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">{when(r.createdAt)}</span>
                    {(r.status === 'failed' || r.status === 'unrouted' || r.status === 'sending') && (
                      <button
                        type="button"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(r.id)}
                        className="rounded-md border border-border px-2 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-50"
                      >
                        {retry.isPending && retry.variables === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Retry'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function Notice({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  const Icon = ok ? Check : AlertCircle
  return (
    <div
      className={cn(
        'mt-3 flex items-start gap-2 rounded-md border p-2.5 text-xs',
        ok ? 'border-success/30 bg-success/15 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <div>{children}</div>
    </div>
  )
}
