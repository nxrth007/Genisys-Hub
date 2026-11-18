'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight, CreditCard, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Chip } from '@/components/ui/chip'
import { billingLabel, shortDate, stripeLink, type BillingState, type ClientBilling } from '@/lib/stripe-billing-plan'
import type { ClientSubscriptionsView } from '@/lib/stripe-billing'

/**
 * Every client's Stripe subscription on the Clients page: a chip on each row
 * (BillingChip), a section in the client's detail (BillingSection), and one
 * panel with all of them (SubscriptionsPanel) — filter by where they stand,
 * the roster clients with no subscription, and the Stripe customers that match
 * no client, so nobody is lost. All three share one read of
 * /api/clients/subscriptions. Read-only: the Stripe Dashboard is a link away
 * for anything that changes money.
 */

export const SUBSCRIPTIONS_KEY = ['clients-subscriptions']

export function useClientSubscriptions() {
  return useQuery<ClientSubscriptionsView>({
    queryKey: SUBSCRIPTIONS_KEY,
    queryFn: async () => {
      const res = await fetch('/api/clients/subscriptions')
      if (!res.ok) throw new Error(`Failed to load subscriptions (${res.status})`)
      return res.json()
    },
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
    retry: 1,
  })
}

const fullDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const day = (iso: string | null | undefined) => (iso ? fullDate.format(new Date(iso)) : '—')

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

const linkOpts = (v: ClientSubscriptionsView | undefined) => ({ accountId: v?.account.id ?? null, livemode: v?.key?.mode !== 'test' })

/* -------------------------------------------------------------------------- */
/*  The chip on a client's row                                                */
/* -------------------------------------------------------------------------- */

