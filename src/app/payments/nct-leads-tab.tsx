'use client'

import { useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  cents,
  fieldClass,
  fromIso,
  ErrorBlock,
  LoadingBlock,
  StatCard,
  StatusPill,
} from './ui'

/**
 * Payments → NCT Leads.
 *
 * NCT POSTs a lead to our webhook → we charge the client's saved card
 * off-session → a scheduled sweep moves settled Stripe cash to Mercury
 * so the buffer covers NCT's next-day debit on the virtual card.
 */

type Config = {
  id: string
  clientName: string
  stripeCustomerId: string
  pricePerLeadCents: number
  costPerLeadCents: number
  weeklyCapCents: number
  sourceKey: string
  active: boolean
  weekSpentCents: number
  weekLeadCount: number
}

type Overview = {
  ok: true
  settings: {
    webhookToken: string
    chargingEnabled: boolean
    sweepEnabled: boolean
    sweepMethod: string
    sweepDestinationId: string | null
    sweepFloorCents: number
    sweepMinCents: number
    alertChannel: string | null
    lastSweepAt: string | null
  }
  destinations: Array<{ id: string; kind: string; label: string }>
  configs: Config[]
  week: {
    startsAt: string
    chargedCents: number
    leadCount: number
    costCents: number
    marginCents: number
  }
  alerts: { failedCount: number; cappedCount: number }
  leads: Array<{
    id: string
    leadId: string
    name: string | null
    phone: string | null
    email: string | null
    address: string | null
    service: string | null
    clientName: string | null
    amountCents: number
    chargeStatus: string
    failureReason: string | null
    receivedAt: string
    chargedAt: string | null
  }>
  sweeps: Array<{
    id: string
    amountCents: number
    method: string
    status: string
    detail: string | null
    manual: boolean
    stripePayoutId: string | null
    createdAt: string
  }>
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

export function NctLeadsTab() {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  )
  const [showToken, setShowToken] = useState(false)
  const [editing, setEditing] = useState<Partial<Config> | null>(null)

  // Browser-only value — read through useSyncExternalStore so the server
  // render and the hydrated render agree instead of thrashing state.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => '',
  )

  const { data, isLoading, isError, error } = useQuery<Overview>({
    queryKey: ['payments-nct'],
    queryFn: async () => {
      const res = await fetch('/api/payments/nct/overview')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to load')
      return d
    },
    refetchInterval: 30_000,
  })

  const action = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch('/api/payments/nct/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Action failed.')
      return d as { message?: string }
    },
    onSuccess: (d) => {
      setNotice({ tone: 'ok', text: d.message || 'Done.' })
      queryClient.invalidateQueries({ queryKey: ['payments-nct'] })
    },
    onError: (e) =>
      setNotice({
        tone: 'err',
        text: e instanceof Error ? e.message : 'Action failed.',
      }),
  })

  if (isLoading) return <LoadingBlock />
  if (isError || !data)
    return (
      <ErrorBlock
        message={error instanceof Error ? error.message : 'Failed to load.'}
      />
    )

  const s = data.settings
  const webhookUrl = `${origin}/api/webhooks/nct-leads`

  return (
    <div className="space-y-6">
      {notice && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-xl border p-3 text-sm',
            notice.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
          )}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)}>
            <X className="h-4 w-4 opacity-60 hover:opacity-100" />
          </button>
        </div>
      )}

      {/* ---- Week at a glance */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Billed this week"
          value={cents(data.week.chargedCents)}
          sub={`${data.week.leadCount} lead${data.week.leadCount === 1 ? '' : 's'}`}
        />
        <StatCard
          label="NCT cost"
          value={cents(data.week.costCents)}
          sub="what NCT will charge us back"
        />
        <StatCard
          label="Margin"
          value={cents(data.week.marginCents)}
          tone={data.week.marginCents >= 0 ? 'good' : 'bad'}
        />
        <StatCard
          label="Needs attention"
          value={String(data.alerts.failedCount + data.alerts.cappedCount)}
          sub={`${data.alerts.failedCount} failed · ${data.alerts.cappedCount} held at cap`}
          tone={
            data.alerts.failedCount + data.alerts.cappedCount > 0
              ? 'bad'
              : 'default'
          }
        />
      </div>

      {/* ---- Webhook credential for NCT */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="mb-1 text-sm font-semibold text-foreground">
          Webhook endpoint — give this to NCT
        </h3>
        <p className="mb-3 text-xs text-muted-foreground">
          One lead per POST. Replays of the same Lead ID are ignored, so their
          sender can safely retry.
        </p>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs">
              POST {webhookUrl}
            </code>
            <CopyButton value={webhookUrl} label="Copy URL" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs">
              x-nct-token: {showToken ? s.webhookToken : '•'.repeat(32)}
            </code>
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              {showToken ? (
                <EyeOff className="h-3 w-3" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
              {showToken ? 'Hide' : 'Reveal'}
            </button>
            <CopyButton value={s.webhookToken} label="Copy token" />
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => {
                if (
                  !window.confirm(
                    'Rotate the webhook token? NCT will stop being able to send leads until you give them the new one.',
                  )
                )
                  return
                action.mutate({ action: 'rotateToken' })
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              Rotate
            </button>
          </div>
        </div>

        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Example payload
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed">
{`{
  "leadId": "NCT-10482",
  "name": "Jane Doe",
  "phone": "555-123-4567",
  "email": "jane@example.com",
  "address": "123 Main St, Phoenix AZ",
  "service": "Roofing",
  "sourceKey": "${data.configs[0]?.sourceKey ?? 'forever-lit'}"
}`}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-medium">sourceKey</span> tells us which client
            to bill — it must match a client below. If there&apos;s only one
            active client, it can be left out. The plain{' '}
            <span className="font-mono">Name: …</span> text block NCT posts in
            Slack is also accepted as-is.
          </p>
        </details>
      </div>

      {/* ---- Clients */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">
            Clients billed for NCT leads
          </h3>
          <button
            type="button"
            onClick={() =>
              setEditing({
                pricePerLeadCents: 15000,
                costPerLeadCents: 11000,
                weeklyCapCents: 0,
                active: true,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Add client
          </button>
        </div>

        {editing && (
          <ConfigForm
            initial={editing}
            busy={action.isPending}
            onCancel={() => setEditing(null)}
            onSave={(payload) => {
              action.mutate({ action: 'saveConfig', ...payload })
              setEditing(null)
            }}
          />
        )}

        {data.configs.length === 0 && !editing ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No clients configured yet. Leads will still be recorded, but nothing
            will be charged until a client is added.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {data.configs.map((c) => {
              const pct =
                c.weeklyCapCents > 0
                  ? Math.min(100, (c.weekSpentCents / c.weeklyCapCents) * 100)
                  : 0
              return (
                <div
                  key={c.id}
                  className="rounded-2xl border border-border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-foreground">
                        {c.clientName}
                        {!c.active && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            (inactive)
                          </span>
                        )}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {c.sourceKey} · {c.stripeCustomerId}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(c)}
                        className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Remove ${c.clientName}? Leads already billed stay in the ledger.`,
                            )
                          )
                            return
                          action.mutate({ action: 'deleteConfig', id: c.id })
                        }}
                        className="rounded-md border border-rose-200 px-2 py-1 text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  <p className="mt-2 text-sm text-foreground">
                    {cents(c.pricePerLeadCents)} per lead
                    <span className="text-muted-foreground">
                      {' '}
                      · costs us {cents(c.costPerLeadCents)}
                    </span>
                  </p>

                  <div className="mt-3">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">
                        This week · {c.weekLeadCount} lead
                        {c.weekLeadCount === 1 ? '' : 's'}
                      </span>
                      <span className="font-medium tabular-nums text-foreground">
                        {cents(c.weekSpentCents)}
                        {c.weeklyCapCents > 0
                          ? ` / ${cents(c.weeklyCapCents)}`
                          : ' (uncapped)'}
                      </span>
                    </div>
                    {c.weeklyCapCents > 0 && (
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            pct >= 100
                              ? 'bg-rose-500'
                              : pct >= 80
                                ? 'bg-amber-500'
                                : 'bg-emerald-500',
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ---- Automation controls */}
      <SettingsPanel
        settings={s}
        destinations={data.destinations}
        busy={action.isPending}
        onSave={(payload) => action.mutate({ action: 'saveSettings', ...payload })}
        onSweep={() => {
          if (
            !window.confirm(
              'Send a Stripe payout to Mercury now for the full available balance above your floor?',
            )
          )
            return
          action.mutate({ action: 'sweepNow' })
        }}
      />

      {/* ---- Lead ledger */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Leads received
        </h3>
        {data.leads.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Nothing yet — leads appear here the moment NCT posts one.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Received</th>
                  <th className="px-3 py-2">Lead</th>
                  <th className="px-3 py-2">Contact</th>
                  <th className="px-3 py-2">Client</th>
                  <th className="px-3 py-2 text-right">Charged</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.leads.map((l) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {fromIso(l.receivedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-foreground">
                        {l.name || '—'}
                      </span>
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {l.leadId}
                      </span>
                      {l.address && (
                        <p className="text-[11px] text-muted-foreground">
                          {l.address}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {l.phone || '—'}
                      {l.email && <div className="truncate">{l.email}</div>}
                    </td>
                    <td className="px-3 py-2">{l.clientName || '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                      {l.chargeStatus === 'charged'
                        ? cents(l.amountCents)
                        : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={l.chargeStatus} />
                      {l.failureReason && (
                        <p className="mt-0.5 max-w-[220px] text-[11px] text-muted-foreground">
                          {l.failureReason}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {l.chargeStatus === 'charged' ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <button
                          type="button"
                          disabled={action.isPending}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Charge ${l.clientName || 'the client'} ${cents(l.amountCents || 15000)} for lead ${l.leadId} now?`,
                              )
                            )
                              return
                            action.mutate({ action: 'retryCharge', id: l.id })
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                        >
                          <RefreshCw className="h-3 w-3" />
                          Charge
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Sweep history */}
      {data.sweeps.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            Stripe → Mercury sweeps
          </h3>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.sweeps.map((sw) => (
                  <tr key={sw.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {fromIso(sw.createdAt)}
                      {sw.manual && (
                        <span className="ml-1 text-[10px]">(manual)</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                      {cents(sw.amountCents)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {sw.method}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={sw.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {sw.detail || sw.stripePayoutId || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Client config form                                                        */
/* -------------------------------------------------------------------------- */

function ConfigForm({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: Partial<Config>
  busy: boolean
  onCancel: () => void
  onSave: (payload: Record<string, unknown>) => void
}) {
  const [clientName, setClientName] = useState(initial.clientName ?? '')
  const [stripeCustomerId, setStripeCustomerId] = useState(
    initial.stripeCustomerId ?? '',
  )
  const [sourceKey, setSourceKey] = useState(initial.sourceKey ?? '')
  const [price, setPrice] = useState(
    ((initial.pricePerLeadCents ?? 15000) / 100).toString(),
  )
  const [cost, setCost] = useState(
    ((initial.costPerLeadCents ?? 11000) / 100).toString(),
  )
  const [cap, setCap] = useState(
    ((initial.weeklyCapCents ?? 0) / 100).toString(),
  )
  const [active, setActive] = useState(initial.active !== false)

  const valid =
    clientName.trim() && stripeCustomerId.trim() && sourceKey.trim()

  return (
    <div className="mb-3 rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">
          {initial.id ? `Edit ${initial.clientName}` : 'New client'}
        </h4>
        <button type="button" onClick={onCancel}>
          <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Client name *
          </label>
          <input
            className={fieldClass}
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Forever Lit Solar LLC"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Stripe customer ID *
          </label>
          <input
            className={fieldClass}
            value={stripeCustomerId}
            onChange={(e) => setStripeCustomerId(e.target.value)}
            placeholder="cus_XXXXXXXXXXXX"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Source key *
          </label>
          <input
            className={fieldClass}
            value={sourceKey}
            onChange={(e) => setSourceKey(e.target.value)}
            placeholder="forever-lit"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            What NCT sends to identify this client
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            We charge (per lead)
          </label>
          <input
            className={fieldClass}
            type="number"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            NCT charges us
          </label>
          <input
            className={fieldClass}
            type="number"
            step="0.01"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Weekly cap (0 = none)
          </label>
          <input
            className={fieldClass}
            type="number"
            step="0.01"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </div>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        Active — leads for this source key get charged
      </label>

      <div className="mt-4">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() =>
            onSave({
              id: initial.id,
              clientName: clientName.trim(),
              stripeCustomerId: stripeCustomerId.trim(),
              sourceKey: sourceKey.trim(),
              pricePerLeadCents: Math.round(parseFloat(price || '0') * 100),
              costPerLeadCents: Math.round(parseFloat(cost || '0') * 100),
              weeklyCapCents: Math.round(parseFloat(cap || '0') * 100),
              active,
            })
          }
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
        >
          Save client
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Automation settings                                                       */
/* -------------------------------------------------------------------------- */

function SettingsPanel({
  settings,
  destinations,
  busy,
  onSave,
  onSweep,
}: {
  settings: Overview['settings']
  destinations: Overview['destinations']
  busy: boolean
  onSave: (payload: Record<string, unknown>) => void
  onSweep: () => void
}) {
  const [chargingEnabled, setChargingEnabled] = useState(
    settings.chargingEnabled,
  )
  const [sweepEnabled, setSweepEnabled] = useState(settings.sweepEnabled)
  const [sweepMethod, setSweepMethod] = useState(settings.sweepMethod)
  const [destination, setDestination] = useState(
    settings.sweepDestinationId ?? '',
  )
  const [floor, setFloor] = useState((settings.sweepFloorCents / 100).toString())
  const [min, setMin] = useState((settings.sweepMinCents / 100).toString())
  const [alertChannel, setAlertChannel] = useState(settings.alertChannel ?? '')

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">Automation</h3>

      <label className="flex items-start gap-2 rounded-xl border border-border p-3">
        <input
          type="checkbox"
          checked={chargingEnabled}
          onChange={(e) => setChargingEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <span className="text-sm">
          <span className="font-medium text-foreground">
            Charge cards on incoming leads
          </span>
          <span className="block text-xs text-muted-foreground">
            Master switch. Off = leads are still recorded and visible, but no
            card is touched. Leave off until you&apos;ve tested the webhook.
          </span>
        </span>
      </label>

      <label className="mt-2 flex items-start gap-2 rounded-xl border border-border p-3">
        <input
          type="checkbox"
          checked={sweepEnabled}
          onChange={(e) => setSweepEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <span className="text-sm">
          <span className="font-medium text-foreground">
            Auto-sweep Stripe → Mercury
          </span>
          <span className="block text-xs text-muted-foreground">
            Every 15 minutes, pays out Stripe&apos;s <em>available</em> balance
            above the floor. Pending funds can&apos;t be paid out — that&apos;s
            what the Mercury buffer is for.
          </span>
        </span>
      </label>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Payout speed
          </label>
          <select
            className={fieldClass}
            value={sweepMethod}
            onChange={(e) => setSweepMethod(e.target.value)}
          >
            <option value="standard">Standard ACH — free, 1–2 days</option>
            <option value="instant">Instant — ~1.5% fee, same day</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Destination
          </label>
          {destinations.length > 0 ? (
            <select
              className={fieldClass}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="">Stripe default</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={fieldClass}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="card_… or ba_… (blank = default)"
            />
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Leave in Stripe (floor)
          </label>
          <input
            className={fieldClass}
            type="number"
            step="0.01"
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Minimum sweep
          </label>
          <input
            className={fieldClass}
            type="number"
            step="0.01"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Slack channel for failures
        </label>
        <input
          className={cn(fieldClass, 'max-w-sm')}
          value={alertChannel}
          onChange={(e) => setAlertChannel(e.target.value)}
          placeholder="genisys-alerts"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Gets a message on a failed charge, a lead held at the cap, or a failed
          sweep. The bot must already be in the channel.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onSave({
              chargingEnabled,
              sweepEnabled,
              sweepMethod,
              sweepDestinationId: destination,
              sweepFloorCents: Math.round(parseFloat(floor || '0') * 100),
              sweepMinCents: Math.round(parseFloat(min || '0') * 100),
              alertChannel,
            })
          }
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Save automation settings'
          )}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSweep}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-40"
        >
          <Zap className="h-4 w-4" />
          Sweep now
        </button>
        {settings.lastSweepAt && (
          <span className="text-xs text-muted-foreground">
            Last swept {fromIso(settings.lastSweepAt)}
          </span>
        )}
      </div>
    </div>
  )
}
