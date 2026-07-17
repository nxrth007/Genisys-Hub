import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/payments/stripe/overview
 *
 * Server-side proxy for the Stripe dashboard in the Payments section.
 * Reads the "Stripe API Key" from the Vault and calls the Stripe REST
 * API directly (no SDK). The key never reaches the client. Gated to the
 * Payments email allowlist (owner + Ethan).
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

  const [balance, charges, payouts, account] = await Promise.all([
    stripeGet('/balance', key),
    stripeGet('/charges?limit=10', key),
    stripeGet('/payouts?limit=6', key),
    stripeGet('/account', key),
  ])

  // A 401 from the balance call = bad/expired key; surface it plainly.
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
  const chargeData = (charges.data as { data?: unknown[] })?.data ?? []
  const payoutData = (payouts.data as { data?: unknown[] })?.data ?? []
  const acct = account.data as {
    business_profile?: { name?: string | null }
    email?: string | null
    settings?: { dashboard?: { display_name?: string | null } }
  }

  return NextResponse.json({
    ok: true,
    account: {
      name:
        acct?.settings?.dashboard?.display_name ||
        acct?.business_profile?.name ||
        acct?.email ||
        'Stripe account',
    },
    // amounts are in the smallest currency unit (cents) — formatted client-side
    available: bal.available ?? [],
    pending: bal.pending ?? [],
    charges: (chargeData as Array<Record<string, unknown>>).map((c) => ({
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
    payouts: (payoutData as Array<Record<string, unknown>>).map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      arrivalDate: p.arrival_date,
      created: p.created,
    })),
  })
}
