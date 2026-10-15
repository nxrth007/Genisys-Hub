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
  snapshotId: string | null
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
  const [snapshotDraft, setSnapshotDraft] = useState<string | null>(null)

  const query = useQuery<Overview>({
    queryKey: ['lead-alerts'],
    queryFn: async () => readJson<Overview>(await fetch('/api/admin/lead-alerts')),
    refetchInterval: 30_000,
  })
  const data = query.data
  const refresh = () => qc.invalidateQueries({ queryKey: ['lead-alerts'] })

  const update = useMutation({
    mutationFn: async (patch: { enabled?: boolean; snapshotId?: string | null }) =>
      readJson(
        await fetch('/api/admin/lead-alerts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }),
      ),
    onSuccess: () => {
      setSnapshotDraft(null)
      refresh()
    },
    onError: (err) => window.alert(`Couldn't save: ${(err as Error).message}`),
  })

  const snapshots = useMutation({
    mutationFn: async () =>
      readJson<{ snapshots: { id: string; name: string; type: string }[] }>(
        await fetch('/api/admin/lead-alerts?snapshots=1'),
      ),
    onError: (err) => window.alert(`Couldn't list snapshots: ${(err as Error).message}`),
  })

  const install = useMutation({
    mutationFn: async (clientId: string) =>
      readJson<{ status: string; reason?: string }>(
        await fetch('/api/admin/lead-alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'install', clientId }),
        }),
      ),
    onSuccess: (r) => {
      setNotice(
        r.status === 'installed'
          ? { ok: true, text: 'Loaded into the sub-account.' }
          : { ok: false, text: r.reason || `Not installed (${r.status}).` },
      )
      refresh()
    },
    onError: (err) => setNotice({ ok: false, text: (err as Error).message }),
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
            A client without an EIN can&apos;t text from their own sub-account. Set a client to{' '}
            <span className="font-medium text-foreground/90">No EIN</span> on their card and the Hub installs a
            small workflow in their sub-account that sends each form and chat-widget lead here, then texts their
            contact phone from <code>{data?.vaultEntryName ?? 'GHL Genisys Token'}</code>
            {data?.senderPhone ? ` (${data.senderPhone})` : ''}. Once they have an EIN, changing the status stops
            the texts.
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
          disabled={query.isLoading || update.isPending}
          onClick={() => update.mutate({ enabled: !enabled })}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50',
            enabled ? 'bg-success/15 text-success' : 'bg-muted text-foreground/85',
          )}
        >
          {update.isPending ? (
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

      </div>

      <div className="mt-3 rounded-lg border border-border bg-background px-4 py-3">
        <label htmlFor="lead-alert-snapshot" className="text-sm font-medium">
          Lead-alert snapshot
        </label>
        <p className="text-xs text-muted-foreground">
          {data?.snapshotId
            ? 'Loaded automatically into every No EIN client’s sub-account — as soon as the client is set to No EIN, or their sub-account is linked. Existing workflows and settings in the sub-account are left alone.'
            : 'Not chosen — nothing is installed. Set it up once (below) and the Hub does every client from then on.'}
        </p>
        <div className="mt-2 flex gap-2">
          <input
            id="lead-alert-snapshot"
            value={snapshotDraft ?? data?.snapshotId ?? ''}
            onChange={(e) => setSnapshotDraft(e.target.value)}
            placeholder="Snapshot ID"
            spellCheck={false}
            className="flex-1 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-sm"
          />
          <button
            type="button"
            disabled={snapshotDraft === null || snapshotDraft.trim() === (data?.snapshotId ?? '') || update.isPending}
            onClick={() => update.mutate({ snapshotId: snapshotDraft?.trim() || null })}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => snapshots.mutate()}
            disabled={snapshots.isPending}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
          >
            {snapshots.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Choose…'}
          </button>
        </div>
        {snapshots.data && (
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {snapshots.data.snapshots.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  {s.name || 'Untitled'} <span className="font-mono text-muted-foreground">{s.id}</span>
                </span>
                {s.id === data?.snapshotId ? (
                  <span className="text-success">in use</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Use “${s.name || s.id}” and load it into every No EIN client’s sub-account?`)) {
                        update.mutate({ snapshotId: s.id })
                        snapshots.reset()
                      }
                    }}
                    className="text-primary hover:underline"
                  >
                    Use this
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <details className="mt-3" open={!data?.snapshotId}>
          <summary className="cursor-pointer text-xs font-medium">One-time setup</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Create the webhook URL above and copy it.</li>
            <li>
              In GHL, make an empty sub-account (e.g. <em>Template: Lead alert</em>) with a single workflow,{' '}
              <em>Lead alert → Hub</em>: triggers Form Submitted (no filter) and the chat widget; action Webhook,
              POST, the URL. Publish it. Keep everything else out of that sub-account — the whole snapshot gets
              loaded.
            </li>
            <li>Agency view → Account Snapshots → create a snapshot of that sub-account.</li>
            <li>
              Choose it here. From then on, setting a client to No EIN is the whole job — make sure their card has
              the GHL sub-account linked and a contact phone.
            </li>
            <li>
              Optional Custom Data on the webhook action: <code>source</code> and <code>message</code> override what
              the Hub reads from the lead; any other key is added to the text as-is.
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
                const blocker = !c.linked
                  ? 'No GHL sub-account linked — link it on the client card.'
                  : !c.contactPhone
                    ? 'No contact phone on the client card — nothing to text.'
                    : null
                const installNote =
                  c.installStatus === 'installed'
                    ? c.lastLeadAt
                      ? null
                      : 'Installed — no lead yet.'
                    : c.installStatus === 'installing'
                      ? 'Installing…'
                      : c.installStatus === 'failed'
                        ? `Install failed: ${c.installError ?? 'unknown error'}`
                        : data.snapshotId
                          ? 'Not installed yet — the Hub will within 5 minutes.'
                          : 'Not installed — choose the lead-alert snapshot above.'
                return (
                  <li key={c.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.name}</p>
                      <p className={cn('mt-0.5 break-words text-xs', blocker || c.installStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                        {blocker ?? installNote ?? `Texts ${c.contactPhone}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <p className="text-right text-xs text-muted-foreground">
                        {c.lastLeadAt ? `Last lead ${when(c.lastLeadAt)}` : ''}
                        {c.lastStatus && c.lastStatus !== 'delivered' ? ` · ${c.lastStatus}` : ''}
                      </p>
                      {c.linked && data.snapshotId && c.installStatus !== 'installing' && (
                        <button
                          type="button"
                          disabled={install.isPending}
                          onClick={() => {
                            if (
                              c.installStatus !== 'installed' ||
                              window.confirm(`Load the lead-alert snapshot into ${c.name}’s sub-account again?`)
                            ) {
                              install.mutate(c.id)
                            }
                          }}
                          className="rounded-md border border-border px-2 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-50"
                        >
                          {install.isPending && install.variables === c.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : c.installStatus === 'installed' ? (
                            'Reinstall'
                          ) : (
                            'Install now'
                          )}
                        </button>
                      )}
                    </div>
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
