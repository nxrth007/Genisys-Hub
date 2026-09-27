'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  WhopAccountView,
  WhopDispute,
  WhopMembership,
  WhopOrder,
  WhopPayout,
  WhopPlan,
  WhopPromoCode,
  WhopRefund,
} from '@/lib/whop'
import {
  CopyButton,
  ErrorBlock,
  fieldClass,
  fromIso,
  LoadingBlock,
  money,
  StatCard,
  StatusPill,
} from './ui'

/**
 * Payments → Whop.
 *
 * Everything the Whop key can see, read-only: payments, memberships,
 * plans, promo codes, refunds, disputes, payouts and the balance. One
 * request to /api/payments/whop/overview returns every section; each
 * section either carries its data or says why it could not be read, so a
 * key missing one permission still shows everything else.
 */

type Failed = { ok: false; error: string; permission: boolean; scope: string }
type Section<T> = { ok: true; data: T } | Failed
type Stat = { latest: number | null; total: number | null }

type Overview =
  | { configured: false; hint: string }
  | {
      configured: true
      window: { days: number; since: string }
      account: Section<WhopAccountView>
      payments: Section<{
        orders: WhopOrder[]
        truncated: boolean
        summary: {
          count: number
          paidCount: number
          grossUsd: number
          netUsd: number
          refundedUsd: number
          /** Non-USD payments that couldn't be converted, left out of net/refunded. */
          unconverted: number
          customers: number
        }
      }>
      memberships: Section<{ memberships: WhopMembership[]; truncated: boolean }>
      plans: Section<WhopPlan[]>
      promoCodes: Section<WhopPromoCode[]>
      refunds: Section<WhopRefund[]>
      disputes: Section<WhopDispute[]>
      payouts: Section<WhopPayout[]>
      stats: { mrr: Section<Stat>; activeMembers: Section<Stat> }
    }

const WINDOWS = [30, 90, 365] as const
const PAGE = 50

/** Dispute statuses where Whop is waiting on us. */
const NEEDS_RESPONSE = new Set(['needs_response', 'warning_needs_response'])

/** Memberships that are currently paying or about to. */
const LIVE = new Set(['active', 'trialing', 'past_due', 'canceling'])

const thClass = 'px-3 py-2'
const theadClass =
  'border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground'

