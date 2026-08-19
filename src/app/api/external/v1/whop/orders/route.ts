import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { listWhopOrders, probeWhop, whopConfigured } from '@/lib/whop'

/**
 * GET /api/external/v1/whop/orders?days=&status=&max=
 *
 * Confirmed orders from Whop, which is where clients pay for the $297/mo
 * package. Read-only — this never creates, refunds or voids anything.
 *
 * Owner-gated like the rest of Payments: revenue is admin-only, and the
 * nav hiding the tab is not what enforces that.
 */

const MAX_DAYS = 365

export const GET = withOwnerApi(async (req) => {
  // Answer "not set up yet" as data rather than an error, so the page can
  // show what to do instead of a red failure for a perfectly normal state.
  if (!(await whopConfigured())) {
    return {
      configured: false,
      orders: [],
      summary: null,
      hint: 'Add a vault entry named "Whop API Key" (and optionally "Whop Company ID") to connect Whop.',
    }
  }

  const params = req.nextUrl.searchParams

  // ?probe=1 — try several request shapes and report which Whop accepts.
  // Its rejection message is identical for missing scopes, an
  // undeterminable company, and a malformed parameter; this separates
  // them. Owner-gated like everything else here, and never echoes the key.
  if (params.get('probe') === '1') {
    return { configured: true, probe: await probeWhop() }
  }

  const rawDays = Number(params.get('days'))
  const days =
    Number.isFinite(rawDays) && rawDays > 0 && rawDays <= MAX_DAYS
      ? Math.floor(rawDays)
      : 90
  const createdAfter = new Date(Date.now() - days * 86400_000)

  // 'all' drops the filter entirely — useful for chasing a failed charge.
  const statusParam = (params.get('status') ?? 'paid').trim().toLowerCase()
  const statuses = statusParam === 'all' ? [] : [statusParam]

  const rawMax = Number(params.get('max'))
  const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(1000, rawMax) : 200

  try {
    const { orders: fetched, truncated } = await listWhopOrders({
      max,
      statuses,
      createdAfter,
    })

    // Enforce the status filter here as well as asking Whop for it.
    // The array-parameter encoding is a guess against their docs, and a
    // filter Whop silently ignores would return every status while the
    // UI said "Paid" — wrong in the quiet way that gets believed.
    const orders =
      statuses.length > 0
        ? fetched.filter((o) => statuses.includes(o.status))
        : fetched

    const paid = orders.filter((o) => o.status === 'paid')
    const sum = (pick: (o: (typeof orders)[number]) => number | null) =>
      paid.reduce((n, o) => n + (pick(o) ?? 0), 0)

    const monthAgo = Date.now() - 30 * 86400_000
    const paidLast30 = paid.filter(
      (o) => o.paidAt && new Date(o.paidAt).getTime() >= monthAgo,
    )

    return {
      configured: true,
      window: { days, since: createdAfter.toISOString() },
      truncated,
      summary: {
        count: orders.length,
        paidCount: paid.length,
        // usd_total is Whop's own normalisation, so it's the only figure
        // safe to add up when orders span currencies.
        grossUsd: sum((o) => o.usdTotal),
        netUsd: sum((o) => o.afterFees),
        refundedUsd: sum((o) => o.refunded),
        last30Usd: paidLast30.reduce((n, o) => n + (o.usdTotal ?? 0), 0),
        last30Count: paidLast30.length,
        /** Distinct paying customers, not orders. */
        customers: new Set(
          paid.map((o) => o.customerEmail ?? o.customerUsername ?? o.id),
        ).size,
      },
      orders,
    }
  } catch (err) {
    // Surface Whop's own message — a bad key or missing scope is something
    // Alex can fix, and a generic 500 would hide which it is.
    return {
      configured: true,
      error: err instanceof Error ? err.message : 'Whop request failed.',
      orders: [],
      summary: null,
    }
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
