'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { cents, ErrorBlock, fromIso, LoadingBlock } from './ui'

type DisputeRow = {
  id: string
  stripeDisputeId: string
  status: string
  reason: string
  amountCents: number
  currency: string
  dueBy: string | null
  defenseStatus: string
  paused: boolean
  matchMethod: string | null
  matchConfidence: string
  packetBytes: number | null
  packetSha256: string | null
  lastError: string | null
  client: { id: string; name: string; disputeCount: number } | null
}

type ListResponse = {
  config: { mode: string; submitLeadHours: number; efwRefund: boolean; alertSms: boolean; clientNotices: boolean; openTracking: boolean; milestoneAck: boolean; stampMetadata: boolean; forceDryRun: boolean; submitsToStripe: boolean; canSubmit: boolean }
  templates: Record<string, string>
  outcomes: { byReason: { reason: string; won: number; lost: number; open: number; winRate: number | null }[]; totals: { won: number; lost: number; open: number; winRate: number | null } }
  disputes: DisputeRow[]
}

type Detail = {
  id: string
  stripeDisputeId: string
  status: string
  reason: string
  amountCents: number
  currency: string
  dueBy: string | null
  defenseStatus: string
  paused: boolean
  matchMethod: string | null
  matchConfidence: string
  narrative: string | null
  packetSha256: string | null
  packetIntact: boolean | null
  chain: { ok: boolean; brokenAt: number | null }
  repeat: boolean
  lastError: string | null
  client: { id: string; name: string; disputeCount: number } | null
  events: { seq: number; kind: string; detail: string | null; actor: string | null; at: string; contentHash: string }[]
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || 'Request failed')
  return data
}

