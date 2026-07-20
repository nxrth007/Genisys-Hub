'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CreditCard,
  Landmark,
  ScrollText,
  Loader2,
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Inbox,
  Plus,
  Undo2,
  Send,
  Ban,
  ExternalLink,
  Users,
  FileText,
  Receipt,
  HardHat,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { NctLeadsTab } from './nct-leads-tab'
import { RoofingClientsTab } from './roofing-clients-tab'
import {
  cents,
  ErrorBlock,
  fieldClass,
  fromIso,
  fromUnix,
  LoadingBlock,
  money,
  StatCard,
  StatusPill,
} from './ui'

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type StripeOverview = {
  ok: true
  account: { name: string; currency: string }
  available: Array<{ amount: number; currency: string }>
  pending: Array<{ amount: number; currency: string }>
  inTransit: number
  volume30d: {
    gross: number
    net: number
    fees: number
    count: number
    truncated: boolean
    currency: string
  }
  daily: Array<{ date: string; gross: number }>
  subscriptions: { activeCount: number; mrr: number }
  disputes: {
    count: number
    items: Array<{
      id: string
      amount: number
      currency: string
      status: string
      reason: string
      created: number
    }>
  }
  charges: Array<{
    id: string
    amount: number
    currency: string
    status: string
    paid: boolean
    refunded: boolean
    created: number
    description: string | null
    customerEmail: string | null
  }>
  payouts: Array<{
    id: string
    amount: number
    currency: string
    status: string
    arrivalDate: number
    created: number
  }>
  customers: Array<{
    id: string
    name: string | null
    email: string | null
    created: number
  }>
  invoices: Array<{
    id: string
    number: string | null
    customerName: string | null
    customerEmail: string | null
    amountDue: number
    amountPaid: number
    currency: string
    status: string
    created: number
    hostedUrl: string | null
    pdfUrl: string | null
  }>
}

type MercuryOverview = {
  ok: true
  totalBalance: number
  accounts: Array<{
    id: string
    name: string
    last4: string
    kind: string | null
    status: string | null
    currentBalance: number
    availableBalance: number
  }>
  transactions: Array<{
    id: string
    amount: number
    counterpartyName: string | null
    createdAt: string | null
    status: string | null
    kind: string | null
    note: string | null
    bankDescription: string | null
    accountName: string
  }>
}

