'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CreditCard,
  Landmark,
  ScrollText,
  Loader2,
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Inbox,
} from 'lucide-react'
import { cn } from '@/lib/utils'

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

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

function money(amount: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount)
  } catch {
    return `$${amount.toFixed(2)}`
  }
}
// Stripe amounts are in the smallest currency unit (cents).
function cents(amount: number, currency = 'usd'): string {
  return money(amount / 100, currency)
}
function fromUnix(sec: number): string {
  return new Date(sec * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
function fromIso(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

/* -------------------------------------------------------------------------- */
/*  Shared bits                                                               */
/* -------------------------------------------------------------------------- */

function StatCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

function StatusPill({ status }: { status: string | null }) {
  const s = (status || '').toLowerCase()
  const tone =
    s.includes('succeed') || s === 'paid' || s === 'sent' || s === 'posted'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
      : s.includes('pending') || s.includes('progress')
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
        : s.includes('fail') || s.includes('cancel')
          ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        tone,
      )}
    >
      {status || '—'}
    </span>
  )
}

function LoadingBlock() {
  return (
    <div className="flex h-40 items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
    </div>
  )
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <span>{message}</span>
    </div>
  )
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

function StripeTab() {
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
      <p className="text-sm text-muted-foreground">
        {data.account.name}
      </p>

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
