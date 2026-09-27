'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Loader2, Receipt } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cents, ErrorBlock, fromIso, LoadingBlock, StatusPill } from './ui'

/**
 * Payments → Automations.
 *
 * The on/off switches for the two automations that move money without a
 * person clicking anything. They used to live inside the NCT Leads tab;
 * when that tab was retired the automations themselves kept running on
 * the server (the NCT webhook still charges per lead, the scheduler still
 * sweeps every 15 minutes when enabled), so their switches live here —
 * nothing that moves money is left without a way to turn it off.
 *
 * A toggle sends only the flag it flips (setSwitch), so a stale copy of
 * the settings can never turn the other switch back on. Turning a switch
 * ON asks for a second click; turning one OFF never does.
 */

type NctSettings = {
  chargingEnabled: boolean
  sweepEnabled: boolean
  sweepMethod: string
  sweepDestinationId: string | null
  sweepFloorCents: number
  sweepMinCents: number
  alertChannel: string | null
  notifyEveryLead: boolean
  lastSweepAt: string | null
}

type Sweep = {
  id: string
  amountCents: number
  method: string
  status: string
  detail: string | null
  manual: boolean
  createdAt: string
}

type Overview = {
  ok: true
  settings: NctSettings
  sweeps: Sweep[]
  leads: Array<{ receivedAt: string; chargeStatus: string }>
}

type Switch = 'chargingEnabled' | 'sweepEnabled'

export function AutomationsTab() {
  const qc = useQueryClient()
  const [armed, setArmed] = useState<Switch | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const q = useQuery<Overview>({
    queryKey: ['payments-automations'],
    queryFn: async () => {
      const res = await fetch('/api/payments/nct/overview')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to load (${res.status})`)
      return data as Overview
    },
  })

  const save = useMutation({
    mutationFn: async ({ key, value }: { key: Switch; value: boolean }) => {
      const res = await fetch('/api/payments/nct/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setSwitch', key, value }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save.')
      return { key, value }
    },
    onMutate: () => setMessage(null),
    onSuccess: ({ key, value }) => {
      setArmed(null)
      setMessage(`${key === 'chargingEnabled' ? 'Lead charging' : 'The sweep'} is now ${value ? 'on' : 'off'}.`)
      qc.setQueryData<Overview>(['payments-automations'], (old) =>
        old ? { ...old, settings: { ...old.settings, [key]: value } } : old,
      )
      // Returned so the buttons stay busy until the fresh settings are in.
      return qc.invalidateQueries({ queryKey: ['payments-automations'] })
    },
    onError: (e: Error) => setMessage(e.message),
  })

  if (q.isLoading) return <LoadingBlock />
  if (q.isError) return <ErrorBlock message={(q.error as Error).message} />
  const data = q.data
  if (!data) return null
  const s = data.settings

  function toggle(key: Switch) {
    const on = s[key]
    if (!on && armed !== key) {
      setArmed(key)
      return
    }
    save.mutate({ key, value: !on })
  }

  const lastLead = data.leads[0]?.receivedAt ?? null

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">
        Automations that move money on their own. They keep running on the server whether or not
        anyone is looking, so their switches live here.
      </p>

      <AutomationRow
        icon={Receipt}
        title="NCT lead charging"
        description="Charges the roofing client's card for each lead the NCT webhook delivers."
        on={s.chargingEnabled}
        armed={armed === 'chargingEnabled'}
        busy={save.isPending || q.isFetching}
        onToggle={() => toggle('chargingEnabled')}
        onDisarm={() => setArmed(null)}
        detail={
          <span>
            Last lead received: <span className="text-foreground/85">{fromIso(lastLead)}</span>
          </span>
        }
      />

      <AutomationRow
        icon={ArrowRightLeft}
        title="Stripe → Mercury sweep"
        description="Every 15 minutes, pays settled Stripe balance out to Mercury."
        on={s.sweepEnabled}
        armed={armed === 'sweepEnabled'}
        busy={save.isPending || q.isFetching}
        onToggle={() => toggle('sweepEnabled')}
        onDisarm={() => setArmed(null)}
        detail={
          <div className="flex flex-col gap-2">
            <span>
              Last sweep: <span className="text-foreground/85">{fromIso(s.lastSweepAt)}</span>
            </span>
            {data.sweeps.length > 0 && (
              <ul className="flex flex-col divide-y divide-border-soft rounded-lg border border-border-soft">
                {data.sweeps.slice(0, 5).map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className="font-mono text-[12px] tabular-nums text-foreground/85">
                      {cents(w.amountCents)}
                    </span>
                    <span className="truncate text-[12px] text-muted-foreground">
                      {w.manual ? 'manual' : w.method}
                      {w.detail ? ` · ${w.detail}` : ''}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <StatusPill status={w.status} />
                      <span className="font-mono text-[11px] text-muted-foreground">{fromIso(w.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        }
      />

      {message && <p className="text-[13px] text-muted-foreground">{message}</p>}
    </div>
  )
}

function AutomationRow({
  icon: Icon,
  title,
  description,
  on,
  armed,
  busy,
  onToggle,
  onDisarm,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  on: boolean
  armed: boolean
  busy: boolean
  onToggle: () => void
  onDisarm: () => void
  detail: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[14px] font-semibold">
              {title}
              <span
                className={cn(
                  'eyebrow rounded-md px-2 py-0.5',
                  on ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
                )}
              >
                {on ? 'On' : 'Off'}
              </span>
            </p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {armed && (
            <button
              type="button"
              onClick={onDisarm}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onToggle}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-50',
              armed
                ? 'border-warning/40 bg-warning/15 text-warning hover:bg-warning/20'
                : 'border-border bg-card hover:bg-muted',
            )}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {on ? 'Turn off' : armed ? 'Confirm — turn on' : 'Turn on'}
          </button>
        </div>
      </div>
      <div className="mt-3 border-t border-border-soft pt-3 text-[12.5px] text-muted-foreground">{detail}</div>
    </section>
  )
}
