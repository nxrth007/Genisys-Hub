'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Loader2,
  Receipt,
  RotateCw,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * /clients/invoices — admin audit + retry surface for the PPA bi-
 * weekly invoicing automation. Lists every Invoice row most-recent
 * first with:
 *
 *   - Cycle window (e.g. May 19 – Jun 2)
 *   - Client + count + amount
 *   - Delivery status (email ✓ / SMS ✓ / overflow / missing-contact)
 *   - Copy-payment-link button
 *   - Resend button when delivery had errors (admin only)
 *
 * Filters: by client (all / specific), by status (all / failed /
 * needs-manual). Admin-only via the admin layout chrome — member
 * gets read access too but the Resend button only renders for
 * role=admin (the API enforces the same).
 */

type Invoice = {
  id: string
  client: { id: string; name: string; color: string }
  cycleStartAt: string
  cycleEndAt: string
  appointmentCount: number
  appointmentIds: string[]
  amountCents: number
  paymentLink: string
  emailSentAt: string | null
  smsSentAt: string | null
  deliveryError: string | null
  createdAt: string
}

export default function InvoicesPage() {
  const qc = useQueryClient()
  const [clientFilter, setClientFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'failed' | 'manual'
  >('all')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const { data, isLoading, isError, error } = useQuery<{ invoices: Invoice[] }>({
    queryKey: ['admin-invoices'],
    queryFn: async () => {
      const res = await fetch('/api/admin/invoices')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load invoices')
      }
      return res.json()
    },
  })

  const invoices = data?.invoices ?? []

  // Unique client list for the filter dropdown — derived from
  // results so we don't make a second API call.
  const clientOptions = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>()
    for (const inv of invoices) {
      if (!seen.has(inv.client.id)) {
        seen.set(inv.client.id, { id: inv.client.id, name: inv.client.name })
      }
    }
    return Array.from(seen.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  }, [invoices])

  const filtered = useMemo(() => {
    return invoices.filter((inv) => {
      if (clientFilter !== 'all' && inv.client.id !== clientFilter) {
        return false
      }
      if (statusFilter === 'failed') {
        // Auto-send attempted but at least one channel failed AND
        // it wasn't a deliberate manual hold.
        if (!inv.deliveryError) return false
        if (
          inv.deliveryError === 'overflow' ||
          inv.deliveryError === 'missing_contact_info'
        ) {
          return false
        }
      }
      if (statusFilter === 'manual') {
        if (
          inv.deliveryError !== 'overflow' &&
          inv.deliveryError !== 'missing_contact_info'
        ) {
          return false
        }
      }
      return true
    })
  }, [invoices, clientFilter, statusFilter])

  const summary = useMemo(() => {
    let totalCents = 0
    let totalAppts = 0
    let needsAttention = 0
    for (const inv of invoices) {
      totalCents += inv.amountCents
      totalAppts += inv.appointmentCount
      if (inv.deliveryError) needsAttention++
    }
    return { totalCents, totalAppts, needsAttention, count: invoices.length }
  }, [invoices])

  const resendMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/invoices/${id}/resend`, {
        method: 'POST',
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Resend failed')
      return d
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-invoices'] })
    },
  })

  function copyLink(id: string, link: string) {
    if (!link) return
    void navigator.clipboard.writeText(link).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/clients"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Clients
        </Link>
      </div>

      <header className="flex items-start gap-3">
        <div className="rounded-lg bg-amber-50 p-2.5 dark:bg-amber-950">
          <Receipt className="h-6 w-6 text-amber-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Invoices</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Every PPA invoice the automation has generated. Most recent
            first.
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Total invoices" value={String(summary.count)} />
        <SummaryCard label="Appointments billed" value={String(summary.totalAppts)} />
        <SummaryCard
          label="Total revenue"
          value={formatUsd(summary.totalCents)}
          tone="emerald"
        />
        <SummaryCard
          label="Needs attention"
          value={String(summary.needsAttention)}
          tone={summary.needsAttention > 0 ? 'rose' : 'neutral'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <FilterSelect
          label="Client"
          value={clientFilter}
          onChange={setClientFilter}
          options={[
            { value: 'all', label: 'All clients' },
            ...clientOptions.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as 'all' | 'failed' | 'manual')}
          options={[
            { value: 'all', label: 'All' },
            { value: 'failed', label: 'Delivery failed' },
            { value: 'manual', label: 'Needs manual send' },
          ]}
        />
      </div>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error instanceof Error ? error.message : 'Failed to load'}
        </div>
      )}

      {isLoading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading invoices…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          <Receipt className="mx-auto mb-2 h-6 w-6 text-zinc-400" />
          No invoices match these filters.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Client</th>
                <th className="px-4 py-2 text-left font-semibold">Cycle</th>
                <th className="px-4 py-2 text-left font-semibold">Appts</th>
                <th className="px-4 py-2 text-left font-semibold">Amount</th>
                <th className="px-4 py-2 text-left font-semibold">Email</th>
                <th className="px-4 py-2 text-left font-semibold">SMS</th>
                <th className="px-4 py-2 text-left font-semibold">Sent</th>
                <th className="px-4 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => (
                <tr
                  key={inv.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: inv.client.color }}
                        aria-hidden
                      />
                      <span className="font-medium">{inv.client.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                    {formatRange(inv.cycleStartAt, inv.cycleEndAt)}
                  </td>
                  <td className="px-4 py-3 tabular-nums font-semibold">
                    {inv.appointmentCount}
                  </td>
                  <td className="px-4 py-3 tabular-nums font-semibold">
                    {formatUsd(inv.amountCents)}
                  </td>
                  <td className="px-4 py-3">
                    {inv.emailSentAt ? (
                      <span
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                        title={new Date(inv.emailSentAt).toLocaleString()}
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        Sent
                      </span>
                    ) : inv.deliveryError === 'overflow' ||
                      inv.deliveryError === 'missing_contact_info' ? (
                      <span className="text-[11px] text-zinc-400">—</span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-600 dark:text-rose-400"
                        title={inv.deliveryError || 'Not sent'}
                      >
                        <X className="h-3 w-3" />
                        Failed
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {inv.smsSentAt ? (
                      <span
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                        title={new Date(inv.smsSentAt).toLocaleString()}
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        Sent
                      </span>
                    ) : inv.deliveryError === 'overflow' ||
                      inv.deliveryError === 'missing_contact_info' ? (
                      <span className="text-[11px] text-zinc-400">—</span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-600 dark:text-rose-400"
                        title={inv.deliveryError || 'Not sent'}
                      >
                        <X className="h-3 w-3" />
                        Failed
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {new Date(inv.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-2">
                      {inv.paymentLink && (
                        <button
                          type="button"
                          onClick={() => copyLink(inv.id, inv.paymentLink)}
                          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          title="Copy QuickBooks payment link"
                        >
                          {copiedId === inv.id ? (
                            <>
                              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              Copy link
                            </>
                          )}
                        </button>
                      )}
                      {inv.paymentLink && inv.deliveryError && (
                        <button
                          type="button"
                          onClick={() => resendMutation.mutate(inv.id)}
                          disabled={resendMutation.isPending}
                          className="inline-flex items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300"
                          title="Re-attempt email + SMS delivery"
                        >
                          {resendMutation.isPending &&
                          resendMutation.variables === inv.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RotateCw className="h-3 w-3" />
                          )}
                          Resend
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer explainer for the overflow / missing-contact rows.
          These are the cases where the automation deliberately
          didn't auto-send — admin needs to know what to do. */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        <p className="font-semibold text-zinc-700 dark:text-zinc-300">
          Reading the delivery columns
        </p>
        <ul className="mt-2 space-y-1">
          <li>
            <strong>—</strong> means the invoice was deliberately held (5+
            qualified appointments overflow, or the client had no email /
            phone on file). Send manually through QuickBooks.
          </li>
          <li>
            <strong>Failed</strong> means the automation tried email/SMS
            but the upstream service rejected — hover the X icon for the
            error message. Use <strong>Resend</strong> after fixing the
            contact info on the client record.
          </li>
        </ul>
      </div>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'emerald' | 'rose'
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        tone === 'emerald'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
          : tone === 'rose'
            ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
            : 'border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200',
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 focus:border-blue-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function formatUsd(cents: number): string {
  const dollars = cents / 100
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso)
  const end = new Date(endIso)
  const startStr = start.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
  const endStr = end.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return `${startStr} – ${endStr}`
}