/** Simple 30-day daily-volume bars (amounts in cents). */
function VolumeChart({
  daily,
  currency,
}: {
  daily: Array<{ date: string; gross: number }>
  currency: string
}) {
  const max = Math.max(1, ...daily.map((d) => d.gross))
  const total = daily.reduce((s, d) => s + d.gross, 0)
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Volume · last 30 days
        </h3>
        <span className="text-sm font-bold tabular-nums text-foreground">
          {cents(total, currency)}
        </span>
      </div>
      <div className="flex h-24 items-end gap-[3px]">
        {daily.map((d) => {
          const h = Math.max(2, Math.round((d.gross / max) * 96))
          return (
            <div
              key={d.date}
              className="group relative flex-1"
              title={`${d.date}: ${cents(d.gross, currency)}`}
            >
              <div
                className="w-full rounded-t bg-primary/70 transition group-hover:bg-primary"
                style={{ height: `${h}px` }}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{daily[0]?.date.slice(5)}</span>
        <span>{daily[daily.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Stripe                                                                    */
/* -------------------------------------------------------------------------- */

/** Small ghost button used for the row-level Stripe actions. */
function RowAction({
  onClick,
  disabled,
  icon: Icon,
  children,
  tone = 'default',
}: {
  onClick: () => void
  disabled?: boolean
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger'
          ? 'border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40'
          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      {children}
    </button>
  )
}

function StripeTab() {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'err'
    text: string
  } | null>(null)
  const [showNewInvoice, setShowNewInvoice] = useState(false)

  const { data, isLoading, isError, error } = useQuery<StripeOverview>({
    queryKey: ['payments-stripe'],
    queryFn: async () => {
      const res = await fetch('/api/payments/stripe/overview')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to load Stripe')
      return d
    },
    refetchInterval: 60_000,
  })

  // All write actions go through one gated endpoint; the key stays server-side.
  const action = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch('/api/payments/stripe/actions', {
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
      setShowNewInvoice(false)
      queryClient.invalidateQueries({ queryKey: ['payments-stripe'] })
    },
    onError: (e) =>
      setNotice({
        tone: 'err',
        text: e instanceof Error ? e.message : 'Action failed.',
      }),
  })

  /** Every action here moves money or emails a customer — always confirm. */
  const run = (confirmText: string, payload: Record<string, unknown>) => {
    if (!window.confirm(confirmText)) return
    setNotice(null)
    action.mutate(payload)
  }

  if (isLoading) return <LoadingBlock />
  if (isError || !data)
    return (
      <ErrorBlock
        message={error instanceof Error ? error.message : 'Failed to load Stripe.'}
      />
    )

  const cur = data.account.currency || 'usd'
  const usdAvail = data.available.find((b) => b.currency === cur) ??
    data.available[0]
  const usdPend = data.pending.find((b) => b.currency === cur) ??
    data.pending[0]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{data.account.name}</p>
        <button
          type="button"
          onClick={() => {
            setNotice(null)
            setShowNewInvoice(true)
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New invoice
        </button>
      </div>

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
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="opacity-60 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {showNewInvoice && (
        <NewInvoiceForm
          busy={action.isPending}
          onCancel={() => setShowNewInvoice(false)}
          onSubmit={(payload, sendNow) =>
            run(
              sendNow
                ? `Create this invoice and EMAIL it to ${payload.email} now?`
                : `Create this invoice as a draft (no email sent)?`,
              { action: 'createInvoice', ...payload, sendNow },
            )
          }
        />
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Volume · 30d"
          value={cents(data.volume30d.gross, cur)}
          sub={`${data.volume30d.count} payment${data.volume30d.count === 1 ? '' : 's'}${data.volume30d.truncated ? ' (100+ sample)' : ''}`}
        />
        <StatCard
          label="Net · 30d"
          value={cents(data.volume30d.net, cur)}
          sub={`${cents(data.volume30d.fees, cur)} fees`}
        />
        <StatCard
          label="MRR"
          value={cents(data.subscriptions.mrr, cur)}
          sub={`${data.subscriptions.activeCount} active sub${data.subscriptions.activeCount === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Available"
          value={usdAvail ? cents(usdAvail.amount, usdAvail.currency) : money(0, cur)}
        />
        <StatCard
          label="Pending"
          value={usdPend ? cents(usdPend.amount, usdPend.currency) : money(0, cur)}
        />
        <StatCard label="In transit to bank" value={cents(data.inTransit, cur)} />
      </div>

      {/* 30-day volume chart */}
      <VolumeChart daily={data.daily} currency={cur} />

      {/* Open disputes — surfaced loud since they need action */}
      {data.disputes.count > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/40">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-rose-700 dark:text-rose-300">
            <AlertCircle className="h-4 w-4" />
            {data.disputes.count} open dispute
            {data.disputes.count === 1 ? '' : 's'}
          </p>
          <ul className="space-y-1 text-xs text-rose-700/90 dark:text-rose-300/90">
            {data.disputes.items.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3">
                <span>
                  {cents(d.amount, d.currency)} · {d.reason?.replace(/_/g, ' ')}
                </span>
                <span className="font-mono">{d.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Recent payments
        </h3>
        {data.charges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent charges.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Customer / description</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.charges.map((c) => (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {fromUnix(c.created)}
                    </td>
                    <td className="px-3 py-2">
                      {c.customerEmail || c.description || '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                      {cents(c.amount, c.currency)}
                      {c.refunded && (
                        <span className="ml-1 text-[10px] text-rose-500">
                          refunded
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={c.status} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {c.paid && !c.refunded && c.status === 'succeeded' ? (
                        <RowAction
                          icon={Undo2}
                          tone="danger"
                          disabled={action.isPending}
                          onClick={() =>
                            run(
                              `Refund ${cents(c.amount, c.currency)} to ${c.customerEmail || 'this customer'}? This cannot be undone.`,
                              { action: 'refund', chargeId: c.id },
                            )
                          }
                        >
                          Refund
                        </RowAction>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.payouts.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            Recent payouts
          </h3>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Arrival</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.payouts.map((p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {fromUnix(p.arrivalDate)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                      {cents(p.amount, p.currency)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Directory · recent customers */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
          <Users className="h-4 w-4 text-muted-foreground" />
          Recent customers
        </h3>
        {data.customers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No customers yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {data.customers.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border border-border bg-card p-3"
              >
                <p className="truncate text-sm font-medium text-foreground">
                  {c.name || c.email || c.id}
                </p>
                {c.email && c.name && (
                  <p className="truncate text-xs text-muted-foreground">
                    {c.email}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Added {fromUnix(c.created)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Billing · recent invoices */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Recent invoices
        </h3>
        {data.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No invoices yet — use “New invoice” above to bill a client.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.invoices.map((inv) => {
                  const who =
                    inv.customerName || inv.customerEmail || 'this customer'
                  return (
                    <tr key={inv.id}>
                      <td className="whitespace-nowrap px-3 py-2">
                        <span className="font-mono text-xs">
                          {inv.number || inv.id.slice(-8)}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {fromUnix(inv.created)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {inv.customerName || inv.customerEmail || '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                        {cents(inv.amountDue, inv.currency)}
                        {inv.amountPaid > 0 &&
                          inv.amountPaid < inv.amountDue && (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {cents(inv.amountPaid, inv.currency)} paid
                            </span>
                          )}
                      </td>
                      <td className="px-3 py-2">
                        <StatusPill status={inv.status} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {(inv.status === 'draft' || inv.status === 'open') && (
                            <RowAction
                              icon={Send}
                              disabled={action.isPending}
                              onClick={() =>
                                run(
                                  `Email invoice ${inv.number || ''} (${cents(inv.amountDue, inv.currency)}) to ${who}?`,
                                  { action: 'sendInvoice', invoiceId: inv.id },
                                )
                              }
                            >
                              {inv.status === 'draft' ? 'Send' : 'Resend'}
                            </RowAction>
                          )}
                          {inv.status === 'open' && (
                            <RowAction
                              icon={Ban}
                              tone="danger"
                              disabled={action.isPending}
                              onClick={() =>
                                run(
                                  `Void invoice ${inv.number || ''} for ${who}? It can't be collected after this.`,
                                  { action: 'voidInvoice', invoiceId: inv.id },
                                )
                              }
                            >
                              Void
                            </RowAction>
                          )}
                          {inv.hostedUrl && (
                            <a
                              href={inv.hostedUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Open
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  New-invoice form                                                          */
/* -------------------------------------------------------------------------- */

function NewInvoiceForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (
    payload: {
      email: string
      name: string
      amountCents: number
      description: string
      daysUntilDue: number
    },
    sendNow: boolean,
  ) => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [daysUntilDue, setDaysUntilDue] = useState('7')

  const amountCents = Math.round(parseFloat(amount || '0') * 100)
  const valid = email.trim().length > 3 && amountCents > 0

  const submit = (sendNow: boolean) =>
    onSubmit(
      {
        email: email.trim(),
        name: name.trim(),
        amountCents,
        description: description.trim(),
        daysUntilDue: Number(daysUntilDue) || 7,
      },
      sendNow,
    )

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">New invoice</h3>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Customer email *
          </label>
          <input
            className={fieldClass}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="billing@client.com"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Customer name
          </label>
          <input
            className={fieldClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Only used if they're new to Stripe"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Amount (USD) *
          </label>
          <input
            className={fieldClass}
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1500.00"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Due in (days)
          </label>
          <input
            className={fieldClass}
            type="number"
            min="1"
            value={daysUntilDue}
            onChange={(e) => setDaysUntilDue(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Description
          </label>
          <input
            className={fieldClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. 20 solar appointments — July"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => submit(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Create &amp; email
        </button>
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => submit(false)}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save as draft
        </button>
        <span className="text-xs text-muted-foreground">
          “Create &amp; email” sends a real invoice email to the customer.
        </span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Mercury                                                                   */
/* -------------------------------------------------------------------------- */

function MercuryTab() {
  const { data, isLoading, isError, error } = useQuery<MercuryOverview>({
    queryKey: ['payments-mercury'],
    queryFn: async () => {
      const res = await fetch('/api/payments/mercury/overview')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to load Mercury')
      return d
    },
    refetchInterval: 60_000,
  })

  if (isLoading) return <LoadingBlock />
  if (isError || !data)
    return (
      <ErrorBlock
        message={
          error instanceof Error ? error.message : 'Failed to load Mercury.'
        }
      />
    )

  return (
    <div className="space-y-6">
      <StatCard
        label="Total available balance"
        value={money(data.totalBalance)}
        sub={`${data.accounts.length} account${data.accounts.length === 1 ? '' : 's'}`}
      />

      {data.accounts.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.accounts.map((a) => (
            <div key={a.id} className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-foreground">{a.name}</p>
                <span className="text-xs text-muted-foreground">
                  ••{a.last4}
                </span>
              </div>
              <p className="mt-2 text-xl font-bold tabular-nums text-foreground">
                {money(a.availableBalance)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {money(a.currentBalance)} current
                {a.kind ? ` · ${a.kind}` : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Recent transactions
        </h3>
        {data.transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent transactions.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Counterparty</th>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.transactions.map((t) => {
                  const outgoing = t.amount < 0
                  return (
                    <tr key={t.id}>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {fromIso(t.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        {t.counterpartyName || t.bankDescription || '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {t.accountName}
                      </td>
                      <td
                        className={cn(
                          'whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums',
                          outgoing
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-emerald-600 dark:text-emerald-400',
                        )}
                      >
                        <span className="mr-1 inline-flex align-middle">
                          {outgoing ? (
                            <ArrowUpRight className="h-3 w-3" />
                          ) : (
                            <ArrowDownLeft className="h-3 w-3" />
                          )}
                        </span>
                        {money(Math.abs(t.amount))}
                      </td>
                      <td className="px-3 py-2">
                        <StatusPill status={t.status} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Tabs shell                                                                */
/* -------------------------------------------------------------------------- */

const TABS = [
  { key: 'stripe', label: 'Stripe', icon: CreditCard },
  { key: 'mercury', label: 'Mercury', icon: Landmark },
  { key: 'roofing', label: 'Roofing Clients', icon: HardHat },
  { key: 'nct', label: 'NCT Leads', icon: Receipt },
  { key: 'log', label: 'Automation Log', icon: ScrollText },
] as const

export function PaymentsTabs() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('stripe')

  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'stripe' && <StripeTab />}
      {tab === 'mercury' && <MercuryTab />}
      {tab === 'roofing' && <RoofingClientsTab />}
      {tab === 'nct' && <NctLeadsTab />}
      {tab === 'log' && (
        <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
          <Inbox className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">Automation Log</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Empty for now — this is where payment automations will report.
          </p>
        </div>
      )}
    </div>
  )
}
