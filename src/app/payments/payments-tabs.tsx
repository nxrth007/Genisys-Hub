'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CreditCard, Landmark, ArrowDownLeft, ArrowUpRight, ShoppingBag } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StripeTab } from './stripe-tab'
import { WhopTab } from './whop-tab'
import { ErrorBlock, fromIso, LoadingBlock, money, StatCard, StatusPill } from './ui'

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

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
            <div key={a.id} className="rounded-xl border border-border bg-card p-4">
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
                            ? 'text-destructive'
                            : 'text-success',
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
  { key: 'whop', label: 'Whop', icon: ShoppingBag },
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
      {tab === 'whop' && <WhopTab />}
    </div>
  )
}
