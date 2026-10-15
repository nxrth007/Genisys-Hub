'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Building2, Check, CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  GhlConnectionCheck,
  GhlProvisionRow,
  GhlSubaccountSettings,
} from '@/lib/ghl-subaccount-provisioning'

type ConfigResponse = { settings: GhlSubaccountSettings; recent: GhlProvisionRow[] }

class ForbiddenError extends Error {}

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (res.status === 403) throw new ForbiddenError('forbidden')
  if (!res.ok) throw new Error((data as { error?: string; reason?: string }).error || (data as { reason?: string }).reason || `HTTP ${res.status}`)
  return data as T
}

const STATUS_STYLES: Record<string, string> = {
  created: 'bg-success/15 text-success',
  linked: 'bg-primary-soft text-primary',
  creating: 'bg-muted text-foreground/80',
  failed: 'bg-destructive/10 text-destructive',
  'not started': 'bg-warning/15 text-warning',
}

const SOURCE_LABELS: Record<string, string> = {
  env: 'GHL_COMPANY_ID',
  'vault-description': 'Vault entry description',
  'agency-key': 'the agency key',
  'sub-account-list': 'the agency’s sub-account list',
  'sub-account-token': 'the sub-account tokens in the Vault',
}

/**
 * Settings → GHL sub-accounts: the automation that creates a client's
 * sub-account (with the onboarding snapshot) after a new onboarding
 * submission. Admin-only; hidden for everyone else.
 */
