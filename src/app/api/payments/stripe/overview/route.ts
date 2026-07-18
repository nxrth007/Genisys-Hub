import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/payments/stripe/overview
 *
 * Server-side proxy for the Stripe dashboard. Reads the "Stripe API Key"
 * from the Vault and calls the Stripe REST API directly (no SDK). The
 * key never reaches the client. Gated to the Payments email allowlist.
 *
 * Pulls a real dashboard's worth of data: balance, 30-day volume (gross
 * / net / fees + a daily series), active subscriptions + MRR, recent
 * payments, payouts (incl. in-transit to bank), and open disputes.
 */

const STRIPE_BASE = 'https://api.stripe.com/v1'

async function stripeGet(
  path: string,
  key: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

/** Normalize a recurring price to a MONTHLY amount (in the price's unit). */
function toMonthly(
  unitAmount: number,
  interval: string,
  intervalCount: number,
): number {
  const per = unitAmount / (intervalCount || 1)
  switch (interval) {
    case 'year':
      return per / 12
    case 'week':
      return per * 4.3333
    case 'day':
      return per * 30
    default:
      return per // month
  }
}

export async function GET() {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let key: string
  try {
    key = await getSecretByName('Stripe API Key')
  } catch {
    return NextResponse.json(
      { error: 'no-key', message: 'No "Stripe API Key" found in the Vault.' },
      { status: 400 },
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const since = now - 30 * 24 * 3600
  const gte = encodeURIComponent('created[gte]')

  const [balance, charges, payouts, account, txns, subs, disputes] =
    await Promise.all([
      stripeGet('/balance', key),
      stripeGet('/charges?limit=10', key),
      stripeGet('/payouts?limit=10', key),
      stripeGet('/account', key),
      stripeGet(`/balance_transactions?limit=100&${gte}=${since}`, key),
      stripeGet('/subscriptions?status=active&limit=100', key),
      stripeGet('/disputes?limit=5', key),
    ])

  if (!balance.ok) {
    const d = balance.data as { error?: { message?: string } }
    return NextResponse.json(
      {
        error: 'stripe-error',
        status: balance.status,
        message:
          d?.error?.message ||
          `Stripe returned ${balance.status} — check the "Stripe API Key" in the Vault.`,
      },
      { status: 502 },
    )
  }

  const bal = balance.data as {
    available?: Array<{ amount: number; currency: string }>
    pending?: Array<{ amount: number; currency: string }>
  }
  const chargeData =
    ((charges.data as { data?: unknown[] })?.data as Array<
      Record<string, unknown>
    >) ?? []
  const payoutData =
    ((payouts.data as { data?: unknown[] })?.data as Array<
      Record<string, unknown>
    >) ?? []
  const txnData =
    ((txns.data as { data?: unknown[]; has_more?: boolean })?.data as Array<
      Record<string, unknown>
    >) ?? []
  const txnHasMore = (txns.data as { has_more?: boolean })?.has_more ?? false
  const subData =
    ((subs.data as { data?: unknown[] })?.data as Array<
      Record<string, unknown>
    >) ?? []
  const disputeData =
    ((disputes.data as { data?: unknown[] })?.data as Array<
      Record<string, unknown>
    >) ?? []
  const acct = account.data as {
    business_profile?: { name?: string | null }
    email?: string | null
    default_currency?: string | null
    settings?: { dashboard?: { display_name?: string | null } }
  }

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
    const day = new Date(Number(t.created ?? 0) * 1000)
      .toISOString()
      .slice(0, 10)
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + amount)
  }
  // Fill a continuous 30-day series (oldest → newest) so the chart is stable.
  const daily: Array<{ date: string; gross: number }> = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date((now - i * 24 * 3600) * 1000).toISOString().slice(0, 10)
    daily.push({ date: d, gross: dailyMap.get(d) ?? 0 })
  }

  // ---- Active subscriptions + MRR
  let mrr = 0
  for (const s of subData) {
    const items =
      ((s.items as { data?: unknown[] })?.data as Array<
        Record<string, unknown>
      >) ?? []
    for (const it of items) {
      const price = it.price as
        | {
            unit_amount?: number
            recurring?: { interval?: string; interval_count?: number }
          }
        | undefined
      if (!price?.unit_amount || !price.recurring?.interval) continue
      const qty = Number(it.quantity ?? 1)
      mrr += toMonthly(
        price.unit_amount * qty,
        price.recurring.interval,
        price.recurring.interval_count ?? 1,
      )
    }
  }

  // ---- In-transit to bank (payouts still moving)
  const inTransit = payoutData
    .filter((p) => ['pending', 'in_transit'].includes(String(p.status)))
    .reduce((s, p) => s + Number(p.amount ?? 0), 0)

  const currency = acct?.default_currency || 'usd'

  return NextResponse.json({
    ok: true,
    account: {
      name:
        acct?.settings?.dashboard?.display_name ||
        acct?.business_profile?.name ||
        acct?.email ||
        'Stripe account',
      currency,
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
    subscriptions: { activeCount: subData.length, mrr: Math.round(mrr) },
    disputes: {
      count: disputeData.length,
      items: disputeData.map((d) => ({
        id: d.id,
        amount: d.amount,
        currency: d.currency,
        status: d.status,
        reason: d.reason,
        created: d.created,
      })),
    },
    charges: chargeData.map((c) => ({
      id: c.id,
      amount: c.amount,
      currency: c.currency,
      status: c.status,
      paid: c.paid,
      refunded: c.refunded,
      created: c.created,
      description: c.description ?? null,
      customerEmail:
        (c.billing_details as { email?: string } | undefined)?.email ??
        (c.receipt_email as string | undefined) ??
        null,
    })),
    payouts: payoutData.slice(0, 6).map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      arrivalDate: p.arrival_date,
      created: p.created,
    })),
  })
}