function amount(v: number | null, currency?: string | null): string {
  return v === null ? '—' : money(v, currency ?? 'usd')
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function period(days: number | null): string | null {
  if (days === null || days <= 0) return null
  if (days === 7) return 'weekly'
  if (days >= 28 && days <= 31) return 'monthly'
  if (days >= 89 && days <= 92) return 'quarterly'
  if (days >= 365 && days <= 366) return 'yearly'
  return `every ${days} days`
}

export function WhopTab() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(90)

  const q = useQuery<Overview>({
    queryKey: ['payments-whop', days],
    queryFn: async () => {
      const res = await fetch(`/api/payments/whop/overview?days=${days}`)
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.message || d.error || `Failed to load Whop (${res.status})`)
      return d as Overview
    },
    refetchInterval: 120_000,
  })

  if (q.isLoading) return <LoadingBlock />
  if (q.isError || !q.data) {
    return <ErrorBlock message={q.error instanceof Error ? q.error.message : 'Failed to load Whop.'} />
  }

  const data = q.data
  if (!data.configured) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-[13px] text-muted-foreground">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{data.hint}</span>
      </div>
    )
  }

  const account = data.account.ok ? data.account.data : null
  const pay = data.payments.ok ? data.payments.data : null
  // Totals come from the fetched list; past the cap they're a floor, not the figure.
  const floor = pay?.truncated ? '≥ ' : ''
  const members = data.memberships.ok ? data.memberships.data.memberships : null
  const mrr = data.stats.mrr.ok ? data.stats.mrr.data.latest : null
  const activeStat = data.stats.activeMembers.ok ? data.stats.activeMembers.data.latest : null
  const liveCount = members ? members.filter((m) => LIVE.has(m.status)).length : null
  const pastDue = members ? members.filter((m) => m.status === 'past_due').length : 0
  const openDisputes = data.disputes.ok
    ? data.disputes.data.filter((d) => NEEDS_RESPONSE.has((d.status ?? '').toLowerCase())).length
    : 0

  return (
    <div className="space-y-6">
      {/* Header: which account, which window, refresh. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-foreground">
            {account?.title ?? 'Whop'}
            {account?.status && (
              <span className="ml-2 align-middle">
                <StatusPill status={account.status} />
              </span>
            )}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {account?.id ?? 'Read-only view of the Whop account behind the Vault key'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chips
            options={WINDOWS.map((w) => ({ key: String(w), label: w === 365 ? '1 year' : `${w} days` }))}
            value={String(days)}
            onChange={(k) => setDays(Number(k) as (typeof WINDOWS)[number])}
          />
          <button
            type="button"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {q.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Attention: things that cost money if nobody looks. */}
      {(pastDue > 0 || openDisputes > 0) && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-[13px] text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {[
              pastDue > 0 && `${pastDue} membership${pastDue === 1 ? ' is' : 's are'} past due`,
              openDisputes > 0 && `${openDisputes} dispute${openDisputes === 1 ? ' needs' : 's need'} a response`,
            ]
              .filter(Boolean)
              .join(' · ')}
            .
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label={`Collected · ${days === 365 ? '1y' : `${days}d`}`}
          value={pay ? `${floor}${money(pay.summary.grossUsd)}` : '—'}
          sub={
            !pay
              ? 'Payments unavailable'
              : pay.truncated
                ? `Newest ${pay.orders.length} payments only`
                : `${pay.summary.paidCount} paid · ${pay.summary.customers} customers`
          }
        />
        <StatCard
          label="Net after fees"
          value={pay ? `${floor}${money(pay.summary.netUsd)}` : '—'}
          sub={
            pay && pay.summary.unconverted > 0
              ? `${pay.summary.unconverted} non-USD payment${pay.summary.unconverted === 1 ? '' : 's'} not counted`
              : pay && pay.summary.refundedUsd > 0
                ? `${money(pay.summary.refundedUsd)} refunded`
                : 'What lands after Whop’s cut'
          }
        />
        <StatCard
          label="MRR"
          value={mrr !== null ? money(mrr) : '—'}
          sub={data.stats.mrr.ok ? 'Monthly recurring revenue' : 'Needs stats:read on the key'}
        />
        <StatCard
          label="Active members"
          value={activeStat !== null ? String(Math.round(activeStat)) : liveCount !== null ? String(liveCount) : '—'}
          sub={activeStat !== null ? 'Paying members, per Whop' : liveCount !== null ? 'Active, trialing or past due' : 'Memberships unavailable'}
        />
        <StatCard
          label="Whop balance"
          value={account?.totalUsd != null ? money(account.totalUsd) : '—'}
          sub={account?.lifetimeUsd != null ? `${money(account.lifetimeUsd)} lifetime` : 'Held at Whop'}
        />
      </div>

      <Block title="Payments" section={data.payments}>
        {(p) => <PaymentsTable orders={p.orders} truncated={p.truncated} days={days} />}
      </Block>

      <Block title="Memberships" section={data.memberships}>
        {(m) => <MembershipsTable memberships={m.memberships} truncated={m.truncated} />}
      </Block>

      <Block title="Plans" section={data.plans}>
        {(plans) => <PlansTable plans={plans} />}
      </Block>

      <Block title="Promo codes" section={data.promoCodes}>
        {(codes) => <PromoTable codes={codes} />}
      </Block>

      <div className="grid gap-6 xl:grid-cols-2">
        <Block title="Refunds" section={data.refunds}>
          {(refunds) => <RefundsTable refunds={refunds} />}
        </Block>
        <Block title="Disputes" section={data.disputes}>
          {(disputes) => <DisputesTable disputes={disputes} />}
        </Block>
      </div>

      <Block title="Payouts" section={data.payouts}>
        {(payouts) => <PayoutsTable payouts={payouts} balances={account?.balances ?? []} />}
      </Block>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                           */
/* -------------------------------------------------------------------------- */

function Block<T>({
  title,
  section,
  children,
}: {
  title: string
  section: Section<T>
  children: (data: T) => React.ReactNode
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      {section.ok ? children(section.data) : <Unavailable failed={section} />}
    </section>
  )
}

/** Why a section is empty: a missing key permission (with the one to add), or Whop's own error. */
function Unavailable({ failed }: { failed: Failed }) {
  const permission = failed.permission || /not authori[sz]ed/i.test(failed.error)
  return (
    <div className="rounded-xl border border-dashed border-border p-4 text-[13px] text-muted-foreground">
      {permission ? (
        <>
          <p>
            The Whop API key can’t read this yet. In Whop → Developer → API keys, give the key the{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground/85">
              {failed.scope}
            </code>{' '}
            permission, then refresh.
          </p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">{failed.error}</p>
        </>
      ) : (
        <p>{failed.error}</p>
      )}
    </div>
  )
}

function Chips({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: string; label: string; count?: number }>
  value: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            'rounded-lg border px-2.5 py-1 text-[12px] font-medium transition',
            value === o.key
              ? 'border-foreground/30 bg-muted text-foreground'
              : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1.5 tabular-nums text-muted-foreground">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Status chips built from the rows themselves, busiest first, with an "All" in front. */
function statusOptions(statuses: string[]) {
  const counts = new Map<string, number>()
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1)
  return [
    { key: 'all', label: 'All', count: statuses.length },
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, label: titleCase(key), count })),
  ]
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

function Table({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className={theadClass}>
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  )
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null
  return (
    <button
      type="button"
      onClick={onMore}
      className="mt-2 w-full rounded-lg border border-border py-1.5 text-[12px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      Show more ({total - shown} left)
    </button>
  )
}

function Person({ name, email, username }: { name: string | null; email: string | null; username: string | null }) {
  const primary = name ?? username ?? email
  return (
    <div className="min-w-0">
      <p className="truncate text-foreground">{primary ?? '—'}</p>
      {email && email !== primary && <p className="truncate text-[12px] text-muted-foreground">{email}</p>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Sections                                                                  */
/* -------------------------------------------------------------------------- */

function PaymentsTable({ orders, truncated, days }: { orders: WhopOrder[]; truncated: boolean; days: number }) {
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)

  if (orders.length === 0) {
    return <Empty>No Whop payments in the last {days === 365 ? 'year' : `${days} days`}.</Empty>
  }

  // A status can vanish on refetch or a window switch; fall back to All rather than an empty table.
  const active = status === 'all' || orders.some((o) => o.status === status) ? status : 'all'
  const needle = query.trim().toLowerCase()
  const rows = orders.filter(
    (o) =>
      (active === 'all' || o.status === active) &&
      (!needle ||
        [o.customerName, o.customerEmail, o.customerUsername, o.productTitle, o.id].some((v) =>
          v?.toLowerCase().includes(needle),
        )),
  )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Chips
          options={statusOptions(orders.map((o) => o.status))}
          value={active}
          onChange={(k) => {
            setStatus(k)
            setLimit(PAGE)
          }}
        />
        <label className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(PAGE)
            }}
            placeholder="Customer, email or product"
            className={cn(fieldClass, 'py-1.5 pl-8 text-[13px]')}
          />
        </label>
      </div>

      {rows.length === 0 ? (
        <Empty>No payments match.</Empty>
      ) : (
        <Table
          head={
            <>
              <th className={thClass}>Date</th>
              <th className={thClass}>Customer</th>
              <th className={thClass}>Product</th>
              <th className={cn(thClass, 'text-right')}>Amount</th>
              <th className={cn(thClass, 'text-right')}>Net</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Card</th>
            </>
          }
        >
          {rows.slice(0, limit).map((o) => (
            <tr key={o.id}>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromIso(o.paidAt ?? o.createdAt)}</td>
              <td className="max-w-[220px] px-3 py-2">
                <Person name={o.customerName} email={o.customerEmail} username={o.customerUsername} />
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                <p className="truncate">{o.productTitle ?? '—'}</p>
                {o.billingReason && <p className="text-[11px]">{titleCase(o.billingReason)}</p>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                {amount(o.total, o.currency)}
                {o.refunded ? (
                  <p className="text-[11px] font-normal text-destructive">−{amount(o.refunded, o.currency)} refunded</p>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                {amount(o.afterFees, o.currency)}
              </td>
              <td className="px-3 py-2">
                <StatusPill status={o.status} />
                {o.substatus && o.substatus !== o.status && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{titleCase(o.substatus)}</p>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {o.cardBrand || o.cardLast4 ? `${o.cardBrand ? titleCase(o.cardBrand) : 'Card'} ••${o.cardLast4 ?? '—'}` : '—'}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <ShowMore shown={Math.min(limit, rows.length)} total={rows.length} onMore={() => setLimit((l) => l + PAGE)} />
      {truncated && (
        <p className="text-[12px] text-muted-foreground">
          Showing the newest {orders.length} payments in this window. Older ones are in Whop.
        </p>
      )}
    </div>
  )
}

function MembershipsTable({ memberships, truncated }: { memberships: WhopMembership[]; truncated: boolean }) {
  const [status, setStatus] = useState('all')
  const [limit, setLimit] = useState(PAGE)

  if (memberships.length === 0) return <Empty>No memberships yet.</Empty>

  const active = status === 'all' || memberships.some((m) => m.status === status) ? status : 'all'
  const rows = active === 'all' ? memberships : memberships.filter((m) => m.status === active)

  return (
    <div className="space-y-2">
      <Chips
        options={statusOptions(memberships.map((m) => m.status))}
        value={active}
        onChange={(k) => {
          setStatus(k)
          setLimit(PAGE)
        }}
      />
      <Table
        head={
          <>
            <th className={thClass}>Customer</th>
            <th className={thClass}>Product</th>
            <th className={thClass}>Price</th>
            <th className={thClass}>Status</th>
            <th className={thClass}>Renews / ends</th>
            <th className={thClass}>Joined</th>
          </>
        }
      >
        {rows.slice(0, limit).map((m) => (
          <tr key={m.id}>
            <td className="max-w-[220px] px-3 py-2">
              <Person name={m.customerName} email={m.customerEmail} username={m.customerUsername} />
            </td>
            <td className="px-3 py-2 text-muted-foreground">{m.productTitle ?? '—'}</td>
            <td className="whitespace-nowrap px-3 py-2 tabular-nums">{m.renewalPrice ?? '—'}</td>
            <td className="px-3 py-2">
              <StatusPill status={m.status} />
              {m.cancellationReason && (
                <p className="mt-0.5 max-w-[200px] truncate text-[11px] text-muted-foreground" title={m.cancellationReason}>
                  {m.cancellationReason}
                </p>
              )}
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
              {m.canceledAt ? (
                <>Canceled {fromIso(m.canceledAt)}</>
              ) : (
                <>
                  {fromIso(m.periodEndsAt)}
                  {m.cancelAtPeriodEnd && <p className="text-[11px] text-warning">Cancels at period end</p>}
                </>
              )}
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromIso(m.joinedAt)}</td>
          </tr>
        ))}
      </Table>
      <ShowMore shown={Math.min(limit, rows.length)} total={rows.length} onMore={() => setLimit((l) => l + PAGE)} />
      {truncated && (
        <p className="text-[12px] text-muted-foreground">Showing the newest {memberships.length} memberships.</p>
      )}
    </div>
  )
}

function PlansTable({ plans }: { plans: WhopPlan[] }) {
  if (plans.length === 0) return <Empty>No plans.</Empty>
  return (
    <Table
      head={
        <>
          <th className={thClass}>Plan</th>
          <th className={thClass}>Price</th>
          <th className={thClass}>Billing</th>
          <th className={cn(thClass, 'text-right')}>Members</th>
          <th className={thClass}>Visibility</th>
          <th className={cn(thClass, 'text-right')}>Checkout link</th>
        </>
      }
    >
      {plans.map((p) => {
        const every = period(p.billingPeriodDays)
        return (
          <tr key={p.id}>
            <td className="px-3 py-2">
              <p className="text-foreground">{p.title ?? p.productTitle ?? p.id}</p>
              {p.title && p.productTitle && <p className="text-[12px] text-muted-foreground">{p.productTitle}</p>}
            </td>
            <td className="whitespace-nowrap px-3 py-2 tabular-nums">
              {p.formattedPrice ?? amount(p.renewalPrice ?? p.initialPrice, p.currency)}
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
              {p.planType === 'one_time' ? 'One-time' : every ? titleCase(every) : p.planType ? titleCase(p.planType) : '—'}
              {p.trialDays ? <p className="text-[11px]">{p.trialDays}-day trial</p> : null}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{p.members ?? '—'}</td>
            <td className="px-3 py-2 text-muted-foreground">{p.visibility ? titleCase(p.visibility) : '—'}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right">
              {p.purchaseUrl ? (
                <span className="inline-flex items-center gap-1.5">
                  <CopyButton value={p.purchaseUrl} label="Copy" />
                  <a
                    href={p.purchaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" /> Open
                  </a>
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
          </tr>
        )
      })}
    </Table>
  )
}

function PromoTable({ codes }: { codes: WhopPromoCode[] }) {
  if (codes.length === 0) return <Empty>No promo codes.</Empty>
  return (
    <Table
      head={
        <>
          <th className={thClass}>Code</th>
          <th className={thClass}>Discount</th>
          <th className={thClass}>Product</th>
          <th className={cn(thClass, 'text-right')}>Used</th>
          <th className={thClass}>Status</th>
          <th className={thClass}>Expires</th>
        </>
      }
    >
      {codes.map((c) => (
        <tr key={c.id}>
          <td className="whitespace-nowrap px-3 py-2 font-mono text-[13px] text-foreground">{c.code}</td>
          <td className="whitespace-nowrap px-3 py-2">{c.discount ?? '—'}</td>
          <td className="px-3 py-2 text-muted-foreground">{c.productTitle ?? 'Any product'}</td>
          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
            {c.uses ?? 0}
            {c.unlimitedStock ? ' / ∞' : c.stock !== null ? ` / ${c.stock}` : ''}
          </td>
          <td className="px-3 py-2">
            <StatusPill status={c.status} />
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{c.expiresAt ? fromIso(c.expiresAt) : 'Never'}</td>
        </tr>
      ))}
    </Table>
  )
}

function RefundsTable({ refunds }: { refunds: WhopRefund[] }) {
  if (refunds.length === 0) return <Empty>No refunds.</Empty>
  return (
    <Table
      head={
        <>
          <th className={thClass}>Date</th>
          <th className={cn(thClass, 'text-right')}>Amount</th>
          <th className={thClass}>Status</th>
          <th className={thClass}>Payment</th>
        </>
      }
    >
      {refunds.map((r) => (
        <tr key={r.id}>
          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromIso(r.createdAt)}</td>
          <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{amount(r.amount, r.currency)}</td>
          <td className="px-3 py-2">
            <StatusPill status={r.status} />
          </td>
          <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{r.paymentId ?? '—'}</td>
        </tr>
      ))}
    </Table>
  )
}

function DisputesTable({ disputes }: { disputes: WhopDispute[] }) {
  if (disputes.length === 0) return <Empty>No disputes.</Empty>
  return (
    <Table
      head={
        <>
          <th className={thClass}>Opened</th>
          <th className={cn(thClass, 'text-right')}>Amount</th>
          <th className={thClass}>Reason</th>
          <th className={thClass}>Status</th>
          <th className={thClass}>Respond by</th>
        </>
      }
    >
      {disputes.map((d) => (
        <tr key={d.id}>
          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromIso(d.createdAt)}</td>
          <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{amount(d.amount, d.currency)}</td>
          <td className="px-3 py-2 text-muted-foreground">
            {d.reason ? titleCase(d.reason) : '—'}
            {d.productTitle && <p className="text-[11px]">{d.productTitle}</p>}
          </td>
          <td className="px-3 py-2">
            <StatusPill status={d.status} />
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromIso(d.needsResponseBy)}</td>
        </tr>
      ))}
    </Table>
  )
}

function PayoutsTable({ payouts, balances }: { payouts: WhopPayout[]; balances: WhopAccountView['balances'] }) {
  return (
    <div className="space-y-3">
      {balances.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {balances.map((b) => (
            <div key={b.symbol} className="rounded-xl border border-border bg-card p-4">
              <p className="eyebrow text-muted-foreground">{b.symbol.toUpperCase()} balance</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-foreground">{amount(b.available, b.symbol)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[
                  b.pending !== null && `${amount(b.pending, b.symbol)} pending`,
                  b.inTransit !== null && b.inTransit > 0 && `${amount(b.inTransit, b.symbol)} in transit`,
                  b.reserve !== null && b.reserve > 0 && `${amount(b.reserve, b.symbol)} reserved`,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Available to pay out'}
              </p>
            </div>
          ))}
        </div>
      )}
      {payouts.length === 0 ? (
        <Empty>No payouts yet.</Empty>
      ) : (
        <Table
          head={
            <>
              <th className={thClass}>Requested</th>
              <th className={cn(thClass, 'text-right')}>Amount</th>
              <th className={cn(thClass, 'text-right')}>Fee</th>
              <th className={cn(thClass, 'text-right')}>Net</th>
              <th className={thClass}>To</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Arrives</th>
            </>
          }
        >
          {payouts.map((p) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromIso(p.createdAt)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{amount(p.amount, p.currency)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">{amount(p.fee, p.currency)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{amount(p.net, p.currency)}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {p.destination ?? '—'}
                {p.speed && <p className="text-[11px]">{titleCase(p.speed)}</p>}
              </td>
              <td className="px-3 py-2">
                <StatusPill status={p.status} />
                {p.failure && <p className="mt-0.5 max-w-[200px] text-[11px] text-destructive">{p.failure}</p>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromIso(p.estimatedArrival)}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}
