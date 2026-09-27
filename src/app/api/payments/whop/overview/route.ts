import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import {
  getWhopAccountView,
  getWhopCompanyId,
  getWhopStat,
  listWhopDisputes,
  listWhopMemberships,
  listWhopOrders,
  listWhopPayouts,
  listWhopPlans,
  listWhopPromoCodes,
  listWhopRefunds,
  whopConfigured,
  WhopError,
} from '@/lib/whop'

/**
 * GET /api/payments/whop/overview?days=30|90|365
 *
 * Everything the Payments → Whop tab shows, in one call: payments,
 * memberships, plans, promo codes, refunds, disputes, payouts, the
 * account balance, and MRR / active-member stats.
 *
 * Each section is fetched and reported on its own. A Whop key only has
 * the permissions it was created with, and a key that can read payments
 * but not payouts should still show payments — so a section that fails
 * says why (and, for a missing permission, which one to add) while the
 * rest render. Read-only throughout; the key never leaves the server.
 * Gated to the Payments email allowlist.
 */

type Section<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; permission: boolean; scope: string }

async function section<T>(scope: string, fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Whop request failed.'
    return {
      ok: false,
      error,
      // listWhopOrders predates WhopError and reports the status in its message.
      permission: err instanceof WhopError ? err.isPermission : /^Whop returned 40[13]\b/.test(error),
      scope,
    }
  }
}

const WINDOWS = new Set([30, 90, 365])

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (!(await whopConfigured())) {
    return NextResponse.json({
      configured: false,
      hint: 'Add a Vault entry named "Whop API Key" to connect Whop.',
    })
  }

  const asked = Number(req.nextUrl.searchParams.get('days'))
  const days = WINDOWS.has(asked) ? asked : 90
  const createdAfter = new Date(Date.now() - days * 86400_000)

  // Most resources are addressed by the account's biz_ id. The key can
  // report it (needs company:balance:read); the Vault can also hold it.
  const companyId = await getWhopCompanyId()
  const needsCompany = <T>(fn: (id: string) => Promise<T>) => () => {
    if (!companyId) {
      throw new Error(
        'Whop needs the account id for this. Add a Vault entry "Whop Company ID" with your biz_… id (Whop → Settings).',
      )
    }
    return fn(companyId)
  }

  const [account, payments, memberships, plans, promoCodes, refunds, disputes, payouts, mrr, activeMembers] =
    await Promise.all([
      section('company:balance:read', getWhopAccountView),
      section('payment:basic:read', async () => {
        // All statuses in the window — the tab filters client-side, and
        // "paid" totals are computed from exactly what is shown. When the
        // cap is hit, `truncated` tells the tab its totals are partial.
        const { orders, truncated } = await listWhopOrders({ max: 1000, statuses: [], createdAfter })
        const paid = orders.filter((o) => o.status === 'paid')

        // usd_total is Whop's own normalisation — the one field already in
        // USD. Net and refunded are in the payment's currency, so they are
        // converted at that payment's own rate (usd_total / total); a
        // payment that can't be converted is left out and counted.
        let unconverted = 0
        const inUsd = (o: (typeof orders)[number], v: number | null): number => {
          if (v === null || v === 0) return 0
          const cur = (o.currency ?? 'usd').toLowerCase()
          if (cur === 'usd') return v
          if (o.usdTotal !== null && o.total) return v * (o.usdTotal / o.total)
          unconverted++
          return 0
        }
        const sum = (pick: (o: (typeof orders)[number]) => number) => paid.reduce((n, o) => n + pick(o), 0)

        return {
          orders,
          truncated,
          summary: {
            count: orders.length,
            paidCount: paid.length,
            grossUsd: sum((o) => o.usdTotal ?? 0),
            netUsd: sum((o) => inUsd(o, o.afterFees)),
            refundedUsd: sum((o) => inUsd(o, o.refunded)),
            unconverted,
            customers: new Set(paid.map((o) => o.customerEmail ?? o.customerUsername ?? o.id)).size,
          },
        }
      }),
      section('member:basic:read', needsCompany((id) => listWhopMemberships(id))),
      section('plan:basic:read', needsCompany(listWhopPlans)),
      section('promo_code:basic:read', needsCompany(listWhopPromoCodes)),
      section('payment:basic:read', needsCompany(listWhopRefunds)),
      section('payment:dispute:read', needsCompany(listWhopDisputes)),
      section('payout:withdrawal:read', needsCompany(listWhopPayouts)),
      section('stats:read', needsCompany((id) => getWhopStat('monthly_recurring_revenue', id))),
      section('stats:read', needsCompany((id) => getWhopStat('paid_active_members', id))),
    ])

  return NextResponse.json({
    configured: true,
    window: { days, since: createdAfter.toISOString() },
    account,
    payments,
    memberships,
    plans,
    promoCodes,
    refunds,
    disputes,
    payouts,
    stats: { mrr, activeMembers },
  })
}
