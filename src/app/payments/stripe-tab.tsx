'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, Ban, CalendarClock, ExternalLink, FileText, Loader2, Plus, RefreshCw, Send, Undo2, Users, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Chip } from '@/components/ui/chip'
import { permissionLabel, type BillingState, type StripeDenied } from '@/lib/stripe-billing-plan'
import { cents, CopyButton, ErrorBlock, fieldClass, fromUnix, LoadingBlock, money, StatCard, StatusPill } from './ui'

/**
 * Payments → Stripe: the signup site's Stripe account, read through
 * /api/payments/stripe/overview with the Vault's read-only key. The layout Alex
 * knows (KPIs, volume chart, disputes, payments, payouts, customers, invoices)
 * plus what he asked for on 2026-11-18: which account this is, every
 * subscription by status with MRR, renewals and first charges due, payment
 * problems, failed payments and open invoices. Sections the key may not read
 * say so instead of showing zeros, and the banner says exactly what a fuller
 * key needs. Write actions only appear with a full secret key, which the Hub
 * doesn't hold.
 */

/* -------------------------------------------------------------------------- */
/*  Types (what /api/payments/stripe/overview returns)                        */
/* -------------------------------------------------------------------------- */

type SubRow = {
  id: string
  customerId: string | null
  who: string
  email: string | null
  plan: string | null
  price: string | null
  status: string
  state: BillingState
  amountCents: number | null
  currency: string
  trialEnd: string | null
  periodEnd: string | null
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  endedAt: string | null
  created: string | null
  link: string
  customerLink: string | null
}

type ChargeRow = {
  id: string
  amount: number
  currency: string
  status: string
  paid: boolean
  refunded: boolean
  created: number
  description: string | null
  customerEmail: string | null
  customerName: string | null
  customerId: string | null
  failureMessage: string | null
  link: string
}

type InvoiceRow = {
  id: string
  number: string | null
  customerName: string | null
  customerEmail: string | null
  customerId: string | null
  subscriptionId: string | null
  amountDue: number
  amountPaid: number
  currency: string
  status: string
  created: number
  dueDate: number | null
  attemptCount: number
  nextAttempt: number | null
  hostedUrl: string | null
  pdfUrl: string | null
  link: string
}

export type StripeOverview = {
  ok: true
  asOf: string
  account: { name: string; id: string | null; marker: string | null; sameAsSignup: boolean | null; currency: string; dashboardUrl: string }
  key: { entry: string; kind: 'restricted' | 'secret' | 'publishable' | 'unknown'; mode: 'live' | 'test' | null; readOnly: boolean }
  sections: Record<'account' | 'balance' | 'volume' | 'charges' | 'payouts' | 'disputes' | 'invoices' | 'subscriptions' | 'customers', boolean>
  denied: StripeDenied[]
  errors: string[]
  setup: { entry: string; permissions: string[]; legacyKeyPresent: boolean; legacyEntry: string }
  available: Array<{ amount: number; currency: string }>
  pending: Array<{ amount: number; currency: string }>
  inTransit: number
  volume30d: { gross: number; net: number; fees: number; count: number; truncated: boolean; currency: string }
  daily: Array<{ date: string; gross: number }>
  subscriptions: {
    total: number
    counts: Record<string, number>
    states: Record<Exclude<BillingState, 'none'>, number>
    activeCount: number
    trialingCount: number
    mrr: number
    trialMrr: number
    upcoming: Array<SubRow & { at: string; kind: 'first charge' | 'renewal'; amountCents: number | null }>
    problems: SubRow[]
    ending: SubRow[]
    canceledRecently: SubRow[]
    truncated: boolean
  }
  disputes: { count: number; items: Array<{ id: string; amount: number; currency: string; status: string; reason: string; created: number; link: string }> }
  charges: ChargeRow[]
  failedPayments: ChargeRow[]
  payouts: Array<{ id: string; amount: number; currency: string; status: string; arrivalDate: number; created: number; link: string }>
  customers: Array<{ id: string; name: string | null; email: string | null; created: number; delinquent: boolean; link: string }>
  customerCount: number
  invoices: InvoiceRow[]
  openInvoices: Array<InvoiceRow & { pastDue: boolean }>
}

const fullDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const day = (iso: string | null | undefined) => (iso ? fullDate.format(new Date(iso)) : '—')