export function BillingChip({ billing, loading, detail = true }: { billing: ClientBilling | null | undefined; loading?: boolean; detail?: boolean }) {
  if (!billing && loading) return <span className="font-mono text-[11px] text-muted-foreground/50">…</span>
  const label = billingLabel(billing)
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Chip tone={label.tone}>{label.text}</Chip>
      {detail && label.detail && <span className="font-mono text-[11px] text-muted-foreground">{label.detail}</span>}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/*  The section in a client's detail                                          */
/* -------------------------------------------------------------------------- */

export function BillingSection({ clientId, emails }: { clientId: string; emails: Array<string | null | undefined> }) {
  const q = useClientSubscriptions()
  const v = q.data
  const b = v?.byClient[clientId]
  const label = billingLabel(b)
  const s = b?.subscription ?? null
  const customer = b?.customers[0] ?? null
  const looked = [...new Set(emails.map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean))]

  return (
    <section className="rounded-xl border border-border-soft bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="eyebrow text-muted-foreground">Billing (Stripe)</p>
        {v && <p className="font-mono text-[11px] text-muted-foreground/70">{v.error ? 'Stripe unavailable' : `as of ${ago(v.asOf)}`}</p>}
      </div>
      {q.isLoading ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking Stripe…
        </p>
      ) : q.isError ? (
        <p className="text-sm text-destructive">Couldn’t load subscriptions.</p>
      ) : v?.error && !b?.customers.length ? (
        <p className="text-sm text-warning">{v.error}</p>
      ) : !b || b.state === 'none' ? (
        <p className="text-sm text-muted-foreground">
          <Chip tone="muted">Not in Stripe</Chip>
          <span className="ml-2">
            {looked.length
              ? `No Stripe customer with ${looked.join(' or ')}. If they signed up under another email, put it in the contact email and this will match.`
              : 'No email on file to look them up by — add the contact email.'}
          </span>
        </p>
      ) : (
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="eyebrow text-muted-foreground/80">Status</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Chip tone={label.tone}>{label.text}</Chip>
              {label.detail && <span className="text-muted-foreground">{label.detail}</span>}
              {s && s.status !== 'active' && s.status !== 'trialing' && <span className="font-mono text-[11px] text-muted-foreground/70">Stripe: {s.status.replace(/_/g, ' ')}</span>}
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-muted-foreground/80">Plan</dt>
            <dd className="mt-1 text-sm">{s ? [s.plan, s.price].filter(Boolean).join(' · ') || '—' : '—'}</dd>
          </div>
          <div>
            <dt className="eyebrow text-muted-foreground/80">{s?.status === 'trialing' ? 'Trial ends · first charge' : s?.cancelAtPeriodEnd ? 'Ends' : 'Next charge'}</dt>
            <dd className="mt-1 text-sm">
              {s ? day(s.status === 'trialing' ? (s.trialEnd ?? s.periodEnd) : s.periodEnd) : '—'}
              {s && !s.cancelAtPeriodEnd && s.price && (s.status === 'trialing' || s.status === 'active') && <span className="ml-1.5 text-muted-foreground">({s.price})</span>}
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-muted-foreground/80">Started</dt>
            <dd className="mt-1 text-sm">{day(s?.created)}</dd>
          </div>
          <div>
            <dt className="eyebrow text-muted-foreground/80">Stripe customer</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {customer ? (
                <>
                  <span className="font-mono text-[12px]">{customer.id}</span>
                  <a href={stripeLink('customer', customer.id, linkOpts(v))} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline">
                    <ExternalLink className="h-3 w-3" /> Open in Stripe
                  </a>
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-muted-foreground/80">Matched by</dt>
            <dd className="mt-1 text-sm text-muted-foreground">
              {b.matchedBy === 'email' ? `email (${customer?.email ?? '—'})` : b.matchedBy === 'name' ? `name (${customer?.name ?? '—'}) — the emails differ` : '—'}
            </dd>
          </div>
          {b.subscriptions.length > 1 && (
            <div className="sm:col-span-2 lg:col-span-3">
              <dt className="eyebrow text-muted-foreground/80">All subscriptions</dt>
              <dd className="mt-1 flex flex-col gap-1 text-sm">
                {b.subscriptions.map((x) => (
                  <span key={x.id} className="flex flex-wrap items-center gap-2">
                    <Chip tone={billingLabel({ state: stateWord(x.status, x.cancelAtPeriodEnd), subscription: x }).tone}>{x.status.replace(/_/g, ' ')}</Chip>
                    <span>{[x.plan, x.price].filter(Boolean).join(' · ') || x.id}</span>
                    <span className="text-muted-foreground">started {day(x.created)}{x.endedAt ? `, ended ${day(x.endedAt)}` : ''}</span>
                    <a href={stripeLink('subscription', x.id, linkOpts(v))} target="_blank" rel="noreferrer" className="text-[12px] text-primary hover:underline">
                      Stripe
                    </a>
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  )
}

/** The state a bare Stripe status reads as (for the list of older subscriptions). */
function stateWord(status: string, cancelAtPeriodEnd: boolean): BillingState {
  if (['past_due', 'unpaid', 'incomplete', 'paused'].includes(status)) return 'problem'
  if (status === 'active' || status === 'trialing') return cancelAtPeriodEnd ? 'ending' : status
  return 'canceled'
}

/* -------------------------------------------------------------------------- */
/*  The panel: every subscription, filters, who's missing                     */
/* -------------------------------------------------------------------------- */

type View = 'all' | 'problem' | 'active' | 'trialing' | 'ending' | 'canceled' | 'without' | 'unmatched'

const OPEN_KEY = 'clients.subscriptions.open'

export function SubscriptionsPanel({ onOpenClient }: { onOpenClient: (clientId: string) => void }) {
  const qc = useQueryClient()
  const q = useClientSubscriptions()
  const [open, setOpen] = useState(true)
  const [view, setView] = useState<View>('all')
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(OPEN_KEY)
      if (saved === '0') setOpen(false)
    } catch {
      // private window or storage blocked: stay open
    }
  }, [])
  const toggle = () => {
    setOpen((o) => {
      try {
        window.localStorage.setItem(OPEN_KEY, o ? '0' : '1')
      } catch {
        // nothing to remember into
      }
      return !o
    })
  }
  const refresh = useMutation({
    mutationFn: async (): Promise<ClientSubscriptionsView> => {
      const res = await fetch('/api/clients/subscriptions?refresh=1')
      if (!res.ok) throw new Error(`Refresh failed (${res.status})`)
      return res.json()
    },
    onSuccess: (data) => qc.setQueryData(SUBSCRIPTIONS_KEY, data),
  })

  const v = q.data
  const rows = useMemo(() => {
    if (!v) return []
    if (view === 'all') return v.rows.filter((r) => r.state !== 'canceled' || v.rows.length <= 25)
    return v.rows.filter((r) => r.state === view)
  }, [v, view])

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border-soft bg-surface px-4 py-2.5 text-[12.5px] text-muted-foreground">
        <CreditCard className="h-3.5 w-3.5" /> Subscriptions (Stripe) <Loader2 className="h-3 w-3 animate-spin" />
      </div>
    )
  }
  if (q.isError || !v) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-warning">
        <AlertTriangle className="h-3.5 w-3.5" /> Subscriptions (Stripe): couldn’t load — refresh the page to try again.
      </div>
    )
  }

  const st = v.summary.states
  const running = st.active + st.trialing + st.ending
  const trouble = st.problem > 0 || v.summary.unmatched > 0 || !!v.error
  const opts = linkOpts(v)
  const filters: Array<{ key: View; label: string; count: number; tone?: 'pink' | 'amber' }> = [
    { key: 'all', label: 'All', count: v.summary.total },
    { key: 'problem', label: 'Payment problems', count: st.problem, tone: 'pink' },
    { key: 'active', label: 'Active', count: st.active },
    { key: 'trialing', label: 'Trials', count: st.trialing },
    { key: 'ending', label: 'Ending', count: st.ending, tone: 'amber' },
    { key: 'canceled', label: 'Canceled', count: st.canceled },
    { key: 'without', label: 'Not in Stripe', count: v.summary.clientsWithout },
    { key: 'unmatched', label: 'In Stripe, no client', count: v.summary.unmatched, tone: v.summary.unmatched ? 'amber' : undefined },
  ]

  return (
    <div className={cn('flex flex-col rounded-xl border text-[12.5px]', trouble ? 'border-warning/40 bg-warning/5' : 'border-border-soft bg-surface')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
        <button type="button" onClick={toggle} className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
          {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          <CreditCard className="h-3.5 w-3.5" /> Subscriptions (Stripe)
        </button>
        {v.error ? (
          <span className="inline-flex items-center gap-1.5 text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {v.error}
          </span>
        ) : (
          <span className="text-muted-foreground">
            <b className="font-medium text-foreground/85">{running}</b> running · {st.active} active · {st.trialing} on trial
            {st.ending ? ` · ${st.ending} ending` : ''}
            {st.problem ? <span className="text-destructive"> · {st.problem} with a payment problem</span> : ''}
            {' · '}
            {v.summary.clientsWithout} client{v.summary.clientsWithout === 1 ? '' : 's'} not in Stripe
            {v.summary.unmatched ? <span className="text-warning"> · {v.summary.unmatched} in Stripe with no client</span> : ''}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-3">
          {v.account.sameAsSignup === false && (
            <span className="inline-flex items-center gap-1 text-warning">
              <AlertTriangle className="h-3.5 w-3.5" /> not the signup’s Stripe account
            </span>
          )}
          <span className="font-mono text-[11px] text-muted-foreground/70">{v.key ? `${v.key.name} · ` : ''}{ago(v.asOf)}</span>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground/85 transition hover:bg-muted disabled:opacity-50"
          >
            {refresh.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Check Stripe now
          </button>
          <a
            href={v.account.id ? `https://dashboard.stripe.com/${v.account.id}/subscriptions` : 'https://dashboard.stripe.com/subscriptions'}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" /> Stripe
          </a>
        </span>
      </div>
      {v.denied.length > 0 && (
        <p className="border-t border-border-soft px-4 py-1.5 text-[12px] text-muted-foreground">
          The “{v.key?.name}” key may not read {v.denied.map((d) => d.what).join(', ')} — fine for this list; the Payments page says what a fuller key needs.
        </p>
      )}
      {open && (
        <div className="flex flex-col gap-3 border-t border-border-soft px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setView(f.key)}
                className={cn(
                  'rounded-lg border px-2.5 py-1 text-[12px] font-medium transition',
                  view === f.key ? 'border-foreground/30 bg-muted text-foreground' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  f.count > 0 && f.tone === 'pink' && view !== f.key && 'border-destructive/40 text-destructive',
                  f.count > 0 && f.tone === 'amber' && view !== f.key && 'border-warning/40 text-warning',
                )}
              >
                {f.label}
                <span className="ml-1.5 tabular-nums opacity-70">{f.count}</span>
              </button>
            ))}
          </div>

          {view === 'without' ? (
            v.clientsWithout.length === 0 ? (
              <Empty>Every roster client has a Stripe subscription.</Empty>
            ) : (
              <>
                <p className="text-[12px] text-muted-foreground">
                  Roster clients (not archived, churned or denied) with no Stripe customer under any email the Hub has for them. Clients from before the Stripe sign-up (Whop, GHL-era) land here too — it means “not billed through Stripe”, not “not paying”.
                </p>
                <Table head={['Client', 'Status', 'Email we looked for', 'Since']}>
                  {v.clientsWithout.map((c) => (
                    <tr key={c.id} onClick={() => onOpenClient(c.id)} className="cursor-pointer transition hover:bg-surface-muted">
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2">
                        <Chip>{c.lifecycle}</Chip>
                      </td>
                      <td className="px-3 py-2 font-mono text-[12px] text-muted-foreground">{c.email ?? 'no email on file'}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-muted-foreground">{day(c.createdAt)}</td>
                    </tr>
                  ))}
                </Table>
              </>
            )
          ) : view === 'unmatched' ? (
            v.unmatched.length === 0 ? (
              <Empty>Every Stripe customer belongs to a client.</Empty>
            ) : (
              <>
                <p className="text-[12px] text-muted-foreground">
                  Stripe customers whose email and name match no client. A sign-up whose onboarding form hasn’t come in yet shows here until it does; so does a client who signed up under a different email — set that email as the client’s contact email and they’ll match.
                </p>
                <Table head={['Stripe customer', 'Subscription', 'Plan', 'Next', 'Looks like', 'Stripe']}>
                  {v.unmatched.map((u) => {
                    const label = billingLabel(u)
                    const s = u.subscription
                    return (
                      <tr key={u.customer.id}>
                        <td className="px-3 py-2">
                          <p className="font-medium">{u.customer.name ?? u.customer.email ?? u.customer.id}</p>
                          {u.customer.name && u.customer.email && <p className="font-mono text-[11.5px] text-muted-foreground">{u.customer.email}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <BillingChip billing={{ clientId: '', state: u.state, subscription: s, subscriptions: u.subscriptions, customers: [u.customer], matchedBy: null }} />
                          {u.state === 'none' && <span className="block font-mono text-[11px] text-muted-foreground">customer only</span>}
                        </td>
                        <td className="px-3 py-2">{s ? [s.plan, s.price].filter(Boolean).join(' · ') || '—' : '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-muted-foreground">{s ? label.detail ?? day(s.periodEnd) : day(u.customer.created)}</td>
                        <td className="px-3 py-2">
                          {u.suggestion ? (
                            <button type="button" onClick={() => onOpenClient(u.suggestion!.clientId)} className="text-primary underline-offset-2 hover:underline">
                              {u.suggestion.name}
                            </button>
                          ) : (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <a href={stripeLink('customer', u.customer.id, opts)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                            <ExternalLink className="h-3 w-3" /> Open
                          </a>
                        </td>
                      </tr>
                    )
                  })}
                </Table>
              </>
            )
          ) : rows.length === 0 ? (
            <Empty>{v.summary.total === 0 ? 'No subscriptions in Stripe yet. The first sign-up at leadgenisys.com will show here.' : 'Nothing in this group.'}</Empty>
          ) : (
            <>
              <Table head={['Client', 'Plan', 'Status', 'Next charge / ends', 'Started', 'Stripe']}>
                {rows.map((r) => {
                  const label = billingLabel({ state: r.state, subscription: r })
                  const when = r.state === 'trialing' ? (r.trialEnd ?? r.periodEnd) : r.state === 'canceled' ? (r.endedAt ?? r.canceledAt) : r.periodEnd
                  return (
                    <tr
                      key={r.id}
                      onClick={r.client ? () => onOpenClient(r.client!.id) : undefined}
                      className={cn('transition', r.client && 'cursor-pointer hover:bg-surface-muted')}
                    >
                      <td className="px-3 py-2">
                        {r.client ? (
                          <>
                            <p className="font-medium">
                              {r.client.name}
                              {r.client.archived && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">archived</span>}
                            </p>
                            {r.email && <p className="font-mono text-[11.5px] text-muted-foreground">{r.email}</p>}
                          </>
                        ) : (
                          <>
                            <p className="font-medium text-warning">{r.name ?? r.email ?? r.customerId ?? '—'} <span className="font-mono text-[11px]">no client</span></p>
                            {r.name && r.email && <p className="font-mono text-[11.5px] text-muted-foreground">{r.email}</p>}
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{[r.plan, r.price].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="px-3 py-2">
                        <Chip tone={label.tone}>{r.status.replace(/_/g, ' ')}</Chip>
                        {r.cancelAtPeriodEnd && r.state !== 'canceled' && <span className="ml-1.5 font-mono text-[11px] text-warning">cancels at period end</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-muted-foreground">
                        {when ? `${r.state === 'canceled' ? 'ended ' : r.state === 'trialing' ? 'first charge ' : r.cancelAtPeriodEnd ? 'ends ' : 'renews '}${shortDate(when)}` : '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-muted-foreground">{day(r.created)}</td>
                      <td className="whitespace-nowrap px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <a href={stripeLink('subscription', r.id, opts)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                          <ExternalLink className="h-3 w-3" /> Open
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </Table>
              {view === 'all' && v.rows.length > 25 && st.canceled > 0 && (
                <p className="text-[12px] text-muted-foreground">Canceled subscriptions are under the “Canceled” filter.</p>
              )}
              {v.truncated && <p className="text-[12px] text-warning">Stripe’s list was cut at 1,000 — the oldest subscriptions aren’t shown.</p>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-[13px]">
        <thead className="eyebrow bg-surface-muted text-left text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-soft">{children}</tbody>
      </table>
    </div>
  )
}
