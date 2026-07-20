'use client'

import { useState, useSyncExternalStore } from 'react'
import {
  AlertCircle,
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  RotateCcw,
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
import {
  useNctAction,
  useNctOverview,
  type NctOverview,
  type Notice,
} from './nct-shared'

/**
 * Payments → NCT Leads.
 *
 * NCT POSTs a lead to our webhook → we charge the client's saved card
 * off-session → a scheduled sweep moves settled Stripe cash to Mercury
 * so the buffer covers NCT's next-day debit on the virtual card.
 */

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
  const [notice, setNotice] = useState<Notice>(null)
  const [showToken, setShowToken] = useState(false)

  // Browser-only value — read through useSyncExternalStore so the server
  // render and the hydrated render agree instead of thrashing state.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => '',
  )

  const { data, isLoading, isError, error } = useNctOverview()
  const action = useNctAction(setNotice)

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

      {data.configs.length === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          No roofing clients configured yet — leads will be recorded but never
          charged. Add one on the <strong>Roofing Clients</strong> tab.
        </div>
      )}

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
/*  Automation settings                                                       */
/* -------------------------------------------------------------------------- */

function SettingsPanel({
  settings,
  destinations,
  busy,
  onSave,
  onSweep,
}: {
  settings: NctOverview['settings']
  destinations: NctOverview['destinations']
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