export function DisputesTab() {
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const [narrative, setNarrative] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = useQuery<ListResponse>({
    queryKey: ['disputes'],
    queryFn: async () => {
      const res = await fetch('/api/payments/disputes')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load disputes')
      return data
    },
  })
  const detail = useQuery<Detail>({
    queryKey: ['dispute', open],
    enabled: !!open,
    queryFn: async () => {
      const res = await fetch(`/api/payments/disputes/${open}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load dispute')
      setNarrative(data.narrative ?? '')
      return data
    },
  })

  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!open) return
    setBusy(true)
    setError(null)
    try {
      await post(`/api/payments/disputes/${open}`, { action, ...extra })
      await qc.invalidateQueries({ queryKey: ['dispute', open] })
      await qc.invalidateQueries({ queryKey: ['disputes'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  if (list.isLoading) return <LoadingBlock />
  if (list.isError || !list.data) return <ErrorBlock message={list.error instanceof Error ? list.error.message : 'Failed to load disputes.'} />
  const { config, outcomes, disputes } = list.data
  const rate = outcomes.totals.winRate === null ? '—' : `${Math.round(outcomes.totals.winRate * 100)}%`

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-foreground">Dispute defense is in {config.mode.replace('_', '-')}{config.forceDryRun ? ' (forced dry-run)' : ''}</p>
            <p className="mt-1 text-muted-foreground">
              {config.canSubmit
                ? `Live. Auto-submit is ${config.submitLeadHours}h before the deadline, unless a dispute is paused, its narrative was edited, or the client match is weak. Submit is final.`
                : config.submitsToStripe
                  ? 'Stage. Evidence is saved on the dispute with submit=false. Nothing is sent to the bank until you switch to live.'
                  : 'Dry-run. Packets are stored here. Stripe is not updated, and evidence cannot be submitted.'}
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={() => post('/api/payments/disputes', { action: 'reconcile' }).then(() => qc.invalidateQueries({ queryKey: ['disputes'] }))}>Refresh from Stripe</button>
            <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={() => post('/api/payments/disputes', { action: 'probe' }).then((d) => alert(probeText(d)))}>Check key permissions</button>
          </div>
        </div>
        <Settings config={config} onSaved={() => qc.invalidateQueries({ queryKey: ['disputes'] })} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Win / loss by reason</h3>
        <p className="mb-2 text-xs text-muted-foreground">Won {outcomes.totals.won} · Lost {outcomes.totals.lost} · Open {outcomes.totals.open} · Win rate {rate}</p>
        {outcomes.byReason.length === 0 ? (
          <p className="text-sm text-muted-foreground">No disputes yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Won</th><th className="px-3 py-2">Lost</th><th className="px-3 py-2">Open</th><th className="px-3 py-2">Win rate</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {outcomes.byReason.map((r) => (
                  <tr key={r.reason}>
                    <td className="px-3 py-2">{r.reason}</td>
                    <td className="px-3 py-2">{r.won}</td>
                    <td className="px-3 py-2">{r.lost}</td>
                    <td className="px-3 py-2">{r.open}</td>
                    <td className="px-3 py-2">{r.winRate === null ? '—' : `${Math.round(r.winRate * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-3 py-2">Due</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Defense</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {disputes.length === 0 && <tr><td className="px-3 py-4 text-muted-foreground" colSpan={5}>No disputes on file. A webhook or Refresh from Stripe will add them.</td></tr>}
            {disputes.map((d) => (
              <tr key={d.id} className="cursor-pointer hover:bg-muted/30" onClick={() => setOpen(d.id)}>
                <td className="whitespace-nowrap px-3 py-2">{fromIso(d.dueBy)}</td>
                <td className="px-3 py-2">{cents(d.amountCents, d.currency)}</td>
                <td className="px-3 py-2">{d.reason}</td>
                <td className="px-3 py-2">
                  {d.client?.name ?? 'Unmatched'}
                  {(d.client?.disputeCount ?? 0) >= 2 && <span className="ml-2 text-xs text-destructive">Repeat</span>}
                </td>
                <td className="px-3 py-2">{d.paused ? 'paused' : d.defenseStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && detail.data && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">{detail.data.client?.name ?? 'Unmatched'} · {detail.data.reason}</h3>
              <p className="text-xs text-muted-foreground">{detail.data.stripeDisputeId} · {cents(detail.data.amountCents, detail.data.currency)} · due {fromIso(detail.data.dueBy)} · match {detail.data.matchMethod ?? 'none'} ({detail.data.matchConfidence})</p>
              {detail.data.repeat && <p className="mt-1 text-sm text-destructive">Repeat disputer. Warn the team before more work for this client.</p>}
              <p className="mt-1 text-xs text-muted-foreground">Audit chain {detail.data.chain.ok ? 'intact' : `broken at event ${detail.data.chain.brokenAt}`} · packet {detail.data.packetIntact === null ? 'not built' : detail.data.packetIntact ? `intact ${detail.data.packetSha256?.slice(0, 12)}` : 'HASH MISMATCH'}</p>
            </div>
            <button type="button" className="text-xs text-muted-foreground" onClick={() => setOpen(null)}>Close</button>
          </div>
          {detail.data.lastError && <p className="text-sm text-destructive">{detail.data.lastError}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <label className="block text-xs font-medium">Narrative (editing this stops auto-submit)</label>
          <textarea className="min-h-28 w-full rounded-lg border border-border bg-background p-2 text-sm" value={narrative} onChange={(e) => setNarrative(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={() => act('narrative', { narrative })}>Save narrative</button>
            <button type="button" disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={() => act('rebuild')}>Rebuild packet</button>
            <a className="rounded-lg border border-border px-3 py-1.5 text-xs" href={`/api/payments/disputes/${open}/packet`}>Download packet</a>
            <button type="button" disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={() => act(detail.data!.paused ? 'resume' : 'pause')}>{detail.data.paused ? 'Resume' : 'Pause'}</button>
            <button type="button" disabled={busy || !config.canSubmit} className="rounded-lg bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-40" onClick={() => { if (confirm('Submit this evidence to Stripe? This is final and cannot be undone.')) void act('submit') }}>Submit now</button>
          </div>
          {!config.canSubmit && <p className="text-xs text-muted-foreground">{config.submitsToStripe ? 'Submit stays off in stage. Live mode is required before evidence is sent to the bank.' : 'Submit stays off in dry-run. Stripe is not updated.'}</p>}
          <div className="max-h-48 overflow-auto text-xs text-muted-foreground">
            {detail.data.events.map((e) => (
              <p key={e.seq}>{e.seq}. {fromIso(e.at)} {e.kind}{e.detail ? ` — ${e.detail}` : ''} <span className="font-mono">{e.contentHash.slice(0, 10)}</span></p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Settings({ config, onSaved }: { config: ListResponse['config']; onSaved: () => void }) {
  const [mode, setMode] = useState(config.mode)
  const [hours, setHours] = useState(String(config.submitLeadHours))
  const [efw, setEfw] = useState(config.efwRefund)
  const [notices, setNotices] = useState(config.clientNotices)
  const [milestone, setMilestone] = useState(config.milestoneAck)
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault()
        void post('/api/payments/disputes', {
          action: 'settings',
          config: { mode, submitLeadHours: Number(hours), efwRefund: efw, clientNotices: notices, milestoneAck: milestone },
        }).then(onSaved)
      }}
    >
      <label>Mode
        <select className="ml-1 rounded border border-border bg-background px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="dry_run">dry-run</option>
          <option value="stage">stage</option>
          <option value="live">live</option>
        </select>
      </label>
      <label>Auto-submit lead (hours)
        <input className="ml-1 w-16 rounded border border-border bg-background px-2 py-1" value={hours} onChange={(e) => setHours(e.target.value)} />
      </label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={efw} onChange={(e) => setEfw(e.target.checked)} /> Refund early fraud warnings</label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={notices} onChange={(e) => setNotices(e.target.checked)} /> Onboarding confirmation emails</label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={milestone} onChange={(e) => setMilestone(e.target.checked)} /> Milestone confirmations</label>
      <button type="submit" className="rounded-lg border border-border px-3 py-1.5">Save</button>
    </form>
  )
}

function probeText(d: { reads?: { label: string; ok: boolean; missing: string | null }[]; webhook?: { found: boolean; missingEvents: string[] } | null; writesNotVerified?: string[] }): string {
  const reads = (d.reads ?? []).map((r) => `${r.ok ? 'ok' : 'MISSING'} ${r.label}${r.missing ? ` (${r.missing})` : ''}`).join('\n')
  const hook = d.webhook ? (d.webhook.found ? `Webhook found. Missing events: ${d.webhook.missingEvents.join(', ') || 'none'}` : 'Webhook endpoint not found on this key') : 'Webhook endpoints could not be read'
  return `${reads}\n\n${hook}\n\nWrite permissions are not probed (a probe would change live data):\n${(d.writesNotVerified ?? []).join('\n')}`
}
