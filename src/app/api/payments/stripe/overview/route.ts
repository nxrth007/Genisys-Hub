import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { firstSecret, STRIPE_KEY_ENTRIES } from '@/lib/stripe-onboarding'
import {
  billingSnapshot,
  LEGACY_STRIPE_KEY_ENTRY,
  listItems,
  PAYMENTS_KEY_PERMISSIONS,
  paymentsStripeKey,
  STRIPE_PAYMENTS_KEY_ENTRY,
  stripeRead,
} from '@/lib/stripe-billing'
import { stateOf, stripeLink, summarize, type BillingSubscription, type StripeDenied } from '@/lib/stripe-billing-plan'

/**
 * GET /api/payments/stripe/overview
 *
 * Server-side proxy for the Stripe dashboard on the Payments page. Reads the
 * signup site's Stripe account — the Vault's "Stripe Official Payments Key",
 * else the sign-up gate's "Stripe Official Restricted" — and calls Stripe's
 * REST API directly (no SDK). The key never reaches the browser. Gated to the
 * Payments email allowlist. Read-only: GETs only. ?refresh=1 re-reads the
 * subscriptions instead of using the two-minute snapshot.
 *
 * Pulls a dashboard's worth: balance, 30-day volume (gross / net / fees + a
 * daily series), every subscription (counts by status, MRR, renewals and first
 * charges due in 30 days, payment problems, cancellations), recent and failed
 * payments, open invoices, payouts, open disputes, recent customers. A
 * restricted key that may not read a section says so (`denied`) instead of
 * failing the page, so the subscriptions show even before the fuller key exists.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const key = await paymentsStripeKey()
  if (!key) {
    return NextResponse.json(
      { error: 'no-key', message: `No "${STRIPE_PAYMENTS_KEY_ENTRY}" (or "${STRIPE_KEY_ENTRIES[0]}") in the Vault.` },
      { status: 400 },
    )
  }
  const refresh = req.nextUrl.searchParams.get('refresh') === '1'

  const now = Math.floor(Date.now() / 1000)
  const since = now - 30 * 24 * 3600
  const gte = encodeURIComponent('created[gte]')

  const [snapshot, balance, charges, payouts, txns, disputes, invoices, legacyKey] = await Promise.all([
    billingSnapshot({ refresh }),
    stripeRead(key.value, '/balance'),
    stripeRead(key.value, '/charges?limit=100'),
    stripeRead(key.value, '/payouts?limit=10'),
    stripeRead(key.value, `/balance_transactions?limit=100&${gte}=${since}`),
    stripeRead(key.value, '/disputes?limit=5'),
    stripeRead(key.value, '/invoices?limit=100'),
    firstSecret([LEGACY_STRIPE_KEY_ENTRY]),
  ])

  // Nothing at all could be read: the key is wrong, or Stripe is down.
  if (snapshot.error && !balance.ok && !charges.ok && !invoices.ok) {
    return NextResponse.json(
      {
        error: 'stripe-error',
        status: balance.status,
        message: `${balance.error ?? snapshot.error} — check the "${key.name}" in the Vault.`,
      },
      { status: 502 },
    )
  }

  const denied: StripeDenied[] = []
  const errors: string[] = []
  for (const d of snapshot.denied) denied.push(d)
  for (const r of [balance, charges, payouts, txns, disputes, invoices]) {
    if (r.ok) continue
    if (r.denied) denied.push(r.denied)
    else if (r.error) errors.push(r.error)
  }
  const seen = new Set<string>()
  const deniedUnique = denied.filter((d) => (seen.has(d.what) ? false : (seen.add(d.what), true)))
  if (snapshot.error) errors.push(snapshot.error)

  const bal = balance.ok && isObj(balance.data) ? (balance.data as { available?: Array<{ amount: number; currency: string }>; pending?: Array<{ amount: number; currency: string }> }) : {}
  const chargeData = listItems(charges)
  const payoutData = listItems(payouts)
  const txnData = listItems(txns)
  const txnHasMore = isObj(txns.data) && txns.data.has_more === true
  const disputeData = listItems(disputes)
  const invoiceData = listItems(invoices)

  const currency = bal.available?.[0]?.currency ?? snapshot.subscriptions[0]?.currency ?? 'usd'
  const accountId = snapshot.account.id
  const livemode = key.mode !== 'test'
  const link = (kind: Parameters<typeof stripeLink>[0], id: string) => stripeLink(kind, id, { accountId, livemode })

  // ---- 30-day volume from balance transactions (charges/payments only)
  let grossVolume = 0
  let netVolume = 0
  let feeVolume = 0
  let paymentCount = 0
  const dailyMap = new Map<string, number>()
  for (const t of txnData) {
    const type = String(t.type ?? '')
    if (type !== 'charge' && type !== 'payment') continue
    const amount = Number(t.amount ?? 0)
    grossVolume += amount
    netVolume += Number(t.net ?? 0)
    feeVolume += Number(t.fee ?? 0)
    paymentCount++
    const day = new Date(Number(t.created ?? 0) * 1000).toISOString().slice(0, 10)
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + amount)
  }
  // Fill a continuous 30-day series (oldest → newest) so the chart is stable.
  const daily: Array<{ date: string; gross: number }> = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date((now - i * 24 * 3600) * 1000).toISOString().slice(0, 10)
    daily.push({ date: d, gross: dailyMap.get(d) ?? 0 })
  }

  // ---- Subscriptions: every status, MRR, what's due, what's wrong
  const summary = summarize(snapshot.subscriptions)
  const subRow = (s: BillingSubscription) => ({
    id: s.id,
    customerId: s.customerId,
    who: s.name ?? s.email ?? s.customerId ?? s.id,
    email: s.email,
    plan: s.plan,
    price: s.price,
    status: s.status,
    state: stateOf(s),
    amountCents: s.amountCents,
    currency: s.currency,
    trialEnd: s.trialEnd,
    periodEnd: s.periodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    canceledAt: s.canceledAt,
    endedAt: s.endedAt,
    created: s.created,
    link: link('subscription', s.id),
    customerLink: s.customerId ? link('customer', s.customerId) : null,
  })

  // ---- In-transit to bank (payouts still moving)
  const inTransit = payoutData.filter((p) => ['pending', 'in_transit'].includes(String(p.status))).reduce((s, p) => s + Number(p.amount ?? 0), 0)

  const customerEmailOf = (c: Obj) => (isObj(c.billing_details) ? str(c.billing_details.email) : null) ?? str(c.receipt_email) ?? null
  const customerNameOf = (c: Obj) => (isObj(c.billing_details) ? str(c.billing_details.name) : null)
  const failureOf = (c: Obj) => str(c.failure_message) ?? (isObj(c.outcome) ? str(c.outcome.seller_message) : null)
  const chargeRow = (c: Obj) => ({
    id: String(c.id),
    amount: num(c.amount) ?? 0,
    currency: str(c.currency) ?? currency,
    status: str(c.status) ?? 'unknown',
    paid: c.paid === true,
    refunded: c.refunded === true,
    created: num(c.created) ?? 0,
    description: str(c.description),
    customerEmail: customerEmailOf(c),
    customerName: customerNameOf(c),
    customerId: typeof c.customer === 'string' ? c.customer : null,
    failureMessage: failureOf(c),
    link: link('payment', typeof c.payment_intent === 'string' ? c.payment_intent : String(c.id)),
  })
  const invoiceRow = (i: Obj) => ({
    id: String(i.id),
    number: str(i.number),
    customerName: str(i.customer_name) ?? str(i.customer_email),
    customerEmail: str(i.customer_email),
    customerId: typeof i.customer === 'string' ? i.customer : null,
    subscriptionId: typeof i.subscription === 'string' ? i.subscription : isObj(i.subscription) ? str(i.subscription.id) : null,
    amountDue: num(i.amount_due) ?? 0,
    amountPaid: num(i.amount_paid) ?? 0,
    currency: str(i.currency) ?? currency,
    status: str(i.status) ?? 'unknown', // draft | open | paid | void | uncollectible
    created: num(i.created) ?? 0,
    dueDate: num(i.due_date),
    attemptCount: num(i.attempt_count) ?? 0,
    nextAttempt: num(i.next_payment_attempt),
    hostedUrl: str(i.hosted_invoice_url),
    pdfUrl: str(i.invoice_pdf),
    link: link('invoice', String(i.id)),
  })

  const failedPayments = chargeData.filter((c) => str(c.status) === 'failed' && (num(c.created) ?? 0) >= since).map(chargeRow)
  const openInvoices = invoiceData
    .filter((i) => str(i.status) === 'open')
    .map(invoiceRow)
    .map((i) => ({ ...i, pastDue: (i.dueDate !== null && i.dueDate < now) || i.attemptCount > 0 }))
    .sort((a, b) => (a.dueDate ?? a.created) - (b.dueDate ?? b.created))

  const recentCustomers = [...snapshot.customers]
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
    .slice(0, 8)
    .map((c) => ({ id: c.id, name: c.name, email: c.email, created: c.created ? Math.floor(new Date(c.created).getTime() / 1000) : 0, delinquent: c.delinquent, link: link('customer', c.id) }))

  return NextResponse.json(
    {
      ok: true,
      asOf: snapshot.at,
      account: {
        name: snapshot.account.name ?? (snapshot.account.marker ? `Stripe account …${snapshot.account.marker}` : 'Stripe account'),
        id: accountId,
        marker: snapshot.account.marker,
        sameAsSignup: snapshot.account.sameAsSignup,
        currency,
        dashboardUrl: accountId ? `https://dashboard.stripe.com/${accountId}/dashboard` : 'https://dashboard.stripe.com/',
      },
      key: { entry: key.name, kind: key.kind, mode: key.mode, readOnly: key.readOnly },
      // Which sections this key may read; the UI says "needs permission" instead of showing zeros.
      sections: {
        account: !!accountId,
        balance: balance.ok,
        volume: txns.ok,
        charges: charges.ok,
        payouts: payouts.ok,
        disputes: disputes.ok,
        invoices: invoices.ok,
        subscriptions: !snapshot.error,
        customers: snapshot.customers.length > 0 || !snapshot.denied.some((d) => d.path.startsWith('/customers')),
      },
      denied: deniedUnique,
      errors,
      setup: {
        entry: STRIPE_PAYMENTS_KEY_ENTRY,
        permissions: PAYMENTS_KEY_PERMISSIONS,
        legacyKeyPresent: !!legacyKey,
        legacyEntry: LEGACY_STRIPE_KEY_ENTRY,
      },
      // amounts in smallest unit (cents); formatted client-side
      available: bal.available ?? [],
      pending: bal.pending ?? [],
      inTransit,
      volume30d: {
        gross: grossVolume,
        net: netVolume,
        fees: feeVolume,
        count: paymentCount,
        truncated: txnHasMore, // >100 txns in 30d — figures are a partial sample
        currency,
      },
      daily,
      subscriptions: {
        total: summary.total,
        counts: summary.counts,
        states: summary.states,
        activeCount: summary.counts.active ?? 0,
        trialingCount: summary.counts.trialing ?? 0,
        mrr: summary.mrrCents,
        trialMrr: summary.trialMonthlyCents,
        upcoming: summary.upcoming.map((u) => ({ ...subRow(u.subscription), at: u.at, kind: u.kind, amountCents: u.amountCents })),
        problems: summary.problems.map(subRow),
        ending: summary.ending.map(subRow),
        canceledRecently: summary.canceledRecently.map(subRow),
        truncated: snapshot.truncated,
      },
      disputes: {
        count: disputeData.length,
        items: disputeData.map((d) => ({
          id: d.id,
          amount: d.amount,
          currency: d.currency,
          status: d.status,
          reason: d.reason,
          created: d.created,
          link: link('dispute', String(d.id)),
        })),
      },
      charges: chargeData.slice(0, 10).map(chargeRow),
      failedPayments,
      payouts: payoutData.slice(0, 6).map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        arrivalDate: p.arrival_date,
        created: p.created,
        link: link('payout', String(p.id)),
      })),
      customers: recentCustomers,
      customerCount: snapshot.customers.length,
      invoices: invoiceData.slice(0, 10).map(invoiceRow),
      openInvoices,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