function ago(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

const STATE_TONE: Record<BillingState, 'mint' | 'blue' | 'pink' | 'amber' | 'muted'> = { active: 'mint', trialing: 'blue', problem: 'pink', ending: 'amber', canceled: 'amber', none: 'muted' }

/** Simple 30-day daily-volume bars (amounts in cents). */
function VolumeChart({ daily, currency }: { daily: Array<{ date: string; gross: number }>; currency: string }) {
  const max = Math.max(1, ...daily.map((d) => d.gross))
  const total = daily.reduce((s, d) => s + d.gross, 0)
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">Volume · last 30 days</h3>
        <span className="text-sm font-bold tabular-nums text-foreground">{cents(total, currency)}</span>
      </div>
      <div className="flex h-24 items-end gap-[3px]">
        {daily.map((d) => {
          const h = Math.max(2, Math.round((d.gross / max) * 96))
          return (
            <div key={d.date} className="group relative flex-1" title={`${d.date}: ${cents(d.gross, currency)}`}>
              <div className="w-full rounded-t bg-primary/70 transition group-hover:bg-primary" style={{ height: `${h}px` }} />
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
        tone === 'danger' ? 'border-destructive/30 text-destructive hover:bg-destructive/10' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      {children}
    </button>
  )
}

function OpenLink({ href, label = 'Open' }: { href: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground">
      <ExternalLink className="h-3 w-3" />
      {label}
    </a>
  )
}

const thClass = 'px-3 py-2'
const theadClass = 'border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground'

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

function Who({ name, email }: { name: string | null; email: string | null }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-foreground">{name ?? email ?? '—'}</p>
      {email && name && <p className="truncate text-[12px] text-muted-foreground">{email}</p>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  The tab                                                                   */
/* -------------------------------------------------------------------------- */

export function StripeTab() {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
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

  // Re-read the subscriptions now instead of the two-minute snapshot.
  const refresh = useMutation({
    mutationFn: async (): Promise<StripeOverview> => {
      const res = await fetch('/api/payments/stripe/overview?refresh=1')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.message || d.error || 'Refresh failed')
      return d
    },
    onSuccess: (d) => queryClient.setQueryData(['payments-stripe'], d),
    onError: (e) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Refresh failed.' }),
  })

  // All write actions go through one gated endpoint; the key stays server-side. With a read-only key the
  // server refuses them and the buttons below never show.
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
    onError: (e) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Action failed.' }),
  })

  /** Every action here moves money or emails a customer — always confirm. */
  const run = (confirmText: string, payload: Record<string, unknown>) => {
    if (!window.confirm(confirmText)) return
    setNotice(null)
    action.mutate(payload)
  }

  if (isLoading) return <LoadingBlock />
  if (isError || !data) return <ErrorBlock message={error instanceof Error ? error.message : 'Failed to load Stripe.'} />

  const cur = data.account.currency || 'usd'
  const usdAvail = data.available.find((b) => b.currency === cur) ?? data.available[0]
  const usdPend = data.pending.find((b) => b.currency === cur) ?? data.pending[0]
  const ro = data.key.readOnly
  const sub = data.subscriptions
  const canWrite = !ro

  /** "needs Balance: Read" for a section this key may not read. */
  const needs = (what: string) => {
    const d = data.denied.find((x) => x.what === what)
    return d ? `needs ${permissionLabel(d.permission) ?? `${what}: Read`}` : 'not readable with this key'
  }

  return (
    <div className="space-y-6">
      {/* Which account, which key */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {data.account.name}
            {data.account.id && <code className="font-mono text-[11px] text-muted-foreground">{data.account.id}</code>}
            {data.account.sameAsSignup === true && <Chip tone="mint">Signup account</Chip>}
            {data.account.sameAsSignup === false && <Chip tone="pink">Not the signup account</Chip>}
            {data.key.mode === 'test' && <Chip tone="amber">Test mode</Chip>}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              Vault key “{data.key.entry}” · {data.key.kind}
              {ro ? ' · read-only' : ''}
            </span>
            <span>·</span>
            <span>subscriptions as of {ago(data.asOf)}</span>
            <span>·</span>
            <Link href="/clients" className="underline underline-offset-2 hover:text-foreground">
              by client on the Clients page
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            {refresh.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
          <a href={data.account.dashboardUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted">
            <ExternalLink className="h-4 w-4" />
            Open Stripe
          </a>
          {canWrite && (
            <button
              type="button"
              onClick={() => {
                setNotice(null)
                setShowNewInvoice(true)
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-foreground/90"
            >
              <Plus className="h-4 w-4" />
              New invoice
            </button>
          )}
        </div>
      </div>

      {/* What this key can't read, and exactly what a fuller one needs */}
      {data.denied.length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            The “{data.key.entry}” key can’t read {data.denied.map((d) => d.what).join(', ')}
          </p>
          <p className="mt-1.5 text-[13px] text-warning/90">
            Subscriptions, customers and renewals show from it. For balances, payments, payouts and invoices, make a <b>read-only</b> restricted key in Stripe → Developers → API keys → “Create restricted key” with{' '}
            <span className="font-medium">{data.setup.permissions.join(' · ')}</span>, and save it in the Vault as <span className="font-mono">“{data.setup.entry}”</span>. No write permissions: the Hub only looks.
          </p>
          <ul className="mt-2 space-y-0.5 font-mono text-[11.5px] text-warning/80">
            {data.denied.map((d) => (
              <li key={d.path}>
                {d.what}: {d.permission ? `Stripe wants ${permissionLabel(d.permission)} (${d.permission})` : d.message || 'refused'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.errors.length > 0 && <ErrorBlock message={data.errors.join(' · ')} />}
      {data.setup.legacyKeyPresent && (
        <p className="text-xs text-muted-foreground">
          The Vault still has the old “{data.setup.legacyEntry}” (the previous Stripe account, Lead Genisys LLC). Nothing reads it any more; it can be removed.
        </p>
      )}

      {notice && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-xl border p-3 text-sm',
            notice.tone === 'ok' ? 'border-success/30 bg-success/15 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {showNewInvoice && canWrite && (
        <NewInvoiceForm
          busy={action.isPending}
          onCancel={() => setShowNewInvoice(false)}
          onSubmit={(payload, sendNow) =>
            run(sendNow ? `Create this invoice and EMAIL it to ${payload.email} now?` : `Create this invoice as a draft (no email sent)?`, { action: 'createInvoice', ...payload, sendNow })
          }
        />
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Volume · 30d"
          value={data.sections.volume ? cents(data.volume30d.gross, cur) : '—'}
          sub={data.sections.volume ? `${data.volume30d.count} payment${data.volume30d.count === 1 ? '' : 's'}${data.volume30d.truncated ? ' (100+ sample)' : ''}` : needs('Balance transactions')}
        />
        <StatCard label="Net · 30d" value={data.sections.volume ? cents(data.volume30d.net, cur) : '—'} sub={data.sections.volume ? `${cents(data.volume30d.fees, cur)} fees` : needs('Balance transactions')} />
        <StatCard
          label="MRR"
          value={data.sections.subscriptions ? cents(sub.mrr, cur) : '—'}
          sub={data.sections.subscriptions ? `${sub.activeCount} active sub${sub.activeCount === 1 ? '' : 's'}${sub.trialingCount ? ` · +${cents(sub.trialMrr, cur)} once ${sub.trialingCount} trial${sub.trialingCount === 1 ? '' : 's'} convert` : ''}` : needs('Subscriptions')}
        />
        <StatCard label="Available" value={data.sections.balance ? (usdAvail ? cents(usdAvail.amount, usdAvail.currency) : money(0, cur)) : '—'} sub={data.sections.balance ? undefined : needs('Balance')} />
        <StatCard label="Pending" value={data.sections.balance ? (usdPend ? cents(usdPend.amount, usdPend.currency) : money(0, cur)) : '—'} sub={data.sections.balance ? undefined : needs('Balance')} />
        <StatCard label="In transit to bank" value={data.sections.payouts ? cents(data.inTransit, cur) : '—'} sub={data.sections.payouts ? undefined : needs('Payouts')} />
      </div>

      {/* Subscriptions: every status, what's due, what's wrong */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            Subscriptions
            <span className="font-normal text-muted-foreground">
              {sub.total} in Stripe{sub.truncated ? ' (list cut at 1,000)' : ''}
            </span>
          </h3>
          <Link href="/clients" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Every subscription by client, with filters →
          </Link>
        </div>
        {!data.sections.subscriptions ? (
          <p className="text-sm text-muted-foreground">{needs('Subscriptions')}.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatCard label="Active" value={String(sub.states.active)} sub={`${cents(sub.mrr, cur)} MRR`} tone={sub.states.active ? 'good' : 'default'} />
              <StatCard label="On trial" value={String(sub.states.trialing)} sub={sub.states.trialing ? `${cents(sub.trialMrr, cur)}/mo once they convert` : 'first charge follows the trial'} />
              <StatCard label="Payment problems" value={String(sub.states.problem)} sub="past due, unpaid, no card" tone={sub.states.problem ? 'bad' : 'default'} />
              <StatCard label="Ending" value={String(sub.states.ending)} sub="set to cancel at period end" />
              <StatCard label="Canceled · 30d" value={String(sub.canceledRecently.length)} sub={`${sub.states.canceled} canceled in all`} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 text-[13px] font-semibold text-foreground">Due in the next 30 days</h4>
                {sub.upcoming.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No renewals or first charges due in the next 30 days.</p>
                ) : (
                  <Table
                    head={
                      <>
                        <th className={thClass}>When</th>
                        <th className={thClass}>Who</th>
                        <th className={thClass}>Plan</th>
                        <th className={cn(thClass, 'text-right')}>Amount</th>
                        <th className={cn(thClass, 'text-right')}>Stripe</th>
                      </>
                    }
                  >
                    {sub.upcoming.map((u) => (
                      <tr key={u.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                          {day(u.at)}
                          <span className="ml-1.5 text-[11px]">{u.kind}</span>
                        </td>
                        <td className="max-w-[220px] px-3 py-2">
                          <Who name={u.who === u.email ? null : u.who} email={u.email} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{u.plan ?? u.price ?? '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{u.amountCents !== null ? cents(u.amountCents, u.currency) : '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          <OpenLink href={u.link} />
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </div>
              <div>
                <h4 className="mb-2 text-[13px] font-semibold text-foreground">Payment problems{sub.ending.length ? ' and cancellations' : ''}</h4>
                {sub.problems.length + sub.ending.length + sub.canceledRecently.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing past due, nothing ending, nothing canceled in the last 30 days.</p>
                ) : (
                  <Table
                    head={
                      <>
                        <th className={thClass}>Who</th>
                        <th className={thClass}>Plan</th>
                        <th className={thClass}>Status</th>
                        <th className={thClass}>Since / until</th>
                        <th className={cn(thClass, 'text-right')}>Stripe</th>
                      </>
                    }
                  >
                    {[...sub.problems, ...sub.ending, ...sub.canceledRecently].map((s) => (
                      <tr key={s.id}>
                        <td className="max-w-[220px] px-3 py-2">
                          <Who name={s.who === s.email ? null : s.who} email={s.email} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{[s.plan, s.price].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="px-3 py-2">
                          <Chip tone={STATE_TONE[s.state]}>{s.state === 'ending' ? 'ending' : s.status.replace(/_/g, ' ')}</Chip>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                          {s.state === 'canceled' ? `ended ${day(s.endedAt ?? s.canceledAt)}` : s.state === 'ending' ? `ends ${day(s.periodEnd)}` : s.periodEnd ? `period ended ${day(s.periodEnd)}` : '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          <OpenLink href={s.link} />
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {/* 30-day volume chart */}
      {data.sections.volume && <VolumeChart daily={data.daily} currency={cur} />}

      {/* Open disputes — surfaced loud since they need action */}
      {data.disputes.count > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertCircle className="h-4 w-4" />
            {data.disputes.count} open dispute{data.disputes.count === 1 ? '' : 's'}
          </p>
          <ul className="space-y-1 text-xs text-rose-700/90 dark:text-rose-300/90">
            {data.disputes.items.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3">
                <span>
                  {cents(d.amount, d.currency)} · {d.reason?.replace(/_/g, ' ')}
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-mono">{d.status}</span>
                  <OpenLink href={d.link} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recent payments */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Recent payments</h3>
        {!data.sections.charges ? (
          <p className="text-sm text-muted-foreground">Payments aren’t readable with this key ({needs('Charges (payments)')}).</p>
        ) : data.charges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No charges yet — the first trial converts 30 days after sign-up.</p>
        ) : (
          <Table
            head={
              <>
                <th className={thClass}>Date</th>
                <th className={thClass}>Customer / description</th>
                <th className={cn(thClass, 'text-right')}>Amount</th>
                <th className={thClass}>Status</th>
                <th className={cn(thClass, 'text-right')}>{canWrite ? 'Actions' : 'Stripe'}</th>
              </>
            }
          >
            {data.charges.map((c) => (
              <tr key={c.id}>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromUnix(c.created)}</td>
                <td className="px-3 py-2">
                  <Who name={c.customerName} email={c.customerEmail ?? c.description} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                  {cents(c.amount, c.currency)}
                  {c.refunded && <span className="ml-1 text-[10px] text-destructive">refunded</span>}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={c.status} />
                  {c.failureMessage && <p className="mt-0.5 max-w-[240px] truncate text-[11px] text-destructive" title={c.failureMessage}>{c.failureMessage}</p>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    {canWrite && c.paid && !c.refunded && c.status === 'succeeded' && (
                      <RowAction
                        icon={Undo2}
                        tone="danger"
                        disabled={action.isPending}
                        onClick={() => run(`Refund ${cents(c.amount, c.currency)} to ${c.customerEmail || 'this customer'}? This cannot be undone.`, { action: 'refund', chargeId: c.id })}
                      >
                        Refund
                      </RowAction>
                    )}
                    <OpenLink href={c.link} />
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      {/* Failed payments, last 30 days */}
      {data.failedPayments.length > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Failed payments · 30d
          </h3>
          <Table
            head={
              <>
                <th className={thClass}>Date</th>
                <th className={thClass}>Customer</th>
                <th className={cn(thClass, 'text-right')}>Amount</th>
                <th className={thClass}>Why</th>
                <th className={cn(thClass, 'text-right')}>Stripe</th>
              </>
            }
          >
            {data.failedPayments.map((c) => (
              <tr key={c.id}>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromUnix(c.created)}</td>
                <td className="px-3 py-2">
                  <Who name={c.customerName} email={c.customerEmail} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{cents(c.amount, c.currency)}</td>
                <td className="px-3 py-2 text-[12px] text-muted-foreground">{c.failureMessage ?? '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <OpenLink href={c.link} />
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {data.payouts.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground">Recent payouts</h3>
          <Table
            head={
              <>
                <th className={thClass}>Arrival</th>
                <th className={cn(thClass, 'text-right')}>Amount</th>
                <th className={thClass}>Status</th>
              </>
            }
          >
            {data.payouts.map((p) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fromUnix(p.arrivalDate)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{cents(p.amount, p.currency)}</td>
                <td className="px-3 py-2">
                  <StatusPill status={p.status} />
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {/* ---- Directory · recent customers */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
          <Users className="h-4 w-4 text-muted-foreground" />
          Recent customers
          {data.customerCount > 0 && <span className="font-normal text-muted-foreground">{data.customerCount} in all</span>}
        </h3>
        {!data.sections.customers ? (
          <p className="text-sm text-muted-foreground">Customers aren’t readable with this key ({needs('Customers')}).</p>
        ) : data.customers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No customers yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {data.customers.map((c) => (
              <div key={c.id} className="rounded-xl border border-border bg-card p-3">
                <p className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{c.name || c.email || c.id}</span>
                  {c.delinquent && <Chip tone="pink">unpaid</Chip>}
                </p>
                {c.email && c.name && <p className="truncate text-xs text-muted-foreground">{c.email}</p>}
                {/* Surface the cus_ id so nobody has to dig in Stripe for it. */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <code className="truncate font-mono text-[11px] text-muted-foreground">{c.id}</code>
                  <CopyButton value={c.id} label="Copy" />
                  <OpenLink href={c.link} />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">Added {fromUnix(c.created)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Billing · invoices */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Recent invoices
        </h3>
        {!data.sections.invoices ? (
          <p className="text-sm text-muted-foreground">Invoices aren’t readable with this key ({needs('Invoices')}).</p>
        ) : data.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet — Stripe makes one for each subscription charge.</p>
        ) : (
          <Table
            head={
              <>
                <th className={thClass}>Invoice</th>
                <th className={thClass}>Customer</th>
                <th className={cn(thClass, 'text-right')}>Amount</th>
                <th className={thClass}>Status</th>
                <th className={cn(thClass, 'text-right')}>{canWrite ? 'Actions' : 'Open'}</th>
              </>
            }
          >
            {data.invoices.map((inv) => {
              const who = inv.customerName || inv.customerEmail || 'this customer'
              return (
                <tr key={inv.id}>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="font-mono text-xs">{inv.number || inv.id.slice(-8)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{fromUnix(inv.created)}</span>
                  </td>
                  <td className="px-3 py-2">{inv.customerName || inv.customerEmail || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                    {cents(inv.amountDue, inv.currency)}
                    {inv.amountPaid > 0 && inv.amountPaid < inv.amountDue && <span className="ml-1 text-[10px] text-muted-foreground">{cents(inv.amountPaid, inv.currency)} paid</span>}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={inv.status} />
                    {inv.status === 'open' && inv.attemptCount > 0 && <p className="mt-0.5 text-[11px] text-destructive">{inv.attemptCount} failed attempt{inv.attemptCount === 1 ? '' : 's'}{inv.nextAttempt ? `, retry ${fromUnix(inv.nextAttempt)}` : ''}</p>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {canWrite && (inv.status === 'draft' || inv.status === 'open') && (
                        <RowAction icon={Send} disabled={action.isPending} onClick={() => run(`Email invoice ${inv.number || ''} (${cents(inv.amountDue, inv.currency)}) to ${who}?`, { action: 'sendInvoice', invoiceId: inv.id })}>
                          {inv.status === 'draft' ? 'Send' : 'Resend'}
                        </RowAction>
                      )}
                      {canWrite && inv.status === 'open' && (
                        <RowAction icon={Ban} tone="danger" disabled={action.isPending} onClick={() => run(`Void invoice ${inv.number || ''} for ${who}? It can't be collected after this.`, { action: 'voidInvoice', invoiceId: inv.id })}>
                          Void
                        </RowAction>
                      )}
                      {inv.hostedUrl && <OpenLink href={inv.hostedUrl} label="Invoice" />}
                      <OpenLink href={inv.link} label="Stripe" />
                    </div>
                  </td>
                </tr>
              )
            })}
          </Table>
        )}
      </div>

      {/* Open invoices: unpaid, with the past-due ones flagged */}
      {data.openInvoices.length > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <AlertTriangle className="h-4 w-4 text-warning" />
            Open invoices · {data.openInvoices.length}
            <span className="font-normal text-muted-foreground">
              {data.openInvoices.filter((i) => i.pastDue).length} past due · {cents(data.openInvoices.reduce((s, i) => s + i.amountDue, 0), cur)} outstanding
            </span>
          </h3>
          <Table
            head={
              <>
                <th className={thClass}>Invoice</th>
                <th className={thClass}>Customer</th>
                <th className={cn(thClass, 'text-right')}>Due</th>
                <th className={thClass}>Due date</th>
                <th className={cn(thClass, 'text-right')}>Open</th>
              </>
            }
          >
            {data.openInvoices.map((inv) => (
              <tr key={inv.id}>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{inv.number || inv.id.slice(-8)}</td>
                <td className="px-3 py-2">{inv.customerName || inv.customerEmail || '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{cents(inv.amountDue, inv.currency)}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className={cn(inv.pastDue ? 'text-destructive' : 'text-muted-foreground')}>
                    {inv.dueDate ? fromUnix(inv.dueDate) : inv.nextAttempt ? `retry ${fromUnix(inv.nextAttempt)}` : '—'}
                    {inv.pastDue ? ' · past due' : ''}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    {inv.hostedUrl && <OpenLink href={inv.hostedUrl} label="Invoice" />}
                    <OpenLink href={inv.link} label="Stripe" />
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  New-invoice form (only with a full secret key in the Vault)               */
/* -------------------------------------------------------------------------- */

function NewInvoiceForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (payload: { email: string; name: string; amountCents: number; description: string; daysUntilDue: number }, sendNow: boolean) => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [daysUntilDue, setDaysUntilDue] = useState('7')

  const amountCents = Math.round(parseFloat(amount || '0') * 100)
  const valid = email.trim().length > 3 && amountCents > 0

  const submit = (sendNow: boolean) =>
    onSubmit({ email: email.trim(), name: name.trim(), amountCents, description: description.trim(), daysUntilDue: Number(daysUntilDue) || 7 }, sendNow)

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">New invoice</h3>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Customer email *</label>
          <input className={fieldClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="billing@client.com" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Customer name</label>
          <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Only used if they're new to Stripe" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Amount (USD) *</label>
          <input className={fieldClass} type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1500.00" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Due in (days)</label>
          <input className={fieldClass} type="number" min="1" value={daysUntilDue} onChange={(e) => setDaysUntilDue(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
          <input className={fieldClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Website build — one-off" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => submit(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
        <span className="text-xs text-muted-foreground">“Create &amp; email” sends a real invoice email to the customer.</span>
      </div>
    </div>
  )
}