export function GhlSubaccountsSection() {
  const qc = useQueryClient()
  const [snapshotDraft, setSnapshotDraft] = useState<string | null>(null)
  const [check, setCheck] = useState<GhlConnectionCheck | null>(null)
  const [retryNotice, setRetryNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const config = useQuery<ConfigResponse>({
    queryKey: ['ghl-subaccounts'],
    queryFn: async () => readJson<ConfigResponse>(await fetch('/api/admin/ghl-subaccounts')),
    retry: (count, err) => !(err instanceof ForbiddenError) && count < 2,
  })

  const update = useMutation({
    mutationFn: async (patch: { enabled?: boolean; snapshotId?: string }) =>
      readJson(
        await fetch('/api/admin/ghl-subaccounts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }),
      ),
    onSuccess: () => {
      setSnapshotDraft(null)
      setCheck(null)
      qc.invalidateQueries({ queryKey: ['ghl-subaccounts'] })
    },
    onError: (err) => window.alert(`Couldn't save: ${(err as Error).message}`),
  })

  const runCheck = useMutation({
    mutationFn: async () =>
      readJson<GhlConnectionCheck>(await fetch('/api/admin/ghl-subaccounts/check', { method: 'POST' })),
    onSuccess: setCheck,
    onError: (err) => window.alert(`Check failed: ${(err as Error).message}`),
  })

  const retry = useMutation({
    mutationFn: async (clientId: string) => {
      const res = await fetch('/api/admin/ghl-subaccounts/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      })
      return (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; reason?: string; name?: string }
    },
    onSuccess: (r) => {
      setRetryNotice(
        r.ok
          ? { ok: true, text: `${r.status === 'linked' ? 'Linked' : 'Created'} “${r.name}”.` }
          : { ok: false, text: r.reason || 'Retry failed.' },
      )
      qc.invalidateQueries({ queryKey: ['ghl-subaccounts'] })
    },
    onError: (err) => setRetryNotice({ ok: false, text: (err as Error).message }),
  })

  if (config.error instanceof ForbiddenError) return null

  const settings = config.data?.settings
  const enabled = !!settings?.enabled
  const snapshotValue = snapshotDraft ?? settings?.snapshotId ?? ''
  const snapshotDirty = snapshotDraft !== null && snapshotDraft.trim() !== settings?.snapshotId

  function handleToggle(next: boolean) {
    if (next) {
      const ok = window.confirm(
        'Turn on GHL sub-account creation?\n\nEach NEW onboarding submission that creates a new client will get a sub-account in the agency, named "First name: Business name", with the configured snapshot loaded.\n\nSubmissions that arrived while this was off are not picked up.',
      )
      if (!ok) return
    }
    update.mutate({ enabled: next })
  }

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-muted p-2">
          <Building2 className="h-5 w-5 text-foreground/80" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold">GHL sub-accounts for new clients</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            When a new onboarding submission becomes a new client, a sub-account is created in the GHL agency
            — named like <span className="font-medium text-foreground/90">Randy: J&amp;R Painting</span> — with
            the snapshot below loaded, and linked on the client. Uses the <code>GHL Agency Key</code> from the
            Vault. Clients from earlier submissions are never touched; results post to #genisys-alerts.
          </p>
        </div>
      </div>

      {config.isError && (
        <Notice ok={false}>Couldn&apos;t load: {(config.error as Error).message}</Notice>
      )}

      <div className="mt-5 flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
        <div>
          <p className="text-sm font-medium">Create automatically</p>
          <p className="text-xs text-muted-foreground">
            {settings
              ? enabled
                ? `On for submissions received after ${new Date(settings.since).toLocaleString()}.`
                : 'Off — GHL only allows creating sub-accounts by API on Agency Pro ($497/mo). Make them by hand and link them from the client card. Turning this on only applies to submissions from then on.'
              : 'Loading…'}
          </p>
        </div>
        <button
          type="button"
          disabled={config.isLoading || update.isPending}
          onClick={() => handleToggle(!enabled)}
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
        <label htmlFor="ghl-snapshot-id" className="text-sm font-medium">
          Snapshot ID
        </label>
        <p className="text-xs text-muted-foreground">Loaded into every new sub-account. Checked before each one is created.</p>
        <div className="mt-2 flex gap-2">
          <input
            id="ghl-snapshot-id"
            value={snapshotValue}
            onChange={(e) => setSnapshotDraft(e.target.value)}
            spellCheck={false}
            className="flex-1 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-sm"
          />
          <button
            type="button"
            disabled={!snapshotDirty || update.isPending}
            onClick={() => update.mutate({ snapshotId: snapshotValue.trim() })}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => runCheck.mutate()}
          disabled={runCheck.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
        >
          {runCheck.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Check connection
        </button>
        <span className="text-xs text-muted-foreground">Read-only — confirms the key, the agency and the snapshot.</span>
      </div>

      {check && <CheckResult check={check} onUseSnapshot={(id) => update.mutate({ snapshotId: id })} />}

      {config.data && config.data.recent.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-medium">Latest</p>
          {retryNotice && <Notice ok={retryNotice.ok}>{retryNotice.text}</Notice>}
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {config.data.recent.map((r) => (
              <li key={r.clientId} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{r.clientName}</span>
                    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', STATUS_STYLES[r.status] ?? 'bg-muted')}>
                      {r.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.at ? new Date(r.at).toLocaleString() : ''}
                    {r.snapshotStatus ? ` · snapshot: ${r.snapshotStatus}` : ''}
                  </p>
                  {r.error && (
                    <p className={cn('mt-0.5 break-words text-xs', r.status === 'not started' ? 'text-muted-foreground' : 'text-destructive')}>
                      {r.error}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      GHL <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {enabled && (r.status === 'failed' || r.status === 'creating' || r.status === 'not started') && (
                    <button
                      type="button"
                      disabled={retry.isPending}
                      onClick={() => {
                        if (r.status !== 'not started' || window.confirm(`Create a GHL sub-account for ${r.clientName} and load the onboarding snapshot?`)) retry.mutate(r.clientId)
                      }}
                      className="rounded-md border border-border px-2 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-50"
                    >
                      {retry.isPending && retry.variables === r.clientId ? <Loader2 className="h-3 w-3 animate-spin" /> : r.status === 'not started' ? 'Create' : 'Retry'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function CheckResult({ check, onUseSnapshot }: { check: GhlConnectionCheck; onUseSnapshot: (id: string) => void }) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-background px-4 py-3 text-sm">
      <Notice ok={check.ok}>
        {check.ok ? 'Ready — the key works, and the snapshot is in the agency.' : check.problems.join(' ')}
      </Notice>
      {check.companyId && (
        <p className="text-xs text-muted-foreground">
          Agency <span className="font-mono text-foreground/90">{check.companyId}</span>
          {check.companyIdSource ? ` (from ${SOURCE_LABELS[check.companyIdSource] ?? check.companyIdSource})` : ''}
          {check.snapshot.found && (
            <>
              {' '}· snapshot <span className="font-medium text-foreground/90">{check.snapshot.name || check.snapshot.id}</span>
              {check.snapshot.type ? ` (${check.snapshot.type})` : ''}
            </>
          )}
        </p>
      )}
      {check.snapshots.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium">Snapshots in the agency ({check.snapshots.length})</summary>
          <ul className="mt-2 space-y-1">
            {check.snapshots.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  {s.name || 'Untitled'} <span className="font-mono text-muted-foreground">{s.id}</span>
                  {s.type ? <span className="text-muted-foreground"> · {s.type}</span> : null}
                </span>
                {s.id === check.snapshot.id ? (
                  <span className="text-success">in use</span>
                ) : (
                  <button type="button" onClick={() => onUseSnapshot(s.id)} className="text-primary hover:underline">
                    Use this
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {check.recentSubAccountNames.length > 0 && (
        <div>
          <p className="text-xs font-medium">Newest sub-accounts — new ones will be named the same way</p>
          <p className="mt-1 text-xs text-muted-foreground">{check.recentSubAccountNames.join(' · ')}</p>
        </div>
      )}
    </div>
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
