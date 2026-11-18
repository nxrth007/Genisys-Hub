import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { clientSubscriptionsView } from '@/lib/stripe-billing'

/**
 * GET /api/clients/subscriptions
 *
 * Every client's Stripe subscription, for the Clients page: where each client
 * stands (trial, active, past due, ending, canceled, not in Stripe), every
 * subscription in one list, the Stripe customers no client matches, and the
 * roster clients with no subscription at all. Clients are matched to Stripe
 * customers by email the way the onboarding form's check is (case doesn't
 * matter), then by name when exactly one client has it.
 *
 * Read from Stripe at most every two minutes; ?refresh=1 asks again now.
 * Staff only (admin + member). Read-only: nothing here changes anything in
 * Stripe. Money totals (MRR, balances) stay on the Payments page.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const denied = await requireStaff()
  if (denied) return denied
  const refresh = req.nextUrl.searchParams.get('refresh') === '1'
  try {
    return NextResponse.json(await clientSubscriptionsView({ refresh }), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[clients/subscriptions]', err)
    return NextResponse.json({ error: 'Could not read subscriptions' }, { status: 500 })
  }
}
