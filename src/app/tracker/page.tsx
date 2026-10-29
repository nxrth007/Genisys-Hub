'use client'

/**
 * Client tracker (DB copy of the "Client Onboarding Tracker" sheet).
 * Staff only (middleware + requireStaff on /api/tracker). Click a step to
 * flip it; every change is audited. "Status link" copies a client's
 * read-only status link to the clipboard; nothing is sent to the client.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/components/ui/page-header'
import { STEP_HEADERS, TRACKER_STEPS, type TrackerStatus, type TrackerStep } from '@/lib/tracker/columns'

type Row = {
  clientId: string
  clientName: string
  business: string | null
  contactName: string | null
  contactEmail: string | null
  startDate: string | null
  steps: Record<TrackerStep, TrackerStatus>
  current: TrackerStep | null
  hasRow: boolean
  sheetRow: number | null
  archived: boolean
}
type ListResponse = { rows: Row[]; sheetSync: { enabled: boolean; last: { at: string; counts: Record<string, number>; error: string | null } | null } }
type SyncResponse = { dryRun: boolean; counts: Record<string, number>; missingHeaders: string[]; error: string | null; ops: { kind: string; sheetRow: number; label?: string; reason?: string }[] }

export default function TrackerPage() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [step, setStep] = useState<TrackerStep | ''>('')
  const [status, setStatus] = useState<TrackerStatus>('pending')
  const [sync, setSync] = useState<SyncResponse | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (step) {
    params.set('step', step)
    params.set('status', status)
  }
  const list = useQuery<ListResponse>({
    queryKey: ['tracker', params.toString()],
    queryFn: async () => {
      const r = await fetch(`/api/tracker?${params}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    },
  })

  const flip = useMutation({
    mutationFn: async (v: { clientId: string; step: TrackerStep; status: TrackerStatus }) => {
      const r = await fetch('/api/tracker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tracker'] }),
    onError: (e) => setMsg(String(e instanceof Error ? e.message : e)),
  })

  const runSync = useMutation({
    mutationFn: async (dryRun: boolean): Promise<SyncResponse> => {
      const r = await fetch('/api/tracker/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun }) })
      return r.json()
    },
    onSuccess: (s) => {
      setSync(s)
      qc.invalidateQueries({ queryKey: ['tracker'] })
    },
  })

  async function copyLink(clientId: string) {
    const r = await fetch(`/api/tracker/${clientId}/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.path) return setMsg(j?.error ?? `Could not create link (HTTP ${r.status})`)
    const url = `${window.location.origin}${j.path}`
    await navigator.clipboard.writeText(url).catch(() => {})
    setMsg(`Status link copied (not sent): ${url}`)
  }

  const rows = list.data?.rows ?? []
  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Client tracker"
        subtitle="The onboarding tracker sheet, stored in the Hub. Click a step to change it."
        breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: 'Tracker' }]}
        actions={
          <div className="flex gap-2">
            <button className="rounded-md border px-3 py-1.5 text-sm" disabled={runSync.isPending} onClick={() => runSync.mutate(true)}>Preview sheet sync</button>
            <button className="rounded-md border px-3 py-1.5 text-sm" disabled={runSync.isPending} onClick={() => confirm('Copy ✅ steps from the Google Sheet into the Hub? The sheet is not changed.') && runSync.mutate(false)}>Sync from sheet</button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input className="w-64 rounded-md border px-3 py-1.5" placeholder="Search client, business, email" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="rounded-md border px-2 py-1.5" value={step} onChange={(e) => setStep(e.target.value as TrackerStep | '')}>
          <option value="">All steps</option>
          {TRACKER_STEPS.map((s) => <option key={s} value={s}>{STEP_HEADERS[s]}</option>)}
        </select>
        {step && (
          <select className="rounded-md border px-2 py-1.5" value={status} onChange={(e) => setStatus(e.target.value as TrackerStatus)}>
            <option value="pending">is pending</option>
            <option value="done">is done</option>
          </select>
        )}
        <span className="text-neutral-500">{rows.length} client{rows.length === 1 ? '' : 's'}</span>
        {list.data?.sheetSync.last && (
          <span className="text-neutral-500">· last sheet sync {new Date(list.data.sheetSync.last.at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET{list.data.sheetSync.enabled ? ' (auto)' : ''}</span>
        )}
      </div>

      {msg && <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm break-all" onClick={() => setMsg(null)}>{msg}</p>}
      {sync && (
        <div className="rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">{sync.dryRun ? 'Preview' : 'Synced'}: {sync.error ?? Object.entries(sync.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(', ')}</p>
          {!!sync.missingHeaders?.length && <p className="text-neutral-500">Sheet has no column: {sync.missingHeaders.join(', ')}</p>}
          {sync.ops?.filter((o) => o.kind === 'unmatched').map((o) => (
            <p key={o.sheetRow} className="text-neutral-500">Row {o.sheetRow} ({o.label}): {o.reason === 'ambiguous' ? 'matches more than one client' : o.reason === 'duplicate_row' ? 'second row for the same client' : 'no matching Hub client'}, skipped</p>
          ))}
        </div>
      )}

      {list.isLoading ? <p className="text-sm text-neutral-500">Loading…</p> : list.error ? <p className="text-sm text-red-600">{String(list.error)}</p> : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-3 py-2">Client Name</th>
                <th className="px-3 py-2">Business</th>
                <th className="px-3 py-2">Contact Email</th>
                <th className="px-3 py-2">Start Date</th>
                {TRACKER_STEPS.map((s) => <th key={s} className="px-3 py-2">{STEP_HEADERS[s]}</th>)}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.clientId} className="border-t">
                  <td className="px-3 py-2">{r.contactName ?? '—'}</td>
                  <td className="px-3 py-2 font-medium">{r.business ?? r.clientName}</td>
                  <td className="px-3 py-2">{r.contactEmail ?? '—'}</td>
                  <td className="px-3 py-2">{r.startDate ?? '—'}</td>
                  {TRACKER_STEPS.map((s) => (
                    <td key={s} className="px-3 py-2">
                      <button
                        title={r.steps[s] === 'done' ? 'Mark pending' : 'Mark done'}
                        disabled={flip.isPending}
                        onClick={() => flip.mutate({ clientId: r.clientId, step: s, status: r.steps[s] === 'done' ? 'pending' : 'done' })}
                      >
                        {r.steps[s] === 'done' ? '✅' : '❌'}
                      </button>
                    </td>
                  ))}
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button className="text-xs underline" onClick={() => copyLink(r.clientId)}>Status link</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
